// The Switchyard Overview's data model built from a real planner (test/planner-fixture.mjs) and AO sessions (an isolated
// daemon with the scripted fake omp): a session that asks a question, two queues with a dependency, a scheduled queue,
// a task held by provider usage. The same builders the extension host feeds (src/overview/overview-core.ts).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AoClient } from "../../src/ao/client";
import { type AoSessionModel, AoSessionWatcher } from "../../src/ao/model";
import { prFactsOf } from "../../src/ao/pr";
import { laneQueue, metaOf } from "../../src/ext/session-view";
import { type OverviewSession, buildOverview, overviewSession } from "../../src/overview/overview-core";
import type { PlanView } from "../../src/planner/types";
import { sessionDag } from "../../src/shared/session-graph";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";
import { type PlannerFixture, startPlannerFixture } from "../planner-fixture.mjs";

const HOUR = 3_600_000;

let ao: AoFixture;
let client: AoClient;
let watcher: AoSessionWatcher;
let planner: PlannerFixture;
let project: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	// A provider window nearly full: `spare` work is held (and the window shows as a meter at the hold threshold).
	ao.setUsage([{ provider: "fake", id: "5h", label: "5 Hour", usedPercent: 97, resetsAt: Date.now() + 2 * HOUR }]);
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	project = await ao.createProject(ao.scratchRepo());
	watcher = new AoSessionWatcher(client);
	await watcher.start();
	planner = await startPlannerFixture({ ao, pollMs: 200, usageEveryMs: 500 });
});

after(async () => {
	watcher?.close();
	await planner?.stop();
	await ao?.stop();
});

/** Resolves with the session's model once `pred` holds; the timer only bounds a hang. */
function waitForSession(id: string, what: string, pred: (m: AoSessionModel) => boolean, timeoutMs = 30_000): Promise<AoSessionModel> {
	const { promise, resolve, reject } = Promise.withResolvers<AoSessionModel>();
	const check = (m: AoSessionModel | undefined) => {
		if (!m || !pred(m)) return;
		clearTimeout(timer);
		off();
		resolve(m);
	};
	const off = watcher.onChange(({ changed }) => {
		for (const m of changed) if (m.id === id) check(m);
	});
	const timer = setTimeout(() => {
		off();
		reject(new Error(`timed out waiting for ${what}: state ${watcher.get(id)?.state}`));
	}, timeoutMs);
	void watcher.refresh(id).then(check, () => undefined);
	return promise;
}

async function spawn(name: string, prompt: string): Promise<string> {
	const { session } = await client.spawnSession({ projectId: project, harness: "omp", mode: "chat", kind: "worker", displayName: name, approvalMode: "default", prompt });
	return session.id;
}

/** What the extension host does: each session's meta with the planner's queue summary for it. */
function sessionsFor(plan: PlanView): OverviewSession[] {
	return watcher.all().map(model => {
		const meta = metaOf(model, model.cwd ?? "/work/repo");
		const queue = laneQueue(plan, model.id);
		return overviewSession({ ...meta, ...(queue && { queue }) }, { project: "repo", ...(model.question && { question: model.question }), prs: (model.view.prs ?? []).map(prFactsOf) });
	});
}

test("the overview of a real planner and AO: needs you, next up, held, scheduler meters and the dependency graph", { skip }, async () => {
	const up = await spawn("upstream", "write up.txt hello");
	const down = await spawn("downstream", "write down.txt hello");
	const asking = await spawn("asking", "ask Ship it? | yes | no");
	await waitForSession(up, "upstream idle", m => m.state === "idle");
	await waitForSession(down, "downstream idle", m => m.state === "idle");
	await waitForSession(asking, "the question", m => m.state === "needs_input");

	const startAt = Date.now() + 2 * HOUR;
	await planner.call("edit", {
		ops: [
			{ op: "lane.add", id: up, session: up, autoRun: false },
			{ op: "lane.add", id: down, session: down, autoRun: false },
			{ op: "add", ref: "build", task: { title: "Build API", lane: up } },
			{ op: "add", task: { title: "Ship docs", lane: down, after: ["@build"] } },
			{ op: "lane.startAt", id: up, at: startAt },
			{ op: "add", task: { title: "Spare cleanup", notes: "echo spare", usage: "spare", options: { project, model: "fake/fake-model" } } },
		],
	});
	const plan: PlanView = await planner.waitFor((p: PlanView) => p.tasks.some(t => t.title === "Spare cleanup" && t.state === "held") && (p.status.usageWindows?.length ?? 0) > 0, { what: "the held task and the usage window" });
	const model = buildOverview({ now: Date.now(), sessions: sessionsFor(plan), orchestrators: [], plan });

	// Needs you: the session's own question.
	const ask = model.needsYou.find(n => n.session === asking);
	assert.equal(ask?.kind, "question");
	assert.match(ask?.detail ?? "", /Ship it/);
	assert.equal(model.working.length, 0);

	// Next up: the scheduled queue's task by its start time, then the one that waits for it.
	assert.deepEqual(
		model.nextUp.map(n => [n.title, n.state]),
		[
			["Build API", "scheduled"],
			["Ship docs", "blocked"],
		],
	);
	const [build, ship] = model.nextUp;
	assert.ok(build.at !== undefined && Math.abs(build.at - startAt) < 1000, `scheduled at the lane's start: ${build.at} vs ${startAt}`);
	assert.equal(build.session, up);
	assert.deepEqual(ship.blockedBy.map(b => b.title), ["Build API"]);

	// Held: the spare task waits on the provider's usage window; the group says when it lifts.
	assert.equal(model.held.length, 1);
	const [held] = model.held;
	assert.equal(held.kind, "usage");
	assert.deepEqual(held.tasks.map(t => t.title), ["Spare cleanup"]);
	assert.ok(held.until !== undefined && held.until > Date.now(), "the window's reset is when the hold lifts");

	// Scheduler: limit, counts and the window as a meter at the hold threshold.
	const sched = model.scheduler;
	assert.ok(sched);
	assert.equal(sched.held, 1);
	assert.equal(sched.blocked, 1);
	assert.equal(sched.scheduled, 1);
	const meter = sched.usage.find(u => u.provider === "fake");
	assert.equal(meter?.percent, 97);
	assert.equal(meter?.level, "hold");

	// Dependency graph: the downstream session waits for the upstream one; the planner's state is its badge.
	assert.deepEqual(model.graph.map(g => [g.id, g.state]), [[up, "idle"], [down, "queued"]]);
	const dag = sessionDag(model.graph, model.graph, new Date());
	assert.equal(dag.nodes.find(n => n.id === up)?.badge?.tone, "wait");
	assert.equal(dag.nodes.find(n => n.id === down)?.badge?.text, "blocked");
	assert.deepEqual(dag.edges.map(e => [e.from, e.to, e.classes]), [[up, down, ["enforced", "pending"]]]);
});
