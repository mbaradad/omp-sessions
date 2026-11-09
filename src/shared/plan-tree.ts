// How the Tasks view lays out the planner's plan (PLANNER-API.md): lanes (queues) in start order,
// each with its tasks, then the free tasks, and the one-line state of a task or lane. Pure.
import type { LaneView, PlanView, Priority, TaskView } from "../planner/types";
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
		lane.completed ? "✔ completed" : "",
	]
		.filter(Boolean)
		.join(" · ");
}
