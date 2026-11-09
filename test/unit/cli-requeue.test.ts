// `queue requeue` (src/cli/plan.ts canRequeue): refused when the planner's lane.requeue would do nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlannerQueue, canRequeue } from "../../src/cli/plan";

const task = (status: PlannerQueue["tasks"][number]["status"], extra: Record<string, unknown> = {}) => ({ id: status, title: status, subtasks: [], status, createdAt: 0, state: status, ...extra }) as unknown as PlannerQueue["tasks"][number];
const queue = (tasks: PlannerQueue["tasks"], extra: Partial<PlannerQueue> = {}): PlannerQueue => ({ id: "q", autoRun: false, tasks, ...extra }) as PlannerQueue;

test("canRequeue: failed, interrupted, paused and finished queues can; empty, running and already-waiting ones can't", () => {
	assert.equal(canRequeue(queue([])), false, "no tasks");
	assert.equal(canRequeue(queue([task("done"), task("failed")], { autoRun: true })), true, "failed");
	assert.equal(canRequeue(queue([task("pending", { interrupted: 1 })], { autoRun: true })), true, "interrupted");
	assert.equal(canRequeue(queue([task("pending")])), true, "paused");
	assert.equal(canRequeue(queue([task("pending")], { autoRun: true })), false, "armed");
	assert.equal(canRequeue(queue([task("pending")], { startAt: 1 })), false, "scheduled");
	assert.equal(canRequeue(queue([task("done"), task("running")], { autoRun: true })), false, "running");
	assert.equal(canRequeue(queue([task("running"), task("failed")])), true, "a failed task can go back even while another runs");
	assert.equal(canRequeue(queue([task("done"), task("skipped")], { autoRun: true })), true, "finished: the last task runs again");
});
