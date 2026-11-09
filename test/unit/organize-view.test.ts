import assert from "node:assert/strict";
import * as os from "node:os";
import { test } from "node:test";
import { emptyOrgData } from "../../src/shared/organize";
import { type ViewNode, buildView, resolveSort, sortSessions } from "../../src/shared/organize-view";
import type { SessionMeta } from "../../src/shared/protocol";

// The Sessions view and the board read the completed marker from `queue.completed` (the planner's lane.complete).
function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
	return { id, cwd: os.tmpdir(), title: id, status: "idle", pid: 0, socket: "", createdAt: 1, updatedAt: 1, changedFiles: 0, ...extra };
}
const queue = (pending: number, extra: Partial<NonNullable<SessionMeta["queue"]>> = {}): SessionMeta["queue"] => ({ pending, running: 0, done: 0, total: pending, autoRun: false, ...extra });
const done = (completedAt: number): SessionMeta["queue"] => queue(0, { completed: true, completedAt });
const ids = (list: readonly SessionMeta[]) => list.map(m => m.id);

test("sort scheduled: next start first, ties by last activity, unscheduled (or nothing pending) last", () => {
	const list = [
		meta("none", { updatedAt: 50 }),
		meta("late", { queue: queue(1, { startAt: 3000 }) }),
		meta("soon-old", { queue: queue(2, { startAt: 1000 }), updatedAt: 5 }),
		meta("soon-new", { queue: queue(1, { startAt: 1000 }), updatedAt: 9 }),
		// A start time with nothing pending left waits for nothing.
		meta("stale", { queue: queue(0, { startAt: 500 }), updatedAt: 40 }),
	];
	assert.deepEqual(ids(sortSessions(list, "scheduled", emptyOrgData())), ["soon-new", "soon-old", "late", "none", "stale"]);
});

test("sort completed: marked first (latest mark first, unknown time last), then the most recently finished, working last", () => {
	const list = [
		meta("working", { status: "working", updatedAt: 9999 }),
		meta("idle-old", { status: "idle", updatedAt: 200 }),
		meta("old", { queue: done(100), updatedAt: 5000 }),
		meta("stopped-new", { status: "stopped", updatedAt: 800 }),
		meta("nostamp", { queue: done(0) }),
		meta("recent", { queue: done(900) }),
		meta("asking", { status: "waiting", updatedAt: 50 }),
	];
	assert.deepEqual(ids(sortSessions(list, "completed", emptyOrgData())), ["recent", "old", "nostamp", "stopped-new", "idle-old", "working", "asking"]);
});

test("auto sort: manual order for custom groups, last activity otherwise; the new modes pass through", () => {
	assert.equal(resolveSort("auto", "group"), "manual");
	assert.equal(resolveSort("auto", "project"), "activity");
	assert.equal(resolveSort("scheduled", "group"), "scheduled");
	assert.equal(resolveSort("completed", "status"), "completed");
});

test("buildView hideCompleted hides marked sessions; the filter matches the word completed", () => {
	const base = {
		sessions: [meta("a"), meta("b", { queue: done(1) })],
		data: emptyOrgData(),
		groupBy: "none" as const,
		sortBy: "name" as const,
		filter: "",
		showArchived: false,
		visible: () => true,
		inWorkspace: () => true,
		project: (m: SessionMeta) => ({ root: m.cwd, isRepo: false }),
		noWorkspace: true,
	};
	const sessionIds = (nodes: ViewNode[]) => nodes.flatMap(n => (n.kind === "session" ? [n.meta.id] : "sessions" in n ? n.sessions.map(s => s.id) : []));
	assert.deepEqual(sessionIds(buildView(base)), ["a", "b"]);
	assert.deepEqual(sessionIds(buildView({ ...base, hideCompleted: true })), ["a"]);
	assert.deepEqual(sessionIds(buildView({ ...base, filter: "completed" })), ["b"]);
	assert.deepEqual(sessionIds(buildView({ ...base, sortBy: "completed" })), ["b", "a"], "the view applies the chosen order");
});
