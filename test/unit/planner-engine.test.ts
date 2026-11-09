// The planner's pure engine: graph readiness, queue (lane) ops, slots and priorities, schedules, usage
// gating, run outcomes and what survives a reload from disk.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { queueOpsToPlanOps, queueView } from "../../src/planner/compat";
import { type ReadinessContext, advance, applyOps, emptyState, evaluate, finishRun, normalizeOptions, normalizeState, startRun, taskPrompt } from "../../src/planner/engine";
import type { PlanOp, PlanState, TaskView } from "../../src/planner/types";
import { holdFor, isLimitError, parseResetAt, replyIsLimitError, replyIsProviderError, spendUse } from "../../src/planner/usage";
import { parseOmpUsage } from "../../src/planner/usage-source";
import { nextOccurrence, normalizeRule, parseStartTime } from "../../src/planner/when";

const NOW = Date.parse("2026-11-09T10:00:00Z");
const MIN = 60_000;

function ctx(now = NOW, extra: Partial<ReadinessContext> = {}): ReadinessContext {
	return { now, busySessions: new Set(), usage: { limits: [], windows: [], spend: [], config: { holdAtPercent: 95, spareBelowPercent: 60 } }, ...extra };
}

/** Applies ops to a fresh (or given) plan; returns the state and the ref → id map. */
function plan(ops: PlanOp[], base: PlanState = emptyState(), now = NOW) {
	const res = applyOps(base, ops, now);
	return { s: res.state, refs: res.refs };
}

const byTitle = (views: TaskView[], title: string) => views.find(v => v.title === title) as TaskView;
const dispatched = (s: PlanState, c = ctx()) => evaluate(s, c).dispatch.map(t => t.title);

/** Runs task `title` to completion with `summary`. */
function complete(s: PlanState, title: string, summary = `${title} done`, now = NOW): void {
	const t = s.tasks.find(x => x.title === title);
	assert.ok(t);
	startRun(s, t.id, { key: `k-${t.id}`, via: "spawn", prompt: "p", spawn: { displayName: "t" } }, now);
	finishRun(s, t.id, { kind: "completed", summary }, now + 1000);
}

describe("graph readiness", () => {
	const graph = () =>
		plan([
			{ op: "add", ref: "a", task: { title: "A" } },
			{ op: "add", ref: "b", task: { title: "B", after: ["@a"] } },
			{ op: "add", ref: "c", task: { title: "C", after: ["@a"] } },
		]);

	test("children wait for their parent, then run in parallel", () => {
		const { s } = graph();
		s.config.maxConcurrent = 0;
		const ev = evaluate(s, ctx());
		assert.deepEqual(ev.dispatch.map(t => t.title), ["A"]);
		assert.equal(byTitle(ev.views, "B").state, "blocked");
		assert.deepEqual(byTitle(ev.views, "B").blockedBy, [s.tasks[0].id]);
		assert.deepEqual(byTitle(ev.views, "A").children, [s.tasks[1].id, s.tasks[2].id]);
		complete(s, "A");
		assert.deepEqual(dispatched(s), ["B", "C"]);
	});

	test("the parents' results go into the child's prompt unless inputs is none", () => {
		const { s } = graph();
		complete(s, "A", "Found 3 bugs in parser.ts");
		const b = s.tasks.find(t => t.title === "B");
		assert.ok(b);
		assert.match(taskPrompt(s, b), /Results of the tasks this one depends on:\n\n### A\nFound 3 bugs in parser\.ts/);
		b.inputs = "none";
		assert.doesNotMatch(taskPrompt(s, b), /Results/);
	});

	test("a failed parent keeps children blocked and says so; requeue + success unblocks", () => {
		const { s } = graph();
		const a = s.tasks[0];
		startRun(s, a.id, { key: "k", via: "spawn", prompt: "p", spawn: { displayName: "t" } }, NOW);
		finishRun(s, a.id, { kind: "error", error: { message: "boom" } }, NOW);
		assert.equal(a.status, "failed");
		const ev = evaluate(s, ctx());
		assert.equal(ev.dispatch.length, 0);
		assert.match(byTitle(ev.views, "B").waitReason ?? "", /a dependency failed: A/);
		const again = applyOps(s, [{ op: "requeue", id: a.id }], NOW).state;
		complete(again, "A");
		assert.deepEqual(dispatched(again), ["B", "C"]);
	});

	test("skip satisfies dependents; a deleted dependency keeps blocking", () => {
		const { s, refs } = graph();
		const skipped = applyOps(s, [{ op: "skip", id: refs.a }], NOW).state;
		assert.deepEqual(dispatched(skipped), ["B", "C"]);
		const removed = applyOps(s, [{ op: "remove", id: refs.a }], NOW).state;
		const ev = evaluate(removed, ctx());
		assert.equal(ev.dispatch.length, 0);
		assert.match(byTitle(ev.views, "B").waitReason ?? "", /\(missing\)/);
	});

	test("a failed dependency keeps blocking and says so; marking its queue completed releases the dependents, running work never does", () => {
		const lane = "l_0000000002";
		const { s, refs } = plan([
			{ op: "lane.add", id: lane, title: "Q" },
			{ op: "add", ref: "a", task: { title: "A", lane } },
			{ op: "add", ref: "b", task: { title: "B", after: ["@a"] } },
		]);
		const a = s.tasks.find(t => t.id === refs.a);
		assert.ok(a);
		startRun(s, a.id, { key: "k-a", via: "spawn", prompt: "p", spawn: { displayName: "t" } }, NOW);
		const running = applyOps(s, [{ op: "lane.complete", id: lane, completed: true }], NOW).state;
		assert.equal(byTitle(evaluate(running, ctx()).views, "B").state, "blocked", "running work is never finished");
		finishRun(s, a.id, { kind: "error", error: { message: "boom" } }, NOW + 1000);
		const failed = byTitle(evaluate(s, ctx()).views, "B");
		assert.equal(failed.state, "blocked");
		assert.match(failed.waitReason ?? "", /a dependency failed: A/);
		const completed = applyOps(s, [{ op: "lane.complete", id: lane, completed: true }], NOW + 2000).state;
		assert.equal(evaluate(completed, ctx(NOW + 2000)).dispatch.map(t => t.title).includes("B"), true, "completed counts as finished");
		const undone = applyOps(completed, [{ op: "lane.complete", id: lane, completed: false }], NOW + 3000).state;
		assert.equal(byTitle(evaluate(undone, ctx(NOW + 3000)).views, "B").state, "blocked");
	});

	test("self, unknown and cyclic dependencies are refused with the path", () => {
		const { s, refs } = graph();
		assert.throws(() => applyOps(s, [{ op: "after", id: refs.a, ids: [refs.a] }], NOW), /can't wait for itself/);
		assert.throws(() => applyOps(s, [{ op: "after", id: refs.a, ids: ["nope"] }], NOW), /unknown task nope/);
		assert.throws(() => applyOps(s, [{ op: "after", id: refs.a, ids: [refs.b] }], NOW), /cycle: "A" → "B" → "A"/);
		// A rejected batch changes nothing, even its valid ops.
		assert.throws(() => applyOps(s, [{ op: "add", task: { title: "D" } }, { op: "after", id: refs.a, ids: [refs.c] }], NOW));
		assert.equal(s.tasks.length, 3);
	});
});

describe("requeue and reschedule from cards (lane.requeue, lane.startAt, run)", () => {
	const MIN = 60_000;
	const L = "l_00000000r1";
	const q = (...titles: string[]) =>
		plan([{ op: "lane.add", id: L, title: "Q", autoRun: false }, ...titles.map((title): PlanOp => ({ op: "add", task: { title, lane: L } }))]).s;
	const fail = (s: PlanState, title: string) => {
		const t = s.tasks.find(x => x.title === title);
		assert.ok(t);
		startRun(s, t.id, { key: `k-${t.id}`, via: "spawn", prompt: "p", spawn: { displayName: "t" } }, NOW);
		finishRun(s, t.id, { kind: "error", error: { message: "boom" } }, NOW + 1000);
	};
	const requeue = (s: PlanState) => applyOps(s, [{ op: "lane.requeue", id: L }], NOW).state;
	const laneOf = (s: PlanState) => s.lanes.find(l => l.id === L);

	test("failed tasks go back to pending clean and the lane is re-armed", () => {
		const s = q("a", "b", "c");
		complete(s, "a");
		fail(s, "b");
		assert.equal(laneOf(s)?.autoRun, false, "a failure stops the lane");
		const next = requeue(s);
		assert.deepEqual(next.tasks.map(t => t.status), ["done", "pending", "pending"]);
		assert.deepEqual([next.tasks[1].summary, next.tasks[1].attempts, next.tasks[1].finishedAt], [undefined, undefined, undefined]);
		assert.equal(laneOf(next)?.autoRun, true);
		assert.deepEqual(dispatched(next), ["b"]);
	});

	test("a scheduled start is kept: the requeued task waits for it", () => {
		const s = q("a");
		fail(s, "a");
		const scheduled = applyOps(s, [{ op: "lane.startAt", id: L, at: NOW + 60 * MIN }], NOW).state;
		const next = requeue(scheduled);
		assert.deepEqual([next.tasks[0].status, laneOf(next)?.autoRun, laneOf(next)?.startAt], ["pending", false, NOW + 60 * MIN]);
		assert.equal(byTitle(evaluate(next, ctx()).views, "a").state, "scheduled");
		assert.deepEqual(dispatched(next), []);
		assert.equal(advance(next, NOW + 61 * MIN), true);
		assert.deepEqual(dispatched(next, ctx(NOW + 61 * MIN)), ["a"]);
	});

	test("an interrupted or paused lane runs again; the interrupted mark is cleared", () => {
		const s = q("a", "b");
		s.tasks[0].interrupted = NOW;
		s.tasks[0].summary = "Interrupted";
		const next = requeue(s);
		assert.deepEqual([next.tasks[0].interrupted, next.tasks[0].summary, laneOf(next)?.autoRun], [undefined, undefined, true]);
	});

	test("a finished lane runs its last task again; an empty or running one is left alone", () => {
		const s = q("a", "b");
		complete(s, "a");
		complete(s, "b");
		const next = requeue(s);
		assert.deepEqual(next.tasks.map(t => t.status), ["done", "pending"]);
		assert.equal(next.tasks[1].finishedAt, undefined);
		assert.equal(laneOf(next)?.autoRun, true);
		assert.equal(requeue(q()).tasks.length, 0);
		const busy = q("a", "b");
		complete(busy, "a");
		startRun(busy, busy.tasks[1].id, { key: "k", via: "spawn", prompt: "p", spawn: { displayName: "t" } }, NOW);
		const same = requeue(busy);
		assert.deepEqual(same.tasks.map(t => t.status), ["done", "running"]);
	});

	test("run now drops the lane's start time and arms it; scheduling again moves it; unscheduling keeps the lane paused", () => {
		const s = applyOps(q("a", "b"), [{ op: "lane.startAt", id: L, at: NOW + 120 * MIN }], NOW).state;
		assert.equal(laneOf(s)?.startAt, NOW + 120 * MIN);
		const moved = applyOps(s, [{ op: "lane.startAt", id: L, at: NOW + 30 * MIN }], NOW).state;
		assert.equal(laneOf(moved)?.startAt, NOW + 30 * MIN);
		const cleared = applyOps(moved, [{ op: "lane.startAt", id: L, at: null }], NOW).state;
		assert.deepEqual([laneOf(cleared)?.startAt, laneOf(cleared)?.autoRun], [undefined, false]);
		assert.deepEqual(dispatched(cleared), [], "unscheduled work stays paused");
		const ran = applyOps(s, [{ op: "run", id: s.tasks[1].id }], NOW).state;
		assert.deepEqual([laneOf(ran)?.startAt, laneOf(ran)?.autoRun, ran.tasks[0].title], [undefined, true, "b"]);
		assert.deepEqual(dispatched(ran), ["b"]);
		assert.throws(() => applyOps(s, [{ op: "lane.startAt", id: L, at: Number.NaN }], NOW), /epoch ms or null/);
	});

	test("the old queue ops map: schedule → lane.startAt, requeue → lane.requeue, run without id → the first pending task", () => {
		const s = q("a", "b");
		assert.deepEqual(queueOpsToPlanOps(s, L, [{ op: "schedule", at: NOW + MIN }, { op: "schedule", at: null }, { op: "requeue" }, { op: "run" }]), [
			{ op: "lane.startAt", id: L, at: NOW + MIN },
			{ op: "lane.startAt", id: L, at: null },
			{ op: "lane.requeue", id: L },
			{ op: "run", id: s.tasks[0].id },
		]);
	});
});

describe("lanes (queues)", () => {
	const lane = () =>
		plan([
			{ op: "lane.add", id: "l_0000000001", title: "Q" },
			{ op: "add", task: { title: "one", lane: "l_0000000001" } },
			{ op: "add", task: { title: "two", lane: "l_0000000001" } },
			{ op: "add", task: { title: "three", lane: "l_0000000001" } },
		]);

	test("one task at a time, in lane order; move and run reorder", () => {
		const { s } = lane();
		s.config.maxConcurrent = 0;
		let ev = evaluate(s, ctx());
		assert.deepEqual(ev.dispatch.map(t => t.title), ["one"]);
		assert.match(byTitle(ev.views, "two").waitReason ?? "", /behind "one"/);
		const moved = applyOps(s, [{ op: "move", id: s.tasks[2].id, index: 0 }], NOW).state;
		assert.deepEqual(moved.tasks.map(t => t.title), ["three", "one", "two"]);
		const ran = applyOps(s, [{ op: "run", id: s.tasks[1].id }], NOW).state;
		assert.deepEqual(dispatched(ran), ["two"]);
		// While "two" runs, the lane is busy.
		const two = ran.tasks.find(t => t.title === "two");
		assert.ok(two);
		startRun(ran, two.id, { key: "k", via: "spawn", prompt: "p", spawn: { displayName: "t" } }, NOW);
		ev = evaluate(ran, ctx());
		assert.equal(ev.dispatch.length, 0);
	});

	test("pause, resume, scheduled start, failure pauses the lane, lane requeue", () => {
		const { s } = lane();
		const id = "l_0000000001";
		const paused = applyOps(s, [{ op: "lane.pause", id }], NOW).state;
		assert.equal(byTitle(evaluate(paused, ctx()).views, "one").state, "paused");
		const later = applyOps(s, [{ op: "lane.startAt", id, at: NOW + 30 * MIN }], NOW).state;
		assert.equal(byTitle(evaluate(later, ctx()).views, "one").state, "scheduled");
		assert.equal(advance(later, NOW + 31 * MIN), true);
		assert.deepEqual(dispatched(later, ctx(NOW + 31 * MIN)), ["one"]);
		// A failure without retries stops the lane; lane.requeue re-runs the failed task and re-arms.
		const one = s.tasks[0];
		startRun(s, one.id, { key: "k", via: "spawn", prompt: "p", spawn: { displayName: "t" } }, NOW);
		finishRun(s, one.id, { kind: "error", error: { message: "x" } }, NOW);
		assert.equal(s.lanes[0].autoRun, false);
		assert.equal(dispatched(s).length, 0);
		const requeued = applyOps(s, [{ op: "lane.requeue", id }], NOW).state;
		assert.equal(requeued.tasks[0].status, "pending");
		assert.deepEqual(dispatched(requeued), ["one"]);
	});

	test("done and skip move the head; done ticks subtasks; running tasks refuse edits", () => {
		const { s } = lane();
		const withSub = applyOps(s, [{ op: "addSubtask", id: s.tasks[0].id, title: "sub" }, { op: "done", id: s.tasks[0].id }, { op: "skip", id: s.tasks[1].id }], NOW).state;
		assert.equal(withSub.tasks[0].subtasks[0].done, true);
		assert.deepEqual(dispatched(withSub), ["three"]);
		startRun(withSub, withSub.tasks[2].id, { key: "k", via: "spawn", prompt: "p", spawn: { displayName: "t" } }, NOW);
		assert.throws(() => applyOps(withSub, [{ op: "remove", id: withSub.tasks[2].id }], NOW), /is running; abort it/);
		assert.throws(() => applyOps(withSub, [{ op: "update", id: withSub.tasks[2].id, options: { model: "a/b" } }], NOW), /only its title, notes and priority/);
	});

	test("old QueueOps map onto the lane; getQueue keeps the old shape", () => {
		const s = emptyState();
		const ops = queueOpsToPlanOps(s, "repo-3", [
			{ op: "add", title: "first", options: { retries: 2 } },
			{ op: "add", title: "second" },
			{ op: "autoRun", value: true },
		]);
		const next = applyOps(s, ops, NOW).state;
		assert.equal(next.lanes[0].session, "repo-3");
		const q = queueView(next, evaluate(next, ctx()).views, "repo-3");
		assert.equal(q.autoRun, true);
		assert.deepEqual(
			q.tasks.map(t => [t.title, t.status, t.options?.retries]),
			[
				["first", "pending", 2],
				["second", "pending", undefined],
			],
		);
		// A lane added through `queue` starts unarmed, like an old queue.
		const fresh = applyOps(s, queueOpsToPlanOps(s, "repo-4", [{ op: "add", title: "x" }]), NOW).state;
		assert.equal(fresh.lanes[0].autoRun, false);
		// `schedule` and `requeue` map to lane ops.
		assert.deepEqual(queueOpsToPlanOps(next, "repo-3", [{ op: "schedule", at: NOW + MIN }, { op: "requeue" }]), [
			{ op: "lane.startAt", id: "repo-3", at: NOW + MIN },
			{ op: "lane.requeue", id: "repo-3" },
		]);
	});
});

describe("slots and priorities", () => {
	test("the concurrency limit caps dispatch; priority beats plan order", () => {
		const { s } = plan([
			{ op: "add", task: { title: "n1" } },
			{ op: "add", task: { title: "n2" } },
			{ op: "add", task: { title: "low", priority: "low" } },
			{ op: "add", task: { title: "urgent", priority: "urgent" } },
		]);
		s.config.maxConcurrent = 2;
		assert.deepEqual(dispatched(s), ["urgent", "n1"]);
		const ev = evaluate(s, ctx());
		assert.equal(byTitle(ev.views, "n2").position, 1);
		assert.equal(byTitle(ev.views, "low").position, 2);
		assert.match(byTitle(ev.views, "n2").waitReason ?? "", /waiting for a slot/);
		startRun(s, s.tasks[3].id, { key: "k", via: "spawn", prompt: "p", spawn: { displayName: "t" } }, NOW);
		assert.deepEqual(dispatched(s), ["n1"]);
		s.config.maxConcurrent = 0;
		assert.deepEqual(dispatched(s), ["n1", "n2", "low"]);
		s.config.paused = true;
		assert.deepEqual(dispatched(s), []);
	});

	test("a lane's priority applies to its tasks; one dispatch per AO session", () => {
		const { s } = plan([
			{ op: "add", task: { title: "free" } },
			{ op: "lane.add", id: "sess-1", priority: "high" },
			{ op: "add", task: { title: "in lane", lane: "sess-1" } },
			{ op: "lane.add", id: "l_0000000002", session: "sess-1" },
			{ op: "add", task: { title: "same session", lane: "l_0000000002" } },
		]);
		s.config.maxConcurrent = 0;
		assert.deepEqual(dispatched(s), ["in lane", "free"]);
		// A person chatting in the session holds its lane.
		assert.deepEqual(dispatched(s, ctx(NOW, { busySessions: new Set(["sess-1"]) })), ["free"]);
	});
});

describe("schedules", () => {
	test("a task's start time", () => {
		const { s } = plan([{ op: "add", task: { title: "later", startAt: NOW + 10 * MIN } }]);
		const ev = evaluate(s, ctx());
		assert.equal(byTitle(ev.views, "later").state, "scheduled");
		assert.equal(byTitle(ev.views, "later").waitUntil, NOW + 10 * MIN);
		assert.deepEqual(dispatched(s, ctx(NOW + 10 * MIN)), ["later"]);
	});

	test("recurring every N minutes: one copy per firing, skipped while the last is open, missed ones collapse", () => {
		const { s, refs } = plan([{ op: "recur.add", ref: "r", recurring: { rule: { every: 60 }, task: { title: "nightly" } } }]);
		assert.equal(s.recurring[0].nextAt, NOW + 60 * MIN);
		assert.equal(advance(s, NOW + 30 * MIN), false);
		advance(s, NOW + 60 * MIN);
		assert.equal(s.tasks.filter(t => t.recur === refs.r).length, 1);
		// Still pending at the next occurrence: no second copy.
		advance(s, NOW + 120 * MIN);
		assert.equal(s.tasks.length, 1);
		complete(s, "nightly");
		// Down for five hours: one copy, next occurrence on the original grid.
		advance(s, NOW + 7 * 60 * MIN + 5 * MIN);
		assert.equal(s.tasks.filter(t => t.status === "pending").length, 1);
		assert.equal(s.recurring[0].nextAt, NOW + 8 * 60 * MIN);
	});

	test("recurring at times of day on weekdays; rule validation", () => {
		// 2026-11-09 is a Monday.
		const monday9 = new Date(2026, 10, 9, 9, 0).getTime();
		const rule = normalizeRule({ at: ["17:30", "08:00"], days: [1, 3] });
		assert.deepEqual(rule, { at: ["08:00", "17:30"], days: [1, 3] });
		if (typeof rule === "string") return;
		assert.equal(nextOccurrence(rule, monday9), new Date(2026, 10, 9, 17, 30).getTime());
		assert.equal(nextOccurrence(rule, new Date(2026, 10, 9, 18, 0).getTime()), new Date(2026, 10, 11, 8, 0).getTime());
		assert.match(String(normalizeRule({ every: 1 })), /≥ 5/);
		assert.match(String(normalizeRule({ every: 10, at: ["10:00"] })), /not both/);
		assert.match(String(normalizeRule({ at: ["25:00"] })), /not a time of day/);
	});

	test("parseStartTime", () => {
		assert.equal(parseStartTime("+30m", NOW), NOW + 30 * MIN);
		assert.throws(() => parseStartTime("2020-01-01T00:00", NOW), /in the past/);
		assert.throws(() => parseStartTime("soon", NOW), /can't read/);
	});
});

describe("usage gating", () => {
	test("a limit error holds the provider without using an attempt; success clears it", () => {
		const { s } = plan([{ op: "add", task: { title: "t", options: { model: "anthropic/claude-x", retries: 1 } } }]);
		const t = s.tasks[0];
		startRun(s, t.id, { key: "k", via: "spawn", prompt: "p", spawn: { displayName: "t" }, provider: "anthropic" }, NOW);
		finishRun(s, t.id, { kind: "error", error: { message: "Usage limit reached. Resets in 2 hr." } }, NOW);
		assert.equal(t.status, "pending");
		assert.equal(t.attempts, undefined);
		assert.equal(s.limits.anthropic.until, NOW + 120 * MIN);
		const c = ctx(NOW + MIN, { usage: { limits: Object.values(s.limits), windows: [], spend: [], config: { holdAtPercent: 95, spareBelowPercent: 60 } } });
		const view = byTitle(evaluate(s, c).views, "t");
		assert.equal(view.state, "held");
		assert.match(view.waitReason ?? "", /rate-limit anthropic until/);
		startRun(s, t.id, { key: "k3", via: "spawn", prompt: "p", spawn: { displayName: "t" }, provider: "anthropic" }, NOW + 3 * 60 * MIN);
		finishRun(s, t.id, { kind: "completed", summary: "ok" }, NOW + 3 * 60 * MIN);
		assert.equal(s.limits.anthropic, undefined);
	});

	test("usage windows hold work at the threshold; spare work waits for room; budgets cap spend", () => {
		const config = { holdAtPercent: 95, spareBelowPercent: 60 };
		const windows = [{ provider: "anthropic", window: "5 Hour", usedPercent: 70, resetsAt: NOW + 60 * MIN }];
		assert.equal(holdFor("anthropic", false, { limits: [], windows, spend: [], config }, NOW), undefined);
		assert.match(holdFor("anthropic", true, { limits: [], windows, spend: [], config }, NOW)?.reason ?? "", /spare: usage anthropic 5 Hour 70%/);
		assert.equal(holdFor("openai", true, { limits: [], windows, spend: [], config }, NOW), undefined);
		const full = [{ ...windows[0], usedPercent: 97 }];
		assert.equal(holdFor("anthropic", false, { limits: [], windows: full, spend: [], config }, NOW)?.until, NOW + 60 * MIN);
		// A window whose reset passed no longer holds (fresh numbers come with the next refresh).
		assert.equal(holdFor("anthropic", false, { limits: [], windows: full, spend: [], config }, NOW + 61 * MIN), undefined);
		const spend = spendUse(
			[
				[NOW - 50 * MIN, 3],
				[NOW - 10 * MIN, 2.5],
			],
			{ hour: 5 },
			NOW,
		);
		assert.deepEqual(spend, [{ window: "hour", cap: 5, spent: 5.5, over: true, freesAt: NOW + 10 * MIN }]);
		assert.match(holdFor(undefined, false, { limits: [], windows: [], spend, config }, NOW)?.reason ?? "", /budget hour 5.50\/5 USD/);
	});

	test("limit errors as providers word them", () => {
		assert.equal(parseResetAt("You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.", NOW), NOW + 120 * MIN);
		assert.equal(isLimitError({ message: "429 Too Many Requests" }), true);
		assert.equal(isLimitError({ message: '529 {"type":"error","error":{"type":"overloaded_error"}}' }), false);
		assert.equal(isLimitError({ message: "Your credit balance is too low to access the Anthropic API." }), false);
	});

	test("a completed turn whose reply is a provider's limit error counts as one; an answer that discusses limits doesn't (G35)", () => {
		for (const reply of [
			"429 You have reached your usage limit. Your limit resets at 2026-11-09T21:00:00Z. Please try again in 4 hours. retry-after-ms=14400000",
			"Claude AI usage limit reached|1762700000",
			"You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.",
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit"}}',
			"Rate limit reached for gpt-4o in organization org-abc. Please try again in 4.8s.",
		]) assert.equal(replyIsLimitError(reply, NOW), true, reply);
		for (const reply of [
			"I added rate limiting to the API: a token bucket per client; clients above 100 requests a minute get 429 and a Retry-After header.",
			`${"Summary of the work. ".repeat(100)}Also: 429 You have reached your usage limit.`,
			"Done. The limit is 429 requests.",
			"",
		]) assert.equal(replyIsLimitError(reply, NOW), false, reply.slice(0, 60));
	});

	test("other provider errors that arrive as a completed reply are recognized too, ordinary replies are not", () => {
		for (const reply of ["Error: fake provider failure", '529 {"type":"error","error":{"type":"overloaded_error"}}', "No API key found for anthropic.", "Connection error.", "401 \"invalid x-api-key\""]) assert.equal(replyIsProviderError(reply), true, reply);
		for (const reply of ["Error handling added to the parser; tests pass.", "404 pages fixed and verified.", "Done. I fixed the connection error in the retry loop.", `Error: ${"x".repeat(2000)}`, ""]) assert.equal(replyIsProviderError(reply), false, reply.slice(0, 50));
	});

	test("omp usage --json: the account with most room counts; tier windows don't gate the provider", () => {
		const limit = (id: string, used: number, extra: object = {}) => ({ id, label: id, scope: { provider: "anthropic", ...extra }, window: { resetsAt: NOW + used }, amount: { usedFraction: used / 100 } });
		const windows = parseOmpUsage({
			reports: [
				{ provider: "anthropic", limits: [limit("anthropic:5h", 90), limit("anthropic:7d:fable", 0, { tier: "fable" })] },
				{ provider: "anthropic", limits: [limit("anthropic:5h", 28)] },
			],
		});
		assert.deepEqual(windows, [{ provider: "anthropic", window: "anthropic:5h", usedPercent: 28, resetsAt: NOW + 28 }]);
	});
});

describe("run outcomes", () => {
	const one = (options = {}) => {
		const { s } = plan([{ op: "lane.add", id: "l_0000000003" }, { op: "add", task: { title: "t", lane: "l_0000000003", options } }]);
		const t = s.tasks[0];
		startRun(s, t.id, { key: "k", via: "spawn", prompt: "p", spawn: { displayName: "t" }, session: "sess-9" }, NOW);
		return { s, t };
	};

	test("errors retry with backoff, then fail; cost adds up", () => {
		const { s, t } = one({ retries: 1 });
		finishRun(s, t.id, { kind: "error", error: { message: "boom" }, cost: 0.5 }, NOW + MIN);
		assert.equal(t.status, "pending");
		assert.equal(t.attempts, 1);
		assert.equal(t.holdUntil, NOW + MIN + 10_000);
		assert.equal(byTitle(evaluate(s, ctx(NOW + MIN)).views, "t").state, "held");
		startRun(s, t.id, { key: "k2", via: "send", prompt: "p", session: "sess-9" }, NOW + 2 * MIN);
		finishRun(s, t.id, { kind: "error", error: { message: "boom" }, cost: 0.25 }, NOW + 3 * MIN);
		assert.equal(t.status, "failed");
		assert.equal(t.cost, 0.75);
		assert.match(t.summary ?? "", /gave up after 2 attempts/);
		assert.equal(s.lanes[0].session, "sess-9");
	});

	test("abort pauses; an interruption by someone else or a lost run is marked interrupted and never re-run", () => {
		let { s, t } = one();
		(t.run as NonNullable<typeof t.run>).aborted = true;
		finishRun(s, t.id, { kind: "interrupted" }, NOW);
		assert.equal(t.status, "pending");
		assert.equal(t.interrupted, undefined);
		assert.equal(s.lanes[0].autoRun, false);
		({ s, t } = one());
		finishRun(s, t.id, { kind: "lost", reason: "AO session was deleted." }, NOW);
		assert.equal(t.interrupted, NOW);
		assert.equal(byTitle(evaluate(s, ctx()).views, "t").state, "interrupted");
		assert.equal(dispatched(s).length, 0);
		// Only a person brings it back.
		const ran = applyOps(s, [{ op: "run", id: t.id }], NOW).state;
		assert.deepEqual(dispatched(ran), ["t"]);
	});

	test("a timeout is a failure (retried when allowed), not an interruption", () => {
		const { s, t } = one({ timeoutMinutes: 5 });
		(t.run as NonNullable<typeof t.run>).timedOut = true;
		finishRun(s, t.id, { kind: "interrupted" }, NOW);
		assert.equal(t.status, "failed");
		assert.match(t.summary ?? "", /Timed out after 5 min/);
	});
});

describe("persistence", () => {
	test("a round trip keeps the plan; a running task without a dispatch record comes back interrupted", () => {
		const { s } = plan([
			{ op: "add", ref: "a", task: { title: "A", options: { model: "anthropic/x", thinking: "high" } } },
			{ op: "add", task: { title: "B", after: ["@a"], priority: "high", usage: "spare" } },
			{ op: "recur.add", recurring: { rule: { at: ["09:00"] }, task: { title: "daily" } } },
		]);
		startRun(s, s.tasks[0].id, { key: "k", via: "spawn", prompt: "p", spawn: { displayName: "t" } }, NOW);
		const back = normalizeState(JSON.parse(JSON.stringify(s)));
		assert.deepEqual(back, s);
		const raw = JSON.parse(JSON.stringify(s));
		delete raw.tasks[0].run;
		const lost = normalizeState(raw);
		assert.equal(lost.tasks[0].status, "pending");
		assert.ok(lost.tasks[0].interrupted);
	});
});

describe("task options", () => {
	test("thinking levels are omp's own; `minimal` from old queues and clients means low (G42)", () => {
		assert.equal(normalizeOptions({ thinking: "minimal" })?.thinking, "low");
		for (const level of ["off", "auto", "low", "medium", "high", "xhigh", "max"]) assert.equal(normalizeOptions({ thinking: level })?.thinking, level);
		assert.equal(normalizeOptions({ thinking: "extreme" }), undefined);
	});
});

// The chat panel (ext-chat) turns these message shapes into chips by their first line and trailing sentence.
describe("task prompt shapes the chat panel recognises", () => {
	test("a lane task, a free task and a follow-up keep their heads and trailers", () => {
		const { s: state } = plan([{ op: "lane.add", id: "l_00000000d4" }, { op: "add", task: { title: "In lane", lane: "l_00000000d4" } }, { op: "add", task: { title: "Free" } }]);
		const [inLane, free] = state.tasks;
		assert.match(taskPrompt(state, inLane), /^\[Task 1\/1 from the queue\] In lane\n[\s\S]*\nWork through this task completely/);
		assert.match(taskPrompt(state, free), /^\[Task from the plan\] Free\n[\s\S]*\nWork through this task completely/);
		const followUp = { ...free, followUpOnly: true, followUp: "A changed x.txt." };
		assert.match(taskPrompt(state, followUp), /^\[Follow-up on your task\] Free\n\nA changed x\.txt\.\n\nTake this into account, fix whatever it breaks/);
	});
});
