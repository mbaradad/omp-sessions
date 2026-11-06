// Session host lifecycle: stop, resume by id, SIGHUP, --goal.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { alive, isRecord, launch, textOf, until } from "./harness";

test("stop → meta stopped, socket removed, host and omp exit; restart with the same id resumes", async t => {
	const h = await launch(t);
	const { client: c1 } = await h.connect();
	await c1.prompt("echo remember me");
	await c1.waitFor("meta", m => m.meta.status === "idle" && m.meta.lastText === "remember me");
	// meta.json writes are debounced (~150 ms).
	const before = await until(() => {
		const m = h.meta();
		return m.lastText === "remember me" && m.ompSessionFile ? m : undefined;
	}, "meta.json flush");

	c1.send({ t: "stop" });
	const stopped = await c1.waitFor("meta", m => m.meta.status === "stopped");
	assert.equal(stopped.meta.exitReason, "stopped");
	await until(() => !fs.existsSync(h.socket), "socket removal");
	await until(() => !alive(before.pid) && !alive(before.ompPid), "host and omp exit");
	assert.equal(h.meta().status, "stopped");

	await h.start();
	const { snapshot } = await h.connect("after-restart");
	assert.notEqual(snapshot.meta.pid, before.pid);
	assert.equal(snapshot.meta.status, "idle");
	assert.equal(snapshot.meta.title, "echo remember me");
	assert.equal(snapshot.meta.ompSessionFile, before.ompSessionFile);
	assert.equal(snapshot.meta.createdAt, before.createdAt);
	const argvs = h.fakeEntries().flatMap(e => (e.kind === "argv" && e.argv ? [e.argv] : []));
	assert.equal(argvs.length, 2);
	assert.equal(argvs[1][argvs[1].indexOf("--resume") + 1], before.ompSessionFile);
	assert.deepEqual(
		snapshot.messages.map(m => [isRecord(m) ? m.role : undefined, textOf(m)]),
		[
			["user", "echo remember me"],
			["assistant", "remember me"],
		],
	);
});

test("host ignores SIGHUP and keeps serving", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const { pid, ompPid } = h.meta();
	process.kill(pid, "SIGHUP");
	// The handler logs once it has run; then the process must still be there.
	await until(() => /SIGHUP ignored/.test(fs.readFileSync(path.join(h.dir, "host.log"), "utf8")), "SIGHUP handled");
	assert.ok(alive(pid), "host survived SIGHUP");
	assert.ok(alive(ompPid), "omp survived SIGHUP");
	const result = await c.prompt("echo still here");
	assert.equal(result.status, "completed");
});

test("--goal creates the goal once and titles the session; not re-sent on resume", async t => {
	const h = await launch(t, { args: ["--goal", "Ship it"] });
	const { client: c } = await h.connect();
	const goals = await until(() => {
		const g = h.fakeCommands("goal");
		return g.length > 0 ? g : undefined;
	}, "goal create");
	assert.deepEqual(
		goals.map(g => [g.op, g.objective]),
		[["create", "Ship it"]],
	);
	const meta = await c.waitFor("meta", m => m.meta.title === "Goal: Ship it");
	assert.ok(meta);
	const state = await c.waitFor("state", m => isRecord(m.state) && isRecord(m.state.goal));
	assert.ok(isRecord(state.state) && isRecord(state.state.goal));
	assert.equal(state.state.goal.objective, "Ship it");

	c.send({ t: "stop" });
	await until(() => !alive(h.meta().pid) && !fs.existsSync(h.socket), "host exit");
	await h.start(["--goal", "Ship it"]);
	const { client: c2 } = await h.connect("after-restart");
	// A get_state round trip through omp is ordered after anything onReady sent (incl. a goal).
	await c2.rpc({ id: "sync", type: "get_state" });
	assert.equal(h.fakeCommands("goal").length, 1, "goal not re-created for an existing session");
});

test("omp dying takes the host down cleanly: meta stopped with the exit reason", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const { pid, ompPid } = h.meta();
	assert.ok(ompPid);
	process.kill(ompPid, "SIGKILL");
	const stopped = await c.waitFor("meta", m => m.meta.status === "stopped");
	assert.equal(stopped.meta.exitReason, "signal SIGKILL");
	await until(() => !alive(pid) && !fs.existsSync(h.socket), "host exit");
	assert.equal(h.meta().status, "stopped");
});

test("session folder deleted under a running host: stopping still exits host and omp", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const { pid, ompPid } = h.meta();
	fs.rmSync(h.dir, { recursive: true, force: true });
	c.send({ t: "stop" });
	await until(() => !alive(pid) && !alive(ompPid), "host and omp exit");
});
