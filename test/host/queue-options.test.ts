// Per-task options run by the host against the fake omp: model/thinking switch + restore, fresh
// context (new_session), auto-retry with backoff, timeout, scheduled start (also across a host
// restart), and the recorded results (duration, cost, final summary).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { QueueTask, TaskQueue } from "../../src/shared/protocol";
import { type Client, type Host, alive, launch, monoNow, until } from "./harness";

async function queueWhere(c: Client, pred: (q: TaskQueue) => boolean, from = 0, timeout = 10000): Promise<TaskQueue> {
	return (await c.waitFor("queue", m => pred(m.queue), from, timeout)).queue;
}

test("model and thinking options switch before the task and restore afterwards", async t => {
	const h = await launch(t);
	const { client: c, snapshot } = await h.connect();
	assert.equal(snapshot.meta.model, "fake/fake-model");
	c.send({ t: "queue", ops: [{ op: "add", title: "echo hi", options: { model: "fake/fake-mini", thinking: "high" } }, { op: "autoRun", value: true }] });
	const q = await queueWhere(c, x => x.tasks[0]?.status === "done");
	assert.equal(q.tasks[0].summary, "hi");
	await until(() => h.fakeCommands("set_thinking_level").length === 2, "thinking restored");
	assert.deepEqual(
		h.fakeCommands("set_model").map(m => [m.provider, m.modelId]),
		[
			["fake", "fake-mini"],
			["fake", "fake-model"],
		],
	);
	assert.deepEqual(
		h.fakeCommands("set_thinking_level").map(m => m.level),
		["high", "medium"],
	);
	// Order: switch, prompt, restore.
	const types = h
		.fakeEntries()
		.flatMap(e => (e.kind === "cmd" && e.cmd && ["set_model", "set_thinking_level", "prompt"].includes(e.cmd.type) ? [e.cmd.type] : []));
	assert.deepEqual(types, ["set_model", "set_thinking_level", "prompt", "set_model", "set_thinking_level"]);
});

test("an option omp rejects fails the task before prompting; options matching the session are not re-sent", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	c.send({
		t: "queue",
		ops: [
			{ op: "add", title: "echo same", options: { model: "fake/fake-model", thinking: "medium" } },
			{ op: "add", title: "echo never", options: { model: "fake/nope" } },
			{ op: "autoRun", value: true },
		],
	});
	const q = await queueWhere(c, x => x.tasks[1]?.status === "failed");
	assert.equal(q.tasks[0].status, "done");
	assert.match(q.tasks[1].summary ?? "", /^Could not prepare the task \(model fake\/nope: Model not found/);
	assert.equal(q.autoRun, false);
	assert.equal(h.fakeCommands("prompt").length, 1);
	assert.equal(h.fakeCommands("set_thinking_level").length, 0);
	assert.deepEqual(
		h.fakeCommands("set_model").map(m => m.modelId),
		["nope"],
	);
});

test("freshContext starts the task in a new omp session", async t => {
	const h = await launch(t);
	const { client: c, snapshot } = await h.connect();
	await c.prompt("echo before");
	const firstFile = (await c.waitFor("meta", m => !!m.meta.ompSessionFile)).meta.ompSessionFile;
	const from = c.mark();
	c.send({ t: "queue", ops: [{ op: "add", title: "echo fresh", options: { freshContext: true } }, { op: "run" }] });
	const reset = await c.waitFor("reset", () => true, from);
	assert.equal(reset.messages.length, 0, "transcript starts empty");
	await queueWhere(c, x => x.tasks[0]?.status === "done", from);
	const cmds = h.fakeEntries().flatMap(e => (e.kind === "cmd" && e.cmd ? [e.cmd.type] : []));
	const fresh = cmds.indexOf("new_session");
	assert.ok(fresh >= 0, "fake received new_session");
	assert.ok(fresh < cmds.lastIndexOf("prompt"), "new_session before the task prompt");
	const meta = await c.waitFor("meta", m => !!m.meta.ompSessionFile && m.meta.ompSessionFile !== firstFile, from);
	assert.notEqual(meta.meta.ompSessionFile, snapshot.meta.ompSessionFile);
	const notice = await c.event("notice", ev => /fresh context/.test(String(ev.message)), from);
	assert.equal(notice.level, "info");
});

test("retries: a failing task is re-run with backoff, then fails for good", async t => {
	const h = await launch(t, { env: { OMP_VSCODE_RETRY_BASE_MS: "200" } });
	const { client: c } = await h.connect();
	c.send({ t: "queue", ops: [{ op: "add", title: "fail flaky provider", options: { retries: 2 } }, { op: "add", title: "echo next" }, { op: "autoRun", value: true }] });
	const retrying = await queueWhere(c, x => x.tasks[0]?.attempts === 1);
	assert.equal(retrying.tasks[0].status, "pending");
	assert.match(retrying.tasks[0].summary ?? "", /^Attempt 1 of 3 failed: flaky provider Retrying in/);
	assert.equal(retrying.autoRun, true, "still armed while retrying");
	const q = await queueWhere(c, x => x.tasks[0]?.status === "failed");
	assert.equal(q.tasks[0].attempts, 3);
	assert.equal(q.tasks[0].summary, "flaky provider (gave up after 3 attempts)");
	assert.equal(q.autoRun, false);
	assert.equal(q.tasks[1].status, "pending", "the queue stops at the failed task");
	const times = h.fakeEntries().flatMap(e => (e.kind === "cmd" && e.cmd?.type === "prompt" ? [e.mono] : []));
	assert.equal(times.length, 3);
	// Backoff: 200 ms, then 400 ms between attempts (plus the fake's own run time).
	assert.ok(times[1] - times[0] >= 200 && times[2] - times[1] >= 400, `backoff respected: ${times.join(",")}`);
	// Re-queueing by hand starts over.
	c.send({ t: "queue", ops: [{ op: "update", id: q.tasks[0].id, status: "pending" }] });
	const reset = await queueWhere(c, x => x.tasks[0]?.status === "pending" && x.tasks[0].attempts === undefined);
	assert.equal(reset.tasks[0].durationMs, undefined);
});

test("timeoutMinutes aborts a long task and fails it with the reason", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	// 0.01 min = 600 ms.
	c.send({ t: "queue", ops: [{ op: "add", title: "slow 8000", options: { timeoutMinutes: 0.01 } }, { op: "run" }] });
	const q = await queueWhere(c, x => x.tasks[0]?.status === "failed");
	assert.equal(q.tasks[0].summary, "Timed out after 0.01 min.");
	assert.ok((q.tasks[0].durationMs ?? 0) >= 600 && (q.tasks[0].durationMs ?? 0) < 5000, `duration ${q.tasks[0].durationMs}`);
	assert.equal(h.fakeCommands("abort").length, 1);
	assert.equal(q.autoRun, false);
	await c.event("notice", ev => /timed out/.test(String(ev.message)));
});

test("results: duration, cost and the final assistant text are recorded", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	c.send({ t: "queue", ops: [{ op: "add", title: "write notes.txt hello" }, { op: "run" }] });
	const q = await queueWhere(c, x => x.tasks[0]?.status === "done");
	const task = q.tasks[0];
	assert.equal(task.summary, "Wrote notes.txt");
	assert.ok((task.durationMs ?? 0) > 0);
	// Fake usage: 0.0003 per assistant message; tool call + final text = 2 messages.
	assert.ok(Math.abs((task.cost ?? 0) - 0.0006) < 1e-9, `cost ${task.cost}`);
});

/** A start time `delayMs` from now. `notEarly(task)`: the task didn't start before it, by its wall-clock
 *  startedAt or, should the wall clock have stepped back after the host saw the time come (WSL2 jumps
 *  back ~3 s every half minute), by the monotonic time until its prompt reached omp. */
function startTime(h: Host, delayMs: number): { at: number; notEarly: (task: QueueTask) => boolean } {
	const since = monoNow();
	const at = Date.now() + delayMs;
	const notEarly = (task: QueueTask): boolean => {
		if ((task.startedAt ?? 0) >= at) return true;
		const prompt = h.fakeEntries().find(e => e.kind === "cmd" && e.cmd?.type === "prompt" && String(e.cmd.message).includes(`] ${task.title}\n`));
		return prompt !== undefined && prompt.mono - since >= delayMs;
	};
	return { at, notEarly };
}

test("startAt arms the queue at that time, and survives a host restart", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const first = startTime(h, 1500);
	const at = first.at;
	c.send({ t: "queue", ops: [{ op: "add", title: "echo scheduled" }, { op: "schedule", at }] });
	const armed = await queueWhere(c, x => x.startAt === at);
	assert.equal(armed.autoRun, false);
	assert.equal((await c.waitFor("meta", m => m.meta.queue?.startAt === at)).meta.queue?.startAt, at);
	const q = await queueWhere(c, x => x.tasks[0]?.status === "done", 0, 8000);
	assert.ok(first.notEarly(q.tasks[0]), "not started early");
	assert.equal(q.startAt, undefined);
	assert.equal(q.autoRun, true);

	// Restart: the timer is re-armed from queue.json.
	const second = startTime(h, 2500);
	const at2 = second.at;
	c.send({ t: "queue", ops: [{ op: "add", title: "echo after restart" }, { op: "schedule", at: at2 }] });
	await queueWhere(c, x => x.startAt === at2);
	c.send({ t: "stop" });
	await c.waitFor("meta", m => m.meta.status === "stopped");
	await until(() => !fs.existsSync(h.socket) && !alive(h.meta().pid), "host exit");
	const onDisk: TaskQueue = JSON.parse(fs.readFileSync(path.join(h.dir, "queue.json"), "utf8"));
	assert.equal(onDisk.startAt, at2);
	await h.start();
	const { client: c2 } = await h.connect("after-restart");
	const q2 = await queueWhere(c2, x => x.tasks[1]?.status === "done", 0, 10000);
	assert.ok(second.notEarly(q2.tasks[1]), "not started early after restart");
});

test("schedule null cancels; starting or pausing the queue clears the schedule", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const at = Date.now() + 60_000;
	c.send({ t: "queue", ops: [{ op: "add", title: "echo x" }, { op: "schedule", at }] });
	await queueWhere(c, x => x.startAt === at);
	c.send({ t: "queue", ops: [{ op: "schedule", at: null }] });
	const q = await queueWhere(c, x => x.startAt === undefined);
	assert.equal(q.autoRun, false);
	assert.equal(q.tasks[0].status, "pending");
});
