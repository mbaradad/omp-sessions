import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { settleDeadHost } from "../shared/health";
import { type LaunchOptions, canConnect, findOmp, launchHost, pidAlive, readHostVersion, sendToHost } from "../shared/launch";
import { type FileChange, type QueueOp, type SessionMeta, type TaskQueue, sessionDir, sessionsRoot } from "../shared/protocol";
import { applyQueueOps, queueSummary, readQueueFile, writeQueueFile } from "../shared/queue";
import { type ProjectInfo, findProject } from "./worktree-git";

const rootCache = new Map<string, ProjectInfo>();

/**
 * Project a folder belongs to: the enclosing git repository, else the folder itself. Linked git
 * worktrees map to their main repository (with `worktree` set), so they group under it.
 */
export function projectRoot(cwd: string): ProjectInfo {
	const cached = rootCache.get(cwd);
	if (cached) return cached;
	const found = findProject(cwd);
	rootCache.set(cwd, found);
	return found;
}

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Finds the omp executable: `omp.path` setting, PATH, then common install locations. */
export function resolveOmpPath(): string | undefined {
	return findOmp(vscode.workspace.getConfiguration("omp").get<string>("path"));
}

/** Thrown by `SessionManager.launch` when no omp executable is found (see `onOmpMissing`). */
export class OmpMissingError extends Error {
	constructor() {
		super("Could not find the `omp` executable. Install omp or set `omp.path` in settings.");
	}
}

export class SessionManager implements vscode.Disposable {
	private sessions = new Map<string, SessionMeta>();
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly transitionEmitter = new vscode.EventEmitter<{ meta: SessionMeta; from: SessionMeta["status"] }>();
	/** Fires when a known session changes status (not on first observation). */
	readonly onDidTransition = this.transitionEmitter.event;
	private timer: NodeJS.Timeout;
	private watcher: fs.FSWatcher | undefined;

	/** Version of this extension (from the package.json next to `out/host.js`), recorded by hosts it starts. */
	readonly version: string;
	private readonly missingEmitter = new vscode.EventEmitter<void>();
	/** Fires when a launch fails because the omp executable cannot be found. */
	readonly onOmpMissing = this.missingEmitter.event;

	constructor(private readonly hostScript: string) {
		this.version = readHostVersion(hostScript);
		fs.mkdirSync(sessionsRoot(), { recursive: true, mode: 0o700 });
		this.refresh();
		this.timer = setInterval(() => this.refresh(), 1000);
		try {
			this.watcher = fs.watch(sessionsRoot(), { recursive: true }, () => this.scheduleRefresh());
		} catch {
			/* polling still covers it */
		}
	}

	private pending: NodeJS.Timeout | undefined;
	private scheduleRefresh(): void {
		this.pending ??= setTimeout(() => {
			this.pending = undefined;
			this.refresh();
		}, 80);
	}

	refresh(): void {
		const next = new Map<string, SessionMeta>();
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(sessionsRoot());
		} catch {
			/* no sessions yet */
		}
		for (const id of entries) {
			let meta: SessionMeta;
			try {
				meta = JSON.parse(fs.readFileSync(path.join(sessionDir(id), "meta.json"), "utf8")) as SessionMeta;
			} catch {
				continue;
			}
			if (meta.status !== "stopped") meta = settleDeadHost(meta, pidAlive(meta.pid));
			next.set(id, meta);
		}
		let changed = next.size !== this.sessions.size;
		for (const [id, meta] of next) {
			const prev = this.sessions.get(id);
			if (!prev || prev.updatedAt !== meta.updatedAt || prev.status !== meta.status || prev.title !== meta.title) changed = true;
			if (prev && prev.status !== meta.status) this.transitionEmitter.fire({ meta, from: prev.status });
		}
		this.sessions = next;
		if (changed) this.emitter.fire();
	}

	get(id: string): SessionMeta | undefined {
		return this.sessions.get(id);
	}

	all(): SessionMeta[] {
		return [...this.sessions.values()].sort((a, b) => {
			const ra = a.status === "stopped" ? 1 : 0;
			const rb = b.status === "stopped" ? 1 : 0;
			return ra - rb || b.updatedAt - a.updatedAt;
		});
	}

	/** Session folder overlaps a workspace folder; sessions in linked git worktrees count for their main repository. */
	inWorkspace(meta: SessionMeta): boolean {
		const project = projectRoot(meta.cwd);
		const dirs = project.worktree ? [meta.cwd, project.root] : [meta.cwd];
		return (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === "file" && dirs.some(d => isWithin(d, f.uri.fsPath) || isWithin(f.uri.fsPath, d)));
	}

	changes(id: string): FileChange[] {
		let raw = "";
		try {
			raw = fs.readFileSync(path.join(sessionDir(id), "changes.jsonl"), "utf8");
		} catch {
			return [];
		}
		const out: FileChange[] = [];
		for (const line of raw.split("\n")) {
			if (!line) continue;
			try {
				out.push(JSON.parse(line) as FileChange);
			} catch {
				/* torn write */
			}
		}
		return out;
	}

	/**
	 * Launch a detached host. Reusing an existing id resumes that session's omp transcript with
	 * the omp arguments it was created with (persisted in `launch.json`).
	 */
	launch(opts: LaunchOptions): string {
		const omp = resolveOmpPath();
		if (!omp) {
			this.missingEmitter.fire();
			throw new OmpMissingError();
		}
		const extraArgs = vscode.workspace.getConfiguration("omp").get<string[]>("extraArgs") ?? [];
		const id = launchHost(
			{
				hostScript: this.hostScript,
				omp,
				hostVersion: this.version,
				extraArgs,
				onError: err => void vscode.window.showErrorMessage(`Could not start the omp session host: ${err.message}`),
			},
			opts,
		);
		if (opts.id) this.refresh();
		return id;
	}

	/** Waits until the host accepts connections (Unix sockets and Windows pipes alike). */
	async waitForSocket(id: string, timeoutMs = 20000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const started = Date.now();
		while (Date.now() < deadline) {
			this.refresh();
			const meta = this.get(id);
			// The host already gave up (missing folder, omp failed to start).
			if (meta?.status === "stopped" && meta.updatedAt >= started) return false;
			if (meta && meta.status !== "stopped" && (await canConnect(meta.socket))) return true;
			await sleep(150);
		}
		return false;
	}

	queue(id: string): TaskQueue {
		return readQueueFile(path.join(sessionDir(id), "queue.json"));
	}

	/**
	 * Edits a session's task queue: through the host when it runs (so it can dispatch), else on
	 * disk — the host picks the file up when the session is resumed.
	 */
	async editQueue(id: string, ops: QueueOp[]): Promise<void> {
		const meta = this.get(id);
		if (!meta) return;
		if (meta.status !== "stopped" && (await sendToHost(meta, { t: "queue", ops }))) return;
		const file = path.join(sessionDir(id), "queue.json");
		const next = applyQueueOps(readQueueFile(file), ops);
		writeQueueFile(file, next);
		const metaFile = path.join(sessionDir(id), "meta.json");
		try {
			const onDisk = JSON.parse(fs.readFileSync(metaFile, "utf8")) as SessionMeta;
			const tmp = `${metaFile}.ext.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ ...onDisk, queue: queueSummary(next), updatedAt: Date.now() }, null, 1));
			fs.renameSync(tmp, metaFile);
		} catch {
			/* meta unreadable: the tree still re-reads queue.json */
		}
		this.refresh();
	}

	remove(id: string): void {
		fs.rmSync(sessionDir(id), { recursive: true, force: true });
		this.refresh();
	}

	dispose(): void {
		clearInterval(this.timer);
		clearTimeout(this.pending);
		this.watcher?.close();
		this.emitter.dispose();
		this.transitionEmitter.dispose();
		this.missingEmitter.dispose();
	}
}

export interface HistoryEntry {
	file: string;
	cwd: string;
	title: string;
	mtime: number;
}

/** omp session transcripts recorded for `cwd` (from TUI or other hosts), newest first. */
export function listOmpHistory(cwd: string): HistoryEntry[] {
	const root = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), "sessions");
	const out: HistoryEntry[] = [];
	let dirs: string[] = [];
	try {
		dirs = fs.readdirSync(root);
	} catch {
		return out;
	}
	for (const d of dirs) {
		const full = path.join(root, d);
		let files: string[] = [];
		try {
			files = fs.readdirSync(full).filter(f => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const file = path.join(full, f);
			const head = readHead(file, 4096);
			let title = "";
			let sessionCwd = "";
			for (const line of head.split("\n").slice(0, 3)) {
				try {
					const o = JSON.parse(line) as { type?: string; title?: string; cwd?: string };
					if (o.type === "title" && o.title) title = o.title;
					if (o.type === "session" && o.cwd) sessionCwd = o.cwd;
				} catch {
					/* partial line */
				}
			}
			if (sessionCwd !== cwd) continue;
			const st = fs.statSync(file);
			if (st.size < 600) continue;
			out.push({ file, cwd: sessionCwd, title: title || firstUserText(file) || path.basename(f, ".jsonl"), mtime: st.mtimeMs });
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

function readHead(file: string, bytes: number): string {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const n = fs.readSync(fd, buf, 0, bytes, 0);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

function firstUserText(file: string): string {
	const head = readHead(file, 64 * 1024);
	for (const line of head.split("\n")) {
		if (!line.includes('"role":"user"')) continue;
		try {
			const o = JSON.parse(line) as { message?: { content?: Array<{ type: string; text?: string }> } };
			const text = o.message?.content?.find(c => c.type === "text")?.text;
			if (text) return text.split("\n")[0].slice(0, 80);
		} catch {
			/* skip */
		}
	}
	return "";
}
