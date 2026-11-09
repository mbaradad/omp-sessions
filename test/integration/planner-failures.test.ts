// How the planner treats the failure shapes real omp produces over ACP, end to end (planner process + AO + fake
// omp): a usage limit and a provider error both arrive as a *completed* turn whose reply is the error text; a
// JSON-RPC error is a failed turn; an omp that dies mid-turn leaves AO's turn running with the session exited.
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
	planner = await startPlannerFixture({ ao, usage: false, retryBaseMs: 100, pollMs: 200 });
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

const prompts = (marker: string): number => ao.fakeOmpFrames().filter(f => f.dir === "in" && f.msg?.method === "session/prompt" && JSON.stringify(f.msg.params.prompt).includes(marker)).length;

test("a usage-limit reply (a completed turn) holds the provider and puts the task back without using an attempt", { skip }, async () => {
	await planner.call("edit", { ops: [{ op: "add", task: { title: "limited", notes: "limited 30 planner-limit\necho after-limit", options } }] });
	const held: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "limited").state === "held", { what: "the limited task to be held" });
	assert.match(byTitle(held, "limited").waitReason ?? "", /rate-limit fake/);
	assert.ok(held.status.limits.some(l => l.provider === "fake"), "the provider limit is recorded");
	assert.notEqual(byTitle(held, "limited").status, "done");
	assert.equal(byTitle(held, "limited").attempts ?? 0, 0, "no attempt used");
});

test("a provider-error reply fails the run, so retries and backoff apply", { skip }, async () => {
	await planner.call("edit", { ops: [{ op: "add", task: { title: "provider-error", notes: "fail Error: provider exploded\necho never", options: { project: options.project, retries: 1 } } }] });
	// No model: no provider, so the limit the first test left on `fake` does not gate it.
	const done: PlanView = await planner.waitFor((p: PlanView) => ["failed", "done"].includes(byTitle(p, "provider-error").status), { what: "the provider-error task to settle", timeoutMs: 40_000 });
	assert.equal(byTitle(done, "provider-error").status, "failed");
	assert.match(byTitle(done, "provider-error").summary ?? "", /provider exploded/);
	assert.equal(prompts("provider exploded"), 2, "one retry after the first failure");
});

test("a JSON-RPC error is a failed turn", { skip }, async () => {
	await planner.call("edit", { ops: [{ op: "add", task: { title: "rpc-error", notes: "error internal kaboom", options: { ...options, model: undefined } } }] });
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "rpc-error").status === "failed", { what: "the rpc-error task to fail" });
	assert.match(byTitle(done, "rpc-error").summary ?? "", /kaboom/);
});

test("an omp that dies mid-turn ends the run as interrupted; it is never re-run unattended", { skip }, async () => {
	await planner.call("edit", { ops: [{ op: "add", task: { title: "crash", notes: "echo before-crash\ncrash", options: { ...options, model: undefined } } }] });
	const done: PlanView = await planner.waitFor((p: PlanView) => byTitle(p, "crash").state === "interrupted", { what: "the crashed task to be interrupted", timeoutMs: 40_000 });
	assert.equal(byTitle(done, "crash").status, "pending");
	assert.equal(prompts("before-crash"), 1);
	// Stays put: nothing dispatches it again while nobody acts.
	await new Promise(r => setTimeout(r, 2000)); // real time: the planner polls AO on its own clock
	assert.equal(prompts("before-crash"), 1);
	assert.equal(byTitle(await planner.plan(), "crash").state, "interrupted");
});
