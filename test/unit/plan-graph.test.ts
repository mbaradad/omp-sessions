import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LaneView, PlanView, TaskView } from "../../src/planner/types";
import { type PlanGraph, planGraph } from "../../src/shared/plan-graph";

const NOW = new Date(2026, 10, 9, 12, 0);

function lane(id: string): LaneView {
	return { id, autoRun: true, createdAt: 0, pending: 0, running: 0, done: 0, failed: 0, total: 0 };
}
function task(id: string, extra: Partial<TaskView> = {}): TaskView {
	return { id, title: `task ${id}`, subtasks: [], status: "pending", createdAt: 0, state: "waiting", ...extra };
}
function plan(lanes: LaneView[], tasks: TaskView[]): PlanView {
	return { rev: 1, lanes, tasks, recurring: [], status: {} as PlanView["status"] };
}
const titleOf = (l: LaneView) => `queue ${l.id}`;
const keys = (g: PlanGraph) => g.edges.map(e => `${e.from}>${e.to}:${e.kind}${e.pending ? "" : ":done"}`);

describe("planGraph", () => {
	test("dependencies are solid edges parent → child; the child shows what it waits for", () => {
		const g = planGraph(plan([], [task("a"), task("b", { after: ["a"], state: "blocked", blockedBy: ["a"] }), task("lone")]), titleOf, NOW);
		assert.deepEqual(keys(g), ["a>b:after"]);
		assert.deepEqual(g.nodes.map(n => n.id), ["a", "b"], "a task with no edge is left out");
		assert.equal(g.nodes[1].text, "⛓ waits for task a");
	});

	test("a queue draws its running order as dashed edges between neighbours, in plan order", () => {
		const g = planGraph(plan([lane("q")], [task("1", { lane: "q" }), task("x"), task("2", { lane: "q" }), task("3", { lane: "q" })]), titleOf, NOW);
		assert.deepEqual(keys(g), ["1>2:lane", "2>3:lane"]);
		assert.equal(g.nodes[0].lane, "queue q");
	});

	test("an edge both of whose ends are finished is dropped; one open end keeps it, and a finished parent is not pending", () => {
		const done = { status: "done", state: "done" } as const;
		const g = planGraph(plan([lane("q")], [task("a", { lane: "q", ...done }), task("b", { lane: "q", ...done }), task("c", { lane: "q" }), task("d", { after: ["a", "c"], state: "blocked" })]), titleOf, NOW);
		assert.deepEqual(keys(g), ["a>d:after:done", "c>d:after", "b>c:lane:done"]);
		const finishedOnly = planGraph(plan([lane("q")], [task("a", { lane: "q", ...done }), task("b", { lane: "q", ...done }), task("e", { after: ["a"], ...done })]), titleOf, NOW);
		assert.deepEqual(finishedOnly, { nodes: [], edges: [] });
	});

	test("a dependency that duplicates a queue edge is drawn once; self and missing dependencies are ignored", () => {
		const g = planGraph(plan([lane("q")], [task("a", { lane: "q" }), task("b", { lane: "q", after: ["a", "b", "gone"] })]), titleOf, NOW);
		assert.deepEqual(keys(g), ["a>b:after"]);
	});

	test("carries the session to open and the state text of held and scheduled tasks", () => {
		const at = new Date(2026, 10, 9, 14, 30).getTime();
		const g = planGraph(plan([], [task("a", { session: "proj-1", status: "running", state: "running" }), task("b", { after: ["a"], state: "scheduled", waitUntil: at })]), titleOf, NOW);
		assert.equal(g.nodes[0].session, "proj-1");
		assert.equal(g.nodes[1].text, "⏰ 14:30");
	});
});
