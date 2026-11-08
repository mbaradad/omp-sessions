// `omp-sessions` argument parsing: value flags, per-command flag checks, start times; and the `ls` filters.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { UsageError, checkFlags, parseArgs, parseWhen } from "../../src/cli/args";
import { filterSessions } from "../../src/shared/list-filter";
import type { SessionInfo } from "../../src/shared/server-protocol";

test("parseArgs: value flags, repeated --sub, short aliases, --x=y, -- passthrough", () => {
	const a = parseArgs(["new", "dir", "--task", "Do it", "--sub", "one", "--sub", "two", "-p", "hi", "--all", "--priority=high", "--", "--literal"]);
	assert.deepEqual(a._, ["new", "dir", "--literal"]);
	assert.equal(a.flags.get("task"), "Do it");
	assert.deepEqual(a.multi.get("sub"), ["one", "two"]);
	assert.equal(a.flags.get("prompt"), "hi");
	assert.equal(a.flags.get("all"), true);
	assert.equal(a.flags.get("priority"), "high");
	assert.throws(() => parseArgs(["--title"]), UsageError);
});

test("parseArgs: a value flag followed by another flag is a missing value; --x=--y passes one on purpose", () => {
	assert.throws(() => parseArgs(["new", "--title", "--json"]), UsageError);
	assert.equal(parseArgs(["new", "--title=--json"]).flags.get("title"), "--json");
	assert.equal(parseArgs(["new", "-p", "-"]).flags.get("prompt"), "-");
});

test("checkFlags: a command refuses flags it doesn't take", () => {
	checkFlags(parseArgs(["ls", "--json", "--tag", "x", "-h"]), "ls", ["json", "tag"]);
	assert.throws(() => checkFlags(parseArgs(["ls", "--group", "g", "--bogus"]), "ls", ["group"]), (err: unknown) => err instanceof UsageError && /--bogus/.test(err.message));
});

test("parseWhen: relative, next clock time, ISO; invalid or past times are usage errors", () => {
	const now = new Date(2025, 0, 15, 15, 0, 0).getTime();
	assert.equal(parseWhen("+30m", now), now + 30 * 60_000);
	assert.equal(parseWhen("16:30", now), new Date(2025, 0, 15, 16, 30).getTime());
	// Already past today → tomorrow.
	assert.equal(parseWhen("09:00", now), new Date(2025, 0, 16, 9, 0).getTime());
	assert.equal(parseWhen("2025-02-01T08:00:00Z", now), Date.UTC(2025, 1, 1, 8));
	for (const bad of ["soonish", "25:99", "12:60", "2024-01-01T08:00:00Z", "3"]) assert.throws(() => parseWhen(bad, now), UsageError, bad);
});

test("filterSessions: project, folder, group, tags and state", () => {
	const info = (id: string, cwd: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
		meta: { id, cwd, title: id, status: "idle", pid: 1, socket: "", createdAt: 0, updatedAt: 0, changedFiles: 0 },
		column: "idle",
		state: "idle",
		queue: { pending: 0, running: 0, done: 0, total: 0, autoRun: false },
		priority: "normal",
		order: 0,
		...extra,
	});
	const all = [info("a", "/w/app"), info("b", "/w/app/sub", { group: "Ops", tags: ["x", "y"] }), info("c", "/w/other", { column: "input", meta: { id: "c", cwd: "/w/other", title: "c", status: "waiting", pid: 1, socket: "", createdAt: 0, updatedAt: 0, changedFiles: 0 } })];
	const ids = (f: Parameters<typeof filterSessions>[1]) => filterSessions(all, f).map(i => i.meta.id);
	assert.deepEqual(ids({}), ["a", "b", "c"]);
	assert.deepEqual(ids({ project: "app" }), ["a"]);
	assert.deepEqual(ids({ cwd: "/w/app" }), ["a", "b"]);
	assert.deepEqual(ids({ group: "ops" }), ["b"]);
	assert.deepEqual(ids({ tags: ["x", "y"] }), ["b"]);
	assert.deepEqual(ids({ tags: ["x", "z"] }), []);
	assert.deepEqual(ids({ state: "needs_input" }), ["c"]);
	assert.deepEqual(ids({ state: "input" }), ["c"]);
});

test("filterSessions: a state name matches the state only; --project matches the project root too", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-filter-"));
	try {
		fs.mkdirSync(path.join(root, "app", ".git"), { recursive: true });
		fs.mkdirSync(path.join(root, "app", "pkg"));
		const stopped = (id: string, state: SessionInfo["state"], cwd = path.join(root, "app", "pkg")): SessionInfo => ({
			meta: { id, cwd, title: id, status: "stopped", pid: 0, socket: "", createdAt: 0, updatedAt: 0, changedFiles: 0 },
			column: "stopped",
			state,
			queue: { pending: 1, running: 0, done: 0, total: 1, autoRun: false, ...(state === "scheduled" ? { startAt: Date.now() + 3_600_000 } : {}), ...(state === "interrupted" ? { interrupted: 1 } : {}) },
			priority: "normal",
			order: 0,
		});
		const all = [stopped("done", "stopped"), stopped("later", "scheduled"), stopped("cut", "interrupted"), stopped("there", "stopped", root)];
		const ids = (f: Parameters<typeof filterSessions>[1]) => filterSessions(all, f).map(i => i.meta.id);
		assert.deepEqual(ids({ state: "stopped" }), ["done", "there"], "scheduled and interrupted sessions are stopped by status only");
		assert.deepEqual(ids({ state: "scheduled" }), ["later"]);
		assert.deepEqual(ids({ state: "interrupted" }), ["cut"]);
		assert.deepEqual(ids({ project: "app" }), ["done", "later", "cut"], "pkg's project root is app");
		assert.deepEqual(ids({ project: path.join(root, "app") }), ["done", "later", "cut"]);
		assert.deepEqual(ids({ project: "pkg" }), ["done", "later", "cut"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
