import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeQueue } from "../../src/shared/queue";

describe("normalizeQueue", () => {
	test("non-objects become an empty queue", () => {
		for (const raw of [null, undefined, 3, "x", [], [{ title: "a" }]]) assert.deepEqual(normalizeQueue(raw), { tasks: [], autoRun: false });
	});

	test("drops junk tasks, dedupes ids, defaults status, keeps autoRun only when true", () => {
		const q = normalizeQueue({
			autoRun: "true",
			tasks: [
				null,
				{ title: "" },
				{ id: "a", title: " one ", status: "weird", notes: "  " },
				{ id: "a", title: "two", status: "done", createdAt: 5, summary: "s" },
				{ title: "three", subtasks: [null, { title: "" }, { id: "x", title: "s1", done: "yes" }, { id: "x", title: "s2", done: true }] },
			],
		});
		assert.equal(q.autoRun, false);
		assert.deepEqual(
			q.tasks.map(t => [t.title, t.status]),
			[
				["one", "pending"],
				["two", "done"],
				["three", "pending"],
			],
		);
		assert.equal(q.tasks[0].id, "a");
		assert.notEqual(q.tasks[1].id, "a", "duplicate id replaced");
		assert.equal(q.tasks[0].notes, undefined);
		assert.equal(q.tasks[1].createdAt, 5);
		assert.equal(q.tasks[1].summary, "s");
		const subs = q.tasks[2].subtasks;
		assert.deepEqual(
			subs.map(s => [s.title, s.done]),
			[
				["s1", false],
				["s2", true],
			],
		);
		assert.equal(subs[0].id, "x");
		assert.notEqual(subs[1].id, "x");
		assert.equal(normalizeQueue({ tasks: [], autoRun: true }).autoRun, true);
	});
});
