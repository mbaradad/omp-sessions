import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { type AoClient, type AoSpawnResponse, readNativeSession } from "../ao/client";
import { type AoChangedFile, type AoSessionModel, AoSessionWatcher } from "../ao/model";
import type { PlanOp, PlanView } from "../planner/types";
import { findOmp, readLauncherSettings, sendToHost } from "../shared/launch";
import { type OmpPaths, ompPathsForArgs } from "../shared/omp-paths";
import type { PermissionMode } from "../shared/permissions";
import { type FileChange, type QueueOp, type SessionMeta, type SessionStatus, type TaskQueue, sessionDir } from "../shared/protocol";
import { applyQueueOps, queueSummary, readQueueFile, writeQueueFile } from "../shared/queue";
import { readProjectDefaults } from "../shared/session-config";
import { isRecord, listTranscripts, parseHead, parseTranscriptLine, readTranscriptStart } from "../shared/transcript-files";
import type { AoConnection } from "./ao-connection";
import { approvalModeFor, laneQueue, launchFlags, metaOf, rerunTaskIds, statusOf, withQueue } from "./session-view";
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

/** Thrown when no omp executable is found (see `onOmpMissing`). */
export class OmpMissingError extends Error {
	constructor() {
		super("Could not find the `omp` executable. Install omp or set `omp.path` in settings.");
	}
}

/** What a new session starts with. AO runs it: in a worktree of the folder's git repository, else in a scratch folder. */
export interface NewSessionOptions {
	cwd: string;
	/** Open (resume when stopped) this existing session instead of creating one. */
	id?: string;
	title?: string;
	/** First prompt. */
	prompt?: string;
	/** Old name of the first prompt (New Session with Options' goal). */
	goal?: string;
	model?: string;
	/** Thinking level (AO `effort`). */
	effort?: string;
	mode?: PermissionMode;
	/** omp CLI flags: `--model`, `--thinking` and `--approval-mode` apply; `omp acp` takes no others (GAPS G10). */
	ompArgs?: string[];
	/** An omp transcript to continue: AO cannot adopt one yet (GAPS G8). */
	resumeFile?: string;
}

/** The planner's latest plan and its change event (the Tasks view's PlannerStore has this shape). */
export interface PlanSource {
	readonly plan: PlanView | undefined;
	/** Applies plan edits through the planner (the Tasks view's PlannerStore). */
	edit(ops: PlanOp[]): Promise<unknown>;
	readonly onDidChange: vscode.Event<unknown>;
}

/**
 * Every AO session, as `SessionMeta` records for the views (tree, board, status bar, notifications), kept
 * current from AO's change stream by an AoSessionWatcher; plus the session commands (new, stop, resume,
 * rename, remove) on AO's API.
 */
export class SessionManager implements vscode.Disposable {
	private sessions = new Map<string, SessionMeta>();
	private readonly models = new Map<string, AoSessionModel>();
	/** Workspace folder of each session (AO's list has none; a session's folder never moves). */
	private readonly workspaces = new Map<string, string>();
	/** Files changed in each session's worktree, as last counted. */
	private readonly fileCounts = new Map<string, number>();
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly transitionEmitter = new vscode.EventEmitter<{ meta: SessionMeta; from: SessionMeta["status"] }>();
	/** Fires when a known session changes status (not on first observation). */
	readonly onDidTransition = this.transitionEmitter.event;
	private readonly missingEmitter = new vscode.EventEmitter<void>();
	/** Fires when AO reports that it can't start omp. */
	readonly onOmpMissing = this.missingEmitter.event;
	private watcher: AoSessionWatcher | undefined;
	private starting: Promise<AoSessionWatcher> | undefined;
	private retry: NodeJS.Timeout | undefined;
	private disposed = false;
	/** Set once the first list arrived (until then the views show no sessions, not "none"). */
	loaded = false;
	/** The planner's plan (task queues of sessions), when a planner connection was handed over (`usePlan`). */
	private planSource: PlanSource | undefined;

	constructor(
		private readonly ao: AoConnection,
		/** This extension's version. */
		readonly version: string,
	) {
		void this.connect().catch(() => undefined);
	}

	/**
	 * Takes each session's task-queue summary (`meta.queue`: badges, the board's Queued column, hide-finished)
	 * from the planner's plan, now and whenever it changes. The Tasks view's planner connection provides it.
	 */
	usePlan(source: PlanSource): vscode.Disposable {
		this.planSource = source;
		const apply = () => {
			const transitions: { meta: SessionMeta; from: SessionStatus }[] = [];
			let changed = false;
			for (const [id, meta] of this.sessions) {
				const queue = laneQueue(source.plan, id);
				if (JSON.stringify(queue) === JSON.stringify(meta.queue)) continue;
				const model = this.models.get(id);
				const next = withQueue(meta, queue, model ? statusOf(model.state) : meta.status);
				this.sessions.set(id, next);
				if (next.status !== meta.status) transitions.push({ meta: next, from: meta.status });
				changed = true;
			}
			for (const t of transitions) this.transitionEmitter.fire(t);
			if (changed) this.emitter.fire();
		};
		apply();
		const sub = source.onDidChange(apply);
		return {
			dispose: () => {
				sub.dispose();
				if (this.planSource === source) this.planSource = undefined;
			},
		};
	}

	/** The watcher on the connected daemon; connects (and retries every 10 s in the background) when needed. */
	private connect(): Promise<AoSessionWatcher> {
		if (this.watcher) return Promise.resolve(this.watcher);
		this.starting ??= (async () => {
			try {
				const client = await this.ao.client();
				const watcher = new AoSessionWatcher(client, { conversationLimit: 20 });
				watcher.onChange(change => void this.apply(client, change.changed, change.removed));
				watcher.onStatus(s => {
					if (s.state === "retrying") this.ao.log.warn(`AO change stream: ${s.error} (retry ${s.attempt})`);
				});
				await watcher.start();
				if (this.disposed) watcher.close();
				else this.watcher = watcher;
				return watcher;
			} catch (err) {
				clearTimeout(this.retry);
				if (!this.disposed) this.retry = setTimeout(() => void this.connect().catch(() => undefined), 10_000);
				throw err;
			} finally {
				this.starting = undefined;
			}
		})();
		return this.starting;
	}

	private async workspaceOf(client: AoClient, model: AoSessionModel): Promise<string> {
		const known = this.workspaces.get(model.id);
		if (known) return known;
		const { data } = await client.api.GET("/api/v1/desktop/sessions/{sessionId}/workspace", { params: { path: { sessionId: model.id } } }).catch(() => ({ data: undefined }));
		const dir = data?.workspacePath;
		// A terminated session may have released its workspace: retry on its next change.
		if (dir) this.workspaces.set(model.id, dir);
		return dir ?? "";
	}

	private async apply(client: AoClient, changed: readonly AoSessionModel[], removed: readonly string[]): Promise<void> {
		const cwds = await Promise.all(changed.map(m => this.workspaceOf(client, m)));
		if (this.disposed) return;
		const next = new Map(this.sessions);
		const transitions: { meta: SessionMeta; from: SessionStatus }[] = [];
		let dirty = removed.length > 0 || !this.loaded;
		for (const id of removed) {
			next.delete(id);
			this.models.delete(id);
		}
		const recount: string[] = [];
		changed.forEach((model, i) => {
			const meta = metaOf(model, cwds[i], readNativeSession(model.id));
			// Turn diffs miss files the agent created; the worktree's changes (counted below) don't.
			meta.changedFiles = Math.max(meta.changedFiles, this.fileCounts.get(model.id) ?? 0);
			const queue = laneQueue(this.planSource?.plan, model.id);
			const prev = next.get(model.id);
			if (queue) Object.assign(meta, withQueue(meta, queue, meta.status));
			this.models.set(model.id, model);
			next.set(model.id, meta);
			if (!prev || prev.updatedAt !== meta.updatedAt || prev.status !== meta.status || prev.title !== meta.title || prev.cwd !== meta.cwd || prev.cost !== meta.cost) dirty = true;
			if (prev && prev.status !== meta.status) transitions.push({ meta, from: prev.status });
			if (meta.status !== "working" && meta.status !== "starting" && (!prev || prev.status !== meta.status)) recount.push(model.id);
		});
		this.sessions = next;
		this.loaded = true;
		for (const t of transitions) this.transitionEmitter.fire(t);
		if (dirty) this.emitter.fire();
		for (const id of recount) void this.recountFiles(id);
	}

	/** Updates a session's changed-file count from its worktree (after a turn, on first sight). */
	private async recountFiles(id: string): Promise<void> {
		const files = await this.workspaceFiles(id).catch(() => undefined);
		if (!files || this.disposed) return;
		this.fileCounts.set(id, files.length);
		const meta = this.sessions.get(id);
		if (!meta || meta.changedFiles === files.length) return;
		this.sessions.set(id, { ...meta, changedFiles: files.length });
		this.emitter.fire();
	}

	/** Files the session changed in its workspace compared with its base branch (AO `workspace/files`), paths relative to its folder. */
	async workspaceFiles(id: string): Promise<AoChangedFile[]> {
		const client = await this.ao.client();
		const { data, error, response } = await client.api.GET("/api/v1/sessions/{sessionId}/workspace/files", { params: { path: { sessionId: id } } });
		if (!response.ok || !data) throw new Error(errorMessage(error, response));
		return data.files.flatMap(f => (f.status === "unmodified" ? [] : [{ path: f.path, ...(f.previousPath && { oldPath: f.previousPath }), status: f.status, additions: f.additions, deletions: f.deletions }]));
	}

	/** Re-runs the session's tasks on top of their parents' current work (propagation states `upstream-changed` and `conflict`); resolves with how many. */
	async rerunWithParentChanges(id: string): Promise<number> {
		const source = this.planSource;
		if (!source) throw new Error("the planner is not connected");
		const tasks = rerunTaskIds(source.plan, id);
		if (tasks.length) await source.edit(tasks.map(task => ({ op: "requeue", id: task })));
		return tasks.length;
	}

	/** Relists every session from AO. */
	refresh(): void {
		void this.connect()
			.then(w => w.reload())
			.catch(() => undefined);
	}

	/** Refetches one session now and resolves with its record. */
	async refreshSession(id: string): Promise<SessionMeta | undefined> {
		const watcher = await this.connect();
		await watcher.refresh(id).catch(() => undefined);
		return this.sessions.get(id);
	}

	get(id: string): SessionMeta | undefined {
		return this.sessions.get(id);
	}

	/** The AO model behind a session (conversation snapshot, question, queue of turns). */
	model(id: string): AoSessionModel | undefined {
		return this.models.get(id);
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
	 * in linked git worktrees (every AO project session) count for their main repository. Workspace folders are
	 * local paths on the extension host's machine: `file:` (local or remote extension host) or `vscode-remote:` URIs.
	 */
	inWorkspace(meta: SessionMeta): boolean {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === "file" || f.uri.scheme === "vscode-remote").map(f => f.uri.fsPath);
		if (!folders.length || !meta.cwd) return false;
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
	 * Starts a session in AO (in a worktree of `cwd`'s git repository, else in a scratch folder), or with
	 * `id` reopens that one (resuming it when stopped). Resolves with its id once AO has it.
	 */
	async launch(opts: NewSessionOptions): Promise<string> {
		const client = await this.ao.client();
		if (opts.id) {
			await this.resume(opts.id);
			return opts.id;
		}
		if (opts.resumeFile) throw new Error("AO cannot continue an existing omp transcript yet (GAPS G8): start a new session instead.");
		const flags = launchFlags(opts.ompArgs ?? []);
		if (flags.ignored.length) this.ao.log.warn(`omp flags omp acp can't take, ignored: ${flags.ignored.join(" ")}`);
		// Precedence: this launch, then the project's saved defaults (Session Settings), then the omp Sessions defaults.
		const project = launchFlags(readProjectDefaults(opts.cwd)?.args ?? []);
		const defaults = readLauncherSettings();
		const mode = opts.mode ?? flags.mode ?? project.mode ?? defaults.mode;
		const approval = mode ? approvalModeFor(mode) : undefined;
		const aoProject = await client.projectForFolder(opts.cwd);
		const prompt = (opts.prompt ?? opts.goal)?.trim();
		const model = opts.model ?? flags.model ?? project.model ?? defaults.model;
		const effort = opts.effort ?? flags.effort ?? project.effort;
		const title = opts.title?.trim().slice(0, 100);
		let response: AoSpawnResponse;
		try {
			response = await client.spawnSession({
				harness: "omp",
				mode: "chat",
				kind: "worker",
				...(aoProject && { projectId: aoProject.id }),
				...(title && { displayName: title }),
				...(prompt && { prompt }),
				...(model && { model }),
				...(effort && { effort }),
				...(approval && { approvalMode: approval.approvalMode }),
			});
		} catch (err) {
			if (err instanceof Error && /omp.*(not (installed|found)|missing)|harness.*(not installed|unavailable)/i.test(err.message)) this.missingEmitter.fire();
			throw err;
		}
		const id = response.session.id;
		if (approval?.plan) await this.setPlanMode(id, true).catch(err => this.ao.log.warn(`plan mode for ${id}: ${String(err)}`));
		await this.refreshSession(id);
		return id;
	}

	/** omp's plan mode (its `mode` config option): live, no restart. */
	async setPlanMode(id: string, plan: boolean): Promise<void> {
		const client = await this.ao.client();
		const { response, error } = await client.api.PATCH("/api/v1/sessions/{sessionId}/conversation/config-options/{configId}", {
			params: { path: { sessionId: id, configId: "mode" } },
			body: { value: plan ? "plan" : "default" },
		});
		if (!response.ok) throw new Error(errorMessage(error, response));
	}

	/** Stops the session's agent; the session and its transcript stay (MAPPING D4: AO `exit-agent`). */
	async stop(id: string): Promise<void> {
		const client = await this.ao.client();
		const { response, error } = await client.api.POST("/api/v1/sessions/{sessionId}/exit-agent", { params: { path: { sessionId: id } } });
		if (!response.ok) throw new Error(errorMessage(error, response));
		await this.refreshSession(id);
	}

	/** Brings a stopped session back: `resume-agent` after a stop, `restore` after AO terminated it. */
	async resume(id: string): Promise<void> {
		const client = await this.ao.client();
		const view = this.models.get(id)?.view ?? (await client.getSession(id));
		if (view.isTerminated) await client.restoreSession(id);
		else {
			const { response, error } = await client.api.POST("/api/v1/sessions/{sessionId}/resume-agent", { params: { path: { sessionId: id } } });
			if (!response.ok) throw new Error(errorMessage(error, response));
		}
		await this.refreshSession(id);
	}

	async rename(id: string, title: string): Promise<void> {
		const client = await this.ao.client();
		await client.renameSession(id, title.slice(0, 100));
		await this.refreshSession(id);
	}

	/**
	 * Deletes the session from AO (terminating it first) with its worktree. AO refuses while the worktree has
	 * uncommitted changes: the session then stays, terminated (stopped), and the error names the folder.
	 */
	async remove(id: string): Promise<void> {
		const client = await this.ao.client();
		const view = this.models.get(id)?.view;
		if (!view?.isTerminated) await client.killSession(id);
		const { response, error } = await client.api.DELETE("/api/v1/sessions/{sessionId}", { params: { path: { sessionId: id }, query: { cleanup: true } } });
		if (!response.ok && response.status !== 404) {
			const cwd = this.sessions.get(id)?.cwd;
			await this.refreshSession(id);
			throw new Error(`${errorMessage(error, response)}${response.status === 409 && cwd ? ` (${cwd}: commit or discard the changes there, then remove it again)` : ""}`);
		}
		await this.refreshSession(id);
	}

	/** Pins or unpins the session in AO (its own pin, shown by AO's apps too). */
	async setPinned(id: string, pinned: boolean): Promise<void> {
		const client = await this.ao.client();
		const params = { params: { path: { sessionId: id } } };
		const { response, error } = pinned ? await client.api.POST("/api/v1/sessions/{sessionId}/pin", params) : await client.api.DELETE("/api/v1/sessions/{sessionId}/pin", params);
		if (!response.ok) throw new Error(errorMessage(error, response));
		await this.refreshSession(id);
	}

	/** Model (and thinking) for the session's next turns. */
	async setModel(id: string, settings: { model?: string; effort?: string }): Promise<void> {
		const client = await this.ao.client();
		await client.setTurnSettings(id, { ...(settings.model && { model: settings.model }), ...(settings.effort && { reasoningEffort: settings.effort }) });
		await this.refreshSession(id);
	}

	/**
	 * Switches the permission mode. Plan is omp's live `mode` option; the approval level is fixed when AO
	 * launches omp (GAPS G7), so changing it restarts the idle agent (exit-agent, resume-agent: same transcript).
	 * Resolves with how it applied; throws while the agent is busy or stopped.
	 */
	async setMode(id: string, mode: PermissionMode): Promise<"live" | "restarted"> {
		const meta = this.get(id);
		if (!meta) throw new Error("that session no longer exists");
		if (meta.status === "stopped") throw new Error("the session is stopped: resume it first");
		const client = await this.ao.client();
		const want = approvalModeFor(mode);
		const current = this.models.get(id)?.conversation?.settings.approvalMode ?? "default";
		let how: "live" | "restarted" = "live";
		if (want.approvalMode !== current) {
			if (meta.status !== "idle") throw new Error(`AO restarts omp to change how approvals are answered, which only happens while the session is idle (it is ${meta.status})`);
			await client.setTurnSettings(id, { approvalMode: want.approvalMode });
			const exit = await client.api.POST("/api/v1/sessions/{sessionId}/exit-agent", { params: { path: { sessionId: id } } });
			if (!exit.response.ok) throw new Error(errorMessage(exit.error, exit.response));
			const resume = await client.api.POST("/api/v1/sessions/{sessionId}/resume-agent", { params: { path: { sessionId: id } } });
			if (!resume.response.ok) throw new Error(errorMessage(resume.error, resume.response));
			how = "restarted";
		}
		await this.setPlanMode(id, want.plan);
		await this.refreshSession(id);
		return how;
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

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.retry);
		this.watcher?.close();
		this.emitter.dispose();
		this.transitionEmitter.dispose();
		this.missingEmitter.dispose();
	}
}

function errorMessage(error: unknown, response: Response): string {
	const message = isRecord(error) && typeof error.message === "string" ? error.message : undefined;
	return message ?? `AO answered HTTP ${response.status}`;
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
