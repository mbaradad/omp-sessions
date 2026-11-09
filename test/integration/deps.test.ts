// Dependencies between tasks (PARKED §1) on the whole stack: the planner service process on an isolated AO
// daemon running the scripted fake omp, driven over the planner wire. A task with `after` stays blocked
// (`blockedBy`) until its parents are finished and then starts by itself; a failed parent keeps it blocked
// until the parent is skipped or its queue is marked completed; cycles, itself and unknown tasks are refused
// with their path; a session id names the task that ran in it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PlanView, TaskView } from "../../src/planner/types";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";
import { type PlannerFixture, startPlannerFixture } from "../planner-fixture.mjs";

let ao: AoFixture;
let planner: PlannerFixture;
let project: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	planner = await startPlannerFixture({ ao, pollMs: 200, usage: false });
	project = await ao.createProject(ao.scratchRepo());
});

after(async () => {
	await planner?.stop();
	await ao?.stop();
});

function byTitle(plan: PlanView, title: string): TaskView {
	const task = plan.tasks.find(t => t.title === title);
	assert.ok(task, `task ${title} in the plan`);
	return task;
}

/** session/prompt requests the fake received whose text contains `marker`: how often work was dispatched. */
function prompts(marker: string): number {
	return ao.fakeOmpFrames().filter(f => f.dir === "in" && f.msg?.method === "session/prompt" && JSON.stringify(f.msg.params.prompt).includes(marker)).length;
}

test("B after A: B is blocked on A while A runs, starts by itself once A is done and never before", { skip }, async () => {
	await planner.call("edit", {
		ops: [
			{ op: "add", ref: "a", task: { title: "dep-A", notes: "slow 2500\necho a-finished", options: { project } } },
			{ op: "add", ref: "b", task: { title: "dep-B", notes: "echo b-ran", after: ["@a"], options: { project } } },
		],
	});
	const running: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "dep-A").status === "running", { what: "A running" });
	const a = byTitle(running, "dep-A");
	const b = byTitle(running, "dep-B");
	assert.equal(b.state, "blocked");
	assert.deepEqual(b.blockedBy, [a.id]);
	assert.deepEqual(b.after, [a.id]);
	assert.match(b.waitReason ?? "", /waits for dep-A/);
	assert.equal(prompts("b-ran"), 0, "B was not dispatched while A ran");
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "dep-B").status === "done", { what: "B done" });
	const [doneA, doneB] = [byTitle(done, "dep-A"), byTitle(done, "dep-B")];
	assert.ok((doneB.startedAt ?? 0) >= (doneA.finishedAt ?? Number.POSITIVE_INFINITY), "B started after A finished");
	assert.equal(doneB.blockedBy, undefined);
	assert.equal(prompts("b-ran"), 1);
	// A task in an unfinished parent's tasks lane report: the wire's lane view says what the next task waits for.
	assert.ok(doneA.session && doneB.session && doneA.session !== doneB.session, "each task ran in its own session");
});

test("a failed parent keeps its child blocked (and says so) until the parent is skipped", { skip }, async () => {
	await planner.call("edit", {
		ops: [
			{ op: "add", ref: "a", task: { title: "fail-A", notes: "error boom", options: { project } } },
			{ op: "add", ref: "b", task: { title: "fail-B", notes: "echo fail-b-ran", after: ["@a"], options: { project } } },
		],
	});
	const failed: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "fail-A").status === "failed", { what: "A failed" });
	const b = byTitle(failed, "fail-B");
	assert.equal(b.state, "blocked");
	assert.match(b.waitReason ?? "", /a dependency failed: fail-A/);
	assert.equal(prompts("fail-b-ran"), 0);
	// Skipping the parent counts as finished: the child runs without the parent's result.
	await planner.call("edit", { ops: [{ op: "skip", id: byTitle(failed, "fail-A").id }] });
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "fail-B").status === "done", { what: "B done after the skip" });
	assert.equal(prompts("fail-b-ran"), 1);
	assert.match(byTitle(done, "fail-B").summary ?? "", /fail-b-ran/);
});

test("marking the parent's queue completed releases its child, and reopening it blocks a new child again", { skip }, async () => {
	const lane = "l_deps000001";
	await planner.call("edit", {
		ops: [
			{ op: "lane.add", id: lane, title: "Q", autoRun: false },
			{ op: "add", ref: "a", task: { title: "lane-A", notes: "echo lane-a-ran", lane, options: { project } } },
			{ op: "add", ref: "b", task: { title: "lane-B", notes: "echo lane-b-ran", after: ["@a"], options: { project } } },
		],
	});
	const waiting: PlanView = await planner.plan();
	assert.equal(byTitle(waiting, "lane-B").state, "blocked");
	assert.equal(prompts("lane-a-ran"), 0, "the queue is paused");
	await planner.call("edit", { ops: [{ op: "lane.complete", id: lane, completed: true }] });
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "lane-B").status === "done", { what: "B done once the queue is marked completed" });
	assert.equal(byTitle(done, "lane-A").status, "pending", "A itself never ran");
	assert.equal(prompts("lane-a-ran"), 0);
	assert.equal(prompts("lane-b-ran"), 1);
	await planner.call("edit", { ops: [{ op: "lane.complete", id: lane, completed: false }, { op: "add", task: { title: "lane-C", notes: "echo lane-c-ran", after: [byTitle(done, "lane-A").id], options: { project } } }] });
	assert.equal(byTitle(await planner.plan(), "lane-C").state, "blocked", "reopened: A's work is outstanding again");
});

test("self, unknown and cyclic dependencies are refused with a clear error and change nothing", { skip }, async () => {
	await planner.call("edit", {
		ops: [
			{ op: "add", ref: "a", task: { title: "cyc-A", notes: "echo cyc", autoRun: false, startAt: Date.now() + 3_600_000, options: { project } } },
			{ op: "add", ref: "b", task: { title: "cyc-B", notes: "echo cyc", after: ["@a"], options: { project } } },
		],
	});
	const plan: PlanView = await planner.plan();
	const [a, b] = [byTitle(plan, "cyc-A"), byTitle(plan, "cyc-B")];
	await assert.rejects(planner.call("edit", { ops: [{ op: "after", id: a.id, ids: [a.id] }] }), /can't wait for itself/);
	await assert.rejects(planner.call("edit", { ops: [{ op: "after", id: a.id, ids: ["nope"] }] }), /unknown task nope/);
	await assert.rejects(planner.call("edit", { ops: [{ op: "after", id: a.id, ids: [b.id] }] }), /that would be a cycle: "cyc-A" → "cyc-B" → "cyc-A"/);
	const after: PlanView = await planner.plan();
	assert.equal(byTitle(after, "cyc-A").after, undefined, "the refused edit changed nothing");
	assert.deepEqual(byTitle(after, "cyc-B").after, [a.id]);
});

test("an AO session id names the task that ran in it (clients that only know sessions)", { skip }, async () => {
	await planner.call("edit", { ops: [{ op: "add", task: { title: "ref-A", notes: "echo ref-a", options: { project } } }] });
	const first: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "ref-A").status === "done", { what: "ref-A done" });
	const session = byTitle(first, "ref-A").session as string;
	assert.ok(session);
	await planner.call("edit", { ops: [{ op: "add", task: { title: "ref-B", notes: "echo ref-b", after: [session], options: { project } } }] });
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "ref-B").status === "done", { what: "ref-B done" });
	assert.deepEqual(byTitle(done, "ref-B").after, [byTitle(done, "ref-A").id], "the session id resolved to its task");
});
