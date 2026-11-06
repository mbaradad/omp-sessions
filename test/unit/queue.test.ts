import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import type { QueueOp, QueueTask, TaskQueue } from "../../src/shared/protocol";
import { applyQueueOps, emptyQueue, nextPending, normalizeQueue, queueSummary, readQueueFile, taskPrompt, writeQueueFile } from "../../src/shared/queue";

const NOW = 1_700_000_000_000;

function task(id: string, status: QueueTask["status"] = "pending", extra: Partial<QueueTask> = {}): QueueTask {
	return { id, title: `task ${id}`, subtasks: [], status, createdAt: NOW, ...extra };
}
function queueOf(...tasks: QueueTask[]): TaskQueue {
	return { tasks, autoRun: false };
}
const ids = (q: TaskQueue): string[] => q.tasks.map(t => t.id);
/** Ops as they may arrive from the wire: unvalidated. */
const wire = (ops: unknown): QueueOp[] => ops as QueueOp[];

describe("applyQueueOps", () => {
	test("add: trims/collapses titles, ignores empty ones, clamps the index", () => {
		const q = applyQueueOps(
			queueOf(task("a"), task("b")),
			[
				{ op: "add", title: "  first \n line  ", index: -5 },
				{ op: "add", title: "   " },
				{ op: "add", title: "last", index: 99 },
				{ op: "add", title: "mid", index: 2 },
			],
			NOW,
		);
		assert.deepEqual(
			q.tasks.map(t => t.title),
			["first line", "task a", "mid", "task b", "last"],
		);
		const added = q.tasks[0];
		assert.equal(added.status, "pending");
		assert.equal(added.createdAt, NOW);
		assert.match(added.id, /^[0-9a-f]{10}$/);
		assert.equal(new Set(ids(q)).size, 5);
	});

	test("add: non-numeric index appends; subtasks cleaned; blank notes dropped", () => {
		const q = applyQueueOps(queueOf(task("a")), wire([{ op: "add", title: "x", index: "0", subtasks: ["one", " ", 3, "two"], notes: "  " }]), NOW);
		assert.deepEqual(ids(q).slice(0, 1), ["a"]);
		assert.deepEqual(
			q.tasks[1].subtasks.map(s => [s.title, s.done]),
			[
				["one", false],
				["two", false],
			],
		);
		assert.equal(q.tasks[1].notes, undefined);
	});

	test("unknown ids and junk ops are ignored; input is not mutated", () => {
		const input = queueOf(task("a"), task("b"));
		const before = structuredClone(input);
		const q = applyQueueOps(
			input,
			wire([null, 3, { op: "nope" }, { op: "update", id: "zz", title: "x" }, { op: "remove", id: "zz" }, { op: "move", id: "zz", index: 0 }, { op: "addSubtask", id: "zz", title: "s" }]),
			NOW,
		);
		assert.deepEqual(q, before);
		assert.deepEqual(input, before);
		assert.deepEqual(applyQueueOps(input, wire("not an array")), before);
	});

	test("update: title/notes/status; running is never set by a client", () => {
		const start = queueOf(task("a", "pending", { subtasks: [{ id: "s1", title: "s", done: false }], notes: "n" }));
		let q = applyQueueOps(start, [{ op: "update", id: "a", title: "  ", notes: "", status: "running" }], NOW);
		assert.equal(q.tasks[0].title, "task a", "blank title keeps the old one");
		assert.equal(q.tasks[0].notes, undefined, "empty notes clear");
		assert.equal(q.tasks[0].status, "pending");
		q = applyQueueOps(q, [{ op: "update", id: "a", status: "done" }], NOW);
		assert.equal(q.tasks[0].status, "done");
		assert.equal(q.tasks[0].finishedAt, NOW);
		assert.equal(q.tasks[0].subtasks[0].done, true);
		q = applyQueueOps(queueOf(task("a", "failed", { startedAt: 1, finishedAt: 2, summary: "boom" })), [{ op: "update", id: "a", status: "pending" }], NOW);
		assert.deepEqual([q.tasks[0].startedAt, q.tasks[0].finishedAt, q.tasks[0].summary], [undefined, undefined, undefined]);
		q = applyQueueOps(queueOf(task("a")), wire([{ op: "update", id: "a", status: "bogus" }]), NOW);
		assert.equal(q.tasks[0].status, "pending");
	});

	test("update: a running task cannot be re-statused by a client", () => {
		for (const status of ["done", "skipped", "pending", "failed"] as const) {
			const q = applyQueueOps(queueOf(task("a", "running", { startedAt: NOW })), [{ op: "update", id: "a", status }], NOW);
			assert.equal(q.tasks[0].status, "running", `running → ${status} must be refused`);
			assert.equal(q.tasks[0].startedAt, NOW);
		}
	});

	test("remove: running tasks stay", () => {
		const q = applyQueueOps(queueOf(task("a", "running"), task("b")), [
			{ op: "remove", id: "a" },
			{ op: "remove", id: "b" },
		]);
		assert.deepEqual(ids(q), ["a"]);
	});

	test("move: clamps to bounds", () => {
		const base = queueOf(task("a"), task("b"), task("c"));
		assert.deepEqual(ids(applyQueueOps(base, [{ op: "move", id: "a", index: 99 }])), ["b", "c", "a"]);
		assert.deepEqual(ids(applyQueueOps(base, [{ op: "move", id: "c", index: -3 }])), ["c", "a", "b"]);
		assert.deepEqual(ids(applyQueueOps(base, [{ op: "move", id: "a", index: 1.9 }])), ["b", "a", "c"]);
	});

	test("subtask ops: add/update/move/remove; unknown subtask ids ignored", () => {
		let q = applyQueueOps(queueOf(task("a")), [
			{ op: "addSubtask", id: "a", title: "one" },
			{ op: "addSubtask", id: "a", title: "two" },
			{ op: "addSubtask", id: "a", title: "  " },
		]);
		const [s1, s2] = q.tasks[0].subtasks;
		assert.deepEqual(
			q.tasks[0].subtasks.map(s => s.title),
			["one", "two"],
		);
		q = applyQueueOps(q, [
			{ op: "updateSubtask", id: "a", subtaskId: s1.id, title: "ONE", done: true },
			{ op: "updateSubtask", id: "a", subtaskId: "zz", title: "x" },
			{ op: "moveSubtask", id: "a", subtaskId: s2.id, index: -1 },
			{ op: "moveSubtask", id: "a", subtaskId: "zz", index: 0 },
		]);
		assert.deepEqual(
			q.tasks[0].subtasks.map(s => [s.title, s.done]),
			[
				["two", false],
				["ONE", true],
			],
		);
		q = applyQueueOps(q, [
			{ op: "removeSubtask", id: "a", subtaskId: s2.id },
			{ op: "removeSubtask", id: "a", subtaskId: "zz" },
		]);
		assert.deepEqual(
			q.tasks[0].subtasks.map(s => s.id),
			[s1.id],
		);
	});

	test("run: promotes the task before the first open task and arms autoRun", () => {
		const base = queueOf(task("d1", "done"), task("r", "running"), task("p1"), task("f", "failed", { startedAt: 5, finishedAt: 6 }));
		const q = applyQueueOps(base, [{ op: "run", id: "f" }]);
		assert.deepEqual(ids(q), ["d1", "f", "r", "p1"]);
		assert.equal(q.tasks[1].status, "pending");
		assert.equal(q.tasks[1].startedAt, undefined);
		assert.equal(q.tasks[1].finishedAt, undefined);
		assert.equal(q.autoRun, true);
	});

	test("run: no open tasks → appended; without id → first pending, order kept; running task untouched", () => {
		assert.deepEqual(ids(applyQueueOps(queueOf(task("a", "done"), task("b", "done")), [{ op: "run", id: "a" }])), ["b", "a"]);
		const q = applyQueueOps(queueOf(task("d", "done"), task("p1"), task("p2")), [{ op: "run" }]);
		assert.deepEqual(ids(q), ["d", "p1", "p2"]);
		assert.equal(q.autoRun, true);
		const r = applyQueueOps(queueOf(task("p"), task("r", "running")), [{ op: "run", id: "r" }]);
		assert.deepEqual(ids(r), ["p", "r"]);
		assert.equal(r.tasks[1].status, "running");
		assert.equal(r.autoRun, true);
	});

	test("autoRun and clearDone", () => {
		let q = applyQueueOps(queueOf(task("a", "done"), task("b", "skipped"), task("c", "failed"), task("d")), [{ op: "autoRun", value: true }, { op: "clearDone" }]);
		assert.deepEqual(ids(q), ["c", "d"]);
		assert.equal(q.autoRun, true);
		q = applyQueueOps(q, wire([{ op: "autoRun", value: "yes" }]));
		assert.equal(q.autoRun, false, "only literal true arms it");
	});
});

describe("normalizeQueue", () => {
	test("non-objects become an empty queue", () => {
		for (const raw of [null, undefined, 3, "x", [], [{ title: "a" }]]) assert.deepEqual(normalizeQueue(raw), emptyQueue());
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

describe("summary, nextPending, taskPrompt, files", () => {
	test("queueSummary and nextPending", () => {
		const q: TaskQueue = { autoRun: true, tasks: [task("a", "done"), task("b", "running"), task("c"), task("d", "failed"), task("e")] };
		assert.deepEqual(queueSummary(q), { pending: 2, running: 1, done: 1, total: 5, autoRun: true });
		assert.equal(nextPending(q)?.id, "c");
		assert.equal(nextPending(queueOf(task("a", "done"))), undefined);
	});

	test("taskPrompt carries position, title, notes and subtasks", () => {
		const t = task("a", "pending", {
			title: "echo one",
			notes: "be brief",
			subtasks: [
				{ id: "1", title: "first", done: true },
				{ id: "2", title: "second", done: false },
			],
		});
		const text = taskPrompt(t, { index: 2, total: 3 });
		const lines = text.split("\n");
		assert.equal(lines[0], "[Task 2/3 from the queue] echo one");
		assert.ok(lines.includes("be brief"));
		assert.ok(lines.includes("- [x] first"));
		assert.ok(lines.includes("- [ ] second"));
		assert.equal(taskPrompt(task("b"), { index: 1, total: 1 }).split("\n")[0], "[Task 1/1 from the queue] task b");
	});

	test("readQueueFile tolerates missing/corrupt files; writeQueueFile round-trips atomically", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-queue-"));
		try {
			const file = path.join(dir, "queue.json");
			assert.deepEqual(readQueueFile(file), emptyQueue());
			fs.writeFileSync(file, "{not json");
			assert.deepEqual(readQueueFile(file), emptyQueue());
			const q: TaskQueue = { autoRun: true, tasks: [task("a"), task("b", "done", { summary: "ok", finishedAt: NOW })] };
			writeQueueFile(file, q);
			// normalizeQueue spells out optional fields as undefined; compare the JSON form.
			assert.deepEqual(JSON.parse(JSON.stringify(readQueueFile(file))), q);
			assert.deepEqual(fs.readdirSync(dir), ["queue.json"], "no temp files left");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
