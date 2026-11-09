import assert from "node:assert/strict";
import { test } from "node:test";
import { type SortFields, finishedAt, scheduledStart, sortBy } from "../../src/shared/session-sort";

const f = (title: string, extra: Partial<SortFields> = {}): SortFields => ({ title, createdAt: 1, updatedAt: 1, rank: 0, priority: 2, completed: false, ...extra });
const order = (sort: Parameters<typeof sortBy>[1], items: SortFields[]) => sortBy(items, sort, x => x).map(x => x.title);

test("scheduled: next start first, unscheduled last (most recently active first among them)", () => {
	assert.deepEqual(order("scheduled", [f("none-old", { updatedAt: 1 }), f("later", { startAt: 200 }), f("none-new", { updatedAt: 9 }), f("soon", { startAt: 100 })]), ["soon", "later", "none-new", "none-old"]);
});

test("completed: marked first (latest mark first), then most recently finished, never-finished last", () => {
	const items = [f("working"), f("old-finish", { finishedAt: 10 }), f("done-early", { completed: true, completedAt: 5 }), f("done-late", { completed: true, completedAt: 50 }), f("new-finish", { finishedAt: 20 })];
	assert.deepEqual(order("completed", items), ["done-late", "done-early", "new-finish", "old-finish", "working"]);
});

test("scheduledStart counts only while tasks are pending; finishedAt only for settled sessions", () => {
	const queue = { pending: 1, running: 0, done: 0, total: 1, autoRun: true, startAt: 7 };
	assert.equal(scheduledStart(queue), 7);
	assert.equal(scheduledStart({ ...queue, pending: 0 }), undefined);
	assert.equal(scheduledStart(undefined), undefined);
	assert.equal(finishedAt("idle", 5), 5);
	assert.equal(finishedAt("stopped", 6), 6);
	assert.equal(finishedAt("working", 7), undefined);
	assert.equal(finishedAt("waiting", 8), undefined);
});
