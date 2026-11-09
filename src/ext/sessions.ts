import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AoError, type AoHarnessInfo, type HarnessChoice, availableHarnesses, isOmpHarness, projectWorkerHarness, readNativeSession, resolveHarness } from "../ao/client";
import { type AoChangedFile, type AoSessionModel, AoSessionWatcher, approvalModeFor } from "../ao/model";
import { harnessPickItems, shouldAskHarness } from "./harness-choice";
import type { PlanOp, PlanView, TaskState } from "../planner/types";
import { readSwitchyardConfig } from "../ao/config";
import { type OmpPaths, findOmp, ompPathsForArgs } from "../shared/omp-paths";
import type { PermissionMode } from "../shared/permissions";
import { readMode } from "../shared/session-mode";
import { setSessionMode } from "../shared/session-mode-ops";
import { type QueueOp, type SessionMeta, type SessionStatus, type TaskQueue } from "../shared/protocol";
import { type FileChange, aoCheckpointDir, liveChanges } from "../shared/checkpoints";
import { queueOf } from "../shared/plan-queue";
import { isRecord, listTranscripts, parseHead, parseTranscriptLine, readTranscriptStart } from "../shared/transcript-files";
import type { AoConnection } from "./ao-connection";
import type { SessionQueues } from "./session-queues";
import { type TaskTransition, completeOps, dependencyOps, laneQueue, launchFlags, metaOf, asChangedFile, ownFiles, parentBranches, priorityOps, rerunTaskIds, statusOf, taskBaseOf, taskTransitions, withQueue } from "./session-view";
import type { Priority } from "../shared/organize";
import { type SessionScope, isSessionScope, withinAny } from "./session-scope";
import { type ProjectInfo, changedSince, findProject } from "./worktree-git";

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
	return findOmp();
}

/** Thrown when no omp executable is found (see `onOmpMissing`). */
export class OmpMissingError extends Error {
	constructor() {
		super("Could not find the `omp` executable. Install omp and make sure it is on PATH.");
	}
}

/** Asks which of AO's authorized chat harnesses a new session runs, AO's default first; undefined when cancelled. */
async function pickHarness(harnesses: readonly AoHarnessInfo[], choice: HarnessChoice): Promise<string | undefined> {
	const pick = await vscode.window.showQuickPick(
		harnessPickItems(harnesses, choice).map(i => ({ label: i.label, description: i.description, harness: i.harness })),
		{ title: "Harness for the new session", placeHolder: "Several agent harnesses are logged in to AO (set switchyard.defaultHarness to stop asking)", ignoreFocusOut: true },
	);
	return pick?.harness;
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
	/** The AO harness (claude-code, codex, omp, …): `chooseHarness`'s answer. Absent: resolved at spawn (Switchyard default, project worker harness, AO default). */
	harness?: string;
	/** Explicitly picked: applies to any harness. The Switchyard default model (config.json) applies to omp sessions only. */
	model?: string;
	/** Thinking level (AO `effort`). */
	effort?: string;
	mode?: PermissionMode;
	/** omp CLI flags: `--model`, `--thinking` and `--approval-mode` apply; `omp acp` takes no others (GAPS G10). omp only. */
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
	/** A graph child's own files from git (`diff <Task.git.base>` in its worktree), by session; `key` is what they were computed for. */
	private readonly taskFiles = new Map<string, { key: string; files: AoChangedFile[] }>();
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
				const model = this.models.get(id);
				// Becoming (or ceasing to be) a graph child changes which files count as the session's own.
				const changedFiles = model ? this.ownFilesOf(id, model.changedFiles, meta.cwd).length : meta.changedFiles;
				if (changedFiles === meta.changedFiles && JSON.stringify(queue) === JSON.stringify(meta.queue)) continue;
				const next = { ...withQueue(meta, queue, model ? statusOf(model.state) : meta.status), changedFiles };
				this.sessions.set(id, next);
				if (next.status !== meta.status) transitions.push({ meta: next, from: meta.status });
				changed = true;
			}
			for (const t of transitions) this.transitionEmitter.fire(t);
			for (const t of tasks.changes) this.taskTransitionEmitter.fire(t);
			for (const id of this.sessions.keys()) this.refreshTaskFiles(id);
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
			meta.changedFiles = this.ownFilesOf(model.id, model.changedFiles, meta.cwd).length;
			this.models.set(model.id, model);
			queueMicrotask(() => this.refreshTaskFiles(model.id));
			next.set(model.id, meta);
			if (!prev || prev.updatedAt !== meta.updatedAt || prev.status !== meta.status || prev.title !== meta.title || prev.cwd !== meta.cwd || prev.cost !== meta.cost) dirty = true;
			if (prev && prev.status !== meta.status) transitions.push({ meta, from: prev.status });
		});
		this.sessions = next;
		this.loaded = true;
		for (const t of transitions) this.transitionEmitter.fire(t);
		if (dirty) this.emitter.fire();
	}

	/**
	 * `files` (AO's manifest list) as the session's own work: a graph child's manifest also holds its parents' work
	 * (GAPS G43), so only the files its edit tools touched count (`ownFiles`); other sessions keep the whole list.
	 */
	private ownFilesOf<T extends { path: string }>(id: string, files: readonly T[], cwd: string): T[] {
		const own = taskBaseOf(this.planSource?.plan, id) ? this.taskFiles.get(id)?.files : undefined;
		if (own) return own as unknown as T[];
		// No git answer yet (or no base): what its edit tools touched, for a session that builds on parents.
		const graphChild = parentBranches(this.planSource?.plan, id).length > 0;
		return ownFiles(files, cwd, graphChild ? this.changes(id) : undefined);
	}

	/**
	 * A graph child with a recorded base: its changed files are `git diff <base>` in its worktree (exact, shell edits
	 * included), computed once its agent is not working and again when the session changes after that.
	 */
	private refreshTaskFiles(id: string): void {
		const meta = this.sessions.get(id);
		const base = taskBaseOf(this.planSource?.plan, id);
		if (!meta || !base || !meta.cwd || meta.status === "working" || meta.status === "starting") return;
		const key = `${base}|${meta.updatedAt}`;
		if (this.taskFiles.get(id)?.key === key) return;
		this.taskFiles.set(id, { key, files: this.taskFiles.get(id)?.files ?? [] });
		void changedSince(meta.cwd, base).then(
			list => {
				const files = list.map(asChangedFile);
				this.taskFiles.set(id, { key, files });
				const current = this.sessions.get(id);
				if (!current || this.disposed || current.changedFiles === files.length) return;
				this.sessions = new Map(this.sessions).set(id, { ...current, changedFiles: files.length });
				this.emitter.fire();
			},
			err => this.ao.log.warn(`changed files of ${id} since ${base}: ${String(err)}`),
		);
	}

	/** Files the session changed in its workspace compared with its base branch (AO's workspace manifest), paths relative to its folder; a graph child's own files only. */
	async workspaceFiles(id: string): Promise<AoChangedFile[]> {
		// The watcher's own list: the same source and moment as the count (AO caches its manifest for 3 s unflagged, so a read of
		// ours right after a turn settles could disagree with it). Our read is only for a session the watcher does not carry.
		const model = this.models.get(id);
		if (model) return this.ownFilesOf(id, model.changedFiles, this.get(id)?.cwd ?? model.cwd ?? "");
		const client = await this.ao.client();
		const manifest = await client.workspaceManifest(id);
		const files = manifest.files.flatMap(f => (f.status === "unmodified" ? [] : [{ path: f.path, ...(f.previousPath && { oldPath: f.previousPath }), status: f.status, additions: f.additions, deletions: f.deletions }]));
		return this.ownFilesOf(id, files, this.get(id)?.cwd ?? "");
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

	/** Where a graph child's own work starts (the planner's `Task.git.base`), when it has one: `git diff <it>` in the worktree is what the task changed. */
	taskBase(id: string): string | undefined {
		return taskBaseOf(this.planSource?.plan, id);
	}

	/** The branches this session's tasks build on (their parents'), for "Compare Branch with Base". */
	parentBranches(id: string): Array<{ title: string; branch: string }> {
		return parentBranches(this.planSource?.plan, id);
	}

	/**
	 * The models to offer for a new session of `harness`. omp: a live omp session of this machine's own choices (its
	 * config options: the only exact list; AO's omp catalog has thousands of ids and drops models that run), asking the
	 * most recently active omp sessions in turn; undefined when none is running (callers accept a typed id, the spawn
	 * helper checks it). Another harness: AO's model catalog of it.
	 */
	async modelChoices(harness?: string): Promise<Array<{ value: string; name: string }> | undefined> {
		const client = await this.ao.client(false).catch(() => undefined);
		if (!client) return undefined;
		if (!isOmpHarness(harness)) {
			const catalog = await client.agentModels(harness).catch(() => undefined);
			return catalog?.models.length ? catalog.models.map(m => ({ value: m.id, name: m.label || m.id })) : undefined;
		}
		const live = this.all()
			.filter(m => m.status !== "stopped" && isOmpHarness(m.harness))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 3);
		for (const m of live) {
			const options = await client.configOptions(m.id).catch(() => undefined);
			const choices = options?.options.find(o => o.id === "model")?.choices;
			if (choices?.length) return choices.map(c => ({ value: c.value, name: c.name || c.value }));
		}
		return undefined;
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

	/** `switchyard.sessionScope`, or "all" in a window without folders. */
	scope(): SessionScope {
		if (!vscode.workspace.workspaceFolders?.length) return "all";
		const v = vscode.workspace.getConfiguration("switchyard").get<string>("sessionScope");
		return isSessionScope(v) ? v : "workspace";
	}

	/** Listed by this window's views (Sessions, board, tasks, status bar) under the current scope. */
	inScope(meta: SessionMeta): boolean {
		return this.scope() === "all" || this.inWorkspace(meta);
	}

	/** Whether this window notifies about the session: its workspace's sessions, or every one with `switchyard.notifyAllSessions`. */
	notifies(meta: SessionMeta): boolean {
		return vscode.workspace.getConfiguration("switchyard").get<boolean>("notifyAllSessions", false) || this.inWorkspace(meta);
	}

	/** The session's edits still in effect, as the Switchyard omp extension recorded them. */
	changes(id: string): FileChange[] {
		return liveChanges(aoCheckpointDir(id));
	}

	/**
	 * The harness a new session in `cwd` runs (src/ao/harness.ts's order: `switchyard.defaultHarness` / config.json
	 * `harness`, the AO project's worker harness, AO's default). When nobody chose and several chat harnesses are
	 * authorized, asks with a quick pick (AO's default first). Resolves with undefined when the pick is cancelled.
	 * Throws HarnessError for a default AO can't chat with.
	 */
	async chooseHarness(cwd: string): Promise<string | undefined> {
		const client = await this.ao.client();
		const config = vscode.workspace.getConfiguration("switchyard").get<string>("defaultHarness")?.trim() || readSwitchyardConfig().harness?.trim() || undefined;
		const harnesses = await availableHarnesses(client);
		// The project only matters when there is no Switchyard default; a folder AO has no project for yet has no worker harness.
		const projectId = config ? undefined : (await client.projectForFolder(cwd, { create: false }).catch(() => undefined))?.id;
		const project = projectId ? await projectWorkerHarness(client, projectId) : undefined;
		const choice = resolveHarness({ config, project, harnesses });
		return shouldAskHarness(choice, harnesses) ? pickHarness(harnesses, choice) : choice.harness;
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
		// Precedence: this launch, then the defaults (config.json: Set Default Model / Mode). The default model is an
		// omp model: the spawn applies it to omp sessions only (`defaultModel`).
		const defaults = readSwitchyardConfig();
		const prompt = (opts.prompt ?? opts.goal)?.trim();
		const model = opts.model ?? flags.model;
		const title = opts.title?.trim().slice(0, 100);
		// Asked for: refused by the spawn when the harness can't run it. The default (config.json) gives way to the nearest mode AO offers.
		const mode = opts.mode ?? flags.mode;
		if (opts.harness && !isOmpHarness(opts.harness)) {
			if (flags.rest.length) throw new Error(`extra omp flags (${flags.rest.join(" ")}) are omp-only (Switchyard's omp extension); this session would run ${opts.harness}`);
			if (mode === "plan") throw new Error(`plan mode is omp-only (Switchyard's omp extension); this session would run ${opts.harness}: pick Ask, Edits or Auto`);
		}
		let id: string;
		try {
			// The Switchyard spawn sequence (MAPPING D11): bypass-permissions in AO and the mode in the omp gate,
			// extra omp arguments (G34) applied by a restart before the first message, then the message.
			const spawned = await client.spawnSwitchyard({
				dir: opts.cwd,
				setMode: (sessionId, m) => setSessionMode(client, sessionId, m),
				defaultModel: defaults.model ?? null,
				defaultMode: defaults.mode ?? null,
				...(opts.harness && { harness: opts.harness }),
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

	/**
	 * Switches the permission mode. omp: the omp extension's gate reads the session's mode file on every tool call, so
	 * it is live in any state (checkpoints' `setSessionMode`). Another harness: AO's approval mode (ask → default,
	 * edits → accept-edits, auto → bypass-permissions), which AO applies when it starts the agent: a live, idle
	 * session's agent is restarted on the same transcript. Plan is omp-only.
	 */
	async setMode(id: string, mode: PermissionMode): Promise<void> {
		const meta = this.get(id);
		if (!meta) throw new Error("that session no longer exists");
		if (isOmpHarness(meta.harness)) await setSessionMode(await this.ao.client(), id, mode);
		else await this.setApprovalMode(id, meta.harness ?? "", mode);
		await this.refreshSession(id);
	}

	/** The non-omp half of `setMode`, as the CLI's `switchyard mode` does it. */
	private async setApprovalMode(id: string, harness: string, mode: PermissionMode): Promise<void> {
		if (mode === "plan") throw new Error(`plan mode is omp-only (Switchyard's omp extension); this session runs ${harness}: use Ask, Edits or Auto`);
		const client = await this.ao.client();
		const model = this.models.get(id);
		const view = model?.view ?? (await client.getSession(id));
		const conversation = model?.conversation ?? (await client.getConversation(id).catch(() => undefined));
		const approval = approvalModeFor(mode);
		if (conversation?.settings.approvalMode === approval) return;
		const live = !view.isTerminated && view.activity.state !== "exited";
		if (live && conversation?.turns.some(t => t.state === "running" || t.state === "queued")) throw new Error(`${harness} changes its approval level only when AO restarts it, and the session is working: switch when it is idle, or stop it first`);
		await client.setTurnSettings(id, { approvalMode: approval });
		if (!live) return;
		await client.exitAgent(id);
		await client.resumeAgent(id);
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

/** omp's folders for the sessions this extension starts (`--profile`/`--session-dir` in `switchyard.extraArgs` count). */
export function configuredOmpPaths(): OmpPaths {
	return ompPathsForArgs(vscode.workspace.getConfiguration("switchyard").get<string[]>("extraArgs") ?? []);
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
