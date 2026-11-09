// Public contract of the planner (PLANNER-API.md): the plan model, the views clients get, the edit ops
// and the socket protocol. Clients import types from here and PlannerClient from ./client; nothing else.
// Pure types; no Node APIs.

/** What the planner's start-up `ensureOmpIntegration()` reported (the shape of `OmpIntegrationResult`). */
export interface OmpIntegrationStatus {
	/** What this start wrote: the permission gate (`gate`) and the `omp` shim (`shim`). */
	installed: string[];
	upToDate: boolean;
	skipped?: string;
	error?: string;
	code?: string;
}

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";
/** What omp accepts for its `thinking` option over ACP (`minimal` is read as `low`, see normalizeOptions). */
export const THINKING_LEVELS = ["off", "auto", "low", "medium", "high", "xhigh", "max"] as const;
/** The permission modes the Switchyard omp extension's gate enforces (AO itself always runs the session in bypass). */
export const PERMISSION_MODES = ["ask", "edits", "plan", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface Subtask {
	id: string;
	title: string;
	done: boolean;
}

/** How the planner runs a task. Absent fields: lane defaults, then planner defaults, then AO's. */
export interface TaskOptions {
	/** `provider/modelId`. */
	model?: string;
	thinking?: string;
	/** Start in a new AO session instead of continuing the lane's session. */
	freshContext?: boolean;
	/** Automatic retries after a failure or timeout (backoff). */
	retries?: number;
	/** Interrupt the turn after this long (→ failed, or retried). */
	timeoutMinutes?: number;
	/** Folder to work in; the planner maps it to an AO project (git) or a standalone session. */
	cwd?: string;
	/** AO project id; wins over cwd. */
	project?: string;
	/** Permission mode of a session the planner starts (default `auto`: the gate lets everything through). Unattended work that asks will wait for a person. `plan` is omp-only. */
	mode?: PermissionMode;
	/** AO harness of a session the planner starts (claude-code, codex, omp, …); absent: Switchyard's default, the AO project's worker harness, else AO's default (src/ao/harness.ts). */
	harness?: string;
}

/** What a new AO session starts with (the `spawn` of a TaskRun; MAPPING D11). */
export interface SessionStart {
	displayName: string;
	projectId?: string;
	/** An existing local branch AO checks out (graph propagation seeds one at the parent's head). */
	branch?: string;
	model?: string;
	/** The user's default model (config.json): applied only when the session turns out to run omp. */
	defaultModel?: string;
	thinking?: string;
	mode?: PermissionMode;
	/** The harness asked for (task, lane or planner option, else the user's default); absent: the AO project's worker harness, else AO's default. */
	harness?: string;
}

/**
 * Where a dispatch stands. Written to disk before every AO call, so a restarted planner replays the
 * same idempotent steps (AO dedupes `clientRequestId` and `clientMessageId` durably) instead of guessing.
 */
export interface TaskRun {
	/** Idempotency key: the spawn's `clientRequestId` and the message's `clientMessageId`. Unique per attempt. */
	key: string;
	/** `dispatching`: steps may still be outstanding; `sent`: the prompt is in AO, follow its turn. */
	phase: "dispatching" | "sent";
	/** `spawn`: a new AO session; `send`: a message to the lane's session. */
	via: "spawn" | "send";
	/** Exact spawn body (replayed verbatim after a restart; AO answers a replay with the same session). */
	spawn?: SessionStart;
	/** The git repo (AO project folder) a spawned session works in: its branch is recorded once AO answers. */
	repo?: string;
	/** AO session (known up front for `send`, after the spawn otherwise). */
	session?: string;
	/** AO turn id of this task's prompt, once known. */
	turn?: string;
	/** Exact prompt text. */
	prompt: string;
	/** Settings to apply before the prompt (model, thinking), and what to put back afterwards. */
	settings?: { model?: string; thinking?: string };
	restore?: { model?: string; thinking?: string };
	/** The conversation's running cost when the prompt went out (AO reports totals only). */
	baseCost?: number;
	at: number;
	/** Interrupt requested by a timeout (→ failed/retried) rather than by a person. */
	timedOut?: boolean;
	/** Interrupt requested by a person (`abort`). */
	aborted?: boolean;
	/** Provider (from the model) the task runs on, for limit holds. */
	provider?: string;
	/** Failed tries of the outstanding step (transient AO errors). */
	tries?: number;
}

export interface Task {
	id: string;
	title: string;
	notes?: string;
	subtasks: Subtask[];
	status: TaskStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Final assistant text when the task finished, or the error that stopped it. */
	summary?: string;
	options?: TaskOptions;
	/** Failed attempts of the current run (auto-retry counter). */
	attempts?: number;
	durationMs?: number;
	/** USD of the current run (from AO turn usage). */
	cost?: number;
	/** Epoch ms when a crash, restart or kill cut this task short: never re-run unattended. */
	interrupted?: number;
	/** Lane (queue) the task belongs to; absent = free task. */
	lane?: string;
	/** Tasks (ids) that must be done or skipped first. */
	after?: string[];
	/** "results" (default): the parents' summaries go into the prompt. */
	inputs?: "results" | "none";
	priority?: Priority;
	/** Not before this time (epoch ms). */
	startAt?: number;
	/** "spare": only starts while provider usage leaves room. */
	usage?: "normal" | "spare";
	/** Held by a person. */
	paused?: boolean;
	/** AO session the task runs / ran in. */
	session?: string;
	/** Recurring schedule that created it. */
	recur?: string;
	/** Retry backoff: not before this time (epoch ms). */
	holdUntil?: number;
	/** In-flight dispatch (status running). */
	run?: TaskRun;
	/** AO turn id of the latest run (link task → chat; the key for "this task's changes" and "undo this task"). */
	turn?: string;
	/** A person undid this task's turn in AO (checkpoints): its work is gone, so it no longer satisfies `after`. */
	undone?: boolean;
	/** The next run starts from before the previous attempt: that turn is undone first (`requeue {clean}`). */
	clean?: boolean;
	/** The task's git branch and worktree (AO project sessions), for graph propagation. */
	git?: TaskGit;
	/** Propagation state of each parent edge (parent task id → state). */
	sync?: Record<string, EdgeSync>;
	/** Note for the next run's prompt (upstream changes merged, or a merge to resolve). */
	followUp?: string;
	/** The next run is only that note (a follow-up in the session that has the work), not the whole task again. */
	followUpOnly?: boolean;
}

export interface TaskGit {
	/** The repo's main checkout (AO project path). */
	repo: string;
	branch: string;
	/** Where the branch is checked out (AO's worktree for the task's session). */
	worktree?: string;
	/** Branch head after the task's work was last committed. */
	head?: string;
	/**
	 * Where the task's own work starts: the branch head after its parents were merged in and before its first
	 * run. `git diff base..head` is "what this task changed" (AO's own diff is against the default branch, so
	 * it lists the parents' commits too). Absent for a root task in a session the planner created: AO's diff is exact there.
	 */
	base?: string;
}

/**
 * One parent → child edge: `in-sync` (the child has the parent's head), `pending` (a newer parent head
 * waits for the child's turn to end), `merged` (merged and the child told), `upstream-changed` (merged
 * into a finished child, which was not re-run), `resolving` (the child agent is merging a conflict),
 * `conflict` (it couldn't: a person decides).
 */
export interface EdgeSync {
	state: "in-sync" | "pending" | "merged" | "upstream-changed" | "resolving" | "conflict";
	/** Parent head the child has (merged or branched from). */
	head?: string;
	/** Parent head waiting to be merged. */
	pendingHead?: string;
	/** The child was working when the change came: it gets a follow-up run after the merge. */
	prompt?: boolean;
	/** Conflicted files. */
	files?: string[];
	/** Child branch head before and after the last merge (undo with `git reset`). */
	before?: string;
	after?: string;
	at: number;
}

export interface Lane {
	id: string;
	title?: string;
	/** AO session the lane continues (set by its first task, or given). */
	session?: string;
	/** Off = paused. */
	autoRun: boolean;
	/** Arms autoRun at this time. */
	startAt?: number;
	priority?: Priority;
	defaults?: TaskOptions;
	completed?: boolean;
	completedAt?: number;
	createdAt: number;
}

export interface RecurRule {
	/** Every N minutes (≥ 5). */
	every?: number;
	/** Local times of day "HH:MM". */
	at?: string[];
	/** Weekdays (0 = Sunday) for `at`; absent = every day. */
	days?: number[];
}

export interface Recurring {
	id: string;
	title?: string;
	enabled: boolean;
	rule: RecurRule;
	task: TaskInput;
	lane?: string;
	nextAt: number;
	lastAt?: number;
	/** Default true: no new copy while the previous copy is still pending or running. */
	skipIfRunning?: boolean;
	createdAt: number;
}

export interface UsageConfig {
	/** Any AO-reported usage window at or above this percent holds work on that provider. */
	holdAtPercent: number;
	/** "spare" tasks start only while every window of their provider is below this. */
	spareBelowPercent: number;
}

export type BudgetWindow = "hour" | "day" | "week";
export type BudgetCaps = Partial<Record<BudgetWindow, number>>;

export interface PlannerConfig {
	/** 0 = unlimited. */
	maxConcurrent: number;
	paused: boolean;
	usage: UsageConfig;
	budget?: BudgetCaps;
	defaults?: TaskOptions;
}

/** A provider held after a rate/usage-limit error. */
export interface ProviderLimit {
	provider: string;
	model?: string;
	until: number;
	since: number;
	failures: number;
	reason: string;
	guessed?: boolean;
}

/** A usage window AO reports (agent account limits). */
export interface UsageWindow {
	provider: string;
	window: string;
	usedPercent: number;
	resetsAt?: number;
}

/** Everything the planner persists (plan.json). */
export interface PlanState {
	version: 1;
	rev: number;
	tasks: Task[];
	lanes: Lane[];
	recurring: Recurring[];
	config: PlannerConfig;
	limits: Record<string, ProviderLimit>;
	/** Spend of planner-dispatched turns: [epoch ms, USD]. Kept for a week. */
	spend: Array<[number, number]>;
	/** Provider of omp's own default model, learned from the last session the planner started for a task with no model: it tells tasks that name no model which provider's limits and usage windows apply. */
	defaultProvider?: string;
	/** `switchyard/*` branches of removed tasks that hold work no other branch has: left in git for a person to merge or delete. */
	keptBranches: KeptBranch[];
}

/** A branch the planner made for a task that was removed from the plan, and left behind because deleting it would lose work. */
export interface KeptBranch {
	repo: string;
	branch: string;
	/** Title and id of the removed task. */
	task: string;
	taskId: string;
	/** The removed task's AO session (removed together with the branch once the branch can go). */
	session?: string;
	/** The branch tip when it was kept. */
	tip?: string;
	why: string;
	at: number;
}

// ---------- views ----------

export type TaskState = "blocked" | "scheduled" | "paused" | "held" | "waiting" | "interrupted" | "running" | "done" | "failed" | "skipped";

export interface TaskView extends Omit<Task, "run" | "holdUntil"> {
	state: TaskState;
	/** Unfinished dependencies (missing ids included). */
	blockedBy?: string[];
	/** Tasks waiting for this one. */
	children?: string[];
	waitReason?: string;
	waitUntil?: number;
	/** 1-based start position among waiting tasks. */
	position?: number;
}

export interface LaneView extends Lane {
	/** State of the lane's next open task (first pending or running); absent when nothing is left. */
	state?: TaskState;
	waitReason?: string;
	waitUntil?: number;
	pending: number;
	running: number;
	done: number;
	failed: number;
	total: number;
}

export interface SpendUse {
	window: BudgetWindow;
	cap: number;
	spent: number;
	over: boolean;
	freesAt?: number;
}

export interface PlannerStatus extends PlannerConfig {
	running: number;
	waiting: number;
	scheduled: number;
	held: number;
	blocked: number;
	interrupted: number;
	limits: ProviderLimit[];
	usageWindows: UsageWindow[];
	spend: SpendUse[];
	/** Provider tasks with no model of their own are gated on (omp's default model's), once the planner has run one. */
	defaultProvider?: string;
	ao: { url?: string; connected: boolean; lastEventAt?: number; error?: string };
	version: string;
	startedAt: number;
}

/** One graph edge, parent → child, as clients show it (derived from `Task.sync`; the plan view lists every edge). */
export interface EdgeView {
	parent: string;
	parentSession?: string;
	child: string;
	childSession?: string;
	state: EdgeSync["state"];
	files?: string[];
	parentHead?: string;
	childHead?: string;
	at: number;
}

export interface PlanView {
	rev: number;
	/** Every parent → child edge with a propagation state (only git tasks have any). */
	edges: EdgeView[];
	/** Leftover `switchyard/*` branches with unmerged work of removed tasks (`branch.clean` retries their deletion). */
	keptBranches: KeptBranch[];
	tasks: TaskView[];
	lanes: LaneView[];
	recurring: Recurring[];
	status: PlannerStatus;
}

// ---------- edits ----------

export interface TaskInput {
	title: string;
	notes?: string;
	subtasks?: Array<string | { title: string; done?: boolean }>;
	lane?: string;
	/** Task ids, or "@ref" of a task added earlier in the same batch. */
	after?: string[];
	inputs?: "results" | "none";
	priority?: Priority;
	startAt?: number;
	usage?: "normal" | "spare";
	paused?: boolean;
	options?: TaskOptions;
	/** Add it already done (a checklist entry). */
	done?: boolean;
}

export type PlanOp =
	| { op: "add"; task: TaskInput; ref?: string; index?: number }
	| { op: "update"; id: string; title?: string; notes?: string; priority?: Priority | null; startAt?: number | null; usage?: "normal" | "spare"; inputs?: "results" | "none"; options?: TaskOptions | null; lane?: string | null }
	| { op: "remove"; id: string }
	| { op: "move"; id: string; index: number }
	| { op: "after"; id: string; ids: string[] }
	| { op: "run"; id: string }
	/** `clean`: before it runs again, undo the failed attempt's turn (files and context) through the checkpoints extension. */
	| { op: "requeue"; id: string; clean?: boolean }
	| { op: "pause"; id: string }
	| { op: "resume"; id: string }
	| { op: "abort"; id: string }
	| { op: "done"; id: string }
	| { op: "skip"; id: string }
	| { op: "duplicate"; id: string }
	| { op: "addSubtask"; id: string; title: string }
	| { op: "updateSubtask"; id: string; subtaskId: string; title?: string; done?: boolean }
	| { op: "removeSubtask"; id: string; subtaskId: string }
	| { op: "moveSubtask"; id: string; subtaskId: string; index: number }
	/** `ensure`: when the lane exists already, do nothing (its ref still names it) instead of refusing the batch. A new lane is armed unless `autoRun: false`. */
	| { op: "lane.add"; id?: string; title?: string; session?: string; priority?: Priority; defaults?: TaskOptions; autoRun?: boolean; ensure?: boolean; ref?: string }
	| { op: "lane.update"; id: string; title?: string; priority?: Priority | null; defaults?: TaskOptions | null }
	| { op: "lane.remove"; id: string }
	| { op: "lane.pause"; id: string }
	| { op: "lane.resume"; id: string }
	| { op: "lane.startAt"; id: string; at: number | null }
	| { op: "lane.requeue"; id: string }
	| { op: "lane.retryFailed"; id: string }
	| { op: "lane.clearDone"; id: string }
	| { op: "lane.complete"; id: string; completed: boolean }
	| { op: "recur.add"; recurring: { title?: string; rule: RecurRule; task: TaskInput; lane?: string; skipIfRunning?: boolean; enabled?: boolean }; ref?: string }
	| { op: "recur.update"; id: string; title?: string; rule?: RecurRule; task?: TaskInput; lane?: string | null; skipIfRunning?: boolean; enabled?: boolean }
	| { op: "recur.remove"; id: string }
	| { op: "recur.fire"; id: string }
	/** Retries the deletion of the kept branches: those gone from git, or by now reachable from another branch, leave the list. */
	| { op: "branch.clean" }
	/** Re-checks the task's branch now and propagates new commits to its children (GRAPH-PROPAGATION.md). */
	| { op: "sync"; id: string }
	/** "Re-run with parent changes": one more run in the task's own session with only the upstream note. */
	| { op: "rerun"; id: string };

// ---------- compatibility with the old per-session queue ----------

/** Old QueueTask shape (src/shared/protocol.ts) plus `after`. */
export interface QueueTaskView {
	id: string;
	title: string;
	notes?: string;
	subtasks: Subtask[];
	status: TaskStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	summary?: string;
	options?: TaskOptions;
	attempts?: number;
	durationMs?: number;
	cost?: number;
	interrupted?: number;
	after?: string[];
	state: TaskState;
	blockedBy?: string[];
	session?: string;
}

/** Old TaskQueue shape: one lane. */
export interface QueueView {
	id: string;
	tasks: QueueTaskView[];
	autoRun: boolean;
	startAt?: number;
	session?: string;
	/** State of the next open task (see LaneView.state): queued/scheduled/paused/held/waiting/interrupted/running. */
	state?: TaskState;
	waitReason?: string;
	waitUntil?: number;
}

/** Old QueueOp, plus `after` (PARKED §1) and `requeue` (PARKED §3). */
export type QueueOp =
	| { op: "add"; title: string; notes?: string; subtasks?: Array<string | { title: string; done?: boolean }>; index?: number; options?: TaskOptions; done?: boolean }
	| { op: "update"; id: string; title?: string; notes?: string; status?: TaskStatus }
	| { op: "remove"; id: string }
	| { op: "move"; id: string; index: number }
	| { op: "addSubtask"; id: string; title: string }
	| { op: "updateSubtask"; id: string; subtaskId: string; title?: string; done?: boolean }
	| { op: "removeSubtask"; id: string; subtaskId: string }
	| { op: "moveSubtask"; id: string; subtaskId: string; index: number }
	| { op: "run"; id?: string }
	| { op: "autoRun"; value: boolean }
	| { op: "clearDone" }
	| { op: "setOptions"; id: string; options: TaskOptions }
	| { op: "duplicate"; id: string }
	| { op: "retryFailed" }
	| { op: "schedule"; at: number | null }
	| { op: "after"; ids: string[] }
	| { op: "requeue" };

// ---------- wire ----------

export interface PlannerOps {
	/**
	 * `omp`: what the start-up `ensureOmpIntegration()` did (G46): the gate and the `omp` shim installed, `error`
	 * when one is missing (a mode other than `auto` is then refused at spawn), `skipped` for a development host.
	 */
	ping: { args: Record<string, never>; result: { pid: number; version: string; root: string; startedAt: number; api: 1; omp?: OmpIntegrationStatus; dashboard?: { port: number; listening: boolean; error?: string } } };
	plan: { args: { lane?: string; all?: boolean }; result: PlanView };
	edit: { args: { ops: PlanOp[]; rev?: number }; result: { rev: number; refs: Record<string, string> } };
	getQueue: { args: { id: string }; result: QueueView };
	queue: { args: { id: string; ops: QueueOp[] }; result: QueueView };
	/**
	 * Propagates now and answers when it is done: commits the task's worktree, merges its branch into its
	 * children's, and (with `rerun`) runs it once more first with the upstream note. `id`: task id or AO session id.
	 */
	sync: { args: { id: string; rerun?: boolean }; result: { task: string; rerun: boolean; edges: EdgeView[] } };
	/** `clearLimits`: forget the provider limits learned from failed turns (`true`: all, or the named providers); held work may start again. */
	scheduler: { args: { set?: Partial<PlannerConfig>; clearLimits?: true | string[] }; result: PlannerStatus };
	status: { args: Record<string, never>; result: PlannerStatus };
	shutdown: { args: Record<string, never>; result: Record<string, never> };
}

export type PlannerOpName = keyof PlannerOps;

export interface PlannerRequest {
	id: number;
	op: PlannerOpName | "subscribe";
	args?: unknown;
}

export type PlannerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** One step of graph propagation: `child`'s edge to `parent` moved from `from` (absent: new edge) to `to`. */
export interface SyncChange {
	child: string;
	parent: string;
	from?: EdgeSync["state"];
	to: EdgeSync["state"];
	edge: EdgeSync;
}

export type PlannerEvent =
	| { id: number; event: "plan"; plan: PlanView }
	| { id: number; event: "task"; task: TaskView; from: TaskStatus }
	| ({ id: number; event: "sync" } & SyncChange);
