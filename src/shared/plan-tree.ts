// How the Tasks view lays out the planner's plan (PLANNER-API.md): lanes (queues) in start order,
// each with its tasks, then the free tasks, and the one-line state of a task or lane. Pure.
import type { BudgetCaps, EdgeSync, LaneView, PlanView, PlannerStatus, Priority, TaskView } from "../planner/types";
import { PRIORITIES } from "../planner/types";
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
