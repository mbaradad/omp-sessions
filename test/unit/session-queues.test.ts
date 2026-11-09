import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LaneView, PlanView, QueueOp as PlannerQueueOp, TaskView } from "../../src/planner/types";
import { type QueuePlanner, SessionQueues } from "../../src/ext/session-queues";
import type { QueueOp } from "../../src/shared/protocol";

function lane(id: string, extra: Partial<LaneView> = {}): LaneView {
	return { id, autoRun: false, createdAt: 0, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...extra };
}
function task(id: string, laneId: string): TaskView {
	return { id, title: `task ${id}`, subtasks: [], status: "pending", createdAt: 1, state: "waiting", lane: laneId };
}
function plan(lanes: LaneView[], tasks: TaskView[]): PlanView {
	return { rev: 1, lanes, tasks, recurring: [], edges: [], status: {} as PlanView["status"] };
}

/** A planner that keeps its plan in memory; `queue` records the call and applies `add` to the named lane (creating it, as the real one does). */
function fakePlanner(initial: PlanView) {
	const calls: Array<{ id: string; ops: PlannerQueueOp[] }> = [];
	const planner: QueuePlanner = {
		plan: initial,
		onDidChange: () => ({ dispose: () => undefined }),
		async queue(id, ops) {
			calls.push({ id, ops });
			const current = planner.plan as PlanView;
			const lanes = current.lanes.some(l => l.id === id) ? current.lanes : [...current.lanes, lane(id)];
			const added = ops.flatMap((o): TaskView[] => (o.op === "add" ? [task(`n${current.tasks.length + 1}`, id)] : []));
			(planner as { plan: PlanView }).plan = { ...current, lanes, tasks: [...current.tasks, ...added] };
		},
	};
	return { planner, calls };
}

describe("SessionQueues", () => {
	test("get reads the live plan and never calls the planner (a read must not create a lane)", () => {
		const { planner, calls } = fakePlanner(plan([lane("l_1", { session: "proj-2", autoRun: true })], [task("a", "l_1")]));
		const queues = new SessionQueues(planner);
		assert.deepEqual(queues.get("proj-2").tasks.map(t => t.id), ["a"]);
		assert.equal(queues.get("proj-2").autoRun, true);
		assert.deepEqual(queues.get("proj-9"), { tasks: [], autoRun: false });
		assert.equal(calls.length, 0);
	});

	test("edit goes to the lane that continues the session, whatever its id, and returns the queue as the edit left it", async () => {
		const { planner, calls } = fakePlanner(plan([lane("l_1", { session: "proj-2" })], [task("a", "l_1")]));
		const queues = new SessionQueues(planner);
		const add: QueueOp = { op: "add", title: "more" };
		const after = await queues.edit("proj-2", [add]);
		assert.equal(calls[0].id, "l_1", "the lane's own id, not the session id");
		assert.deepEqual(after.tasks.map(t => t.id), ["a", "n2"]);
	});

	test("edit on a session with no lane names the session: the planner creates its (paused) queue there", async () => {
		const { planner, calls } = fakePlanner(plan([], []));
		const after = await new SessionQueues(planner).edit("proj-5", [{ op: "add", title: "first" }]);
		assert.equal(calls[0].id, "proj-5");
		assert.deepEqual(after.tasks.map(t => t.title), ["task n1"]);
		assert.equal(after.autoRun, false);
	});

	test("a refused edit rejects with the planner's reason and changes nothing", async () => {
		const { planner } = fakePlanner(plan([lane("proj-2")], [task("a", "proj-2")]));
		planner.queue = async () => {
			throw new Error("task a is running: it cannot be removed");
		};
		const queues = new SessionQueues(planner);
		await assert.rejects(queues.edit("proj-2", [{ op: "remove", id: "a" }]), /cannot be removed/);
		assert.deepEqual(queues.get("proj-2").tasks.map(t => t.id), ["a"]);
	});
});
