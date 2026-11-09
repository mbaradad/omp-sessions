// `switchyard migrate`: what comes over from an omp Sessions install (organization structure, defaults,
// scheduler), what stays behind (sessions, with their resume line and unfinished tasks), and that a run
// leaves the old dir alone, backs it up first, and is idempotent.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { readLegacyState } from "../../src/migrate/legacy";
import { leftBehind, mergeOrganize, migrate, type PlannerPort } from "../../src/migrate/migrate";
import { emptyOrgData, type OrgData } from "../../src/shared/organize";

const temps: string[] = [];
after(() => {
	for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sy-migrate-"));
	temps.push(dir);
	return dir;
}

/** A tree of files: `{"a/b.json": value}`; values other than strings are written as JSON. */
function write(root: string, files: Record<string, unknown>): void {
	for (const [rel, value] of Object.entries(files)) {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	}
}

const task = (title: string, status: string, extra: object = {}) => ({ id: title, title, status, subtasks: [], createdAt: 1, ...extra });

/** An install with two sessions (one with a half-done queue, one without a transcript), a tree of groups and settings. */
function oldInstall(): string {
	const home = temp();
	write(home, {
		"sessions/s1/meta.json": { id: "s1", cwd: "/work/a", title: "Alpha", createdAt: 1, ompSessionId: "omp-1" },
		"sessions/s1/queue.json": { autoRun: true, tasks: [task("done one", "done"), task("later", "pending", { notes: "details" }), task("broken", "failed"), task("skipped", "skipped")] },
		"sessions/s2/meta.json": { id: "s2", cwd: "/work/b", title: "Beta", createdAt: 2 },
		"sessions/s2/blobs/x": "snapshot",
		"organize.json": {
			version: 1,
			groups: [{ id: "g1", name: "Work", order: 0 }, { id: "g2", name: "Sub", parentId: "g1", order: 1 }],
			lanes: [{ id: "doing", name: "Doing", order: 0 }],
			sessions: { s1: { groupId: "g1", priority: "high", tags: ["x"], pinned: true } },
			collapsed: { g1: true },
		},
		"scheduler.json": { maxConcurrent: 3, paused: true, stopWhenQueueDone: false, budget: { day: 20, week: -1 } },
		"launcher.json": { mode: "edits", model: "p/m", service: "off", ompPath: "/opt/omp", extraArgs: ["--profile", "work"] },
		"remote.json": { enabled: true },
		"server.pid": "1",
	});
	return home;
}

function tree(root: string): string[] {
	return fs
		.readdirSync(root, { recursive: true })
		.map(String)
		.filter(f => fs.statSync(path.join(root, f)).isFile())
		.sort()
		.map(f => `${f}:${fs.readFileSync(path.join(root, f), "utf8")}`);
}

function plannerSpy(fail = false): PlannerPort & { calls: Array<{ op: string; args: unknown }> } {
	const calls: Array<{ op: string; args: unknown }> = [];
	return {
		calls,
		request: ((op: string, args: unknown) => {
			calls.push({ op, args });
			return fail ? Promise.reject(new Error("down")) : Promise.resolve({});
		}) as PlannerPort["request"],
	};
}

test("dry run writes nothing, anywhere, and reports every old session", async () => {
	const legacyHome = oldInstall();
	const home = path.join(temp(), "sy");
	const before = tree(legacyHome);
	const planner = plannerSpy();
	const lines: string[] = [];
	const report = await migrate({ apply: false, legacyHome, home, planner, log: l => lines.push(l) });
	assert.equal(fs.existsSync(home), false);
	assert.deepEqual(tree(legacyHome), before);
	assert.deepEqual(planner.calls, []);
	assert.equal(report.sessions.length, 2);
	assert.ok(lines.some(l => l.includes('s1 "Alpha" (/work/a): omp --resume omp-1')));
	assert.ok(lines.some(l => l.includes('s2 "Beta" (/work/b): no omp transcript')));
	assert.ok(lines.some(l => l.includes("unfinished (pending): later") && l.includes("sessions/s1/queue.json") && l.includes('switchyard new /work/a --task "…"')));
	assert.ok(lines.some(l => l.includes("unfinished (failed): broken")));
	assert.ok(!lines.some(l => l.includes("skipped") && l.includes("unfinished")));
});

test("apply: structure, defaults and scheduler come over; the old dir is backed up first and never touched", async () => {
	const legacyHome = oldInstall();
	const home = path.join(temp(), "sy");
	const before = tree(legacyHome);
	const planner = plannerSpy();
	const report = await migrate({ apply: true, legacyHome, home, planner });

	assert.deepEqual(tree(legacyHome), before);
	assert.ok(report.backup?.startsWith(path.join(home, "backups")));
	assert.deepEqual(tree(report.backup as string), before);

	const organize = JSON.parse(fs.readFileSync(path.join(home, "organize.json"), "utf8")) as OrgData;
	assert.deepEqual(organize.groups, [{ id: "g1", name: "Work", order: 0 }, { id: "g2", name: "Sub", parentId: "g1", order: 1 }]);
	assert.deepEqual(organize.lanes, [{ id: "doing", name: "Doing", order: 0 }]);
	assert.deepEqual(organize.collapsed, { g1: true });
	assert.deepEqual(organize.sessions, {}, "per-session entries are not migrated");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")), { mode: "edits", model: "p/m", service: "off" });
	assert.deepEqual(planner.calls, [{ op: "scheduler", args: { set: { maxConcurrent: 3, paused: true, budget: { day: 20 } } } }]);
	assert.ok(report.dropped.some(d => d.startsWith("remote.json: phone access was on")));
	assert.ok(report.dropped.some(d => d.includes("extraArgs --profile work")));
	assert.ok(report.dropped.some(d => d.startsWith("launcher.json ompPath")));
});

test("apply twice: the second run writes nothing, makes no backup and does not call the planner again", async () => {
	const legacyHome = oldInstall();
	const home = path.join(temp(), "sy");
	const planner = plannerSpy();
	await migrate({ apply: true, legacyHome, home, planner });
	const after1 = tree(home);
	const second = await migrate({ apply: true, legacyHome, home, planner });
	assert.deepEqual(tree(home), after1);
	assert.equal(second.backup, undefined);
	assert.equal(second.organize?.written, false);
	assert.equal(planner.calls.length, 1);
	assert.equal(second.scheduler?.imported, true);
});

test("a planner that is down or refuses leaves the scheduler for a later run; everything else still comes over", async () => {
	const legacyHome = oldInstall();
	const home = path.join(temp(), "sy");
	const down = await migrate({ apply: true, legacyHome, home, planner: plannerSpy(true) });
	assert.equal(down.scheduler?.imported, false);
	assert.equal(fs.existsSync(path.join(home, "organize.json")), true);
	const none = await migrate({ apply: true, legacyHome, home });
	assert.equal(none.scheduler?.imported, false);
	const planner = plannerSpy();
	const later = await migrate({ apply: true, legacyHome, home, planner });
	assert.equal(later.scheduler?.imported, true);
	assert.equal(planner.calls.length, 1);
});

test("organize merge: groups by id, lanes only when none exist, collapse keys; what exists wins, unknown fields stay", () => {
	const legacy: OrgData = {
		...emptyOrgData(),
		groups: [{ id: "g1", name: "Work", order: 0 }, { id: "g3", name: "New", order: 1 }],
		lanes: [{ id: "doing", name: "Doing", order: 0 }],
		sessions: { a: { priority: "high" } },
		collapsed: { g1: true, g3: true },
	};
	// A newer Switchyard may already store fields this version doesn't know; the merge keeps them.
	const existing = { ...emptyOrgData(), groups: [{ id: "g1", name: "Renamed", order: 3 }], sessions: { "repo-1": { color: "blue", completed: true } }, collapsed: { g1: false }, sortBy: "completed" };
	const merged = mergeOrganize(existing, legacy);
	assert.deepEqual(merged.data.groups, [{ id: "g1", name: "Renamed", order: 3 }, { id: "g3", name: "New", order: 1 }]);
	assert.deepEqual(merged.data.lanes, legacy.lanes);
	assert.deepEqual(merged.data.sessions, { "repo-1": { color: "blue", completed: true } });
	assert.deepEqual(merged.data.collapsed, { g1: false, g3: true });
	assert.equal((merged.data as unknown as Record<string, unknown>).sortBy, "completed");
	assert.equal(merged.groups, 1);
	assert.equal(merged.lanes, 1);
	assert.equal(mergeOrganize({ ...existing, lanes: [{ id: "mine", name: "Mine", order: 0 }] }, legacy).lanes, 0);
});

test("a missing old dir is not an error and creates nothing", async () => {
	const home = path.join(temp(), "sy");
	const report = await migrate({ apply: true, legacyHome: path.join(temp(), "nope"), home });
	assert.deepEqual(report.sessions, []);
	assert.equal(fs.existsSync(home), false);
});

test("legacy reader: unreadable sessions and corrupt files read as absent; an unfinished task keeps its status", () => {
	const home = temp();
	write(home, { "sessions/bad/meta.json": "{nope", "sessions/ok/meta.json": { cwd: "/x", ompSessionId: "o" }, "sessions/ok/queue.json": { tasks: [task("t", "running")] }, "organize.json": "{nope", "scheduler.json": "[]" });
	const state = readLegacyState(home);
	assert.deepEqual(state.unreadable, ["bad"]);
	assert.ok(state.organizeError);
	assert.equal(state.scheduler, undefined);
	assert.deepEqual(leftBehind(state)[0].unfinished, [{ title: "t", status: "running", hasNotes: false }]);
});
