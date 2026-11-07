// Global concurrency slots across independent session hosts sharing one OMP_VSCODE_HOME:
// limit, waiting position, user ordering (organize.json), stale leases, unlimited.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { emptyOrgData } from "../../src/shared/organize";
import type { QueueTask, TaskQueue } from "../../src/shared/protocol";
import { type Client, type Host, launch, until } from "./harness";

function sharedHome(t: TestContext, scheduler?: object): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vsc-sched-"));
	fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
	if (scheduler) fs.writeFileSync(path.join(home, "scheduler.json"), JSON.stringify(scheduler));
	// Removed after the test; the hosts' dispose kills their processes either way.
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	return home;
}

async function hosts(t: TestContext, home: string, n: number): Promise<Array<{ h: Host; c: Client }>> {
	const out: Array<{ h: Host; c: Client }> = [];
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

const overlaps = (a: QueueTask, b: QueueTask) => (a.startedAt ?? 0) < (b.finishedAt ?? 0) && (b.startedAt ?? 0) < (a.finishedAt ?? 0);

test("maxConcurrent=1: the second session's task waits for the slot, then runs", async t => {
	const home = sharedHome(t, { maxConcurrent: 1 });
	const [a, b] = await hosts(t, home, 2);
	a.c.send({ t: "queue", ops: [{ op: "add", title: "slow 800" }, { op: "run" }] });
	await a.c.waitFor("queue", m => m.queue.tasks[0]?.status === "running");
	b.c.send({ t: "queue", ops: [{ op: "add", title: "slow 300" }, { op: "run" }] });
	const waiting = await b.c.waitFor("meta", m => !!m.meta.queue?.waiting);
	assert.equal(waiting.meta.queue?.waiting?.position, 1);
	assert.ok(fs.existsSync(path.join(home, "slots", "waiting", `${b.h.id}.json`)), "waiting marker written");
	const [ta, tb] = await Promise.all([doneTask(a.c), doneTask(b.c)]);
	assert.ok(!overlaps(ta, tb), `ran one at a time: ${ta.startedAt}-${ta.finishedAt} / ${tb.startedAt}-${tb.finishedAt}`);
	assert.ok((tb.startedAt ?? 0) >= (ta.finishedAt ?? 0));
	await b.c.waitFor("meta", m => m.meta.queue?.done === 1 && !m.meta.queue.waiting);
	await until(() => fs.readdirSync(path.join(home, "slots")).filter(f => f.endsWith(".json")).length === 0, "leases released");
	assert.deepEqual(fs.readdirSync(path.join(home, "slots", "waiting")), []);
});

test("waiting sessions start in the user's order (organize.json priority), re-read while waiting", async t => {
	const home = sharedHome(t, { maxConcurrent: 1 });
	const [a, b, c] = await hosts(t, home, 3);
	a.c.send({ t: "queue", ops: [{ op: "add", title: "slow 2000" }, { op: "run" }] });
	await a.c.waitFor("queue", m => m.queue.tasks[0]?.status === "running");
	b.c.send({ t: "queue", ops: [{ op: "add", title: "echo b" }, { op: "run" }] });
	await b.c.waitFor("meta", m => m.meta.queue?.waiting?.position === 1);
	c.c.send({ t: "queue", ops: [{ op: "add", title: "echo c" }, { op: "run" }] });
	await c.c.waitFor("meta", m => m.meta.queue?.waiting?.position === 2);
	// The user bumps C to urgent: it moves ahead of B while both wait.
	const org = emptyOrgData();
	org.sessions[c.h.id] = { priority: "urgent" };
	fs.writeFileSync(path.join(home, "organize.json"), JSON.stringify(org));
	await c.c.waitFor("meta", m => m.meta.queue?.waiting?.position === 1, 0, 5000);
	// Order without wall-clock timestamps (clocks can step, e.g. WSL2): B still pends when C runs.
	await c.c.waitFor("queue", m => m.queue.tasks[0]?.status === "running", 0, 15000);
	const bNow = [...b.c.msgs].reverse().find(m => m.t === "queue");
	assert.equal(bNow?.t === "queue" ? bNow.queue.tasks[0]?.status : undefined, "pending", "C (urgent) ran before B");
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
	a.c.send({ t: "queue", ops: [{ op: "add", title: "slow 1500" }, { op: "run" }] });
	b.c.send({ t: "queue", ops: [{ op: "add", title: "slow 1500" }, { op: "run" }] });
	const [ta, tb] = await Promise.all([doneTask(a.c), doneTask(b.c)]);
	assert.ok(overlaps(ta, tb), "ran concurrently");
});

test("interactive prompts are not gated by the limit", async t => {
	const home = sharedHome(t, { maxConcurrent: 1 });
	const [a, b] = await hosts(t, home, 2);
	a.c.send({ t: "queue", ops: [{ op: "add", title: "slow 1500" }, { op: "run" }] });
	await a.c.waitFor("queue", m => m.queue.tasks[0]?.status === "running");
	const res = await b.c.prompt("echo direct", 3000);
	assert.equal(res.status, "completed");
	assert.equal((await a.c.waitFor("queue", m => m.queue.tasks[0]?.status === "running")).queue.tasks[0].status, "running", "A still running meanwhile");
});
