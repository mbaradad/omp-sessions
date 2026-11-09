// The planner service against an in-memory AO that behaves like AO where it matters: spawn dedupes on
// clientRequestId, messages dedupe on clientMessageId, turns finish when the test says so. Covers the
// dispatch order of a graph under a concurrency limit, and restarts (crash before AO answered, crash
// mid-turn, a session killed meanwhile): nothing is dispatched twice, an interrupted task is marked.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { AoConversationInfo, AoPort, AoStreamHandlers, AoTurnInfo } from "../../src/planner/ao-port";
import { Planner } from "../../src/planner/planner";
import { loadPlan } from "../../src/planner/store";
import type { Task } from "../../src/planner/types";

interface FakeSession {
	id: string;
	terminated: boolean;
	turns: AoTurnInfo[];
	conv: AoConversationInfo;
	spawnBody: Record<string, unknown>;
}

class FakeAo implements AoPort {
	readonly url = "fake://ao";
	sessions = new Map<string, FakeSession>();
	byKey = new Map<string, string>();
	/** Sessions actually created (a replayed spawn doesn't count). */
	created = 0;
	/** While set, spawn calls reach AO (are recorded) but their answers never come back. */
	dropAnswers = false;
	private handlers: AoStreamHandlers | undefined;
	private seq = 0;

	private event(session: string): void {
		this.handlers?.onEvent(++this.seq, session, "idle");
	}

	private turn(s: FakeSession, text: string, clientMessageId?: string): string {
		const id = `${s.id}-t${s.conv.turns.length + 1}`;
		s.conv.turns.push({ id, state: "running", requestedAt: Date.now() + s.conv.turns.length });
		s.conv.messages.push({ turnId: id, role: "user", text, streaming: false, ...(clientMessageId ? { clientMessageId } : {}) });
		return id;
	}

	async spawn(body: Record<string, unknown>) {
		const key = String(body.clientRequestId);
		let id = this.byKey.get(key);
		if (!id) {
			id = `s${++this.created}`;
			const s: FakeSession = { id, terminated: false, turns: [], conv: { turns: [], messages: [], cost: 0 }, spawnBody: body };
			s.turns = s.conv.turns;
			this.sessions.set(id, s);
			this.byKey.set(key, id);
			if (typeof body.prompt === "string") this.turn(s, body.prompt);
		}
		if (this.dropAnswers) return new Promise<never>(() => {});
		return { session: id };
	}

	async send(session: string, text: string, clientMessageId: string) {
		const s = this.sessions.get(session);
		assert.ok(s && !s.terminated);
		const dup = s.conv.messages.find(m => m.clientMessageId === clientMessageId);
		return { turn: dup ? undefined : this.turn(s, text, clientMessageId) } as { turn?: string };
	}

	async conversation(session: string) {
		const s = this.sessions.get(session);
		if (!s) throw Object.assign(new Error("not found"), { status: 404 });
		return structuredClone(s.conv);
	}

	async session(id: string) {
		const s = this.sessions.get(id);
		return s && { id, terminated: s.terminated };
	}

	async activeSessions() {
		return [];
	}

	async interrupt(session: string) {
		this.finishTurn(session, "interrupted");
	}

	async restore(session: string) {
		const s = this.sessions.get(session);
		if (s) s.terminated = false;
	}

	async setModel() {
		return undefined;
	}

	async setThinking() {
		return undefined;
	}

	async projectFor() {
		return undefined;
	}

	subscribe(_after: number | undefined, handlers: AoStreamHandlers) {
		this.handlers = handlers;
		setImmediate(() => handlers.onOpen(false));
		return { close: () => (this.handlers = undefined), lastEventId: undefined };
	}

	/** Ends the session's running turn. */
	finishTurn(session: string, state: AoTurnInfo["state"], reply?: string, cost = 0.1): void {
		const s = this.sessions.get(session);
		const turn = s?.conv.turns.find(t => t.state === "running");
		assert.ok(s && turn, `no running turn in ${session}`);
		turn.state = state;
		if (reply) s.conv.messages.push({ turnId: turn.id, role: "assistant", text: reply, streaming: false });
		s.conv.cost = (s.conv.cost ?? 0) + cost;
		this.event(session);
	}

	promptOf(session: string): string {
		return this.sessions.get(session)?.conv.messages.find(m => m.role === "user")?.text ?? "";
	}
}

async function until<T>(what: string, fn: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

function tempPlan(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, "plan.json");
}

function start(file: string, ao: FakeAo): Planner {
	const p = new Planner({ file, initial: loadPlan(file), connect: async () => ao, pollMs: 100, retryBaseMs: 50 });
	p.start();
	return p;
}

const byTitle = (p: Planner, title: string): Task => p.state.tasks.find(t => t.title === title) as Task;
const running = (p: Planner) => p.state.tasks.filter(t => t.status === "running").map(t => t.title);

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
	await until("timed out", () => byTitle(p, "slow").status === "failed", 8000);
	assert.match(byTitle(p, "slow").summary ?? "", /Timed out/);
	p.stop();
});
