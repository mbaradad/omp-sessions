// The plan engine: validation, edits, readiness, dispatch choice and run outcomes, all pure functions
// over PlanState (no I/O, no clocks: `now` is passed in). The service (service.ts) persists the state
// and talks to AO; everything that decides *what* runs lives here and is unit-tested.
//
// Ported from the old per-session engine: queue ops and task options (src/shared/queue.ts), the
// runner's outcome rules (src/host/queue-runner.ts), launch ranking (src/shared/control.ts
// planLaunches + organize.ts schedulingOrder), dependency checks (omp/deps deps.ts) and requeue
// (omp/requeue requeueOps).
import * as crypto from "node:crypto";
import { type Hold, type TurnError, type UsageContext, holdFor, isLimitError, normalizeBudget, providerOf, recordLimit } from "./usage";
import { nextOccurrence, normalizeRule } from "./when";
import {
	APPROVAL_MODES,
	type EdgeSync,
	type Lane,
	type LaneView,
	type PlanOp,
	type PlanState,
	type PlannerConfig,
	PRIORITIES,
	type Priority,
	type Recurring,
	type Subtask,
	type Task,
	type TaskInput,
	type TaskOptions,
	type TaskRun,
	type TaskState,
	type TaskStatus,
	type TaskView,
	THINKING_LEVELS,
} from "./types";

export const MAX_TITLE = 500;
export const MAX_NOTES = 20_000;
export const MAX_SUMMARY = 4000;
const MAX_TASKS = 5000;
const MAX_SUBTASKS = 200;
const MAX_AFTER = 50;
export const MAX_RETRIES = 10;
export const MAX_TIMEOUT_MINUTES = 24 * 60;
export const MAX_CONCURRENT = 64;
const EDGE_STATES: ReadonlyArray<EdgeSync["state"]> = ["in-sync", "pending", "merged", "upstream-changed", "resolving", "conflict"];
/** Planner-dispatched turns run under these defaults unless a task, lane or config says otherwise. */
export const DEFAULT_CONFIG: PlannerConfig = { maxConcurrent: 2, paused: false, usage: { holdAtPercent: 95, spareBelowPercent: 60 } };

/** A rejected edit: the message goes back to the client as is. */
export class PlanError extends Error {}

function fail(message: string): never {
	throw new PlanError(message);
}

export function newId(prefix = ""): string {
	return prefix + crypto.randomBytes(5).toString("hex");
}

function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function finite(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function cleanTitle(v: unknown): string {
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
}

function cleanNotes(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.slice(0, MAX_NOTES) : undefined;
}

export function isPriority(v: unknown): v is Priority {
	return typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);
}

export function priorityIndex(p: Priority | undefined): number {
	return PRIORITIES.indexOf(p ?? "normal");
}

/** Lane ids the planner makes; anything else names an AO session (a session lane). */
export function isPlannerLaneId(id: string): boolean {
	return /^l_[0-9a-f]{10}$/.test(id);
}

/** Validated task options; undefined when nothing is set. */
export function normalizeOptions(raw: unknown): TaskOptions | undefined {
	const r = rec(raw);
	if (!r) return undefined;
	const out: TaskOptions = {};
	const model = typeof r.model === "string" ? r.model.trim() : "";
	if (/^[^/\s]+\/\S+$/.test(model)) out.model = model;
	// Old queues and clients say `minimal`; omp's lowest named level above off is `low`.
	const thinking = r.thinking === "minimal" ? "low" : r.thinking;
	if (typeof thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(thinking)) out.thinking = thinking;
	if (r.freshContext === true) out.freshContext = true;
	const retries = finite(r.retries);
	if (retries !== undefined && retries >= 1) out.retries = Math.min(MAX_RETRIES, Math.trunc(retries));
	const timeout = finite(r.timeoutMinutes);
	if (timeout !== undefined && timeout > 0) out.timeoutMinutes = Math.min(MAX_TIMEOUT_MINUTES, timeout);
	if (typeof r.cwd === "string" && r.cwd.trim()) out.cwd = r.cwd.trim();
	if (typeof r.project === "string" && r.project.trim()) out.project = r.project.trim();
	if (r.worktree === "auto" || r.worktree === "always" || r.worktree === "never") out.worktree = r.worktree;
	if (typeof r.approvalMode === "string" && (APPROVAL_MODES as readonly string[]).includes(r.approvalMode)) out.approvalMode = r.approvalMode as TaskOptions["approvalMode"];
	return Object.keys(out).length ? out : undefined;
}

function normalizeSubtasks(raw: unknown, keepIds: boolean): Subtask[] {
	const seen = new Set<string>();
	const out: Subtask[] = [];
	for (const v of Array.isArray(raw) ? raw : []) {
		const r = rec(v);
		const title = cleanTitle(r ? r.title : v);
		if (!title) continue;
		let id = keepIds && typeof r?.id === "string" && r.id ? r.id : newId();
		if (seen.has(id)) id = newId();
		seen.add(id);
		out.push({ id, title, done: r?.done === true });
		if (out.length >= MAX_SUBTASKS) break;
	}
	return out;
}

function normalizeIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const v of raw) if (typeof v === "string" && v.trim() && !out.includes(v.trim())) out.push(v.trim());
	return out.slice(0, MAX_AFTER);
}

export function normalizeConfig(raw: unknown, base: PlannerConfig = DEFAULT_CONFIG): PlannerConfig {
	const r = rec(raw) ?? {};
	const max = finite(r.maxConcurrent);
	const usage = rec(r.usage) ?? {};
	const pct = (v: unknown, d: number) => {
		const n = finite(v);
		return n !== undefined && n > 0 && n <= 100 ? n : d;
	};
	const out: PlannerConfig = {
		maxConcurrent: max !== undefined && max >= 0 ? Math.min(MAX_CONCURRENT, Math.trunc(max)) : base.maxConcurrent,
		paused: typeof r.paused === "boolean" ? r.paused : base.paused,
		usage: { holdAtPercent: pct(usage.holdAtPercent, base.usage.holdAtPercent), spareBelowPercent: pct(usage.spareBelowPercent, base.usage.spareBelowPercent) },
	};
	const budget = "budget" in r ? normalizeBudget(r.budget) : base.budget;
	if (budget) out.budget = budget;
	const defaults = "defaults" in r ? normalizeOptions(r.defaults) : base.defaults;
	if (defaults) out.defaults = defaults;
	return out;
}

export function emptyState(): PlanState {
	return { version: 1, rev: 0, tasks: [], lanes: [], recurring: [], config: structuredClone(DEFAULT_CONFIG), limits: {}, spend: [] };
}

const STATUSES: Record<TaskStatus, true> = { pending: true, running: true, done: true, failed: true, skipped: true };

/** A dispatch record from disk; undefined when it is unusable (the run can't be followed). */
function normalizeRun(raw: unknown): TaskRun | undefined {
	const r = rec(raw);
	if (!r || typeof r.key !== "string" || typeof r.prompt !== "string" || (r.phase !== "dispatching" && r.phase !== "sent") || (r.via !== "spawn" && r.via !== "send")) return undefined;
	const run: TaskRun = { key: r.key, phase: r.phase, via: r.via, prompt: r.prompt, at: finite(r.at) ?? 0 };
	if (typeof r.session === "string") run.session = r.session;
	if (typeof r.turn === "string") run.turn = r.turn;
	if (typeof r.provider === "string") run.provider = r.provider;
	const spawn = rec(r.spawn);
	if (spawn) run.spawn = spawn;
	if (typeof r.repo === "string") run.repo = r.repo;
	for (const k of ["settings", "restore"] as const) {
		const v = rec(r[k]);
		if (!v) continue;
		run[k] = {};
		if (typeof v.model === "string") run[k].model = v.model;
		if (typeof v.thinking === "string") run[k].thinking = v.thinking;
	}
	const baseCost = finite(r.baseCost);
	if (baseCost !== undefined) run.baseCost = baseCost;
	const tries = finite(r.tries);
	if (tries) run.tries = tries;
	if (r.timedOut === true) run.timedOut = true;
	if (r.aborted === true) run.aborted = true;
	// A dispatch needs its session or its spawn body to be replayed.
	if (run.via === "spawn" && !run.spawn && !run.session) return undefined;
	if (run.via === "send" && !run.session) return undefined;
	return run;
}

/** Anything read from disk → a well-formed state (unknown fields dropped, broken entries skipped). */
export function normalizeState(raw: unknown): PlanState {
	const r = rec(raw);
	const s = emptyState();
	if (!r) return s;
	s.rev = finite(r.rev) ?? 0;
	s.config = normalizeConfig(r.config);
	const seen = new Set<string>();
	for (const l of Array.isArray(r.lanes) ? r.lanes : []) {
		const lr = rec(l);
		if (!lr || typeof lr.id !== "string" || !lr.id || seen.has(lr.id)) continue;
		seen.add(lr.id);
		const lane: Lane = { id: lr.id, autoRun: lr.autoRun === true, createdAt: finite(lr.createdAt) ?? 0 };
		if (typeof lr.title === "string" && lr.title) lane.title = cleanTitle(lr.title);
		if (typeof lr.session === "string" && lr.session) lane.session = lr.session;
		const startAt = finite(lr.startAt);
		if (startAt && startAt > 0) lane.startAt = startAt;
		if (isPriority(lr.priority) && lr.priority !== "normal") lane.priority = lr.priority;
		const defaults = normalizeOptions(lr.defaults);
		if (defaults) lane.defaults = defaults;
		if (lr.completed === true) Object.assign(lane, { completed: true, completedAt: finite(lr.completedAt) ?? 0 });
		s.lanes.push(lane);
	}
	const lanes = new Set(s.lanes.map(l => l.id));
	seen.clear();
	for (const t of Array.isArray(r.tasks) ? r.tasks : []) {
		const tr = rec(t);
		const title = cleanTitle(tr?.title);
		if (!tr || !title || typeof tr.id !== "string" || !tr.id || seen.has(tr.id)) continue;
		seen.add(tr.id);
		const status = typeof tr.status === "string" && tr.status in STATUSES ? (tr.status as TaskStatus) : "pending";
		const task: Task = { id: tr.id, title, subtasks: normalizeSubtasks(tr.subtasks, true), status, createdAt: finite(tr.createdAt) ?? 0 };
		const notes = cleanNotes(tr.notes);
		if (notes) task.notes = notes;
		for (const k of ["startedAt", "finishedAt", "attempts", "durationMs", "cost", "interrupted", "startAt", "holdUntil"] as const) {
			const n = finite(tr[k]);
			if (n !== undefined && n >= 0) task[k] = n;
		}
		if (typeof tr.summary === "string") task.summary = tr.summary.slice(0, MAX_SUMMARY);
		const options = normalizeOptions(tr.options);
		if (options) task.options = options;
		if (typeof tr.lane === "string" && lanes.has(tr.lane)) task.lane = tr.lane;
		const after = normalizeIds(tr.after);
		if (after.length) task.after = after;
		if (tr.inputs === "none") task.inputs = "none";
		if (isPriority(tr.priority)) task.priority = tr.priority;
		if (tr.usage === "spare") task.usage = "spare";
		if (tr.paused === true) task.paused = true;
		if (typeof tr.session === "string" && tr.session) task.session = tr.session;
		if (typeof tr.recur === "string" && tr.recur) task.recur = tr.recur;
		if (typeof tr.turn === "string" && tr.turn) task.turn = tr.turn;
		if (typeof tr.followUp === "string" && tr.followUp) task.followUp = tr.followUp.slice(0, MAX_NOTES);
		if (tr.followUpOnly === true && task.followUp) task.followUpOnly = true;
		const git = rec(tr.git);
		if (git && typeof git.repo === "string" && typeof git.branch === "string") {
			task.git = { repo: git.repo, branch: git.branch };
			if (typeof git.worktree === "string") task.git.worktree = git.worktree;
			if (typeof git.head === "string") task.git.head = git.head;
		}
		const sync = rec(tr.sync);
		if (sync) {
			task.sync = {};
			for (const [parent, raw] of Object.entries(sync)) {
				const e = rec(raw);
				if (!e || typeof e.state !== "string" || !EDGE_STATES.includes(e.state as EdgeSync["state"])) continue;
				const edge: EdgeSync = { state: e.state as EdgeSync["state"], at: finite(e.at) ?? 0 };
				for (const k of ["head", "pendingHead", "before", "after"] as const) if (typeof e[k] === "string") edge[k] = e[k] as string;
				if (e.prompt === true) edge.prompt = true;
				if (Array.isArray(e.files)) edge.files = e.files.filter((f): f is string => typeof f === "string");
				task.sync[parent] = edge;
			}
		}
		const run = status === "running" ? normalizeRun(tr.run) : undefined;
		if (run) task.run = run;
		else if (status === "running") {
			// Running without a dispatch record can't be followed: it was cut short.
			Object.assign(task, { status: "pending", interrupted: finite(tr.startedAt) ?? 1, summary: "Interrupted: the planner lost track of this run. Run it again to restart it." });
		}
		s.tasks.push(task);
	}
	for (const x of Array.isArray(r.recurring) ? r.recurring : []) {
		const xr = rec(x);
		const rule = normalizeRule(xr?.rule);
		const input = rec(xr?.task);
		if (!xr || typeof xr.id !== "string" || typeof rule === "string" || !input || !cleanTitle(input.title)) continue;
		const item: Recurring = { id: xr.id, enabled: xr.enabled !== false, rule, task: input as unknown as TaskInput, nextAt: finite(xr.nextAt) ?? 0, createdAt: finite(xr.createdAt) ?? 0 };
		if (typeof xr.title === "string" && xr.title) item.title = cleanTitle(xr.title);
		if (typeof xr.lane === "string" && lanes.has(xr.lane)) item.lane = xr.lane;
		const last = finite(xr.lastAt);
		if (last) item.lastAt = last;
		if (xr.skipIfRunning === false) item.skipIfRunning = false;
		s.recurring.push(item);
	}
	for (const [k, v] of Object.entries(rec(r.limits) ?? {})) {
		const l = rec(v);
		if (l && finite(l.until) !== undefined) s.limits[k] = { provider: k, until: l.until as number, since: finite(l.since) ?? (l.until as number), failures: finite(l.failures) ?? 1, reason: typeof l.reason === "string" ? l.reason : "", ...(typeof l.model === "string" ? { model: l.model } : {}), ...(l.guessed === true ? { guessed: true } : {}) };
	}
	if (Array.isArray(r.spend)) for (const e of r.spend) if (Array.isArray(e) && finite(e[0]) !== undefined && finite(e[1]) !== undefined) s.spend.push([e[0], e[1]]);
	return s;
}

// ---------- lookups ----------

export function laneOf(state: PlanState, task: Task): Lane | undefined {
	return task.lane ? state.lanes.find(l => l.id === task.lane) : undefined;
}

/** Options a run uses: config defaults < lane defaults < the task's own. */
export function effectiveOptions(state: PlanState, task: Task): TaskOptions {
	return { ...state.config.defaults, ...laneOf(state, task)?.defaults, ...task.options };
}

export function effectivePriority(state: PlanState, task: Task): Priority {
	return task.priority ?? laneOf(state, task)?.priority ?? "normal";
}

/**
 * A dependency counts as finished when it is done or skipped (a missing one never does). A done task
 * in git counts once its work is committed: children branch from that commit.
 */
function resolved(byId: Map<string, Task>, id: string): boolean {
	const t = byId.get(id);
	return !!t && (t.status === "skipped" || (t.status === "done" && (!t.git || !!t.git.head)));
}

/** The AO session a run continues: the lane's, else the task's own from an earlier run; none with fresh context. */
export function targetSession(s: PlanState, t: Task): string | undefined {
	return effectiveOptions(s, t).freshContext ? undefined : (laneOf(s, t)?.session ?? t.session);
}

/**
 * Why `id` can't wait for `after` (ported from omp/deps `afterError`): itself, an unknown task, or a
 * cycle, named as a path.
 */
export function afterError(id: string, after: readonly string[], exists: (id: string) => boolean, graph: (id: string) => readonly string[] | undefined, label: (id: string) => string = s => s): string | undefined {
	for (const dep of after) {
		if (dep === id) return "a task can't wait for itself";
		if (!exists(dep)) return `unknown task ${dep}`;
	}
	const via = new Map<string, string | undefined>(after.map(d => [d, undefined]));
	const todo = [...after];
	while (todo.length) {
		const cur = todo.shift() as string;
		for (const next of graph(cur) ?? []) {
			if (next === id) {
				const chain = [cur];
				for (let p = via.get(cur); p !== undefined; p = via.get(p)) chain.unshift(p);
				return `that would be a cycle: ${[id, ...chain, id].map(label).join(" → ")} (each waits for the next)`;
			}
			if (via.has(next)) continue;
			via.set(next, cur);
			todo.push(next);
		}
	}
	return undefined;
}

// ---------- edits ----------

/** Side effects an edit asks the service to carry out in AO. */
export type Effect = { kind: "interrupt"; task: string; session: string } | { kind: "sync"; task: string };

export interface EditResult {
	state: PlanState;
	refs: Record<string, string>;
	effects: Effect[];
}

/** Clears the outcome of a previous run so the task runs again from scratch. */
function resetRun(t: Task): void {
	delete t.startedAt;
	delete t.finishedAt;
	delete t.summary;
	delete t.attempts;
	delete t.durationMs;
	delete t.cost;
	delete t.interrupted;
	delete t.holdUntil;
	delete t.run;
	delete t.followUpOnly;
}

/** Positions of `lane`'s tasks (or of free tasks) in the plan array. */
function memberIndexes(state: PlanState, lane: string | undefined): number[] {
	const out: number[] = [];
	state.tasks.forEach((t, i) => {
		if (t.lane === lane) out.push(i);
	});
	return out;
}

/** Inserts `task` at position `index` among its lane's tasks (clamped; default last). */
function insertAt(state: PlanState, task: Task, index: number | undefined): void {
	const members = memberIndexes(state, task.lane);
	const i = index === undefined || !Number.isFinite(index) ? members.length : Math.max(0, Math.min(members.length, Math.trunc(index)));
	const at = i < members.length ? members[i] : members.length ? members[members.length - 1] + 1 : state.tasks.length;
	state.tasks.splice(at, 0, task);
}

/** First task of the lane that is pending or running. */
function laneHead(state: PlanState, lane: string): Task | undefined {
	return state.tasks.find(t => t.lane === lane && (t.status === "pending" || t.status === "running"));
}

function ensureLane(state: PlanState, id: string, now: number): Lane {
	let lane = state.lanes.find(l => l.id === id);
	if (lane) return lane;
	if (!isPlannerLaneId(id) && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) fail(`not a lane or session id: ${id}`);
	lane = { id, autoRun: true, createdAt: now };
	// A lane named after an AO session continues that session.
	if (!isPlannerLaneId(id)) lane.session = id;
	state.lanes.push(lane);
	return lane;
}

function makeTask(state: PlanState, input: TaskInput, now: number, refs: Record<string, string>): Task {
	const i = rec(input);
	if (!i) fail("add needs a task");
	const title = cleanTitle(i.title);
	if (!title) fail("a task needs a title");
	if (state.tasks.length >= MAX_TASKS) fail(`the plan is full (${MAX_TASKS} tasks); remove finished ones`);
	const task: Task = { id: newId(), title, subtasks: normalizeSubtasks(i.subtasks, false), status: "pending", createdAt: now };
	const notes = cleanNotes(i.notes);
	if (notes) task.notes = notes;
	if (typeof i.lane === "string" && i.lane) task.lane = ensureLane(state, refs[i.lane.replace(/^@/, "")] && i.lane.startsWith("@") ? refs[i.lane.slice(1)] : i.lane, now).id;
	if (i.inputs === "none") task.inputs = "none";
	if (isPriority(i.priority)) task.priority = i.priority;
	const startAt = finite(i.startAt);
	if (startAt && startAt > now) task.startAt = startAt;
	if (i.usage === "spare") task.usage = "spare";
	if (i.paused === true) task.paused = true;
	const options = normalizeOptions(i.options);
	if (options) task.options = options;
	if (i.done === true) Object.assign(task, { status: "done", finishedAt: now });
	return task;
}

function resolveRefs(ids: string[], refs: Record<string, string>): string[] {
	return ids.map(id => {
		if (!id.startsWith("@")) return id;
		const r = refs[id.slice(1)];
		if (!r) fail(`unknown ref ${id} (refs name tasks added earlier in the same edit)`);
		return r;
	});
}

function setAfter(state: PlanState, task: Task, ids: string[]): void {
	const byId = new Map(state.tasks.map(t => [t.id, t]));
	const err = afterError(
		task.id,
		ids,
		id => byId.has(id),
		id => byId.get(id)?.after,
		id => `"${byId.get(id)?.title.slice(0, 40) ?? id}"`,
	);
	if (err) fail(err);
	if (ids.length) task.after = ids;
	else delete task.after;
}

/**
 * Applies `ops` atomically: the returned state is a modified copy; the first invalid op throws
 * PlanError and nothing changes. `rev` is bumped by the caller when it persists.
 */
export function applyOps(state: PlanState, ops: readonly PlanOp[], now: number): EditResult {
	const s = structuredClone(state);
	const refs: Record<string, string> = {};
	const effects: Effect[] = [];
	if (!Array.isArray(ops)) fail("ops must be a list");
	const task = (id: unknown): Task => {
		const key = typeof id === "string" && id.startsWith("@") ? refs[id.slice(1)] : id;
		const t = s.tasks.find(x => x.id === key);
		if (!t) fail(`unknown task ${String(id)}`);
		return t;
	};
	const lane = (id: unknown): Lane => {
		const key = typeof id === "string" && id.startsWith("@") ? refs[id.slice(1)] : id;
		const l = s.lanes.find(x => x.id === key);
		if (!l) fail(`unknown lane ${String(id)}`);
		return l;
	};
	const recurring = (id: unknown): Recurring => {
		const r = s.recurring.find(x => x.id === id);
		if (!r) fail(`unknown recurring schedule ${String(id)}`);
		return r;
	};
	const notRunning = (t: Task, what: string) => {
		if (t.status === "running") fail(`"${t.title}" is running; abort it before you ${what} it`);
	};
	for (const raw of ops) {
		const o = rec(raw) as (PlanOp & Record<string, unknown>) | undefined;
		if (!o) fail("an op must be an object");
		const opName: unknown = o.op;
		switch (o.op) {
			case "add": {
				const t = makeTask(s, o.task, now, refs);
				insertAt(s, t, finite(o.index));
				if (o.task.after) setAfter(s, t, resolveRefs(normalizeIds(o.task.after), refs));
				if (typeof o.ref === "string" && o.ref) refs[o.ref] = t.id;
				break;
			}
			case "update": {
				const t = task(o.id);
				const title = cleanTitle(o.title);
				if (title) t.title = title;
				if (typeof o.notes === "string") {
					const notes = cleanNotes(o.notes);
					if (notes) t.notes = notes;
					else delete t.notes;
				}
				if (o.priority === null) delete t.priority;
				else if (isPriority(o.priority)) t.priority = o.priority;
				const running = t.status === "running";
				if ((o.startAt !== undefined || o.usage !== undefined || o.inputs !== undefined || o.options !== undefined || o.lane !== undefined) && running) fail(`"${t.title}" is running; only its title, notes and priority can change`);
				if (o.startAt === null) delete t.startAt;
				else if (finite(o.startAt) !== undefined) t.startAt = o.startAt as number;
				if (o.usage === "spare") t.usage = "spare";
				else if (o.usage === "normal") delete t.usage;
				if (o.inputs === "none") t.inputs = "none";
				else if (o.inputs === "results") delete t.inputs;
				if (o.options === null) delete t.options;
				else if (o.options !== undefined) {
					const options = normalizeOptions(o.options);
					if (options) t.options = options;
					else delete t.options;
				}
				if (o.lane !== undefined) {
					const target = o.lane === null ? undefined : ensureLane(s, o.lane, now).id;
					if (target !== t.lane) {
						s.tasks.splice(s.tasks.indexOf(t), 1);
						if (target) t.lane = target;
						else delete t.lane;
						insertAt(s, t, undefined);
					}
				}
				break;
			}
			case "remove": {
				const t = task(o.id);
				notRunning(t, "remove");
				s.tasks.splice(s.tasks.indexOf(t), 1);
				break;
			}
			case "move": {
				const t = task(o.id);
				s.tasks.splice(s.tasks.indexOf(t), 1);
				insertAt(s, t, finite(o.index) ?? 0);
				break;
			}
			case "after":
				setAfter(s, task(o.id), resolveRefs(normalizeIds(o.ids), refs));
				break;
			case "run": {
				const t = task(o.id);
				if (t.status !== "running") {
					if (t.status !== "pending") t.status = "pending";
					resetRun(t);
					delete t.paused;
					delete t.startAt;
					if (t.lane) {
						// First among the lane's open work.
						s.tasks.splice(s.tasks.indexOf(t), 1);
						const head = laneHead(s, t.lane);
						s.tasks.splice(head ? s.tasks.indexOf(head) : s.tasks.length, 0, t);
						const l = lane(t.lane);
						l.autoRun = true;
						delete l.startAt;
						delete l.completed;
						delete l.completedAt;
					}
				}
				break;
			}
			case "requeue": {
				const t = task(o.id);
				notRunning(t, "requeue");
				t.status = "pending";
				resetRun(t);
				delete t.paused;
				const l = laneOf(s, t);
				if (l && !l.startAt) l.autoRun = true;
				break;
			}
			case "pause":
				task(o.id).paused = true;
				break;
			case "resume": {
				const t = task(o.id);
				delete t.paused;
				break;
			}
			case "abort": {
				const t = task(o.id);
				if (t.status !== "running" || !t.run) fail(`"${t.title}" is not running`);
				t.run.aborted = true;
				if (t.run.session) effects.push({ kind: "interrupt", task: t.id, session: t.run.session });
				break;
			}
			case "done":
			case "skip": {
				const t = task(o.id);
				notRunning(t, o.op === "done" ? "mark done" : "skip");
				t.status = o.op === "done" ? "done" : "skipped";
				t.finishedAt = now;
				delete t.interrupted;
				delete t.holdUntil;
				if (o.op === "done") for (const st of t.subtasks) st.done = true;
				break;
			}
			case "duplicate": {
				const src = task(o.id);
				const copy: Task = { id: newId(), title: src.title, subtasks: src.subtasks.map(st => ({ id: newId(), title: st.title, done: false })), status: "pending", createdAt: now };
				if (src.notes) copy.notes = src.notes;
				if (src.lane) copy.lane = src.lane;
				if (src.inputs) copy.inputs = src.inputs;
				if (src.priority) copy.priority = src.priority;
				if (src.usage) copy.usage = src.usage;
				if (src.after) copy.after = [...src.after];
				if (src.options) copy.options = { ...src.options };
				s.tasks.splice(s.tasks.indexOf(src) + 1, 0, copy);
				break;
			}
			case "addSubtask": {
				const t = task(o.id);
				const title = cleanTitle(o.title);
				if (!title) fail("a subtask needs a title");
				if (t.subtasks.length < MAX_SUBTASKS) t.subtasks.push({ id: newId(), title, done: false });
				break;
			}
			case "updateSubtask": {
				const st = task(o.id).subtasks.find(x => x.id === o.subtaskId);
				if (!st) fail(`unknown subtask ${String(o.subtaskId)}`);
				const title = cleanTitle(o.title);
				if (title) st.title = title;
				if (typeof o.done === "boolean") st.done = o.done;
				break;
			}
			case "removeSubtask": {
				const t = task(o.id);
				t.subtasks = t.subtasks.filter(x => x.id !== o.subtaskId);
				break;
			}
			case "moveSubtask": {
				const t = task(o.id);
				const i = t.subtasks.findIndex(x => x.id === o.subtaskId);
				if (i < 0) fail(`unknown subtask ${String(o.subtaskId)}`);
				const [st] = t.subtasks.splice(i, 1);
				t.subtasks.splice(Math.max(0, Math.min(t.subtasks.length, Math.trunc(finite(o.index) ?? 0))), 0, st);
				break;
			}
			case "lane.add": {
				const id = typeof o.id === "string" && o.id ? o.id : newId("l_");
				if (s.lanes.some(l => l.id === id)) fail(`lane ${id} exists`);
				const l = ensureLane(s, id, now);
				if (o.autoRun === false) l.autoRun = false;
				const title = cleanTitle(o.title);
				if (title) l.title = title;
				if (typeof o.session === "string" && o.session) l.session = o.session;
				if (isPriority(o.priority) && o.priority !== "normal") l.priority = o.priority;
				const defaults = normalizeOptions(o.defaults);
				if (defaults) l.defaults = defaults;
				if (typeof o.ref === "string" && o.ref) refs[o.ref] = l.id;
				break;
			}
			case "lane.update": {
				const l = lane(o.id);
				const title = cleanTitle(o.title);
				if (title) l.title = title;
				if (o.priority === null || o.priority === "normal") delete l.priority;
				else if (isPriority(o.priority)) l.priority = o.priority;
				if (o.defaults === null) delete l.defaults;
				else if (o.defaults !== undefined) {
					const defaults = normalizeOptions(o.defaults);
					if (defaults) l.defaults = defaults;
					else delete l.defaults;
				}
				break;
			}
			case "lane.remove": {
				const l = lane(o.id);
				const running = s.tasks.find(t => t.lane === l.id && t.status === "running");
				if (running) fail(`"${running.title}" is running in that lane; abort it first`);
				s.tasks = s.tasks.filter(t => t.lane !== l.id);
				s.lanes = s.lanes.filter(x => x !== l);
				for (const r of s.recurring) if (r.lane === l.id) delete r.lane;
				break;
			}
			case "lane.pause": {
				const l = lane(o.id);
				l.autoRun = false;
				delete l.startAt;
				break;
			}
			case "lane.resume": {
				const l = lane(o.id);
				l.autoRun = true;
				delete l.startAt;
				break;
			}
			case "lane.startAt": {
				const l = lane(o.id);
				const at = finite(o.at);
				if (at !== undefined && at > 0) {
					// A scheduled start means "not now"; scheduling is a person restarting the lane.
					l.startAt = at;
					l.autoRun = false;
					for (const t of s.tasks) if (t.lane === l.id && t.status === "pending" && t.interrupted) resetRun(t);
				} else if (o.at === null) delete l.startAt;
				else fail("lane.startAt needs at: epoch ms or null");
				break;
			}
			case "lane.requeue":
				requeueLane(s, lane(o.id));
				break;
			case "lane.retryFailed": {
				const l = lane(o.id);
				for (const t of s.tasks) {
					if (t.lane !== l.id || t.status !== "failed") continue;
					t.status = "pending";
					resetRun(t);
				}
				break;
			}
			case "lane.clearDone": {
				const l = lane(o.id);
				s.tasks = s.tasks.filter(t => t.lane !== l.id || (t.status !== "done" && t.status !== "skipped"));
				break;
			}
			case "lane.complete": {
				const l = lane(o.id);
				if (o.completed) Object.assign(l, { completed: true, completedAt: now });
				else {
					delete l.completed;
					delete l.completedAt;
				}
				break;
			}
			case "recur.add": {
				const x = rec(o.recurring);
				if (!x) fail("recur.add needs recurring");
				const rule = normalizeRule(x.rule);
				if (typeof rule === "string") fail(rule);
				const input = rec(x.task);
				if (!input || !cleanTitle(input.title)) fail("a recurring schedule needs a task with a title");
				const item: Recurring = { id: newId("r_"), enabled: x.enabled !== false, rule, task: structuredClone(input) as unknown as TaskInput, nextAt: nextOccurrence(rule, now, now), createdAt: now };
				const title = cleanTitle(x.title);
				if (title) item.title = title;
				if (typeof x.lane === "string" && x.lane) item.lane = ensureLane(s, x.lane, now).id;
				if (x.skipIfRunning === false) item.skipIfRunning = false;
				s.recurring.push(item);
				if (typeof o.ref === "string" && o.ref) refs[o.ref] = item.id;
				break;
			}
			case "recur.update": {
				const r = recurring(o.id);
				const title = cleanTitle(o.title);
				if (title) r.title = title;
				if (o.rule !== undefined) {
					const rule = normalizeRule(o.rule);
					if (typeof rule === "string") fail(rule);
					r.rule = rule;
					r.createdAt = now;
					r.nextAt = nextOccurrence(rule, now, now);
				}
				if (o.task !== undefined) {
					const input = rec(o.task);
					if (!input || !cleanTitle(input.title)) fail("a recurring schedule needs a task with a title");
					r.task = structuredClone(input) as unknown as TaskInput;
				}
				if (o.lane === null) delete r.lane;
				else if (typeof o.lane === "string") r.lane = ensureLane(s, o.lane, now).id;
				if (typeof o.skipIfRunning === "boolean") {
					if (o.skipIfRunning) delete r.skipIfRunning;
					else r.skipIfRunning = false;
				}
				if (typeof o.enabled === "boolean") {
					if (o.enabled && !r.enabled) r.nextAt = nextOccurrence(r.rule, now, r.createdAt);
					r.enabled = o.enabled;
				}
				break;
			}
			case "recur.remove": {
				const r = recurring(o.id);
				s.recurring = s.recurring.filter(x => x !== r);
				break;
			}
			case "sync":
				// Carried out by the service: re-check the task's branch and propagate to its children.
				effects.push({ kind: "sync", task: task(o.id).id });
				break;
			case "recur.fire":
				fireRecurring(s, recurring(o.id), now);
				break;
			default:
				fail(`unknown op ${String(opName)}`);
		}
	}
	return { state: s, refs, effects };
}

/**
 * "Requeue" a lane (omp/requeue requeueOps): failed tasks go back to pending; else a paused or
 * interrupted lane restarts; else the last finished task runs again. The lane is re-armed unless it
 * has a scheduled start.
 */
export function requeueLane(s: PlanState, l: Lane): void {
	const tasks = s.tasks.filter(t => t.lane === l.id);
	if (!tasks.length) return;
	const rearm = () => {
		if (!l.startAt) l.autoRun = true;
	};
	const failed = tasks.filter(t => t.status === "failed");
	if (failed.length) {
		for (const t of failed) {
			t.status = "pending";
			resetRun(t);
		}
		rearm();
		return;
	}
	const pending = tasks.filter(t => t.status === "pending");
	if (pending.length) {
		for (const t of pending) if (t.interrupted) resetRun(t);
		rearm();
		return;
	}
	if (tasks.some(t => t.status === "running")) return;
	const last = tasks[tasks.length - 1];
	last.status = "pending";
	resetRun(last);
	rearm();
}

/** Adds a copy of the schedule's task now (unless the previous copy is still open and skipIfRunning). */
export function fireRecurring(s: PlanState, r: Recurring, now: number): Task | undefined {
	r.lastAt = now;
	if (r.skipIfRunning !== false && s.tasks.some(t => t.recur === r.id && (t.status === "pending" || t.status === "running"))) return undefined;
	const input = { ...r.task, lane: r.lane ?? r.task.lane, after: undefined, startAt: undefined };
	const t = makeTask(s, input, now, {});
	t.recur = r.id;
	insertAt(s, t, undefined);
	return t;
}

// ---------- time passing ----------

/**
 * What time alone changes (mutates): lanes whose scheduled start passed arm themselves, recurring
 * schedules that came due add a task (one copy however many occurrences were missed). Returns true
 * when something changed.
 */
export function advance(s: PlanState, now: number): boolean {
	let changed = false;
	for (const l of s.lanes) {
		if (l.startAt && l.startAt <= now) {
			l.autoRun = true;
			delete l.startAt;
			changed = true;
		}
	}
	for (const r of s.recurring) {
		if (!r.enabled || r.nextAt > now) continue;
		fireRecurring(s, r, now);
		r.nextAt = nextOccurrence(r.rule, now, r.createdAt);
		changed = true;
	}
	return changed;
}

/** The earliest future moment `advance` or readiness would change on its own (timer target). */
export function nextWake(s: PlanState, now: number, holds: Iterable<number | undefined> = []): number | undefined {
	let best: number | undefined;
	const take = (at: number | undefined) => {
		if (at !== undefined && at > now && (best === undefined || at < best)) best = at;
	};
	for (const l of s.lanes) take(l.startAt);
	for (const r of s.recurring) if (r.enabled) take(r.nextAt);
	for (const t of s.tasks) {
		if (t.status !== "pending") continue;
		take(t.startAt);
		take(t.holdUntil);
	}
	for (const at of holds) take(at);
	return best;
}

// ---------- readiness ----------

export interface ReadinessContext {
	now: number;
	/** AO sessions with a turn in progress that the planner didn't start (a person chatting). */
	busySessions: ReadonlySet<string>;
	usage: UsageContext;
}

export interface Evaluation {
	views: TaskView[];
	/** Tasks to dispatch now, in start order (slots already accounted for). */
	dispatch: Task[];
	/** Holds in force (for wake-up timers). */
	holdUntil: number[];
}

function view(t: Task, state: TaskState, extra: Partial<TaskView> = {}): TaskView {
	const { run: _run, holdUntil: _hold, ...rest } = t;
	return { ...rest, state, ...extra };
}

/**
 * The state of every task and which ones start now. Readiness: pending, not paused or interrupted,
 * every dependency done/skipped, start time passed, lane armed and the task at its head, session
 * idle, usage gate open. Ready tasks are ranked by priority, then plan order, and the first free
 * slots' worth start.
 */
export function evaluate(s: PlanState, ctx: ReadinessContext): Evaluation {
	const { now } = ctx;
	const byId = new Map(s.tasks.map(t => [t.id, t]));
	const lanes = new Map(s.lanes.map(l => [l.id, l]));
	const children = new Map<string, string[]>();
	for (const t of s.tasks) for (const p of t.after ?? []) children.set(p, [...(children.get(p) ?? []), t.id]);
	const running = s.tasks.filter(t => t.status === "running");
	const busyLanes = new Set(running.map(t => t.lane).filter((l): l is string => !!l));
	const busySessions = new Set([...ctx.busySessions, ...running.map(t => t.run?.session ?? t.session).filter((x): x is string => !!x)]);
	const views = new Map<string, TaskView>();
	const ready: Task[] = [];
	/** children of ready tasks (they have no unfinished dependencies). */
	const readyExtra = new Map<string, Partial<TaskView>>();
	const holdUntil: number[] = [];
	const heads = new Map<string, Task | undefined>();
	const headOf = (lane: string) => {
		if (!heads.has(lane)) heads.set(lane, laneHead(s, lane));
		return heads.get(lane);
	};
	for (const t of s.tasks) {
		const kids = children.get(t.id);
		const extra: Partial<TaskView> = kids ? { children: kids } : {};
		if (t.status !== "pending") {
			views.set(t.id, view(t, t.status, extra));
			continue;
		}
		const lane = t.lane ? lanes.get(t.lane) : undefined;
		const blockedBy = (t.after ?? []).filter(id => !resolved(byId, id));
		if (blockedBy.length) extra.blockedBy = blockedBy;
		const set = (state: TaskState, more: Partial<TaskView> = {}) => views.set(t.id, view(t, state, { ...extra, ...more }));
		if (t.interrupted) {
			set("interrupted", { waitReason: "interrupted: run or requeue it" });
			continue;
		}
		if (blockedBy.length) {
			const names = blockedBy.map(id => byId.get(id)?.title ?? `${id} (missing)`);
			const failed = blockedBy.some(id => byId.get(id)?.status === "failed");
			set("blocked", { waitReason: `${failed ? "a dependency failed: " : "waits for "}${names.join(", ")}` });
			continue;
		}
		if (t.paused) {
			set("paused", { waitReason: "paused" });
			continue;
		}
		if (lane && !lane.autoRun) {
			if (lane.startAt) set("scheduled", { waitUntil: lane.startAt, waitReason: "lane starts later" });
			else set("paused", { waitReason: "lane paused" });
			continue;
		}
		if (t.startAt && t.startAt > now) {
			set("scheduled", { waitUntil: t.startAt });
			continue;
		}
		if (s.config.paused) {
			set("paused", { waitReason: "planner paused" });
			continue;
		}
		if (lane) {
			const head = headOf(lane.id);
			if (head !== t) {
				set("waiting", { waitReason: head ? `behind "${head.title}" in its lane` : "lane busy" });
				continue;
			}
			if (busyLanes.has(lane.id)) {
				set("waiting", { waitReason: "lane busy" });
				continue;
			}
		}
		if (t.holdUntil && t.holdUntil > now) {
			holdUntil.push(t.holdUntil);
			set("held", { waitReason: "retry backoff", waitUntil: t.holdUntil });
			continue;
		}
		const opts = effectiveOptions(s, t);
		const hold: Hold | undefined = holdFor(providerOf(opts.model), t.usage === "spare", ctx.usage, now);
		if (hold) {
			if (hold.until) holdUntil.push(hold.until);
			set("held", { waitReason: hold.reason, ...(hold.until ? { waitUntil: hold.until } : {}) });
			continue;
		}
		const session = targetSession(s, t);
		if (session && busySessions.has(session)) {
			set("waiting", { waitReason: "its session is busy" });
			continue;
		}
		ready.push(t);
		readyExtra.set(t.id, extra);
	}
	// Rank: priority, then plan order (the array order is the manual order).
	const order = new Map(s.tasks.map((t, i) => [t.id, i]));
	ready.sort((a, b) => priorityIndex(effectivePriority(s, a)) - priorityIndex(effectivePriority(s, b)) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	const free = s.config.maxConcurrent === 0 ? Number.POSITIVE_INFINITY : Math.max(0, s.config.maxConcurrent - running.length);
	const dispatch: Task[] = [];
	const claimed = new Set<string>();
	let position = 0;
	for (const t of ready) {
		const session = targetSession(s, t);
		// Two lanes on one session: the second waits for the first.
		if (dispatch.length < free && !(session && claimed.has(session))) {
			dispatch.push(t);
			if (session) claimed.add(session);
			views.set(t.id, view(t, "waiting", { ...readyExtra.get(t.id), waitReason: "starting" }));
			continue;
		}
		position++;
		views.set(t.id, view(t, "waiting", { ...readyExtra.get(t.id), position, waitReason: s.config.maxConcurrent ? `waiting for a slot (${running.length}/${s.config.maxConcurrent} running)` : "waiting" }));
	}
	return { views: s.tasks.map(t => views.get(t.id) as TaskView), dispatch, holdUntil };
}

export function laneViews(s: PlanState, views: readonly TaskView[] = []): LaneView[] {
	return s.lanes.map(l => {
		const tasks = s.tasks.filter(t => t.lane === l.id);
		const count = (st: TaskStatus) => tasks.filter(t => t.status === st).length;
		const head = views.find(v => v.lane === l.id && (v.status === "pending" || v.status === "running"));
		return {
			...l,
			...(head ? { state: head.state, ...(head.waitReason ? { waitReason: head.waitReason } : {}), ...(head.waitUntil ? { waitUntil: head.waitUntil } : {}) } : {}),
			pending: count("pending"),
			running: count("running"),
			done: count("done"),
			failed: count("failed"),
			total: tasks.length,
		};
	});
}

// ---------- prompts ----------

/**
 * The prompt AO gets for a task: title, notes, subtasks and (by default) the parents' results. A
 * follow-up run (a finished task that must react to an upstream change) gets only the change, in the
 * session that already holds the work.
 */
export function taskPrompt(s: PlanState, task: Task): string {
	if (task.followUpOnly && task.followUp) return [`[Follow-up on your task] ${task.title}`, "", task.followUp, "", "Take this into account, fix whatever it breaks, and finish with a short summary of what you did."].join("\n");
	const lane = task.lane ? s.tasks.filter(t => t.lane === task.lane) : undefined;
	const lines = [lane ? `[Task ${lane.indexOf(task) + 1}/${lane.length} from the queue] ${task.title}` : `[Task from the plan] ${task.title}`];
	if (task.followUp) lines.push("", task.followUp);
	if (task.notes) lines.push("", task.notes);
	if (task.subtasks.length) {
		lines.push("", "Subtasks:");
		for (const st of task.subtasks) lines.push(`- [${st.done ? "x" : " "}] ${st.title}`);
	}
	if (task.inputs !== "none" && task.after?.length) {
		const parents = task.after.map(id => s.tasks.find(t => t.id === id)).filter((t): t is Task => !!t);
		if (parents.length) {
			lines.push("", "Results of the tasks this one depends on:");
			for (const p of parents) lines.push("", `### ${p.title}`, p.status === "skipped" ? "(skipped)" : p.summary?.trim() || "(no summary)");
		}
	}
	lines.push("", "Work through this task completely (track the subtasks with your todo tool), verify the result, and finish with a short summary of what you did.");
	return lines.join("\n");
}

// ---------- run lifecycle ----------

/** Marks `task` running with a dispatch record (written before the AO call). */
export function startRun(s: PlanState, id: string, run: Omit<TaskRun, "phase" | "at">, now: number): Task {
	const t = s.tasks.find(x => x.id === id);
	if (!t || t.status !== "pending") fail(`task ${id} is not pending`);
	if (!t.attempts) {
		delete t.durationMs;
		delete t.cost;
	}
	t.status = "running";
	t.startedAt = now;
	delete t.finishedAt;
	delete t.summary;
	delete t.interrupted;
	delete t.holdUntil;
	t.run = { ...run, phase: "dispatching", at: now };
	return t;
}

/** How a run ended, as the dispatcher saw it in AO. */
export type Outcome =
	| { kind: "completed"; summary?: string; cost?: number }
	| { kind: "error"; error: TurnError; cost?: number }
	/** The turn was interrupted (by our abort or timeout, or by someone in AO). */
	| { kind: "interrupted"; reason?: string; cost?: number }
	/** The planner can't know whether the prompt reached AO, or the session vanished mid-run. */
	| { kind: "lost"; reason: string; sessionGone?: boolean };

/** Wait before auto-retry number `attempt` (1-based): base, 2×, 4×… capped at 5 minutes. */
export function retryDelay(attempt: number, baseMs = 10_000): number {
	return Math.min(5 * 60_000, baseMs * 2 ** Math.max(0, attempt - 1));
}

/**
 * Applies a run's outcome (mutates). Completed → done. A limit error → pending again without using an
 * attempt, provider held. Another error or a timeout → retried with backoff while attempts remain,
 * else failed and the lane pauses. A person's abort → pending and paused. Anything else that cut the
 * run short → interrupted (never re-run unattended; the lane pauses).
 */
export function finishRun(s: PlanState, id: string, outcome: Outcome, now: number, retryBaseMs = 10_000): Task | undefined {
	const t = s.tasks.find(x => x.id === id);
	if (!t || t.status !== "running") return undefined;
	const run = t.run;
	delete t.run;
	const lane = laneOf(s, t);
	if (run?.turn) t.turn = run.turn;
	if (outcome.kind === "lost" && outcome.sessionGone) {
		// The session is gone for good: the next run starts a new one.
		if (lane && lane.session === (run?.session ?? t.session)) delete lane.session;
		delete t.session;
	} else if (run?.session) {
		t.session = run.session;
		// The lane continues where its last task ran.
		if (lane) lane.session = run.session;
	}
	t.finishedAt = now;
	t.durationMs = (t.durationMs ?? 0) + Math.max(0, now - (t.startedAt ?? now));
	const cost = "cost" in outcome ? outcome.cost : undefined;
	if (cost && cost > 0) {
		t.cost = (t.cost ?? 0) + cost;
		s.spend.push([now, cost]);
	}
	const backToPending = (summary: string) => {
		t.status = "pending";
		delete t.startedAt;
		delete t.finishedAt;
		t.summary = summary;
	};
	switch (outcome.kind) {
		case "completed":
			t.status = "done";
			for (const st of t.subtasks) st.done = true;
			if (outcome.summary) t.summary = outcome.summary.slice(0, MAX_SUMMARY);
			if (run?.provider) delete s.limits[run.provider];
			delete t.followUp;
			delete t.followUpOnly;
			return t;
		case "interrupted":
		case "lost": {
			if (outcome.kind === "interrupted" && run?.aborted) {
				backToPending("Aborted.");
				if (lane) lane.autoRun = false;
				else t.paused = true;
				return t;
			}
			if (outcome.kind === "interrupted" && !run?.timedOut) {
				backToPending(`Interrupted${outcome.reason ? `: ${outcome.reason}` : ""}. Run it again to restart it.`);
				t.interrupted = now;
				if (lane) lane.autoRun = false;
				return t;
			}
			if (outcome.kind === "lost") {
				backToPending(`Interrupted: ${outcome.reason} Run it again to restart it.`);
				t.interrupted = now;
				if (lane) lane.autoRun = false;
				return t;
			}
			break;
		}
		case "error":
			if (isLimitError(outcome.error, now)) {
				const provider = outcome.error.provider ?? run?.provider ?? providerOf(outcome.error.model);
				if (provider) {
					const limit = recordLimit(s.limits, outcome.error, provider, outcome.error.model, now);
					backToPending(`Held: ${provider} usage limit until ${new Date(limit.until).toISOString()} (${limit.reason}).`);
					return t;
				}
			}
			break;
	}
	// A failure (error or timeout): retry while attempts remain.
	const minutes = effectiveOptions(s, t).timeoutMinutes ?? 0;
	const reason = run?.timedOut ? `Timed out after ${minutes} min.` : outcome.kind === "error" ? outcome.error.message || "The model request failed." : "The turn was interrupted.";
	const attempts = (t.attempts ?? 0) + 1;
	const allowed = effectiveOptions(s, t).retries ?? 0;
	t.attempts = attempts;
	if (attempts <= allowed) {
		const delay = retryDelay(attempts, retryBaseMs);
		backToPending(`Attempt ${attempts} of ${allowed + 1} failed: ${reason} Retrying in ${Math.round(delay / 1000)}s.`);
		t.holdUntil = now + delay;
		return t;
	}
	t.status = "failed";
	t.summary = (allowed ? `${reason} (gave up after ${attempts} attempts)` : reason).slice(0, MAX_SUMMARY);
	if (lane) lane.autoRun = false;
	return t;
}
