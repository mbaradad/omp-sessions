// The project's orchestrator on a real, isolated AO daemon (test/ao-fixture.mjs) with the scripted fake omp:
// started on demand by a task, listed with its workers, steered, configured and replaced, through src/ao only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AoClient, AoError } from "../../src/ao/client";
import { listOrchestrators, orchestratorConfig, orchestratorOf, resolveProject, restartOrchestrator, setOrchestratorConfig, submitTask } from "../../src/ao/orchestrator";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

let ao: AoFixture;
let client: AoClient;
let repo: string;
let projectId: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	repo = ao.scratchRepo("orch");
	projectId = await ao.createProject(repo, "orch");
});

after(async () => {
	await ao?.stop();
});

/** Polls until `check` returns something, bounded: only a hang fails on the timer. */
async function until<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await check();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${ao.daemonLog().split("\n").slice(-15).join("\n")}`);
		await new Promise(r => setTimeout(r, 300));
	}
}

test("resolveProject: id, name, folder; an unknown name lists what AO has", async () => {
	assert.equal((await resolveProject(client, "orch", "/")).id, projectId);
	assert.equal((await resolveProject(client, repo, "/")).id, projectId);
	assert.equal((await resolveProject(client, undefined, repo)).id, projectId);
	assert.equal((await resolveProject(client, ".", repo)).id, projectId);
	await assert.rejects(() => resolveProject(client, "nope", "/"), /no project "nope"; AO's projects: orch/);
	await assert.rejects(() => resolveProject(client, undefined, "/tmp", { create: false }), /not in a git repository/);
});

test("no orchestrator until a task starts one; the task reaches it and the second one reuses it", { skip }, async () => {
	const project = await resolveProject(client, "orch", "/");
	assert.equal(await orchestratorOf(client, project), undefined);
	assert.deepEqual(await listOrchestrators(client), []);

	const first = await submitTask(client, project, "Move the billing module to the new API");
	assert.equal(first.started, true);
	assert.equal(first.projectId, projectId);
	assert.equal(first.mode, "send");
	assert.ok(first.turnId, "AO says which turn the task started");

	// The fake omp echoes the whole prompt back: the reply is what the orchestrator "said".
	const idle = await until("the orchestrator's reply", async () => {
		const o = await orchestratorOf(client, project);
		return o?.state === "idle" && o.reply?.includes("Move the billing module") ? o : undefined;
	});
	assert.equal(idle.id, first.orchestrator);
	assert.equal(idle.active, true);
	assert.equal(idle.mode, "chat");
	assert.equal(idle.projectName, "orch");
	assert.equal(idle.config.permissions, undefined, "nothing was written to the project's settings");

	const second = await submitTask(client, project, "And update its tests");
	assert.equal(second.started, false);
	assert.equal(second.orchestrator, first.orchestrator);
	await until("the second reply", async () => (await orchestratorOf(client, project))?.reply?.includes("update its tests"));

	const all = await listOrchestrators(client);
	assert.deepEqual(
		all.map(o => o.id),
		[first.orchestrator],
	);
});

test("workers are the project's worker sessions, never the orchestrator itself", { skip }, async () => {
	const project = await resolveProject(client, "orch", "/");
	const { session } = await client.spawnSession({ projectId, harness: "omp", mode: "chat", prompt: "echo from a worker", displayName: "Billing worker" });
	const o = await until("the worker in the orchestrator's view", async () => {
		const info = await orchestratorOf(client, project);
		return info?.workers.some(w => w.id === session.id) ? info : undefined;
	});
	assert.ok(!o.workers.some(w => w.id === o.id));
	const worker = o.workers.find(w => w.id === session.id);
	assert.equal(worker?.title, "Billing worker");
	assert.equal(worker?.harness, "omp");
	assert.deepEqual(worker?.prs, []);
	assert.equal(o.counts.workers, o.workers.length);
});

test("config: set, read back, keep unrelated project settings, clear; bad values are refused before anything is written", { skip }, async () => {
	const before = await client.getProject(projectId);
	const original = "config" in before ? before.config : undefined;
	// Whatever the project already says (the fixture names the workers' harness; the first test saved the orchestrator's).
	const baseline = await orchestratorConfig(client, projectId);

	const set = await setOrchestratorConfig(client, projectId, { harness: "omp", model: "fake/model", rules: "Always ask for a review.", workersRequestReview: true });
	assert.deepEqual(set, { ...baseline, harness: "omp", model: "fake/model", rules: "Always ask for a review.", workersRequestReview: true });
	assert.deepEqual(await orchestratorConfig(client, projectId), set);
	const after = await client.getProject(projectId);
	assert.equal("config" in after && after.config?.defaultBranch, original?.defaultBranch, "the rest of AO's project config survives the write");

	const cleared = await setOrchestratorConfig(client, projectId, { model: null, rules: null });
	assert.deepEqual(cleared, { ...baseline, harness: "omp", workersRequestReview: true });

	// AO validates the settings it is given: a harness it doesn't know is refused before anything is written.
	await assert.rejects(() => setOrchestratorConfig(client, projectId, { harness: "no-such-harness" }), AoError);
	await assert.rejects(() => setOrchestratorConfig(client, projectId, { permissions: "yolo" }), AoError);
	assert.deepEqual(await orchestratorConfig(client, projectId), cleared);
	// Without an orchestrator harness AO refuses to start one: the next start has to choose again.
	await setOrchestratorConfig(client, projectId, { harness: null, workersRequestReview: null });
});

test("a steered message is delivered; a restart replaces the orchestrator", { skip }, async () => {
	const project = await resolveProject(client, "orch", "/");
	const before = await orchestratorOf(client, project);
	assert.ok(before);
	const steered = await submitTask(client, project, "Change of plan: skip the tests", { steer: true });
	assert.equal(steered.mode, "steer");
	assert.equal(steered.orchestrator, before.id);
	await until("the steered reply", async () => (await orchestratorOf(client, project))?.reply?.includes("skip the tests"));

	const fresh = await restartOrchestrator(client, project);
	assert.equal(fresh.started, true);
	assert.notEqual(fresh.id, before.id);
	const now = await orchestratorOf(client, project);
	assert.equal(now?.id, fresh.id);
	assert.equal(now?.active, true);
	const old = (await client.listOrchestrators({ projectId, active: false })).map(v => v.id);
	assert.ok(old.includes(before.id), "the replaced orchestrator is terminated, not deleted");
});

test("an empty task is refused before anything starts", async () => {
	const project = await resolveProject(client, "orch", "/");
	await assert.rejects(() => submitTask(client, project, "   "), /nothing to submit/);
});
