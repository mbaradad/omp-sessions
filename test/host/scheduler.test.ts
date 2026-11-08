// Global concurrency slots across independent session hosts sharing one OMP_VSCODE_HOME:
// limit, waiting position, user ordering (organize.json), stale leases, unlimited.
// Orders are proven by state, never by timing or wall-clock stamps (the clock can step back, e.g.
// WSL2): a queued `ask` task holds its slot until the test answers its dialog, and a host saves the
// finished task to queue.json before it frees the slot.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { emptyOrgData } from "../../src/shared/organize";
import type { QueueTask, TaskQueue } from "../../src/shared/protocol";
import { type Client, type Host, launch, tempDir, until } from "./harness";

interface Session {
	h: Host;
	c: Client;
}

function sharedHome(t: TestContext, scheduler?: object): string {
	const home = tempDir(t, "omp-vsc-sched-");
	fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
	if (scheduler) fs.writeFileSync(path.join(home, "scheduler.json"), JSON.stringify(scheduler));
	return home;
}

async function hosts(t: TestContext, home: string, n: number): Promise<Session[]> {
	const out: Session[] = [];
	for (let i = 0; i < n; i++) {
		const h = await launch(t, { home });
		const { client: c } = await h.connect();
		out.push({ h, c });
	}
	return out;
}

async function doneTask(c: Client, timeout = 15000): Promise<QueueTask> {
	const q: TaskQueue = (await c.waitFor("queue", m => m.queue.tasks[0]?.status === "done", 0, timeout)).queue;
	return q.tasks[0];
}

/** The session's queue as its host last saved it. */
function savedQueue(s: Session): TaskQueue {
	return JSON.parse(fs.readFileSync(path.join(s.h.dir, "queue.json"), "utf8"));
}

function queueTask(s: Session, title: string): void {
	s.c.send({ t: "queue", ops: [{ op: "add", title }, { op: "run" }] });
}

/** Waits until the session's queued `ask` task runs, stopped at its dialog: the session holds its slot
 *  until the returned function answers. */
async function askOpen(s: Session): Promise<() => void> {
	const req = await s.c.event("extension_ui_request", ev => ev.method === "ask", 0, 15000);
	return () => s.c.send({ t: "ui_response", res: { id: String(req.id), answers: [{ id: "q1", selectedOptions: ["alpha"] }] } });
}

test("maxConcurrent=1: the second session's task waits for the slot, then runs", async t => {
	const home = sharedHome(t, { maxConcurrent: 1 });
	const [a, b] = await hosts(t, home, 2);
	queueTask(a, "ask");
	const answerA = await askOpen(a);
	queueTask(b, "echo b");
	const waiting = await b.c.waitFor("meta", m => !!m.meta.queue?.waiting);
	assert.equal(waiting.meta.queue?.waiting?.position, 1);
	assert.ok(fs.existsSync(path.join(home, "slots", "waiting", `${b.h.id}.json`)), "waiting marker written");
	assert.equal(savedQueue(b).tasks[0].status, "pending");
	answerA();
	await b.c.waitFor("queue", m => m.queue.tasks[0]?.status === "running", 0, 15000);
	assert.equal(savedQueue(a).tasks[0].status, "done", "B started only once A's task was done");
	await Promise.all([doneTask(a.c), doneTask(b.c)]);
	await b.c.waitFor("meta", m => m.meta.queue?.done === 1 && !m.meta.queue.waiting);
	await until(() => fs.readdirSync(path.join(home, "slots")).filter(f => f.endsWith(".json")).length === 0, "leases released");
	assert.deepEqual(fs.readdirSync(path.join(home, "slots", "waiting")), []);
});

test("waiting sessions start in the user's order (organize.json priority), re-read while waiting", async t => {
	const home = sharedHome(t, { maxConcurrent: 1 });
	const [a, b, c] = await hosts(t, home, 3);
	queueTask(a, "ask");
	const answerA = await askOpen(a);
	queueTask(b, "echo b");
	await b.c.waitFor("meta", m => m.meta.queue?.waiting?.position === 1);
	queueTask(c, "ask");
	await c.c.waitFor("meta", m => m.meta.queue?.waiting?.position === 2);
	// The user bumps C to urgent: it moves ahead of B while both wait.
	const from = c.c.mark();
	const org = emptyOrgData();
	org.sessions[c.h.id] = { priority: "urgent" };
	fs.writeFileSync(path.join(home, "organize.json"), JSON.stringify(org));
	await c.c.waitFor("meta", m => m.meta.queue?.waiting?.position === 1, from, 5000);
	answerA();
	// C takes the freed slot and keeps it at its dialog: B can't have started.
	const answerC = await askOpen(c);
	assert.equal(savedQueue(b).tasks[0].status, "pending", "C (urgent) ran before B");
	answerC();
	const [tb, tc] = await Promise.all([doneTask(b.c), doneTask(c.c)]);
	assert.equal(tb.status, "done");
	assert.equal(tc.status, "done");
});

test("a stale lease of a dead process doesn't take a slot", async t => {
	const home = sharedHome(t, { maxConcurrent: 1 });
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	fs.mkdirSync(path.join(home, "slots", "waiting"), { recursive: true });
	const stale = path.join(home, "slots", "ghost.json");
	fs.writeFileSync(stale, JSON.stringify({ pid: dead, since: Date.now() - 1000, taskId: "x" }));
	const [a] = await hosts(t, home, 1);
	a.c.send({ t: "queue", ops: [{ op: "add", title: "echo ok" }, { op: "run" }] });
	await doneTask(a.c, 5000);
	assert.ok(!fs.existsSync(stale), "stale lease removed");
});

test("maxConcurrent=0 (default) is unlimited: queued tasks of two sessions run in parallel", async t => {
	const home = sharedHome(t);
	const [a, b] = await hosts(t, home, 2);
	queueTask(a, "ask");
	const answerA = await askOpen(a);
	queueTask(b, "echo b");
	await doneTask(b.c);
	assert.equal(savedQueue(a).tasks[0].status, "running", "B ran while A's task was running");
	answerA();
	await doneTask(a.c);
});

test("interactive prompts are not gated by the limit", async t => {
	const home = sharedHome(t, { maxConcurrent: 1 });
	const [a, b] = await hosts(t, home, 2);
	queueTask(a, "ask");
	await askOpen(a);
	const res = await b.c.prompt("echo direct");
	assert.equal(res.status, "completed");
	assert.equal(savedQueue(a).tasks[0].status, "running", "A still holds the only slot");
});
