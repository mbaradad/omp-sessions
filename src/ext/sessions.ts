import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { settleDeadHost } from "../shared/health";
import { type LaunchOptions, canConnect, findOmp, hostAlive, launchHost, readHostVersion, sendToHost } from "../shared/launch";
import { type OmpPaths, ompPathsForArgs } from "../shared/omp-paths";
import { type FileChange, type QueueOp, type SessionMeta, type TaskQueue, sessionDir, sessionsRoot } from "../shared/protocol";
import { applyQueueOps, queueSummary, readQueueFile, writeQueueFile } from "../shared/queue";
import { isRecord, listTranscripts, parseHead, parseTranscriptLine, readTranscriptStart } from "../shared/transcript-files";
import { plain } from "./plain";
import { type SessionScope, isSessionScope, withinAny } from "./session-scope";
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

const realCache = new Map<string, string>();

/** `p` with symlinks resolved (cached: a folder's real location rarely changes); `p` when it doesn't exist. */
function realPath(p: string): string {
	let real = realCache.get(p);
	if (real === undefined) {
		try {
			real = fs.realpathSync.native(p);
		} catch {
			real = p;
		}
		realCache.set(p, real);
	}
	return real;
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
			if (meta.status !== "stopped") meta = settleDeadHost(meta, hostAlive(meta));
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

	/**
	 * The session's folder is a workspace folder or inside one (as spelled, or with symlinks resolved); sessions
	 * in linked git worktrees count for their main repository. Workspace folders are local paths on the
	 * extension host's machine: `file:` (local or remote extension host) or `vscode-remote:` URIs.
	 */
	inWorkspace(meta: SessionMeta): boolean {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === "file" || f.uri.scheme === "vscode-remote").map(f => f.uri.fsPath);
		if (!folders.length) return false;
		const project = projectRoot(meta.cwd);
		const dirs = project.worktree ? [meta.cwd, project.root] : [meta.cwd];
		return withinAny(dirs, folders) || withinAny(dirs.map(realPath), folders.map(realPath));
	}

	/** `omp.sessionScope`, or "all" in a window without folders. */
	scope(): SessionScope {
		if (!vscode.workspace.workspaceFolders?.length) return "all";
		const v = vscode.workspace.getConfiguration("omp").get<string>("sessionScope");
		return isSessionScope(v) ? v : "workspace";
	}

	/** Listed by this window's views (Sessions, board, tasks, status bar) under the current scope. */
	inScope(meta: SessionMeta): boolean {
		return this.scope() === "all" || this.inWorkspace(meta);
	}

	/** Whether this window notifies about the session: its workspace's sessions, or every one with `omp.notifyAllSessions`. */
	notifies(meta: SessionMeta): boolean {
		return vscode.workspace.getConfiguration("omp").get<boolean>("notifyAllSessions", false) || this.inWorkspace(meta);
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
				onError: err => void vscode.window.showErrorMessage(plain(`Could not start the omp session host: ${err.message}`)),
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
	/** Moved to omp's archive by `omp gc`; resuming restores it first. */
	archived: boolean;
}

/** omp's folders for the sessions this extension starts (`--profile`/`--session-dir` in `omp.extraArgs` count). */
export function configuredOmpPaths(): OmpPaths {
	return ompPathsForArgs(vscode.workspace.getConfiguration("omp").get<string[]>("extraArgs") ?? []);
}

/** omp session transcripts recorded for `cwd` (from TUI or other hosts, archived ones included), newest first. */
export async function listOmpHistory(cwd: string): Promise<HistoryEntry[]> {
	const out: HistoryEntry[] = [];
	for (const { file, mtimeMs, archived } of await listTranscripts(configuredOmpPaths())) {
		let start: string;
		try {
			start = readTranscriptStart(file, 4096);
		} catch {
			continue;
		}
		const head = parseHead(start);
		// Under 600 bytes: a header without a conversation.
		if (head.cwd !== cwd || start.length < 600) continue;
		out.push({ file, cwd, title: head.title || firstUserText(file) || path.basename(file).replace(/\.jsonl(\.gz)?$/, ""), mtime: mtimeMs, archived });
	}
	return out;
}

function firstUserText(file: string): string {
	let head: string;
	try {
		head = readTranscriptStart(file, 64 * 1024);
	} catch {
		return "";
	}
	for (const line of head.split("\n")) {
		if (!line.includes('"role":"user"')) continue;
		const message = parseTranscriptLine(line)?.message;
		const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
		const block = content.find(c => isRecord(c) && c.type === "text");
		if (isRecord(block) && typeof block.text === "string" && block.text) return block.text.split("\n")[0].slice(0, 80);
	}
	return "";
}
