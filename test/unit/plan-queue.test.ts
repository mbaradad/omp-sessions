import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LaneView, PlanView, TaskView } from "../../src/planner/types";
import { laneForSession, queueOf } from "../../src/shared/plan-queue";

function lane(id: string, extra: Partial<LaneView> = {}): LaneView {
	return { id, autoRun: false, createdAt: 0, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...extra };
}
function task(id: string, laneId: string | undefined, extra: Partial<TaskView> = {}): TaskView {
	return { id, title: `task ${id}`, subtasks: [], status: "pending", createdAt: 5, state: "waiting", lane: laneId, ...extra };
}
function plan(lanes: LaneView[], tasks: TaskView[]): PlanView {
	return { rev: 1, lanes, tasks, recurring: [], edges: [], keptBranches: [], status: {} as PlanView["status"] };
}

describe("queueOf", () => {
	test("a session's queue is the lane named after it, or the lane that continues it, in plan order", () => {
		const p = plan([lane("l_1", { session: "proj-2", autoRun: true, startAt: 99 }), lane("proj-3")], [task("a", "l_1"), task("x", "proj-3"), task("b", "l_1"), task("free", undefined)]);
		assert.deepEqual(queueOf(p, "proj-2").tasks.map(t => t.id), ["a", "b"]);
		assert.equal(queueOf(p, "proj-2").autoRun, true);
		assert.equal(queueOf(p, "proj-2").startAt, 99);
		assert.deepEqual(queueOf(p, "proj-3").tasks.map(t => t.id), ["x"]);
		assert.equal(laneForSession(p, "proj-2")?.id, "l_1");
	});

	test("an unknown session, or no plan at all (planner unreachable), is an empty paused queue", () => {
		assert.deepEqual(queueOf(plan([lane("a")], []), "nope"), { tasks: [], autoRun: false });
		assert.deepEqual(queueOf(undefined, "a"), { tasks: [], autoRun: false });
	});

	test("task fields carry over; planner-only options are left out of the old shape; empty options vanish", () => {
		const t = task("a", "s", {
			notes: "n",
			subtasks: [{ id: "s1", title: "one", done: true }],
			status: "failed",
			summary: "boom",
			attempts: 2,
			durationMs: 1500,
			cost: 0.25,
			options: { model: "anthropic/x", thinking: "high", retries: 3, cwd: "/tmp", project: "p" },
		});
		const [out] = queueOf(plan([lane("s")], [t, task("b", "s", { options: { cwd: "/tmp" } })]), "s").tasks;
		assert.deepEqual(out, {
			id: "a",
			title: "task a",
			subtasks: [{ id: "s1", title: "one", done: true }],
			status: "failed",
			createdAt: 5,
			notes: "n",
			summary: "boom",
			options: { model: "anthropic/x", thinking: "high", retries: 3 },
			attempts: 2,
			durationMs: 1500,
			cost: 0.25,
		});
		assert.equal(queueOf(plan([lane("s")], [task("b", "s", { options: { cwd: "/tmp" } })]), "s").tasks[0].options, undefined);
	});

	test("a task cut short shows as interrupted in the old shape", () => {
		const q = queueOf(plan([lane("s")], [task("a", "s", { interrupted: 123, state: "interrupted" })]), "s");
		assert.equal(q.tasks[0].interrupted, 123);
		assert.equal(q.tasks[0].status, "pending");
	});
});
