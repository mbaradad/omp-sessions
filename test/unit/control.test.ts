// omp-sessions server/CLI decisions: which queued sessions to launch (slots, priority, waiters,
// crash leftovers), how typed session names resolve, and list columns.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Control, hasRunnableWork, launchQueue, planLaunches, resolveSession, sessionInfos } from "../../src/shared/control";
import { type OrgData, emptyOrgData, schedulingOrder } from "../../src/shared/organize";
import type { QueueTask, SessionMeta, TaskQueue } from "../../src/shared/protocol";

const task = (status: QueueTask["status"], id: string = status): QueueTask => ({ id, title: id, subtasks: [], status, createdAt: 1 });
const queue = (tasks: QueueTask[], extra: Partial<TaskQueue> = {}): TaskQueue => ({ tasks, autoRun: true, ...extra });

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
	return { id, cwd: os.tmpdir(), title: id, status: "stopped", pid: 0, socket: "", createdAt: 1, updatedAt: 1, changedFiles: 0, ...extra };
}

function org(priorities: Record<string, "urgent" | "high" | "normal" | "low">, extra: Partial<Record<string, { archived?: boolean }>> = {}): OrgData {
	const data = emptyOrgData();
	for (const [id, priority] of Object.entries(priorities)) data.sessions[id] = { priority, ...extra[id] };
	return data;
}

test("hasRunnableWork: pending + auto-run or a due start; never with a task left running", () => {
	const now = 1_000_000;
	assert.equal(hasRunnableWork(queue([task("pending")]), now), true);
	assert.equal(hasRunnableWork(queue([task("pending")], { autoRun: false }), now), false);
	assert.equal(hasRunnableWork(queue([task("pending")], { autoRun: false, startAt: now }), now), true);
	assert.equal(hasRunnableWork(queue([task("pending")], { autoRun: false, startAt: now + 1 }), now), false);
	assert.equal(hasRunnableWork(queue([task("done"), task("failed")]), now), false);
	// A host crash leaves a task "running": rerunning it unattended is the user's call.
	assert.equal(hasRunnableWork(queue([task("running"), task("pending", "p2")]), now), false);
});

test("planLaunches: only candidates ranked within the free slots start", () => {
	const data = org({ hi: "urgent", lo: "low", w: "high" });
	const order = (ids: string[]) => schedulingOrder(data, ids);
	const base = { order, waiters: [] as string[], maxConcurrent: 2, running: 0, launching: 0, maxPerPass: 10 };
	assert.deepEqual(planLaunches({ ...base, candidates: ["lo", "hi"] }), ["hi", "lo"]);
	assert.deepEqual(planLaunches({ ...base, candidates: ["lo", "hi"], running: 1 }), ["hi"]);
	// Launches in flight hold their slot until the host takes a lease or starts waiting.
	assert.deepEqual(planLaunches({ ...base, candidates: ["lo", "hi"], running: 1, launching: 1 }), []);
	// A running host waiting for a slot outranks a low-priority candidate: no pointless launch…
	assert.deepEqual(planLaunches({ ...base, maxConcurrent: 1, candidates: ["lo"], waiters: ["w"] }), []);
	// …but an urgent candidate goes ahead of it.
	assert.deepEqual(planLaunches({ ...base, maxConcurrent: 1, candidates: ["hi", "lo"], waiters: ["w"] }), ["hi"]);
	assert.deepEqual(planLaunches({ ...base, candidates: ["hi"], paused: true }), []);
	// Unlimited: everything, but spread over passes.
	assert.deepEqual(planLaunches({ ...base, maxConcurrent: 0, candidates: ["a", "b", "c"], maxPerPass: 2 }).length, 2);
});

test("launchQueue: stopped sessions with runnable work, by priority; skips archived, gone folders, backoff, running hosts", () => {
	const metas = [
		meta("normal"),
		meta("urgent"),
		meta("archived"),
		meta("gone", { cwd: path.join(os.tmpdir(), "omp-sessions-no-such-dir-xyz") }),
		meta("blocked"),
		meta("running", { status: "idle" }),
		meta("paused"),
	];
	const queues = new Map(metas.map(m => [m.id, queue([task("pending")], m.id === "paused" ? { autoRun: false } : {})]));
	const data = org({ urgent: "urgent", archived: "normal" }, { archived: { archived: true } });
	assert.deepEqual(
		launchQueue(metas, queues, data, Date.now(), id => id === "blocked"),
		["urgent", "normal"],
	);
});

test("sessionInfos: queued stopped sessions are in the waiting column, ranked with waiting hosts", () => {
	const metas = [meta("q-low"), meta("host", { status: "idle", pid: 1 }), meta("done")];
	const queues = new Map([
		["q-low", queue([task("pending")])],
		["host", queue([task("pending")])],
		["done", queue([task("done")])],
	]);
	const data = org({ "q-low": "low", host: "normal" });
	const infos = sessionInfos({ metas, queues, org: data, waiters: [{ sessionId: "host", pid: 1, since: 5, seq: 1 }], launches: ["q-low"] });
	const by = new Map(infos.map(i => [i.meta.id, i]));
	assert.equal(by.get("host")?.column, "waiting");
	assert.deepEqual(by.get("host")?.waiting, { position: 1, since: 5 });
	assert.equal(by.get("q-low")?.column, "waiting");
	assert.deepEqual(by.get("q-low")?.waiting, { position: 2, launch: true });
	assert.equal(by.get("done")?.column, "stopped");
	assert.equal(by.get("done")?.waiting, undefined);
	assert.equal(by.get("q-low")?.priority, "low");
});

test("resolveSession: . for this folder, id prefixes, title words; ambiguity is an error", () => {
	const metas = [
		meta("mw01aaaa", { title: "Fix login bug", cwd: "/repo/a", updatedAt: 10 }),
		meta("mw01bbbb", { title: "Refactor login", cwd: "/repo/a", status: "idle", updatedAt: 5 }),
		meta("mw02cccc", { title: "Docs", cwd: "/repo/b", updatedAt: 20 }),
	];
	// Running sessions win over more recently updated stopped ones.
	assert.deepEqual(resolveSession(".", metas, "/repo/a/src"), { id: "mw01bbbb" });
	assert.ok("error" in resolveSession(".", metas, "/elsewhere"));
	assert.deepEqual(resolveSession("mw02", metas, "/"), { id: "mw02cccc" });
	assert.match(String(Object.values(resolveSession("mw01", metas, "/"))[0]), /matches 2 sessions/);
	assert.deepEqual(resolveSession("docs", metas, "/"), { id: "mw02cccc" });
	assert.match(String(Object.values(resolveSession("login", metas, "/"))[0]), /matches 2 sessions/);
	assert.deepEqual(resolveSession("fix login", metas, "/"), { id: "mw01aaaa" });
	assert.ok("error" in resolveSession("nothing", metas, "/"));
});

test("a scheduled session shows as scheduled (not finished); stop cancels its start so the server won't launch it", async t => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-control-"));
	const prev = process.env.OMP_VSCODE_HOME;
	process.env.OMP_VSCODE_HOME = home;
	t.after(() => {
		if (prev === undefined) delete process.env.OMP_VSCODE_HOME;
		else process.env.OMP_VSCODE_HOME = prev;
		fs.rmSync(home, { recursive: true, force: true });
	});
	const dir = path.join(home, "sessions", "later");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta("later")));
	fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify(queue([task("pending")], { autoRun: false, startAt: Date.now() + 3_600_000 })));
	const control = new Control({
		launcher: () => {
			throw new Error("nothing may launch");
		},
		serverUp: () => true,
		clientName: "test",
	});
	const [info] = control.list({});
	assert.equal(info.column, "scheduled");
	assert.equal(info.state, "scheduled");
	assert.equal(control.scheduler({}).scheduled, 1);

	assert.deepEqual(await control.stop({ id: "later" }), { stopped: false, unqueued: true });
	const after: TaskQueue = JSON.parse(fs.readFileSync(path.join(dir, "queue.json"), "utf8"));
	assert.equal(after.startAt, undefined);
	assert.equal(after.autoRun, false);
	assert.equal(control.list({})[0].state, "stopped");
});
