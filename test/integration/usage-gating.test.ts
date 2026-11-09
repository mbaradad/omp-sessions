// Autoscheduling by usage (PARKED §4), end to end: the planner process on an isolated AO daemon running the
// scripted fake omp. A provider limit that omp gave up retrying arrives as a completed turn whose reply is the
// error (G35): the task is held, then starts by itself at the stated reset and finishes once. A spend budget
// holds new tasks once the cost AO reports for finished turns reaches the cap, until it is raised.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PlanView, TaskView } from "../../src/planner/types";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";
import { type PlannerFixture, startPlannerFixture } from "../planner-fixture.mjs";

let ao: AoFixture;
let planner: PlannerFixture;
let options: { project: string; model: string };

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	planner = await startPlannerFixture({ ao, usage: false, pollMs: 200 });
	options = { project: await ao.createProject(ao.scratchRepo()), model: "fake/fake-model" };
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
const prompts = (marker: string): number => ao.fakeOmpFrames().filter(f => f.dir === "in" && f.msg?.method === "session/prompt" && JSON.stringify(f.msg.params.prompt).includes(marker)).length;

test("a provider limit holds the task and the provider; the task starts by itself at the reset and runs once more, not three times", { skip, timeout: 60_000 }, async () => {
	await planner.call("edit", { ops: [{ op: "add", task: { title: "limited", notes: "limited 4 reset-resume\necho resumed-ok", options } }] });
	const held: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "limited").state === "held", { what: "the limited task to be held" });
	const task = byTitle(held, "limited");
	assert.match(task.waitReason ?? "", /^rate-limit fake until \d\d:\d\d$/);
	assert.ok(task.waitUntil && task.waitUntil > Date.now() && task.waitUntil <= Date.now() + 5_000, "the reset the error states");
	assert.equal(task.attempts ?? 0, 0, "a limit costs no attempt");
	const limit = held.status.limits.find(l => l.provider === "fake");
	assert.ok(limit && !limit.guessed, "a stated reset, not a backoff guess");
	assert.equal(held.status.held, 1);
	// Another task on the limited provider waits behind the limit instead of burning a turn on it.
	await planner.call("edit", { ops: [{ op: "add", task: { title: "behind", notes: "echo behind-ran", options } }] });
	const behind: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "behind").state === "held", { what: "a second task on the provider to be held" });
	assert.match(byTitle(behind, "behind").waitReason ?? "", /^rate-limit fake until/);
	assert.equal(prompts("behind-ran"), 0);
	assert.equal(prompts("resumed-ok"), 1);
	// The reset passes: both run, the first one on the same prompt a second time.
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "limited").status === "done" && byTitle(p, "behind").status === "done", { what: "both tasks to finish after the reset", timeoutMs: 30_000 });
	assert.match(byTitle(done, "limited").summary ?? "", /resumed-ok/);
	assert.equal(prompts("resumed-ok"), 2, "one prompt before the limit, one after it");
	assert.equal(prompts("behind-ran"), 1);
	assert.equal(done.status.limits.filter(l => l.until > Date.now() && l.provider === "fake").length, 0, "success clears the limit");
});

test("a spend budget holds new tasks once finished turns have spent it, until it is raised; running work finishes", { skip, timeout: 60_000 }, async () => {
	await planner.call("scheduler", { set: { budget: { day: 0.4 } } });
	await planner.call("edit", { ops: [{ op: "add", task: { title: "spender", notes: "cost 0.5\necho spent-ok", options: { project: options.project } } }] });
	const spent: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "spender").status === "done" && p.status.spend.some(u => u.window === "day" && u.over), { what: "the spender to finish over the cap" });
	assert.ok((byTitle(spent, "spender").cost ?? 0) >= 0.5, `AO reported the turn's cost (${byTitle(spent, "spender").cost})`);
	await planner.call("edit", { ops: [{ op: "add", task: { title: "blocked", notes: "echo budget-ran", options: { project: options.project } } }] });
	const held: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "blocked").state === "held", { what: "the next task to be held by the budget" });
	assert.match(byTitle(held, "blocked").waitReason ?? "", /^budget day 0\.\d\d\/0\.4 USD/);
	assert.ok((byTitle(held, "blocked").waitUntil ?? 0) > Date.now(), "it says when the spend leaves the day window");
	assert.equal(prompts("budget-ran"), 0);
	// Raising the cap lifts the hold; removing it too.
	await planner.call("scheduler", { set: { budget: { day: 50 } } });
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "blocked").status === "done", { what: "the held task to run after the cap was raised" });
	assert.match(byTitle(done, "blocked").summary ?? "", /budget-ran/);
	assert.equal(prompts("budget-ran"), 1);
	await planner.call("scheduler", { set: { budget: {} } });
});

test("a limit survives a planner crash: the hold is still there and the task is not sent again", { skip, timeout: 60_000 }, async () => {
	await planner.call("edit", { ops: [{ op: "add", task: { title: "durable", notes: "limited 6 durable-key\necho durable-ok", options } }] });
	await planner.waitFor((p: PlanView) => byTitle(p, "durable").state === "held", { what: "durable held" });
	await planner.restart({ kill: true });
	const after: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "durable").state === "held" || byTitle(p, "durable").status === "done", { what: "durable held again after the crash" });
	assert.equal(byTitle(after, "durable").state, "held", "no re-dispatch while the limit holds");
	assert.equal(prompts("durable-ok"), 1);
	await planner.waitFor((p: PlanView) => byTitle(p, "durable").status === "done", { what: "durable done after the reset", timeoutMs: 30_000 });
	assert.equal(prompts("durable-ok"), 2);
});
