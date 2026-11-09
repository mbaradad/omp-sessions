import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LaneView, PlanView, TaskView } from "../../src/planner/types";
import { laneSummary, orderedLanes, taskStateText, tasksOf } from "../../src/shared/plan-tree";

const NOW = new Date(2026, 10, 9, 12, 0);

function lane(id: string, extra: Partial<LaneView> = {}): LaneView {
	return { id, autoRun: false, createdAt: 0, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...extra };
}
function task(id: string, extra: Partial<TaskView> = {}): TaskView {
	return { id, title: `task ${id}`, subtasks: [], status: "pending", createdAt: 0, state: "waiting", ...extra };
}
function plan(lanes: LaneView[], tasks: TaskView[]): PlanView {
	return { rev: 1, lanes, tasks, recurring: [], status: {} as PlanView["status"] };
}

describe("orderedLanes / tasksOf", () => {
	test("urgent queues first, completed ones last, otherwise the planner's order", () => {
		const p = plan([lane("a", { completed: true, priority: "urgent" }), lane("b"), lane("c", { priority: "low" }), lane("d", { priority: "high" }), lane("e")], []);
		assert.deepEqual(orderedLanes(p).map(l => l.id), ["d", "b", "e", "c", "a"]);
	});

	test("a lane's tasks keep plan order; free tasks are the ones without a lane", () => {
		const p = plan([lane("q")], [task("1", { lane: "q" }), task("2"), task("3", { lane: "q" }), task("4", { lane: "other" })]);
		assert.deepEqual(tasksOf(p, "q").map(t => t.id), ["1", "3"]);
		assert.deepEqual(tasksOf(p, undefined).map(t => t.id), ["2"]);
	});
});

describe("taskStateText", () => {
	const titles: Record<string, string> = { a: "Build", b: "Test", c: "Lint" };
	const titleOf = (id: string) => titles[id];

	test("a blocked task names what it waits for, a deleted dependency included", () => {
		assert.equal(taskStateText(task("x", { state: "blocked", blockedBy: ["a", "gone"] }), titleOf, NOW), "⛓ waits for Build, missing task gone");
		assert.equal(taskStateText(task("x", { state: "blocked", blockedBy: ["a", "b", "c"] }), titleOf, NOW), "⛓ waits for Build, Test +1");
	});

	test("scheduled and held tasks say until when", () => {
		const at = new Date(2026, 10, 9, 14, 30).getTime();
		assert.equal(taskStateText(task("x", { state: "scheduled", waitUntil: at }), titleOf, NOW), "⏰ 14:30");
		assert.equal(taskStateText(task("x", { state: "held", waitReason: "rate-limit anthropic", waitUntil: at }), titleOf, NOW), "✋ rate-limit anthropic until 14:30");
		assert.equal(taskStateText(task("x", { state: "held" }), titleOf, NOW), "✋ held");
	});

	test("waiting shows its place in line; an interrupted task asks for a person", () => {
		assert.equal(taskStateText(task("x", { state: "waiting", position: 2 }), titleOf, NOW), "⏳ waiting #2");
		assert.equal(taskStateText(task("x", { state: "interrupted", interrupted: 1 }), titleOf, NOW), "⚠ interrupted: run it again");
	});
});

describe("laneSummary", () => {
	test("says whether the queue runs, waits for a start time, or is paused", () => {
		const at = new Date(2026, 10, 10, 9, 0).getTime();
		assert.equal(laneSummary(lane("q", { autoRun: true, running: 1, pending: 2, done: 1, total: 4 }), NOW), "running · 2 pending · 1/4 done · ▶ auto-run");
		assert.equal(laneSummary(lane("q", { startAt: at, pending: 1, total: 1 }), NOW), "1 pending · 0/1 done · ⏰ starts tomorrow 09:00");
		assert.equal(laneSummary(lane("q", { pending: 1, failed: 1, total: 2, priority: "high" }), NOW), "high · 1 pending · 1 failed · 0/2 done · ⏸ paused");
		assert.equal(laneSummary(lane("q"), NOW), "no tasks");
	});
});
