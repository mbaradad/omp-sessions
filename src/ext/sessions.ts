import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AoError, readNativeSession } from "../ao/client";
import { type AoChangedFile, type AoSessionModel, AoSessionWatcher } from "../ao/model";
import type { PlanOp, PlanView, TaskState } from "../planner/types";
import { findOmp } from "../shared/launch";
import { readSwitchyardConfig } from "../shared/switchyard-config";
import { type OmpPaths, ompPathsForArgs } from "../shared/omp-paths";
import type { PermissionMode } from "../shared/permissions";
import { readMode } from "../shared/session-mode";
import { setSessionMode } from "../shared/session-mode-ops";
import { type QueueOp, type SessionMeta, type SessionStatus, type TaskQueue } from "../shared/protocol";
import { type FileChange, aoCheckpointDir, liveChanges } from "../shared/checkpoints";
import { queueOf } from "../shared/plan-queue";
import { isRecord, listTranscripts, parseHead, parseTranscriptLine, readTranscriptStart } from "../shared/transcript-files";
import type { AoConnection } from "./ao-connection";
import type { SessionQueues } from "./session-queues";
import { type TaskTransition, completeOps, dependencyOps, laneQueue, launchFlags, metaOf, parentBranches, priorityOps, rerunTaskIds, statusOf, taskTransitions, withQueue } from "./session-view";
import type { Priority } from "../shared/organize";
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

/** Finds the omp executable on PATH or in the usual install folders (AO runs the one on the daemon's PATH). */
export function resolveOmpPath(): string | undefined {
	return findOmp(undefined);
}

/** Thrown when no omp executable is found (see `onOmpMissing`). */
export class OmpMissingError extends Error {
	constructor() {
		super("Could not find the `omp` executable. Install omp and make sure it is on PATH.");
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
	/** Branch for the session's worktree: an existing one is checked out when free, else a new one is made from the default branch. */
	branch?: string;
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
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly transitionEmitter = new vscode.EventEmitter<{ meta: SessionMeta; from: SessionMeta["status"] }>();
	/** Fires when a known session changes status (not on first observation). */
	readonly onDidTransition = this.transitionEmitter.event;
	private readonly taskTransitionEmitter = new vscode.EventEmitter<TaskTransition>();
	/** A planner task changed state (running → done, failed, interrupted…); the sounds listen. */
	readonly onDidTaskTransition = this.taskTransitionEmitter.event;
	private taskStates = new Map<string, TaskState>();
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
	private planSub: vscode.Disposable | undefined;
	private queues: SessionQueues | undefined;

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
		// One plan source at a time: a new one replaces the old one's subscription.
		this.planSub?.dispose();
		this.planSource = source;
		const apply = () => {
			const tasks = taskTransitions(this.taskStates, source.plan);
			this.taskStates = tasks.next;
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
			for (const t of tasks.changes) this.taskTransitionEmitter.fire(t);
			if (changed) this.emitter.fire();
		};
		apply();
		const sub = source.onDidChange(apply);
		this.planSub = sub;
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
				watcher.onChange(change => this.apply(change.changed, change.removed));
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

	private apply(changed: readonly AoSessionModel[], removed: readonly string[]): void {
		if (this.disposed) return;
		const next = new Map(this.sessions);
		const transitions: { meta: SessionMeta; from: SessionStatus }[] = [];
		let dirty = removed.length > 0 || !this.loaded;
		for (const id of removed) {
			next.delete(id);
			this.models.delete(id);
		}
		changed.forEach(model => {
			const meta = metaOf(model, model.cwd ?? "", readNativeSession(model.id), readMode(model.id));
			const queue = laneQueue(this.planSource?.plan, model.id);
			const prev = next.get(model.id);
			if (queue) Object.assign(meta, withQueue(meta, queue, meta.status));
			this.models.set(model.id, model);
			next.set(model.id, meta);
			if (!prev || prev.updatedAt !== meta.updatedAt || prev.status !== meta.status || prev.title !== meta.title || prev.cwd !== meta.cwd || prev.cost !== meta.cost) dirty = true;
			if (prev && prev.status !== meta.status) transitions.push({ meta, from: prev.status });
		});
		this.sessions = next;
		this.loaded = true;
		for (const t of transitions) this.transitionEmitter.fire(t);
		if (dirty) this.emitter.fire();
	}

	/** Files the session changed in its workspace compared with its base branch (AO's workspace manifest), paths relative to its folder. */
	async workspaceFiles(id: string): Promise<AoChangedFile[]> {
		const client = await this.ao.client();
		const manifest = await client.workspaceManifest(id);
		return manifest.files.flatMap(f => (f.status === "unmodified" ? [] : [{ path: f.path, ...(f.previousPath && { oldPath: f.previousPath }), status: f.status, additions: f.additions, deletions: f.deletions }]));
	}

	/** Re-runs the session's tasks on top of their parents' current work (propagation states `upstream-changed` and `conflict`): the planner's `rerun` op (only the upstream note, in the task's own session; on a conflict edge it asks the agent to merge). Resolves with how many. */
	async rerunWithParentChanges(id: string): Promise<number> {
		const source = this.planSource;
		if (!source) throw new Error("the planner is not connected");
		const tasks = rerunTaskIds(source.plan, id);
		if (tasks.length) await source.edit(tasks.map(task => ({ op: "rerun", id: task })));
		return tasks.length;
	}

	/**
	 * Scheduling priority of sessions: the planner's lane priority decides which waiting session starts first
	 * (PLANNER-API.md), so it lives there; views sort by organize.json's copy, which callers write too. A session
	 * without a lane gets one (id = the session id, which the planner treats as the session's queue). Without a
	 * planner connection nothing is sent.
	 */
	async setPriority(ids: readonly string[], priority: Priority): Promise<void> {
		const source = this.planSource;
		if (!source || ids.length === 0) return;
		await source.edit(priorityOps(source.plan, ids, priority));
	}

	/**
	 * Makes the session's pending tasks wait for `dependsOn` (sessions; empty = no waiting). Resolves with how many
	 * tasks were edited: 0 when it has none to hold back. The planner refuses a cycle (the error says so).
	 */
	async setDependencies(id: string, dependsOn: readonly string[]): Promise<number> {
		const source = this.planSource;
		const ops = source && dependencyOps(source.plan, id, dependsOn);
		if (!source || !ops) return 0;
		await source.edit(ops);
		return ops.length;
	}

	/**
	 * Marks sessions completed or reopens them: the planner's lane marker (`lane.complete`), so every client sees
	 * it. A session without a lane gets one named after it. Nothing is sent without a planner connection.
	 */
	async setCompleted(ids: readonly string[], completed: boolean): Promise<void> {
		const source = this.planSource;
		if (!source || ids.length === 0) return;
		await source.edit(completeOps(source.plan, ids, completed));
	}

	/** The branches this session's tasks build on (their parents'), for "Compare Branch with Base". */
	parentBranches(id: string): Array<{ title: string; branch: string }> {
		return parentBranches(this.planSource?.plan, id);
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

	/** The session's edits still in effect, as the Switchyard omp extension recorded them. */
	changes(id: string): FileChange[] {
		return liveChanges(aoCheckpointDir(id));
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
		const flags = launchFlags(opts.ompArgs ?? []);
		if (flags.ignored.length) this.ao.log.warn(`omp flags AO owns, ignored: ${flags.ignored.join(" ")}`);
		// Precedence: this launch, then the defaults (config.json: Set Default Model / Mode).
		const defaults = readSwitchyardConfig();
		const prompt = (opts.prompt ?? opts.goal)?.trim();
		const model = opts.model ?? flags.model ?? defaults.model;
		const title = opts.title?.trim().slice(0, 100);
		const mode = opts.mode ?? flags.mode ?? defaults.mode;
		let id: string;
		try {
			// The Switchyard spawn sequence (MAPPING D11): bypass-permissions in AO and the mode in the omp gate,
			// extra omp arguments (G34) applied by a restart before the first message, then the message.
			const spawned = await client.spawnSwitchyard({
				dir: opts.cwd,
				setMode: (sessionId, m) => setSessionMode(client, sessionId, m),
				...(title && { displayName: title }),
				...(opts.branch && { branch: opts.branch }),
				...(prompt && { prompt }),
				...(model && { model }),
				...((opts.effort ?? flags.effort) && { thinking: opts.effort ?? flags.effort }),
				...(mode && { mode }),
				...(flags.rest.length && { ompArgs: flags.rest }),
			});
			id = spawned.session.id;
		} catch (err) {
			if (err instanceof Error && /omp.*(not (installed|found)|missing)|harness.*(not installed|unavailable)/i.test(err.message)) this.missingEmitter.fire();
			throw err;
		}
		await this.refreshSession(id);
		return id;
	}

	/** Stops the session's agent; the session and its transcript stay (MAPPING D4: AO `exit-agent`). */
	async stop(id: string): Promise<void> {
		const client = await this.ao.client();
		await client.exitAgent(id);
		await this.refreshSession(id);
	}

	/** Brings a stopped session back: `resume-agent` after a stop, `restore` after AO terminated it. */
	async resume(id: string): Promise<void> {
		const client = await this.ao.client();
		const view = this.models.get(id)?.view ?? (await client.getSession(id));
		if (view.isTerminated) await client.restoreSession(id);
		else await client.resumeAgent(id);
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
		try {
			await client.deleteSession(id);
		} catch (err) {
			if (err instanceof AoError && err.status === 404) return void (await this.refreshSession(id));
			const cwd = this.sessions.get(id)?.cwd;
			await this.refreshSession(id);
			if (err instanceof AoError && err.status === 409 && cwd) throw new Error(`${err.message} (${cwd}: commit or discard the changes there, then remove it again)`);
			throw err;
		}
		await this.refreshSession(id);
	}

	/** Pins or unpins the session in AO (its own pin, shown by AO's apps too). */
	async setPinned(id: string, pinned: boolean): Promise<void> {
		const client = await this.ao.client();
		await client.setPinned(id, pinned);
		await this.refreshSession(id);
	}

	/** Model (and thinking) for the session's next turns. */
	async setModel(id: string, settings: { model?: string; effort?: string }): Promise<void> {
		const client = await this.ao.client();
		await client.setTurnSettings(id, { ...(settings.model && { model: settings.model }), ...(settings.effort && { reasoningEffort: settings.effort }) });
		await this.refreshSession(id);
	}

	/** Switches the permission mode: the omp extension's gate reads the session's mode file on every tool call, so it is live in any state (checkpoints' `setSessionMode`). */
	async setMode(id: string, mode: PermissionMode): Promise<void> {
		if (!this.get(id)) throw new Error("that session no longer exists");
		await setSessionMode(await this.ao.client(), id, mode);
		await this.refreshSession(id);
	}

	/** Where the session task queues live: the planner's lanes (ext-tasks' SessionQueues over the window's PlannerStore). */
	useQueues(queues: SessionQueues): vscode.Disposable {
		this.queues = queues;
		const sub = queues.onDidChange(() => this.emitter.fire());
		return {
			dispose: () => {
				sub.dispose();
				if (this.queues === queues) this.queues = undefined;
			},
		};
	}

	/** The session's task queue in the old shape (the chat's strip); empty until the planner connection is handed over. */
	queue(id: string): TaskQueue {
		return this.queues?.get(id) ?? queueOf(undefined, id);
	}

	/** Edits the session's task queue through the planner; rejects with the planner's reason when it refuses (a cycle, a running task…). */
	async editQueue(id: string, ops: QueueOp[]): Promise<void> {
		if (!this.queues) throw new Error("the planner is not connected");
		await this.queues.edit(id, ops);
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.retry);
		this.watcher?.close();
		this.emitter.dispose();
		this.transitionEmitter.dispose();
		this.taskTransitionEmitter.dispose();
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
