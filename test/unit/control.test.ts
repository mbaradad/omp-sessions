// omp-vs server/CLI decisions: which queued sessions to launch (slots, priority, waiters,
// crash leftovers), how typed session names resolve, list columns, and CLI argument parsing.
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseArgs, parseWhen } from "../../src/cli/args";
import { hasRunnableWork, launchQueue, planLaunches, resolveSession, sessionInfos } from "../../src/shared/control";
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
		meta("gone", { cwd: path.join(os.tmpdir(), "omp-vs-no-such-dir-xyz") }),
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
	const infos = sessionInfos({ metas, queues, org: data, waiters: [{ sessionId: "host", pid: 1, since: 5 }], launches: ["q-low"] });
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

test("parseArgs: value flags, repeated --sub, short aliases, --x=y, -- passthrough", () => {
	const a = parseArgs(["new", "dir", "--task", "Do it", "--sub", "one", "--sub", "two", "-p", "hi", "--all", "--priority=high", "--", "--literal"]);
	assert.deepEqual(a._, ["new", "dir", "--literal"]);
	assert.equal(a.flags.get("task"), "Do it");
	assert.deepEqual(a.multi.get("sub"), ["one", "two"]);
	assert.equal(a.flags.get("prompt"), "hi");
	assert.equal(a.flags.get("all"), true);
	assert.equal(a.flags.get("priority"), "high");
	assert.throws(() => parseArgs(["--title"]), /needs a value/);
});

test("parseWhen: relative, next clock time, ISO; garbage is undefined", () => {
	const now = new Date(2025, 0, 15, 15, 0, 0).getTime();
	assert.equal(parseWhen("+30m", now), now + 30 * 60_000);
	assert.equal(parseWhen("+2h", now), now + 2 * 3_600_000);
	assert.equal(parseWhen("16:30", now), new Date(2025, 0, 15, 16, 30).getTime());
	// Already past today → tomorrow.
	assert.equal(parseWhen("09:00", now), new Date(2025, 0, 16, 9, 0).getTime());
	assert.equal(parseWhen("2025-02-01T08:00:00Z", now), Date.UTC(2025, 1, 1, 8));
	assert.equal(parseWhen("soonish", now), undefined);
});
