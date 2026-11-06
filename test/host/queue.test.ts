// Host-owned task queue driving the fake omp: dispatch order, completion, abort, failure, restart.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TaskQueue } from "../../src/shared/protocol";
import { type Client, alive, launch, until } from "./harness";

const statuses = (q: TaskQueue): string[] => q.tasks.map(t => t.status);
async function queueWhere(c: Client, pred: (q: TaskQueue) => boolean, from = 0, timeout = 8000): Promise<TaskQueue> {
	return (await c.waitFor("queue", m => pred(m.queue), from, timeout)).queue;
}

test("autoRun feeds pending tasks to omp in order; each finishes done with its summary", async t => {
	const h = await launch(t);
	const { client: c, snapshot } = await h.connect();
	assert.deepEqual(snapshot.queue, { tasks: [], autoRun: false });

	c.send({
		t: "queue",
		ops: [
			{ op: "add", title: "echo one", subtasks: ["a", "b"] },
			{ op: "add", title: "echo two" },
		],
	});
	const added = await queueWhere(c, q => q.tasks.length === 2);
	assert.deepEqual(statuses(added), ["pending", "pending"]);
	assert.equal(added.autoRun, false);

	c.send({ t: "queue", ops: [{ op: "autoRun", value: true }] });
	const done = await queueWhere(c, q => q.tasks.every(x => x.status === "done"), 0, 15000);
	assert.deepEqual(
		done.tasks.map(x => [x.title, x.summary]),
		[
			["echo one", "one"],
			["echo two", "two"],
		],
	);
	assert.ok(done.tasks[0].subtasks.every(s => s.done), "subtasks completed with the task");
	assert.ok((done.tasks[0].finishedAt ?? 0) <= (done.tasks[1].startedAt ?? 0), "ran sequentially");
	assert.equal(done.autoRun, true);

	const prompts = h.fakeCommands("prompt");
	assert.equal(prompts.length, 2);
	assert.match(String(prompts[0].id), new RegExp(`^q:${done.tasks[0].id}:`));
	assert.match(String(prompts[0].message), /^\[Task 1\/2 from the queue\] echo one\n/);
	assert.match(String(prompts[0].message), /- \[ \] a\n- \[ \] b/);
	assert.match(String(prompts[1].message), /^\[Task 2\/2 from the queue\] echo two\n/);

	const meta = await c.waitFor("meta", m => m.meta.queue?.done === 2 && m.meta.status === "idle");
	assert.deepEqual(meta.meta.queue, { pending: 0, running: 0, done: 2, total: 2, autoRun: true });
	const onDisk = await until(() => {
		const q: TaskQueue = JSON.parse(fs.readFileSync(path.join(h.dir, "queue.json"), "utf8"));
		return statuses(q).every(s => s === "done") ? q : undefined;
	}, "queue.json");
	assert.deepEqual(
		onDisk.tasks.map(x => x.id),
		done.tasks.map(x => x.id),
	);
	const { snapshot: late } = await h.connect("late");
	assert.deepEqual(statuses(late.queue ?? { tasks: [], autoRun: false }), ["done", "done"]);
});

test("aborting a running task puts it back to pending and disarms autoRun", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	c.send({ t: "queue", ops: [{ op: "add", title: "slow 10000" }, { op: "add", title: "echo after" }, { op: "run" }] });
	await queueWhere(c, q => q.tasks[0]?.status === "running");
	await c.waitFor("meta", m => m.meta.status === "working");
	await c.event("tool_execution_update");
	const from = c.mark();
	await c.rpc({ id: "abort", type: "abort" });
	const q = await queueWhere(c, x => x.tasks[0].status === "pending", from);
	assert.equal(q.autoRun, false);
	assert.equal(q.tasks[0].summary, "Interrupted.");
	assert.equal(q.tasks[0].startedAt, undefined);
	assert.equal(q.tasks[1].status, "pending");
	await c.waitFor("meta", m => m.meta.status === "idle", from);
	// Proving an absence: outlast the host's real 800 ms post-task dispatch timer (separate process).
	await sleep(1300);
	assert.equal(h.fakeCommands("prompt").length, 1);
});

test("a model error fails the task and disarms autoRun", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	c.send({ t: "queue", ops: [{ op: "add", title: "fail quota exceeded" }, { op: "add", title: "echo never" }, { op: "autoRun", value: true }] });
	const q = await queueWhere(c, x => x.tasks[0]?.status === "failed");
	assert.equal(q.tasks[0].summary, "quota exceeded");
	assert.equal(q.autoRun, false);
	assert.equal(q.tasks[1].status, "pending");
	await sleep(1300); // outlast the host's 800 ms dispatch timer, as above
	assert.equal(h.fakeCommands("prompt").length, 1);
});

test("host restart with a running task resets it to pending and disarms autoRun", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	c.send({ t: "queue", ops: [{ op: "add", title: "slow 20000" }, { op: "run" }] });
	await queueWhere(c, q => q.tasks[0]?.status === "running");
	await until(() => {
		const q: TaskQueue = JSON.parse(fs.readFileSync(path.join(h.dir, "queue.json"), "utf8"));
		return q.tasks[0]?.status === "running";
	}, "running task persisted");
	const { pid, ompPid } = h.meta();
	// A crash, not a stop: no chance to update the queue.
	process.kill(pid, "SIGKILL");
	if (ompPid) process.kill(ompPid, "SIGKILL");
	await until(() => !alive(pid) && !alive(ompPid), "processes killed");
	await c.close();

	await h.start();
	const { snapshot } = await h.connect("after-crash");
	assert.ok(snapshot.queue);
	assert.equal(snapshot.queue.autoRun, false);
	assert.equal(snapshot.queue.tasks[0].status, "pending");
	assert.equal(snapshot.queue.tasks[0].summary, "Interrupted: the session host restarted.");
});

test(
	"clients connected during startup get meta.queue in the ready snapshot",
	async t => {
		const h = await launch(t, { env: { FAKE_OMP_READY_DELAY: "300" } });
		const { client: c } = await h.connect();
		c.send({ t: "queue", ops: [{ op: "add", title: "echo later" }] });
		await queueWhere(c, q => q.tasks.length === 1);
		c.send({ t: "stop" });
		await c.waitFor("meta", m => m.meta.status === "stopped");
		await until(() => !fs.existsSync(h.socket) && !alive(h.meta().pid), "host exit");
		await h.start();
		// connect() says hello immediately, i.e. before the delayed `ready`.
		const { snapshot } = await h.connect("during-startup");
		assert.deepEqual(snapshot.meta.queue, { pending: 1, running: 0, done: 0, total: 1, autoRun: false });
	},
);
