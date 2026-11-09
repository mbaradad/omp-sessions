// The planner's plan seen as the old per-session task queue (src/shared/protocol.ts `TaskQueue`), for
// code that still speaks that shape: the chat panel's queue strip and the webview. A session's queue is
// the lane that continues it (the lane's id is the AO session id, or the lane names it in `session`).
// Pure.
import type { LaneView, PlanView, TaskView } from "../planner/types";
import type { QueueTask, TaskQueue } from "./protocol";

/** The lane that continues AO session `aoSessionId`, if the plan has one. */
export function laneForSession(plan: PlanView | undefined, aoSessionId: string): LaneView | undefined {
	return plan?.lanes.find(l => l.id === aoSessionId) ?? plan?.lanes.find(l => l.session === aoSessionId);
}

function queueTask(t: TaskView): QueueTask {
	const out: QueueTask = { id: t.id, title: t.title, subtasks: t.subtasks.map(s => ({ id: s.id, title: s.title, done: s.done })), status: t.status, createdAt: t.createdAt };
	if (t.notes) out.notes = t.notes;
	if (t.startedAt !== undefined) out.startedAt = t.startedAt;
	if (t.finishedAt !== undefined) out.finishedAt = t.finishedAt;
	if (t.summary !== undefined) out.summary = t.summary;
	const o = t.options;
	if (o && (o.model || o.thinking || o.freshContext || o.retries || o.timeoutMinutes)) {
		out.options = {
			...(o.model ? { model: o.model } : {}),
			...(o.thinking ? { thinking: o.thinking } : {}),
			...(o.freshContext ? { freshContext: true } : {}),
			...(o.retries ? { retries: o.retries } : {}),
			...(o.timeoutMinutes ? { timeoutMinutes: o.timeoutMinutes } : {}),
		};
	}
	if (t.attempts) out.attempts = t.attempts;
	if (t.durationMs !== undefined) out.durationMs = t.durationMs;
	if (t.cost !== undefined) out.cost = t.cost;
	if (t.interrupted) out.interrupted = t.interrupted;
	return out;
}

/** The queue of an AO session: its lane's tasks in order; empty (paused) when it has no lane. */
export function queueOf(plan: PlanView | undefined, aoSessionId: string): TaskQueue {
	const lane = laneForSession(plan, aoSessionId);
	if (!plan || !lane) return { tasks: [], autoRun: false };
	const q: TaskQueue = { tasks: plan.tasks.filter(t => t.lane === lane.id).map(queueTask), autoRun: lane.autoRun };
	if (lane.startAt) q.startAt = lane.startAt;
	return q;
}
