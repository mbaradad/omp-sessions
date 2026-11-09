// The whole stack as it runs for users: the planner service process (test/planner-fixture.mjs) on an
// isolated AO daemon (test/ao-fixture.mjs) running the scripted fake omp, driven only over the planner
// wire. Covers a dependency graph with results passed on, usage-based auto-scheduling (a `spare` task
// waits for provider usage room, read from `omp usage --json`), a planner crash and an AO restart in
// the middle of a run, with nothing dispatched twice.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PlanView, TaskView } from "../../src/planner/types";
import { type AoFixture, aoAvailable, startAoFixture } from "../ao-fixture.mjs";
import { type PlannerFixture, startPlannerFixture } from "../planner-fixture.mjs";

const skip = aoAvailable() ? false : "ao not installed (set OMP_TEST_AO_BIN)";

let ao: AoFixture;
let planner: PlannerFixture;
let project: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	// The fake provider is nearly out of usage: `spare` work must wait.
	ao.setUsage([{ provider: "fake", id: "5h", label: "5 Hour", usedPercent: 97, resetsAt: Date.now() + 3_600_000 }]);
	planner = await startPlannerFixture({ ao });
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

test("graph A → B: B runs after A with A's result in its prompt", { skip }, async () => {
	await planner.call("edit", {
		ops: [
			{ op: "add", ref: "a", task: { title: "A", notes: "echo alpha-result", options: { project } } },
			{ op: "add", ref: "b", task: { title: "B", notes: "prompt", after: ["@a"], options: { project } } },
		],
	});
	const blocked: PlanView = await planner.plan();
	assert.equal(byTitle(blocked, "B").state, "blocked");
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "B").status === "done", { what: "B done" });
	assert.match(byTitle(done, "A").summary ?? "", /alpha-result/);
	// The fake echoed B's whole prompt: it carried A's summary.
	assert.match(byTitle(done, "B").summary ?? "", /alpha-result/);
	assert.ok(byTitle(done, "A").session && byTitle(done, "B").session);
	assert.equal(prompts("alpha-result"), 2, "A once, B once (with A's result)");
});

test("a spare task waits for usage room; a planner crash loses nothing", { skip }, async () => {
	await planner.call("edit", { ops: [{ op: "add", task: { title: "S", notes: "echo spare-ran", usage: "spare", options: { project, model: "fake/fake-model" } } }] });
	const held: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "S").state === "held", { what: "S held" });
	assert.match(byTitle(held, "S").waitReason ?? "", /spare: usage fake 5 Hour 97%/);
	assert.equal(prompts("spare-ran"), 0);
	// Usage drops; the planner crashes and comes back (it reads usage on start) and runs S once.
	ao.setUsage([{ provider: "fake", id: "5h", label: "5 Hour", usedPercent: 10 }]);
	await planner.restart({ kill: true });
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "S").status === "done", { what: "S done" });
	assert.match(byTitle(done, "S").summary ?? "", /spare-ran/);
	assert.equal(prompts("spare-ran"), 1);
});

test("an AO daemon restart mid-turn: the task finishes and is not dispatched again", { skip }, async () => {
	await planner.call("edit", { ops: [{ op: "add", task: { title: "R", notes: "slow 3000\necho survived-ao-restart", options: { project } } }] });
	await planner.waitFor((p: PlanView) => byTitle(p, "R").status === "running" && prompts("survived-ao-restart") === 1, { what: "R running" });
	await ao.restart();
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "R").status === "done", { what: "R done after the AO restart" });
	assert.match(byTitle(done, "R").summary ?? "", /survived-ao-restart/);
	assert.equal(prompts("survived-ao-restart"), 1);
});
