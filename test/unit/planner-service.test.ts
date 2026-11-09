// The planner service against an in-memory AO: dispatch order of a graph under a concurrency limit, and
// restarts (crash before AO answered, crash mid-turn, a session killed meanwhile): nothing is dispatched
// twice, an interrupted task is marked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Planner } from "../../src/planner/planner";
import * as fs from "node:fs";
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

test("a model the spawn helper refuses fails the task without retry and leaves no session (G36); sessions start in AO bypass with the mode the task names (D11)", async t => {
	const ao = new FakeAo();
	ao.modelIds = ["anthropic/claude-x"];
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "add", task: { title: "typo", options: { model: "anthropic/claude-xx" } } }, { op: "add", task: { title: "asks", options: { mode: "ask", thinking: "low" } } }, { op: "add", task: { title: "plain" } }]);
	await until("typo failed", () => byTitle(p, "typo").status === "failed");
	assert.match(byTitle(p, "typo").summary ?? "", /Unknown omp model "anthropic\/claude-xx"/);
	await until("others sent", () => byTitle(p, "asks").run?.phase === "sent" && byTitle(p, "plain").run?.phase === "sent");
	assert.equal(ao.created, 2);
	const asks = ao.sessions.get(byTitle(p, "asks").run?.session as string)?.spawnBody;
	assert.deepEqual([asks?.mode, asks?.thinking, asks?.approvalMode], ["ask", "low", "bypass-permissions"]);
	const plain = ao.sessions.get(byTitle(p, "plain").run?.session as string)?.spawnBody;
	assert.deepEqual([plain?.mode, plain?.approvalMode], [undefined, "bypass-permissions"]);
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

test("someone resumes a dead host: AO fails the stuck turn with 'controller ended before the turn completed'; the task is interrupted, not failed or retried (G39)", async t => {
	const ao = new FakeAo();
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "add", task: { title: "long", options: { retries: 3 } } }]);
	const s = await until("sent", () => byTitle(p, "long").run?.phase === "sent" && byTitle(p, "long").run?.session);
	const session = ao.sessions.get(s);
	assert.ok(session);
	// A person (or the CLI) resumed the dead agent first; AO ended the turn as failed.
	const turn = session.conv.turns.find(x => x.state === "running");
	assert.ok(turn);
	turn.state = "failed";
	turn.errorMessage = "controller ended before the turn completed";
	ao.poke(s, "idle");
	await until("interrupted", () => byTitle(p, "long").interrupted);
	assert.equal(byTitle(p, "long").attempts, undefined, "no attempt used, nothing retried");
	assert.match(byTitle(p, "long").summary ?? "", /host died/);
});

test("a person's Stop cancels the running turn at the ACP level (-32800 'Request cancelled'): the task is interrupted and the lane paused, not failed and retried", async t => {
	const ao = new FakeAo();
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "lane.add", id: "l_00000000e5" }, { op: "add", task: { title: "stopped", lane: "l_00000000e5", options: { retries: 3 } } }, { op: "add", task: { title: "next", lane: "l_00000000e5" } }]);
	const s = await until("sent", () => byTitle(p, "stopped").run?.phase === "sent" && byTitle(p, "stopped").run?.session);
	const turn = ao.sessions.get(s)?.conv.turns.find(x => x.state === "running");
	assert.ok(turn);
	turn.state = "failed";
	turn.errorMessage = 'ACP session/prompt: {"code":-32800,"message":"Request cancelled"}';
	ao.poke(s, "idle");
	await until("interrupted", () => byTitle(p, "stopped").interrupted);
	assert.equal(byTitle(p, "stopped").attempts, undefined, "no attempt used, nothing retried");
	assert.equal(p.state.lanes[0].autoRun, false, "the lane is paused");
	await sleep(300);
	assert.equal(byTitle(p, "next").status, "pending", "the next task is not started unattended");
});

test("a task with a timeout still notices its turn ending within a moment (a slow re-check must not hold off events and polls)", async t => {
	const ao = new FakeAo();
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "add", task: { title: "timed", options: { timeoutMinutes: 10 } } }]);
	const s = await until("sent", () => byTitle(p, "timed").run?.phase === "sent" && byTitle(p, "timed").run?.session);
	// Let at least one check run (it arms the long re-check), then end the turn.
	await sleep(700);
	const at = Date.now();
	ao.finishTurn(s, "completed", "done");
	await until("done", () => byTitle(p, "timed").status === "done", 10_000);
	assert.ok(Date.now() - at < 5000, `noticed after ${Date.now() - at} ms`);
});

test("a new session starts with the user's default model and mode (config.json) when nothing else names one; a continued session and explicit options win", async t => {
	const ao = new FakeAo();
	const p = new Planner({ file: tempPlan(t), connect: async () => ao, pollMs: 100, userDefaults: () => ({ model: "anthropic/claude-x", mode: "edits" }) });
	p.start();
	t.after(() => p.stop());
	p.setConfig({ maxConcurrent: 0 });
	p.edit([{ op: "add", task: { title: "plain" } }, { op: "add", task: { title: "explicit", options: { model: "anthropic/other", mode: "plan" } } }, { op: "lane.add", id: "l_00000000ff" }, { op: "add", task: { title: "first", lane: "l_00000000ff" } }, { op: "add", task: { title: "second", lane: "l_00000000ff" } }]);
	await until("sent", () => ["plain", "explicit", "first"].every(n => byTitle(p, n).run?.phase === "sent"));
	const body = (title: string) => ao.sessions.get(byTitle(p, title).run?.session as string)?.spawnBody;
	assert.deepEqual([body("plain")?.model, body("plain")?.mode], ["anthropic/claude-x", "edits"]);
	assert.deepEqual([body("explicit")?.model, body("explicit")?.mode], ["anthropic/other", "plan"]);
	ao.finishTurn(byTitle(p, "first").run?.session as string, "completed", "one");
	await until("second sent", () => byTitle(p, "second").run?.phase === "sent");
	assert.equal(byTitle(p, "second").run?.via, "send");
	assert.equal(byTitle(p, "second").run?.settings?.model, undefined, "a continued session keeps its own model");
});

test("`scheduler {clearLimits}` forgets a provider limit and held work starts; a completed lane is cleared by new work and by a person's prompt (not by a /command)", async t => {
	const ao = new FakeAo();
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "add", task: { title: "held", options: { model: "anthropic/claude-x" } } }]);
	const s = await until("sent", () => byTitle(p, "held").run?.phase === "sent" && byTitle(p, "held").run?.session);
	ao.finishTurn(s, "completed", "429 You have reached your usage limit. Your limit resets at 2099-01-01T00:00:00Z. Try again in 9 hours.");
	await until("held", () => p.state.limits.anthropic && byTitle(p, "held").status === "pending");
	assert.equal(p.view().tasks.find(x => x.title === "held")?.state, "held");
	p.setConfig(undefined, ["openai"]);
	assert.ok(p.state.limits.anthropic, "naming another provider leaves it");
	p.setConfig(undefined, true);
	assert.equal(p.state.limits.anthropic, undefined);
	await until("held task re-dispatched", () => byTitle(p, "held").status === "running");

	// A lane marked completed: new work clears the mark, so does a person's prompt, a /command doesn't.
	const q = new FakeAo();
	const p2 = start(tempPlan(t), q);
	t.after(() => p2.stop());
	p2.edit([{ op: "lane.add", id: "l_00000000cc" }, { op: "add", task: { title: "one", lane: "l_00000000cc" } }]);
	const s2 = await until("one sent", () => byTitle(p2, "one").run?.phase === "sent" && byTitle(p2, "one").run?.session);
	q.finishTurn(s2, "completed", "done");
	await until("one done", () => byTitle(p2, "one").status === "done");
	p2.edit([{ op: "lane.complete", id: "l_00000000cc", completed: true }]);
	assert.equal(p2.state.lanes[0].completed, true);
	p2.edit([{ op: "add", task: { title: "two", lane: "l_00000000cc" } }]);
	await until("two running", () => byTitle(p2, "two").status === "running");
	assert.equal(p2.state.lanes[0].completed, undefined, "a task of the lane started");
	q.finishTurn(byTitle(p2, "two").run?.session as string, "completed", "done");
	await until("two done", () => byTitle(p2, "two").status === "done");
	p2.edit([{ op: "lane.complete", id: "l_00000000cc", completed: true }]);
	const session = byTitle(p2, "two").session as string;
	const personSays = (text: string) => {
		const sess = q.sessions.get(session);
		assert.ok(sess);
		sess.conv.messages.push({ turnId: "t-person", role: "user", text, streaming: false });
		q.poke(session, "idle");
		q.poke(session, "active");
	};
	personSays("/undo");
	await sleep(300);
	assert.equal(p2.state.lanes[0].completed, true, "a /command is not a prompt");
	personSays("one more thing please");
	await until("cleared by the prompt", () => p2.state.lanes[0].completed === undefined);
});

test("a turn AO marks completed while its last reply still streams: the summary waits for the final text; a reply that never settles is taken after the grace", async t => {
	const ao = new FakeAo();
	const p = new Planner({ file: tempPlan(t), connect: async () => ao, pollMs: 100, settleMs: 1500, userDefaults: () => ({}) });
	p.start();
	t.after(() => p.stop());
	p.setConfig({ maxConcurrent: 0 });
	p.edit([{ op: "add", task: { title: "races" } }, { op: "add", task: { title: "stuck" } }]);
	const s1 = await until("races sent", () => byTitle(p, "races").run?.phase === "sent" && byTitle(p, "races").run?.session);
	const s2 = await until("stuck sent", () => byTitle(p, "stuck").run?.phase === "sent" && byTitle(p, "stuck").run?.session);
	ao.finishTurnWhileStreaming(s1, "Found three bu");
	ao.finishTurnWhileStreaming(s2, "never fin");
	await sleep(500);
	assert.equal(byTitle(p, "races").status, "running", "not recorded while the reply streams");
	ao.settleReply(s1, "Found three bugs in parser.ts");
	await until("races done", () => byTitle(p, "races").status === "done");
	assert.equal(byTitle(p, "races").summary, "Found three bugs in parser.ts");
	// A reply that never stops streaming does not hold the task forever.
	await until("stuck done after the grace", () => byTitle(p, "stuck").status === "done", 8000);
});

test("implicit lanes start paused (like an old queue); lane.add arms its lane; `ensure` makes lane.add idempotent", async t => {
	const ao = new FakeAo();
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "add", task: { title: "in a new lane", lane: "sess-implicit" } }]);
	assert.equal(p.state.lanes.find(l => l.id === "sess-implicit")?.autoRun, false);
	await sleep(300);
	assert.equal(byTitle(p, "in a new lane").status, "pending", "nothing runs until somebody starts the lane");
	const { refs } = p.edit([{ op: "lane.add", id: "l_00000000a1", title: "explicit", ref: "l" }, { op: "lane.add", id: "l_00000000a1", ensure: true, title: "ignored", ref: "again" }]);
	assert.equal(p.state.lanes.find(l => l.id === "l_00000000a1")?.autoRun, true);
	assert.equal(p.state.lanes.find(l => l.id === "l_00000000a1")?.title, "explicit", "an existing lane is left as it is");
	assert.equal(refs.again, "l_00000000a1");
	assert.throws(() => p.edit([{ op: "lane.add", id: "l_00000000a1" }]), /lane l_00000000a1 exists/);
	// A task added to the implicit lane runs once the lane is resumed.
	p.edit([{ op: "lane.resume", id: "sess-implicit" }]);
	await until("runs after resume", () => byTitle(p, "in a new lane").status === "running" || byTitle(p, "in a new lane").status === "failed");
});

test("a model and thinking level a task asks for on a continued session are put back after its turn", async t => {
	const ao = new FakeAo();
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "lane.add", id: "l_00000000b2" }, { op: "add", task: { title: "first", lane: "l_00000000b2" } }, { op: "add", task: { title: "second", lane: "l_00000000b2", options: { model: "anthropic/other", thinking: "low" } } }]);
	const s = await until("first sent", () => byTitle(p, "first").run?.phase === "sent" && byTitle(p, "first").run?.session);
	ao.models_.set(s, "anthropic/claude-x");
	ao.thinking_.set(s, "high");
	ao.finishTurn(s, "completed", "one");
	await until("second sent", () => byTitle(p, "second").run?.phase === "sent");
	assert.equal(ao.models_.get(s), "anthropic/other");
	assert.equal(ao.thinking_.get(s), "low");
	ao.finishTurn(s, "completed", "two");
	await until("second done", () => byTitle(p, "second").status === "done");
	await until("restored", () => ao.models_.get(s) === "anthropic/claude-x" && ao.thinking_.get(s) === "high");
});

test("a scheduled start that passed while the planner was down fires at boot", async t => {
	const file = tempPlan(t);
	const ao = new FakeAo();
	let p = start(file, ao);
	p.edit([{ op: "lane.add", id: "l_00000000c3" }, { op: "add", task: { title: "due", lane: "l_00000000c3" } }, { op: "lane.startAt", id: "l_00000000c3", at: Date.now() + 3_600_000 }]);
	await sleep(200);
	assert.equal(byTitle(p, "due").status, "pending");
	p.stop();
	// The planner is down; the start time passes (edit the file, as an hour going by would).
	const plan = JSON.parse(fs.readFileSync(file, "utf8"));
	plan.lanes[0].startAt = Date.now() - 1000;
	fs.writeFileSync(file, JSON.stringify(plan));
	p = start(file, ao);
	t.after(() => p.stop());
	await until("fires at boot", () => byTitle(p, "due").run?.phase === "sent");
	assert.equal(p.state.lanes[0].startAt, undefined);
});

test("the hibernation setting is applied on every (re)connect to AO, and an AO that refuses doesn't stop the planner (G28)", async t => {
	const ao = new FakeAo();
	ao.hibernation = { enabled: true, changed: true };
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	await until("applied on connect", () => ao.hibernationCalls >= 1);
	// The stream reopens (the daemon restarted and forgot the flag): applied again.
	ao.reopen();
	await until("applied again", () => ao.hibernationCalls >= 2);
	p.edit([{ op: "add", task: { title: "still works" } }]);
	await until("dispatches", () => byTitle(p, "still works").run?.phase === "sent");
});
