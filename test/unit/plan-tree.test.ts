import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LaneView, PlanView, TaskView } from "../../src/planner/types";
import { afterUndoOps, armedLanes, checkTaskOption, continuesSession, failureHint, keptBranchText, modeGateNote, holdLines, isUndoable, undoneWith, laneSummary, orderedLanes, parseBudget, syncAttention, syncConflicts, syncText, taskStateText, tasksOf } from "../../src/shared/plan-tree";

const NOW = new Date(2026, 10, 9, 12, 0);

function lane(id: string, extra: Partial<LaneView> = {}): LaneView {
	return { id, autoRun: false, createdAt: 0, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...extra };
}
function task(id: string, extra: Partial<TaskView> = {}): TaskView {
	return { id, title: `task ${id}`, subtasks: [], status: "pending", createdAt: 0, state: "waiting", ...extra };
}
function plan(lanes: LaneView[], tasks: TaskView[]): PlanView {
	return { rev: 1, lanes, tasks, recurring: [], edges: [], keptBranches: [], status: {} as PlanView["status"] };
}

describe("orderedLanes / tasksOf", () => {
	test("urgent queues first, completed ones last, otherwise the planner's order", () => {
		const p = plan([lane("a", { completed: true, priority: "urgent" }), lane("b"), lane("c", { priority: "low" }), lane("d", { priority: "high" }), lane("e")], []);
		assert.deepEqual(orderedLanes(p).map(l => l.id), ["d", "b", "e", "c", "a"]);
	});

	test("a lane's tasks keep plan order; free tasks are the ones without a lane", () => {
		const p = plan([lane("q")], [task("1", { lane: "q" }), task("2"), task("3", { lane: "q" }), task("4", { lane: "other" })]);
		assert.deepEqual(tasksOf(p, "q").map(t => t.id), ["1", "3"]);
		assert.deepEqual(tasksOf(p, undefined).map(t => t.id), ["2"]);
	});
});

describe("taskStateText", () => {
	const titles: Record<string, string> = { a: "Build", b: "Test", c: "Lint" };
	const titleOf = (id: string) => titles[id];

	test("a blocked task names what it waits for, a deleted dependency included", () => {
		assert.equal(taskStateText(task("x", { state: "blocked", blockedBy: ["a", "gone"] }), titleOf, NOW), "⛓ waits for Build, missing task gone");
		assert.equal(taskStateText(task("x", { state: "blocked", blockedBy: ["a", "b", "c"] }), titleOf, NOW), "⛓ waits for Build, Test +1");
	});

	test("scheduled and held tasks say until when", () => {
		const at = new Date(2026, 10, 9, 14, 30).getTime();
		assert.equal(taskStateText(task("x", { state: "scheduled", waitUntil: at }), titleOf, NOW), "⏰ 14:30");
		assert.equal(taskStateText(task("x", { state: "held", waitReason: "rate-limit anthropic", waitUntil: at }), titleOf, NOW), "✋ rate-limit anthropic until 14:30");
		assert.equal(taskStateText(task("x", { state: "held" }), titleOf, NOW), "✋ held");
	});

	test("waiting shows its place in line; an interrupted task asks for a person", () => {
		assert.equal(taskStateText(task("x", { state: "waiting", position: 2 }), titleOf, NOW), "⏳ waiting #2");
		assert.equal(taskStateText(task("x", { state: "interrupted", interrupted: 1 }), titleOf, NOW), "⚠ interrupted: run it again");
	});
});

describe("laneSummary", () => {
	test("says whether the queue runs, waits for a start time, or is paused", () => {
		const at = new Date(2026, 10, 10, 9, 0).getTime();
		assert.equal(laneSummary(lane("q", { autoRun: true, running: 1, pending: 2, done: 1, total: 4 }), NOW), "running · 2 pending · 1/4 done · ▶ auto-run");
		assert.equal(laneSummary(lane("q", { startAt: at, pending: 1, total: 1 }), NOW), "1 pending · 0/1 done · ⏰ starts tomorrow 09:00");
		assert.equal(laneSummary(lane("q", { pending: 1, failed: 1, total: 2, priority: "high" }), NOW), "high · 1 pending · 1 failed · 0/2 done · ⏸ paused");
		assert.equal(laneSummary(lane("q"), NOW), "no tasks");
	});
});

describe("parseBudget", () => {
	test("reads USD caps per window in any order, with $, = and commas", () => {
		assert.deepEqual(parseBudget("day 20"), { caps: { day: 20 } });
		assert.deepEqual(parseBudget("Week=$100, hour 2.5 day 20"), { caps: { week: 100, hour: 2.5, day: 20 } });
	});

	test("empty (or off) removes the budget; anything else, or a zero cap, is an error that says what to type", () => {
		assert.deepEqual(parseBudget("  "), { caps: {} });
		assert.deepEqual(parseBudget("off"), { caps: {} });
		for (const bad of ["20", "month 5", "day twenty", "day 20 please", "day 0"]) assert.ok("error" in parseBudget(bad), bad);
	});
});

describe("holdLines", () => {
	test("lists limits still in force and the spend per capped window, saying when a full cap frees", () => {
		const at = new Date(2026, 10, 9, 12, 0).getTime();
		const lines = holdLines(
			{
				limits: [
					{ provider: "anthropic", until: at + 3_600_000, since: at, failures: 1, reason: "429 usage limit" },
					{ provider: "openai", until: at - 1, since: at - 9, failures: 1, reason: "old" },
				],
				spend: [
					{ window: "day", cap: 20, spent: 21.5, over: true, freesAt: at + 7_200_000 },
					{ window: "hour", cap: 5, spent: 1, over: false },
				],
			},
			NOW,
		);
		assert.deepEqual(lines, ["anthropic is rate-limited until 13:00 (429 usage limit)", "spend this day: $21.50 of $20 (cap reached, frees 14:00)", "spend this hour: $1.00 of $5"]);
	});
});

describe("sync state", () => {
	const edge = (state: "in-sync" | "merged" | "pending" | "upstream-changed" | "resolving" | "conflict") => ({ state, at: 1 });

	test("the worst incoming edge decides; merged and in-sync need nothing", () => {
		assert.equal(syncAttention({ sync: { a: edge("merged"), b: edge("in-sync") } }), undefined);
		assert.equal(syncAttention({ sync: { a: edge("pending"), b: edge("upstream-changed") } }), "upstream-changed");
		assert.equal(syncAttention({ sync: { a: edge("resolving"), b: edge("conflict"), c: edge("pending") } }), "conflict");
		assert.equal(syncAttention({}), undefined);
		assert.equal(syncText(undefined), "");
		assert.equal(syncText("conflict"), "⚠ merge conflict: needs a person");
	});

	test("a queue says why its next task isn't starting when it is held, blocked or interrupted", () => {
		const at = new Date(2026, 10, 9, 14, 30).getTime();
		assert.equal(laneSummary(lane("q", { autoRun: true, pending: 1, total: 1, state: "held", waitReason: "rate-limit anthropic", waitUntil: at }), NOW), "1 pending · 0/1 done · ▶ auto-run · ✋ rate-limit anthropic until 14:30");
		assert.equal(laneSummary(lane("q", { autoRun: true, pending: 1, total: 1, state: "blocked" }), NOW), "1 pending · 0/1 done · ▶ auto-run · ⛓ blocked");
		assert.equal(laneSummary(lane("q", { pending: 1, total: 1, state: "paused" }), NOW), "1 pending · 0/1 done · ⏸ paused", "paused shows only as the arm state");
	});

	test("conflicts are the edges in the conflict state, one entry each with their files; the key changes when a new conflict arises on the same edge", () => {
		const t = task("c", { sync: { a: { state: "conflict", files: ["x.txt", "y.txt"], at: 5 }, b: edge("merged"), d: { state: "conflict", at: 6 } } });
		const found = syncConflicts(plan([], [t, task("ok", { sync: { a: edge("pending") } })]));
		assert.deepEqual(found.map(c => [c.task.id, c.parentId, c.files]), [["c", "a", ["x.txt", "y.txt"]], ["c", "d", []]]);
		const later = syncConflicts(plan([], [task("c", { sync: { a: { state: "conflict", at: 9 } } })]));
		assert.notEqual(later[0].key, found[0].key);
	});
});

describe("checkTaskOption", () => {
	test("a model must look like provider/modelId (further slashes allowed); a bare name is refused so it isn't silently dropped", () => {
		assert.equal(checkTaskOption("model", "anthropic/claude-opus-4-6"), undefined);
		assert.equal(checkTaskOption("model", " openrouter/anthropic/claude-opus "), undefined);
		for (const bad of ["opus", "anthropic/", "/x", "a b/c", "anthropic/ claude"]) assert.ok(checkTaskOption("model", bad), bad);
	});

	test("thinking is one of omp's levels (minimal is read as low by the planner)", () => {
		for (const ok of ["off", "auto", "low", "medium", "high", "xhigh", "max", "minimal"]) assert.equal(checkTaskOption("thinking", ok), undefined, ok);
		assert.match(checkTaskOption("thinking", "extreme") ?? "", /One of: off, auto, low/);
	});

	test("retries are whole numbers 1-10 and the time limit is minutes up to a day", () => {
		assert.equal(checkTaskOption("retries", "3"), undefined);
		for (const bad of ["0", "11", "2.5", "-1", "x"]) assert.ok(checkTaskOption("retries", bad), bad);
		assert.equal(checkTaskOption("timeout", "90"), undefined);
		assert.equal(checkTaskOption("timeout", "0.5"), undefined);
		for (const bad of ["0", "-5", "1441", "soon"]) assert.ok(checkTaskOption("timeout", bad), bad);
	});

	test("empty text is valid in every field: it clears the option", () => {
		for (const f of ["model", "thinking", "retries", "timeout"] as const) assert.equal(checkTaskOption(f, "  "), undefined, f);
	});
});

describe("undoing a task", () => {
	const ran = (id: string, session: string, startedAt: number, extra: Partial<TaskView> = {}): TaskView => task(id, { session, turn: `turn-${id}`, status: "done", state: "done", startedAt, ...extra });

	test("only a finished task that has an AO session and turn can be undone", () => {
		assert.equal(isUndoable(ran("a", "s", 1)), true);
		assert.equal(isUndoable(ran("a", "s", 1, { status: "failed", state: "failed" })), true);
		assert.equal(isUndoable(ran("a", "s", 1, { status: "pending", state: "waiting" })), false);
		assert.equal(isUndoable(ran("a", "s", 1, { turn: undefined })), false);
		assert.equal(isUndoable(ran("a", "s", 1, { session: undefined })), false);
		assert.equal(isUndoable(ran("a", "s", 1, { undone: true })), false, "the planner already knows it is undone");
	});

	test("undoing a turn takes the later turns of the same session with it, not earlier ones or other sessions", () => {
		const t1 = ran("1", "s", 100);
		const t2 = ran("2", "s", 200);
		const t3 = ran("3", "s", 300, { status: "failed", state: "failed" });
		const other = ran("o", "other", 250);
		const pending = task("p", { session: "s", startedAt: 400 });
		const p = plan([], [t3, other, t2, pending, t1]);
		assert.deepEqual(undoneWith(p, t2).map(t => t.id), ["2", "3"]);
		assert.deepEqual(undoneWith(p, t1).map(t => t.id), ["1", "2", "3"]);
		assert.deepEqual(undoneWith(p, t3).map(t => t.id), ["3"]);
	});

	test("afterwards every undone task is pending again and held: queues are paused (requeue re-arms them), separate tasks paused one by one", () => {
		const inQueue = [task("a", { lane: "q" }), task("b", { lane: "q" })];
		const free = task("f");
		const ops = afterUndoOps([...inQueue, free]);
		assert.deepEqual(ops, [{ op: "requeue", id: "a" }, { op: "requeue", id: "b" }, { op: "requeue", id: "f" }, { op: "pause", id: "f" }, { op: "lane.pause", id: "q" }]);
		const requeueIndex = ops.findIndex(o => o.op === "requeue" && o.id === "b");
		assert.ok(ops.findIndex(o => o.op === "lane.pause") > requeueIndex, "the pause comes after the requeue that re-arms the queue");
	});

	test("only armed queues (running by themselves) are held during an undo: those of the undone tasks and the one continuing the session; paused or scheduled ones stay as they are", () => {
		const p = plan([lane("run", { autoRun: true }), lane("paused"), lane("timed", { startAt: 99 }), lane("other", { autoRun: true }), lane("cont", { autoRun: true, session: "s" })], []);
		const tasks = [task("a", { lane: "run" }), task("b", { lane: "run" }), task("c", { lane: "paused" }), task("d", { lane: "timed" }), task("free")];
		assert.deepEqual(armedLanes(p, tasks, "s"), ["run", "cont"], "the queue continuing the session counts even without an undone task in it");
		assert.deepEqual(armedLanes(p, [], "nothing"), []);
	});
});

describe("continuesSession", () => {
	test("a task in a queue whose session exists continues it, a task in a queue with no session starts one", () => {
		const p = plan([lane("q", { session: "proj-1" }), lane("fresh")], []);
		assert.equal(continuesSession(p, { lane: "q" }), true);
		assert.equal(continuesSession(p, { lane: "fresh" }), false);
		assert.equal(continuesSession(p, { lane: "unknown" }), false);
		assert.equal(continuesSession(undefined, { lane: "q" }), false);
	});

	test("a separate task continues its own session when it ran before; fresh context always starts a new one", () => {
		assert.equal(continuesSession(plan([], []), { session: "proj-2" }), true);
		assert.equal(continuesSession(plan([], []), {}), false);
		assert.equal(continuesSession(plan([lane("q", { session: "proj-1" })], []), { lane: "q" }, true), false);
		assert.equal(continuesSession(plan([], []), { session: "proj-2" }, true), false);
	});
});

describe("keptBranchText", () => {
	test("says whose branch it was and why the planner kept it", () => {
		assert.equal(keptBranchText({ task: "Write release notes", why: "holds 2 commits no other branch has" }), "of “Write release notes” — holds 2 commits no other branch has");
	});
});

describe("modeGateNote", () => {
	test("auto never needs the gate; ask, edits and plan are refused at spawn without it", () => {
		for (const gate of [true, false]) assert.equal(modeGateNote("auto", gate), "");
		for (const m of ["ask", "edits", "plan"]) {
			assert.equal(modeGateNote(m, true), "");
			assert.match(modeGateNote(m, false), /gate is not installed/);
		}
	});
});

describe("failureHint", () => {
	test("recognises the missing-gate refusal on a failed task only", () => {
		const summary = 'Permission mode "plan" needs the Switchyard permission gate, which is not installed (looked in /x). Run `switchyard omp-extension install`; without the gate a session can only start in mode "auto".';
		assert.equal(failureHint({ status: "failed", summary }), "⚠ permission gate not installed");
		assert.equal(failureHint({ status: "pending", summary }), "", "a requeued task is not failed any more");
		assert.equal(failureHint({ status: "failed", summary: "The model request failed." }), "");
		assert.equal(failureHint({ status: "failed" }), "");
	});
});
