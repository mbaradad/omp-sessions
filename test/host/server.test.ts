// The omp-sessions server against real hosts and the fake omp: launching queued stopped sessions by
// priority within the concurrency limit, stopping them when their queue is done unless someone
// watches, never rerunning a task a crash interrupted; and the host's viewer/activity fields it
// relies on.
import { type ChildProcess, spawn } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { HostConnection } from "../../src/shared/host-conn";
import type { QueueTask, SessionMeta, TaskQueue } from "../../src/shared/protocol";
import { ServerClient } from "../../src/shared/server-client";
import { alive, launch, until } from "./harness";

const SERVER_JS = process.env.OMP_TEST_SERVER_JS ?? "";
const FAKE_OMP = process.env.OMP_TEST_FAKE_OMP ?? "";

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** A stopped session that has never run, with one task queued (as `omp-sessions new --task` creates it). */
function queuedSession(home: string, id: string, cwd: string, title: string, status: QueueTask["status"] = "pending"): void {
	const dir = path.join(home, "sessions", id);
	fs.mkdirSync(dir, { recursive: true });
	const now = Date.now();
	const meta: SessionMeta = { id, cwd, title: id, status: "stopped", pid: 0, socket: "", createdAt: now, updatedAt: now, changedFiles: 0 };
	const queue: TaskQueue = { tasks: [{ id: `${id}-t`, title, subtasks: [], status, createdAt: now }], autoRun: true };
	fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
	fs.writeFileSync(path.join(dir, "launch.json"), JSON.stringify({ ompArgs: [] }));
	fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify(queue));
}

test("server: queued sessions start by priority within the limit; done ones stop unless watched; crash leftovers stay", async t => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-server-"));
	const cwd = path.join(home, "work");
	const fake = path.join(home, "fake-sessions");
	for (const d of [cwd, fake, path.join(home, "sessions")]) fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(path.join(home, "launcher.json"), JSON.stringify({ ompPath: FAKE_OMP }));
	fs.writeFileSync(path.join(home, "scheduler.json"), JSON.stringify({ maxConcurrent: 1 }));
	fs.writeFileSync(
		path.join(home, "organize.json"),
		JSON.stringify({ version: 1, groups: [], lanes: [], collapsed: {}, sessions: { urgent: { priority: "urgent" }, low: { priority: "low" } } }),
	);
	queuedSession(home, "low", cwd, "slow 600");
	queuedSession(home, "urgent", cwd, "slow 600");
	queuedSession(home, "crashed", cwd, "echo again", "running");

	const meta = (id: string) => readJson<SessionMeta>(path.join(home, "sessions", id, "meta.json"));
	const queue = (id: string) => readJson<TaskQueue>(path.join(home, "sessions", id, "queue.json"));
	const pids = new Set<number>();
	const seen = (id: string) => {
		const m = meta(id);
		if (m?.pid) pids.add(m.pid);
		if (m?.ompPid) pids.add(m.ompPid);
		return m;
	};

	const server: ChildProcess = spawn(process.execPath, [SERVER_JS], {
		env: { ...process.env, OMP_VSCODE_HOME: home, FAKE_OMP_SESSIONS: fake, OMP_SESSIONS_DONE_GRACE_MS: "300" },
		stdio: "ignore",
	});
	let viewer: HostConnection | undefined;
	t.after(async () => {
		viewer?.close();
		server.kill("SIGTERM");
		const sockets = ["low", "urgent", "crashed"].flatMap(id => seen(id)?.socket ?? []);
		for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
		await until(() => [...pids].every(p => !alive(p)) && server.exitCode !== null, "processes to exit", 5000).catch(() => {});
		// Killed hosts leave their sockets, possibly in the short tmp fallback outside `home`.
		for (const s of sockets) fs.rmSync(s, { force: true });
		fs.rmSync(home, { recursive: true, force: true });
	});

	// Urgent goes first; low stays stopped (no omp process) while the only slot is taken.
	await until(() => seen("urgent")?.status !== "stopped", "urgent launched", 15000);
	assert.equal(seen("low")?.status, "stopped");
	assert.equal(meta("urgent")?.launchedBy, "scheduler");

	// Someone opens low's chat as soon as it runs: it must survive its queue finishing.
	// Order without wall-clock timestamps (clocks can step, e.g. WSL2): with limit 1, low is only
	// launched once urgent released its slot, so urgent's task is done by the time low runs.
	const lowMeta = await until(() => {
		const m = seen("low");
		return m && m.status !== "stopped" && m.status !== "starting" && m.socket ? m : undefined;
	}, "low launched after urgent", 20000);
	assert.equal(queue("urgent")?.tasks[0].status, "done", "limit 1: low started only after urgent's task finished");
	viewer = (await HostConnection.open(lowMeta.socket, "panel")).conn;

	await until(() => meta("urgent")?.status === "stopped", "urgent stopped once its queue was done", 20000);
	await until(() => queue("low")?.tasks[0].status === "done", "low done", 20000);

	await sleep(3000);
	assert.notEqual(meta("low")?.status, "stopped", "a watched session is not stopped");
	viewer.close();
	viewer = undefined;
	await until(() => meta("low")?.status === "stopped", "low stopped once nobody watches", 15000);

	// A task a crash left "running" is never rerun unattended.
	assert.equal(meta("crashed")?.pid, 0);

	process.env.OMP_VSCODE_HOME = home;
	const client = await ServerClient.connect();
	assert.ok(client, "server answers on its socket");
	const list = await client.request("list", {});
	client.close();
	assert.deepEqual(list.map(i => [i.meta.id, i.column]).sort(), [
		["crashed", "stopped"],
		["low", "stopped"],
		["urgent", "stopped"],
	]);
});

test("host: meta.viewers counts people, not the omp-sessions server or omp-sessions show; prompts stamp userActiveAt", async t => {
	const h = await launch(t);
	await sleep(300);
	const idleSince = h.meta().updatedAt;
	const { client } = await h.connect("panel");
	await until(() => h.meta().viewers === 1, "viewer counted");
	await h.connect("omp-sessions-server");
	await h.connect("omp-sessions-show");
	await sleep(300);
	assert.equal(h.meta().viewers, 1);
	assert.equal(h.meta().userActiveAt, undefined);
	// Someone looking is not activity: lists sorted by it must not reorder when a session is opened.
	assert.equal(h.meta().updatedAt, idleSince);
	await client.prompt("echo hi");
	await until(() => h.meta().userActiveAt, "prompt marks user activity");
	await client.close();
	await until(() => h.meta().viewers === 0, "viewer dropped");
});
