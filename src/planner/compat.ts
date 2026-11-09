// The old per-session queue contract on top of lanes: `queue {id, ops}` takes the old QueueOps (plus
// `after` and `requeue` from the parked omp/deps and omp/requeue branches) and `getQueue` returns the
// old TaskQueue shape, so clients that edited a session's queue keep working with a lane id or an AO
// session id. Pure.
import { PlanError, laneViews } from "./engine";
import type { PlanOp, PlanState, QueueOp, QueueView, TaskView } from "./types";

function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Old QueueOps on lane `lane` → PlanOps. Lane-level `after` (ids of tasks or lanes) becomes the
 * dependencies of every unfinished task of the lane; a lane id stands for all of that lane's tasks.
 */
export function queueOpsToPlanOps(state: PlanState, lane: string, ops: readonly QueueOp[]): PlanOp[] {
	if (!Array.isArray(ops)) throw new PlanError("ops must be a list");
	const out: PlanOp[] = [];
	const exists = state.lanes.some(l => l.id === lane);
	if (!exists) out.push({ op: "lane.add", id: lane, autoRun: false });
	const members = () => state.tasks.filter(t => t.lane === lane);
	/** Refs of the tasks this batch adds, so a later `after` in the same batch reaches them. */
	const added: string[] = [];
	for (const raw of ops) {
		const o = rec(raw) as (QueueOp & Record<string, unknown>) | undefined;
		if (!o) throw new PlanError("an op must be an object");
		const opName: unknown = o.op;
		switch (o.op) {
			case "add":
				added.push(`q${added.length}`);
				out.push({ op: "add", ref: added[added.length - 1], task: { title: o.title, notes: o.notes, subtasks: o.subtasks, options: o.options, done: o.done, lane }, ...(typeof o.index === "number" ? { index: o.index } : {}) });
				break;
			case "update": {
				if (o.title !== undefined || o.notes !== undefined) out.push({ op: "update", id: o.id, title: o.title, notes: o.notes });
				if (o.status === "done") out.push({ op: "done", id: o.id });
				else if (o.status === "skipped") out.push({ op: "skip", id: o.id });
				else if (o.status === "pending") out.push({ op: "requeue", id: o.id });
				break;
			}
			case "remove":
			case "duplicate":
				out.push({ op: o.op, id: o.id });
				break;
			case "move":
				out.push({ op: "move", id: o.id, index: o.index });
				break;
			case "addSubtask":
			case "updateSubtask":
			case "removeSubtask":
			case "moveSubtask":
				out.push(o as PlanOp);
				break;
			case "setOptions":
				out.push({ op: "update", id: o.id, options: o.options ?? null });
				break;
			case "run": {
				const id = typeof o.id === "string" ? o.id : members().find(t => t.status === "pending")?.id;
				out.push(id ? { op: "run", id } : { op: "lane.resume", id: lane });
				break;
			}
			case "autoRun":
				out.push({ op: o.value === true ? "lane.resume" : "lane.pause", id: lane });
				break;
			case "clearDone":
				out.push({ op: "lane.clearDone", id: lane });
				break;
			case "retryFailed":
				out.push({ op: "lane.retryFailed", id: lane });
				break;
			case "schedule":
				out.push({ op: "lane.startAt", id: lane, at: typeof o.at === "number" ? o.at : null });
				break;
			case "requeue":
				out.push({ op: "lane.requeue", id: lane });
				break;
			case "after": {
				const ids: string[] = [];
				for (const id of Array.isArray(o.ids) ? o.ids : []) {
					if (typeof id !== "string") continue;
					const laneTasks = state.tasks.filter(t => t.lane === id).map(t => t.id);
					if (state.lanes.some(l => l.id === id)) ids.push(...laneTasks);
					else ids.push(id);
				}
				for (const t of members()) if (t.status === "pending") out.push({ op: "after", id: t.id, ids });
				for (const ref of added) out.push({ op: "after", id: `@${ref}`, ids });
				break;
			}
			default:
				throw new PlanError(`unknown queue op ${String(opName)}`);
		}
	}
	return out;
}

/** The old TaskQueue shape of one lane (an unknown lane is an empty, unarmed queue). */
export function queueView(state: PlanState, views: readonly TaskView[], lane: string): QueueView {
	const l = laneViews(state).find(x => x.id === lane);
	const out: QueueView = {
		id: lane,
		autoRun: l?.autoRun ?? false,
		tasks: views
			.filter(t => t.lane === lane)
			.map(t => {
				const { lane: _lane, inputs: _inputs, priority: _priority, startAt: _startAt, usage: _usage, paused: _paused, recur: _recur, children: _children, waitReason: _reason, waitUntil: _until, position: _position, ...rest } = t;
				return rest;
			}),
	};
	if (l?.startAt) out.startAt = l.startAt;
	if (l?.session) out.session = l.session;
	const head = views.find(t => t.lane === lane && (t.status === "pending" || t.status === "running"));
	if (head) Object.assign(out, { state: head.state, ...(head.waitReason ? { waitReason: head.waitReason } : {}), ...(head.waitUntil ? { waitUntil: head.waitUntil } : {}) });
	return out;
}
