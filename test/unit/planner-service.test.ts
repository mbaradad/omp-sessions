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
