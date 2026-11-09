// The planner service against an in-memory AO: dispatch order of a graph under a concurrency limit, and
// restarts (crash before AO answered, crash mid-turn, a session killed meanwhile): nothing is dispatched
// twice, an interrupted task is marked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { FakeAo, byTitle, running, start, tempPlan, until } from "./planner-fake-ao";
import { loadPlan } from "../../src/planner/store";


test("A → (B, C) under a limit of 1, with a planner restart mid-run: each task runs once, in order, with A's result", async t => {
	const file = tempPlan(t);
	const ao = new FakeAo();
	let p = start(file, ao);
	p.setConfig({ maxConcurrent: 1 });
	p.edit([
		{ op: "add", ref: "a", task: { title: "A" } },
		{ op: "add", ref: "b", task: { title: "B", after: ["@a"] } },
		{ op: "add", ref: "c", task: { title: "C", after: ["@a"] } },
	]);
	const a = await until("A running in AO", () => byTitle(p, "A").run?.phase === "sent" && byTitle(p, "A").run?.session);
	assert.deepEqual(running(p), ["A"]);
	ao.finishTurn(a, "completed", "A found 3 bugs");
	const b = await until("B sent", () => byTitle(p, "B").run?.phase === "sent" && byTitle(p, "B").run?.session);
	assert.equal(byTitle(p, "A").status, "done");
	assert.equal(byTitle(p, "C").status, "pending");
	assert.match(ao.promptOf(b), /### A\nA found 3 bugs/);
	// The planner goes away while B runs in AO, and comes back from its file.
	p.stop();
	p = start(file, ao);
	await sleep(300);
	assert.deepEqual(running(p), ["B"]);
	assert.equal(ao.created, 2);
	ao.finishTurn(b, "completed", "B done");
	const c = await until("C sent", () => byTitle(p, "C").run?.phase === "sent" && byTitle(p, "C").run?.session);
	ao.finishTurn(c, "completed", "C done");
	await until("C done", () => byTitle(p, "C").status === "done");
	assert.equal(ao.created, 3);
	assert.deepEqual(
		p.state.tasks.map(x => [x.title, x.status, x.summary]),
		[
			["A", "done", "A found 3 bugs"],
			["B", "done", "B done"],
			["C", "done", "C done"],
		],
	);
	assert.ok(Math.abs((byTitle(p, "C").cost ?? 0) - 0.1) < 1e-9);
	p.stop();
});

test("a crash after AO got the spawn but before it answered: the replay finds the same session", async t => {
	const file = tempPlan(t);
	const ao = new FakeAo();
	ao.dropAnswers = true;
	let p = start(file, ao);
	p.edit([{ op: "add", task: { title: "only" } }]);
	await until("spawn reached AO", () => ao.created === 1);
	assert.equal(loadPlan(file).tasks[0].run?.phase, "dispatching");
	p.stop();
	ao.dropAnswers = false;
	p = start(file, ao);
	const session = await until("replayed", () => byTitle(p, "only").run?.phase === "sent" && byTitle(p, "only").run?.session);
	assert.equal(session, "s1");
	assert.equal(ao.created, 1);
	ao.finishTurn(session, "completed", "ok");
	await until("done", () => byTitle(p, "only").status === "done");
	p.stop();
});

test("a session killed in AO while the planner was down: the task comes back interrupted and stays put", async t => {
	const file = tempPlan(t);
	const ao = new FakeAo();
	let p = start(file, ao);
	p.edit([{ op: "lane.add", id: "l_00000000aa" }, { op: "add", task: { title: "one", lane: "l_00000000aa" } }, { op: "add", task: { title: "two", lane: "l_00000000aa" } }]);
	const s = await until("one sent", () => byTitle(p, "one").run?.phase === "sent" && byTitle(p, "one").run?.session);
	p.stop();
	ao.finishTurn(s, "recovered");
	p = start(file, ao);
	await until("interrupted", () => byTitle(p, "one").interrupted);
	const view = p.view().tasks.find(x => x.title === "one");
	assert.equal(view?.state, "interrupted");
	assert.equal(p.state.lanes[0].autoRun, false);
	await sleep(300);
	assert.equal(ao.created, 1);
	assert.deepEqual(running(p), []);
	// A person restarts it: it continues the lane's session with a message.
	p.edit([{ op: "run", id: byTitle(p, "one").id }]);
	await until("re-sent", () => byTitle(p, "one").run?.phase === "sent");
	assert.equal(byTitle(p, "one").run?.via, "send");
	assert.equal(ao.created, 1);
	p.stop();
});

test("abort and timeout interrupt the AO turn; abort pauses, a timeout fails", async t => {
	const ao = new FakeAo();
	const file = tempPlan(t);
	const p = start(file, ao);
	p.edit([{ op: "add", task: { title: "long" } }, { op: "add", task: { title: "slow", options: { timeoutMinutes: 0.001 } } }]);
	await until("both sent", () => running(p).length === 2 && p.state.tasks.every(x => x.run?.phase === "sent"));
	p.edit([{ op: "abort", id: byTitle(p, "long").id }]);
	await until("aborted", () => byTitle(p, "long").status === "pending");
	assert.equal(byTitle(p, "long").paused, true);
	await until("timed out", () => byTitle(p, "slow").status === "failed");
	assert.match(byTitle(p, "slow").summary ?? "", /Timed out/);
	p.stop();
});

test("a limit omp gave up retrying arrives as a completed turn: the task is held until the reset, not done (G35)", async t => {
	const ao = new FakeAo();
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	const reset = new Date(Date.now() + 2 * 3_600_000).toISOString();
	p.edit([
		{ op: "add", task: { title: "limited", options: { model: "anthropic/claude-x", retries: 2 } } },
		{ op: "add", task: { title: "talks about limits" } },
	]);
	const s1 = await until("limited sent", () => byTitle(p, "limited").run?.phase === "sent" && byTitle(p, "limited").run?.session);
	ao.finishTurn(s1, "completed", `429 You have reached your usage limit. Your limit resets at ${reset}. Please try again in 2 hours.`);
	await until("held", () => byTitle(p, "limited").status === "pending" && p.state.limits.anthropic);
	assert.equal(byTitle(p, "limited").attempts, undefined);
	assert.equal(p.state.limits.anthropic.until, Date.parse(reset));
	assert.equal(p.view().tasks.find(x => x.title === "limited")?.state, "held");
	// A normal answer that merely mentions rate limits is a normal answer.
	const s2 = await until("other sent", () => byTitle(p, "talks about limits").run?.phase === "sent" && byTitle(p, "talks about limits").run?.session);
	ao.finishTurn(s2, "completed", "I added rate limiting to the API: a token bucket per client, 100 requests a minute; clients above it get 429 and a Retry-After header. Tests cover the bucket refill.");
	await until("done", () => byTitle(p, "talks about limits").status === "done");
});

test("a model AO doesn't list fails the dispatch before any session exists (G36); sessions start in bypass-permissions unless told otherwise", async t => {
	const ao = new FakeAo();
	ao.modelIds = ["anthropic/claude-x"];
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "add", task: { title: "typo", options: { model: "anthropic/claude-xx" } } }, { op: "add", task: { title: "asks", options: { approvalMode: "default" } } }, { op: "add", task: { title: "plain" } }]);
	await until("typo failed", () => byTitle(p, "typo").status === "failed");
	assert.match(byTitle(p, "typo").summary ?? "", /doesn't know the model "anthropic\/claude-xx"/);
	await until("others sent", () => byTitle(p, "asks").run?.phase === "sent" && byTitle(p, "plain").run?.phase === "sent");
	assert.equal(ao.created, 2);
	assert.equal(ao.sessions.get(byTitle(p, "asks").run?.session as string)?.spawnBody.approvalMode, "default");
	assert.equal(ao.sessions.get(byTitle(p, "plain").run?.session as string)?.spawnBody.approvalMode, "bypass-permissions");
	assert.equal(ao.sessions.get(byTitle(p, "plain").run?.session as string)?.spawnBody.prompt, undefined, "the task goes out as a message, not with the spawn");
});

test("a chat host that dies mid-turn leaves the task interrupted; running it again resumes the agent and continues the session (G39)", async t => {
	const file = tempPlan(t);
	const ao = new FakeAo();
	let p = start(file, ao);
	t.after(() => p.stop());
	p.edit([{ op: "lane.add", id: "l_00000000dd" }, { op: "add", task: { title: "long", lane: "l_00000000dd" } }]);
	const s = await until("sent", () => byTitle(p, "long").run?.phase === "sent" && byTitle(p, "long").run?.session);
	ao.killHost(s);
	await until("interrupted", () => byTitle(p, "long").interrupted);
	assert.match(byTitle(p, "long").summary ?? "", /host died/);
	assert.equal(p.state.lanes[0].autoRun, false);
	// Across a planner restart it stays put: nothing is re-sent unattended.
	p.stop();
	p = start(file, ao);
	t.after(() => p.stop());
	await sleep(300);
	assert.equal(byTitle(p, "long").status, "pending");
	assert.deepEqual(ao.resumed, []);
	p.edit([{ op: "run", id: byTitle(p, "long").id }]);
	await until("re-sent", () => byTitle(p, "long").run?.phase === "sent");
	assert.deepEqual(ao.resumed, [s]);
	assert.equal(ao.created, 1);
	assert.equal(byTitle(p, "long").run?.session, s);
});

test("a lane is found by its id and by its AO session; its session is known from dispatch on; the lane reports its state", async t => {
	const ao = new FakeAo();
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	const at = Date.now() + 3_600_000;
	const { refs } = p.edit([{ op: "lane.add", ref: "l" }, { op: "add", task: { title: "first", lane: "@l" } }, { op: "add", task: { title: "later", startAt: at, lane: "@l" } }, { op: "lane.add", ref: "m", autoRun: false }, { op: "add", task: { title: "parked", lane: "@m" } }]);
	const session = await until("first sent", () => byTitle(p, "first").run?.phase === "sent" && byTitle(p, "first").run?.session);
	// Running: the lane already names its session.
	assert.equal(p.state.lanes.find(l => l.id === refs.l)?.session, session);
	assert.equal(p.getQueue(session).id, refs.l);
	assert.equal(p.getQueue(refs.l).state, "running");
	assert.deepEqual(p.view(session).lanes.map(l => l.id), [refs.l]);
	assert.equal(p.getQueue(refs.m).state, "paused");
	ao.finishTurn(session, "completed", "done");
	await until("later is next", () => byTitle(p, "first").status === "done");
	const q = p.getQueue(session);
	assert.equal(q.state, "scheduled");
	assert.equal(q.waitUntil, at);
	// Queue ops through the session id land on the same lane.
	await p.queue(session, [{ op: "add", title: "third" }]);
	assert.equal(p.getQueue(refs.l).tasks.length, 3);
	assert.equal(p.state.lanes.length, 2);
});

test("any provider error omp ends as a completed reply fails the run (retries apply); a host that died with no event is noticed", async t => {
	const ao = new FakeAo();
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.setConfig({ maxConcurrent: 0 });
	p.edit([{ op: "add", task: { title: "errs" } }, { op: "add", task: { title: "retries", options: { retries: 1 } } }, { op: "add", task: { title: "silent death" } }]);
	const sErr = await until("errs sent", () => byTitle(p, "errs").run?.phase === "sent" && byTitle(p, "errs").run?.session);
	const sRetry = await until("retries sent", () => byTitle(p, "retries").run?.phase === "sent" && byTitle(p, "retries").run?.session);
	const sDead = await until("dead sent", () => byTitle(p, "silent death").run?.phase === "sent" && byTitle(p, "silent death").run?.session);
	ao.finishTurn(sErr, "completed", "Error: fake provider failure");
	ao.finishTurn(sRetry, "completed", '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
	ao.killHostSilently(sDead);
	await until("errs failed", () => byTitle(p, "errs").status === "failed");
	assert.match(byTitle(p, "errs").summary ?? "", /Error: fake provider failure/);
	await until("retry scheduled", () => byTitle(p, "retries").status === "pending" && byTitle(p, "retries").attempts === 1);
	assert.match(byTitle(p, "retries").summary ?? "", /Attempt 1 of 2 failed/);
	await until("silent death interrupted", () => byTitle(p, "silent death").interrupted);
});

test("an undone task stops satisfying `after` for dependents that haven't started; redoing it brings it back (checkpoints)", async t => {
	const ao = new FakeAo();
	let undone = false;
	const p = start(tempPlan(t), ao, { undone: async () => undone });
	t.after(() => p.stop());
	p.edit([{ op: "add", ref: "a", task: { title: "A" } }, { op: "add", task: { title: "B", after: ["@a"], startAt: Date.now() + 3_600_000 } }]);
	const s = await until("A sent", () => byTitle(p, "A").run?.phase === "sent" && byTitle(p, "A").run?.session);
	ao.finishTurn(s, "completed", "A done");
	await until("A done with its turn kept", () => byTitle(p, "A").status === "done" && byTitle(p, "A").turn);
	assert.equal(p.view().tasks.find(x => x.title === "B")?.state, "scheduled");
	undone = true;
	ao.poke(s, "active");
	ao.poke(s, "idle");
	await until("A undone", () => byTitle(p, "A").undone);
	assert.equal(p.view().tasks.find(x => x.title === "B")?.state, "blocked");
	assert.equal(byTitle(p, "A").status, "done", "no automatic re-run");
	undone = false;
	ao.poke(s, "active");
	ao.poke(s, "idle");
	await until("A redone", () => !byTitle(p, "A").undone);
	assert.equal(p.view().tasks.find(x => x.title === "B")?.state, "scheduled");
});

test("requeue {clean} undoes the failed attempt first, and only for the last task of a session", async t => {
	const ao = new FakeAo();
	const rewound: string[] = [];
	const p = start(tempPlan(t), ao, { rewind: async task => void rewound.push(task.title) });
	t.after(() => p.stop());
	p.edit([{ op: "lane.add", id: "l_00000000ee" }, { op: "add", task: { title: "one", lane: "l_00000000ee" } }, { op: "add", task: { title: "two", lane: "l_00000000ee" } }]);
	const s = await until("one sent", () => byTitle(p, "one").run?.phase === "sent" && byTitle(p, "one").run?.session);
	ao.finishTurn(s, "completed", "one done");
	await until("two sent", () => byTitle(p, "two").run?.phase === "sent");
	ao.finishTurn(s, "failed" as never);
	await until("two failed", () => byTitle(p, "two").status === "failed");
	// "one" can't be undone: the later "two" shares its session and would be rewound too.
	assert.throws(() => p.edit([{ op: "requeue", id: byTitle(p, "one").id, clean: true }]), /would rewind the later task "two"/);
	p.edit([{ op: "requeue", id: byTitle(p, "two").id, clean: true }]);
	assert.equal(byTitle(p, "two").clean, true);
	await until("two re-sent", () => byTitle(p, "two").run?.phase === "sent");
	assert.deepEqual(rewound, ["two"]);
	assert.equal(byTitle(p, "two").clean, undefined);
});

test("requeue {clean} without the checkpoints hook fails the dispatch with a clear message", async t => {
	const ao = new FakeAo();
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "add", task: { title: "only" } }]);
	const s = await until("sent", () => byTitle(p, "only").run?.phase === "sent" && byTitle(p, "only").run?.session);
	ao.finishTurn(s, "failed" as never);
	await until("failed", () => byTitle(p, "only").status === "failed");
	p.edit([{ op: "requeue", id: byTitle(p, "only").id, clean: true }]);
	await until("failed again", () => byTitle(p, "only").status === "failed" && (byTitle(p, "only").summary ?? "").includes("clean retry"));
});
