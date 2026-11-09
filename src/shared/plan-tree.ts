// How the Tasks view lays out the planner's plan (PLANNER-API.md): lanes (queues) in start order,
// each with its tasks, then the free tasks, and the one-line state of a task or lane. Pure.
import type { BudgetCaps, EdgeSync, LaneView, PlanOp, PlanView, PlannerStatus, Priority, TaskView } from "../planner/types";
import { PRIORITIES, THINKING_LEVELS } from "../planner/types";
import { formatStartTime } from "./task-text";

const rank = (p: Priority | undefined): number => PRIORITIES.indexOf(p ?? "normal");

/** Lanes the view lists: priority first (urgent → low), then the planner's order. Completed lanes last. */
export function orderedLanes(plan: PlanView): LaneView[] {
	return plan.lanes
		.map((lane, i) => ({ lane, i }))
		.sort((a, b) => Number(!!a.lane.completed) - Number(!!b.lane.completed) || rank(a.lane.priority) - rank(b.lane.priority) || a.i - b.i)
		.map(x => x.lane);
}

/** A lane's tasks (or the free tasks, `lane` undefined) in the planner's order. */
export function tasksOf(plan: PlanView, lane: string | undefined): TaskView[] {
	return plan.tasks.filter(t => t.lane === lane);
}

/** Why a pending task isn't running, or its outcome, in a few words. */
export function taskStateText(task: TaskView, titleOf: (id: string) => string | undefined, now = new Date()): string {
	switch (task.state) {
		case "blocked": {
			const names = (task.blockedBy ?? []).map(id => titleOf(id) ?? `missing task ${id}`);
			return names.length ? `⛓ waits for ${names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ")}` : "⛓ blocked";
		}
		case "scheduled":
			return `⏰ ${formatStartTime(task.waitUntil ?? task.startAt ?? now.getTime(), now)}`;
		case "paused":
			return "⏸ paused";
		case "held":
			return `✋ ${task.waitReason ?? "held"}${task.waitUntil ? ` until ${formatStartTime(task.waitUntil, now)}` : ""}`;
		case "waiting":
			return task.position ? `⏳ waiting #${task.position}` : "⏳ waiting";
		case "interrupted":
			return "⚠ interrupted: run it again";
		case "running":
		case "done":
		case "failed":
		case "skipped":
			return task.state;
	}
}

/** Edge states that need a look, worst first (`in-sync` and `merged` are fine). */
const ATTENTION: ReadonlyArray<EdgeSync["state"]> = ["conflict", "resolving", "upstream-changed", "pending"];

/** The worst state among a task's incoming dependency edges (a parent's changes reaching its worktree), if one needs attention. */
export function syncAttention(task: Pick<TaskView, "sync">): EdgeSync["state"] | undefined {
	const states = new Set(Object.values(task.sync ?? {}).map(e => e.state));
	return ATTENTION.find(s => states.has(s));
}

/** A merge of a parent's changes that a person has to decide (it counts as needs-input). */
export interface SyncConflict {
	/** Stable per conflict (task, parent, when it arose): notify once. */
	key: string;
	task: TaskView;
	parentId: string;
	files: string[];
}

/** Every edge of the plan in the `conflict` state. */
export function syncConflicts(plan: PlanView): SyncConflict[] {
	return plan.tasks.flatMap(task =>
		Object.entries(task.sync ?? {})
			.filter(([, edge]) => edge.state === "conflict")
			.map(([parentId, edge]) => ({ key: `${task.id}\n${parentId}\n${edge.at}`, task, parentId, files: edge.files ?? [] })),
	);
}

const SYNC_TEXT: Record<EdgeSync["state"], string> = {
	"in-sync": "",
	merged: "",
	pending: "⇄ parent changed, merging soon",
	"upstream-changed": "⇄ parent changed after this ran",
	resolving: "⇄ resolving a merge conflict",
	conflict: "⚠ merge conflict: needs a person",
};

/** One-line label for an edge or task sync state ("" when nothing needs attention). */
export function syncText(state: EdgeSync["state"] | undefined): string {
	return state ? SYNC_TEXT[state] : "";
}

/** Why a queue's next task isn't starting, when it is held, blocked or cut short ("" otherwise: paused/scheduled show as the arm state). */
function laneWaitText(lane: LaneView, now: Date): string {
	if (lane.state === "held") return `✋ ${lane.waitReason ?? "held"}${lane.waitUntil ? ` until ${formatStartTime(lane.waitUntil, now)}` : ""}`;
	if (lane.state === "blocked") return "⛓ blocked";
	if (lane.state === "interrupted") return "⚠ interrupted";
	return "";
}

/** "running · 2 pending · 1/4 done · ▶ auto-run" for a lane. */
export function laneSummary(lane: LaneView, now = new Date()): string {
	const armed = lane.autoRun ? "▶ auto-run" : lane.startAt ? `⏰ starts ${formatStartTime(lane.startAt, now)}` : lane.pending ? "⏸ paused" : "";
	return [
		lane.priority && lane.priority !== "normal" ? lane.priority : "",
		lane.running ? "running" : "",
		lane.pending ? `${lane.pending} pending` : "",
		lane.failed ? `${lane.failed} failed` : "",
		lane.total ? `${lane.done}/${lane.total} done` : "no tasks",
		armed,
		laneWaitText(lane, now),
		lane.completed ? "✔ completed" : "",
	]
		.filter(Boolean)
		.join(" · ");
}

const BUDGET_WINDOWS = ["hour", "day", "week"] as const;

/**
 * "day 20", "hour 2 day 20 week 100" (USD per rolling window; `$`, `=` and commas allowed) → caps.
 * Empty text clears the budget (`{}`). Anything else is an error that says what to type.
 */
export function parseBudget(text: string): { caps: BudgetCaps } | { error: string } {
	const t = text.trim().toLowerCase();
	if (!t || t === "off" || t === "none") return { caps: {} };
	const caps: BudgetCaps = {};
	const rest = t.replace(/(hour|day|week)\s*=?\s*\$?\s*(\d+(?:\.\d+)?)\s*,?/g, (_m, window: (typeof BUDGET_WINDOWS)[number], usd: string) => {
		caps[window] = Number(usd);
		return "";
	});
	if (rest.trim() || Object.keys(caps).length === 0) return { error: 'Type caps in USD like "day 20" or "hour 2 day 20 week 100"; empty removes the budget.' };
	if (Object.values(caps).some(v => !(v > 0))) return { error: "A cap must be more than 0 (leave the window out to have no cap)." };
	return { caps };
}

/** Why queued work may be held right now, one line each: provider limits and spend caps in force. */
export function holdLines(status: Pick<PlannerStatus, "limits" | "spend">, now = new Date()): string[] {
	const out = status.limits.filter(l => l.until > now.getTime()).map(l => `${l.provider} is rate-limited until ${formatStartTime(l.until, now)}${l.reason ? ` (${l.reason.slice(0, 80)})` : ""}`);
	for (const s of status.spend) {
		out.push(`spend this ${s.window}: $${s.spent.toFixed(2)} of $${s.cap}${s.over ? ` (cap reached${s.freesAt ? `, frees ${formatStartTime(s.freesAt, now)}` : ""})` : ""}`);
	}
	return out;
}

export type TaskOptionField = "model" | "thinking" | "retries" | "timeout";

/**
 * Why typed text is not a usable value for a task option, or undefined when it is (empty clears the option).
 * The planner silently drops an option it can't read, so a typo must be refused here: `opus` would otherwise
 * be accepted and the task would run on the session's own model. (Whether the model exists is the planner's
 * dispatch-time check; this only catches what can't be a model id.)
 */
export function checkTaskOption(field: TaskOptionField, text: string): string | undefined {
	const t = text.trim();
	if (!t) return undefined;
	switch (field) {
		case "model":
			return /^[^/\s]+\/\S+$/.test(t) ? undefined : "Type provider/modelId, e.g. anthropic/claude-opus-4-6 (empty clears it).";
		case "thinking":
			return t === "minimal" || (THINKING_LEVELS as readonly string[]).includes(t) ? undefined : `One of: ${THINKING_LEVELS.join(", ")} (empty clears it).`;
		case "retries":
			return /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 10 ? undefined : "A whole number from 1 to 10 (empty clears it).";
		case "timeout":
			return Number.isFinite(Number(t)) && Number(t) > 0 && Number(t) <= 24 * 60 ? undefined : "Minutes, more than 0 and at most 1440 (empty clears it).";
	}
}

/** Tasks a person can undo with the checkpoints: they ran, finished, and the planner knows which AO turn did the work. */
export function isUndoable(task: Pick<TaskView, "status" | "session" | "turn">): boolean {
	return (task.status === "done" || task.status === "failed") && !!task.session && !!task.turn;
}

/**
 * What undoing `task`'s turn takes with it: the checkpoint rewinds that prompt AND every later one in the same
 * AO session, so later tasks that ran in that session are undone too. In the order they ran.
 */
export function undoneWith(plan: PlanView, task: TaskView): TaskView[] {
	const from = task.startedAt ?? 0;
	return plan.tasks
		.filter(t => t.session === task.session && (t.status === "done" || t.status === "failed") && (t.id === task.id || (t.startedAt ?? 0) > from))
		.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/**
 * Planner edits after an undo: every undone task goes back to pending, held so nothing re-runs by itself
 * (`requeue` re-arms a queue, so the queue is paused again in the same batch; a task in no queue is paused on its own).
 */
export function afterUndoOps(undone: readonly TaskView[]): PlanOp[] {
	const ops: PlanOp[] = [];
	const lanes = new Set<string>();
	for (const t of undone) {
		ops.push({ op: "requeue", id: t.id });
		if (t.lane) lanes.add(t.lane);
		else ops.push({ op: "pause", id: t.id });
	}
	for (const lane of lanes) ops.push({ op: "lane.pause", id: lane });
	return ops;
}
