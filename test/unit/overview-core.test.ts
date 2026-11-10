import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LaneView, PlanView, PlannerStatus, TaskState, TaskView } from "../../src/planner/types";
import {
	type NextItem,
	type OverviewOrchestrator,
	type OverviewSession,
	agoText,
	buildOverview,
	durationText,
	heldGroups,
	holdKind,
	inText,
	meterPercent,
	needsYou,
	nextUp,
	orchestratorItems,
	orderNextUp,
	prsNeedingAttention,
	schedulerView,
	tidyReason,
	usageLevel,
	workingNow,
} from "../../src/overview/overview-core";

const NOW = Date.UTC(2025, 0, 10, 9, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

function status(extra: Partial<PlannerStatus> = {}): PlannerStatus {
	return {
		maxConcurrent: 2,
		paused: false,
		usage: { holdAtPercent: 95, spareBelowPercent: 60 },
		running: 0,
		waiting: 0,
		scheduled: 0,
		held: 0,
		blocked: 0,
		interrupted: 0,
		limits: [],
		usageWindows: [],
		spend: [],
		ao: { connected: true },
		version: "test",
		startedAt: NOW - HOUR,
		...extra,
	};
}

function task(id: string, state: TaskState, extra: Partial<TaskView> = {}): TaskView {
	return { id, title: `Task ${id}`, subtasks: [], status: state === "running" ? "running" : state === "done" ? "done" : state === "failed" ? "failed" : "pending", createdAt: NOW, state, ...extra };
}

function lane(id: string, extra: Partial<LaneView> = {}): LaneView {
	return { id, autoRun: true, createdAt: NOW, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...extra };
}

function plan(tasks: TaskView[], extra: Partial<PlanView> = {}): PlanView {
	return { rev: 1, edges: [], keptBranches: [], tasks, lanes: [], recurring: [], status: status(), ...extra };
}

function session(id: string, extra: Partial<OverviewSession> = {}): OverviewSession {
	return { id, title: `Session ${id}`, project: "app", status: "idle", createdAt: NOW - HOUR, updatedAt: NOW - 10 * MIN, prs: [], ...extra };
}

const pr = (number: number, extra: Partial<OverviewSession["prs"][number]> = {}): OverviewSession["prs"][number] => ({
	number,
	url: `https://example.test/pull/${number}`,
	state: "open",
	ci: "passing",
	review: "none",
	mergeability: "mergeable",
	reviewComments: false,
	updatedAt: new Date(NOW - number * MIN).toISOString(),
	...extra,
});

describe("times and meters", () => {
	test("durationText keeps the two units that matter", () => {
		assert.equal(durationText(20_000), "under 1m");
		assert.equal(durationText(14 * MIN + 59_000), "14m");
		assert.equal(durationText(2 * HOUR + 10 * MIN), "2h 10m");
		assert.equal(durationText(2 * HOUR), "2h");
		assert.equal(durationText(3 * 24 * HOUR + 4 * HOUR + 5 * MIN), "3d 4h");
		assert.equal(durationText(24 * HOUR), "1d");
	});
	test("inText and agoText: the future says 'in', a passed time is due now", () => {
		assert.equal(inText(NOW + 2 * HOUR + 10 * MIN, NOW), "in 2h 10m");
		assert.equal(inText(NOW, NOW), "due now");
		assert.equal(inText(NOW - MIN, NOW), "due now");
		assert.equal(agoText(NOW - 5 * MIN, NOW), "5m ago");
		assert.equal(agoText(NOW - 5_000, NOW), "just now");
	});
	test("meterPercent rounds, clamps and survives no cap", () => {
		assert.equal(meterPercent(5, 20), 25);
		assert.equal(meterPercent(1, 3), 33);
		assert.equal(meterPercent(25, 20), 100);
		assert.equal(meterPercent(5, 0), 0);
		assert.equal(meterPercent(-1, 10), 0);
		assert.equal(meterPercent(Number.NaN, 10), 0);
	});
	test("usageLevel follows the planner's thresholds", () => {
		const t = { holdAtPercent: 95, spareBelowPercent: 60 };
		assert.equal(usageLevel(59, t), "ok");
		assert.equal(usageLevel(60, t), "warn");
		assert.equal(usageLevel(94, t), "warn");
		assert.equal(usageLevel(95, t), "hold");
	});
	test("tidyReason: a JSON error body reads as its message, long text is cut", () => {
		assert.equal(tidyReason('429 {"type":"error","error":{"type":"rate_limit_error","message":"Usage limit reached. Please try again in 7200s."}}'), "Usage limit reached. Please try again in 7200s.");
		assert.equal(tidyReason("  rate   limited \n again "), "rate limited again");
		assert.equal(tidyReason("x".repeat(200), 20), `${"x".repeat(19)}…`);
		assert.equal(tidyReason('{"message":"say \\"hi\\""}'), 'say "hi"');
	});
	test("holdKind names the planner's reasons", () => {
		assert.equal(holdKind("rate-limit anthropic until 14:05"), "rate-limit");
		assert.equal(holdKind("usage anthropic 5h 97% until 15:00"), "usage");
		assert.equal(holdKind("spare: usage fake 5 Hour 97%"), "usage");
		assert.equal(holdKind("budget day 21.50/20 USD"), "budget");
		assert.equal(holdKind("retry backoff"), "backoff");
		assert.equal(holdKind("whatever"), "other");
		assert.equal(holdKind(undefined), "other");
	});
});

describe("needsYou", () => {
	test("questions and approvals first, then conflicts, interrupted and failed; oldest first inside a kind", () => {
		const sessions = [
			session("failed", { queue: { pending: 0, running: 0, done: 1, total: 2, autoRun: true, failed: 1 } }),
			session("ask-new", { status: "waiting", updatedAt: NOW - MIN, question: { title: "Ship it?", approval: false } }),
			session("ask-old", { status: "waiting", updatedAt: NOW - 30 * MIN, question: { title: "Run rm -rf?", approval: true } }),
			session("conflict", { status: "waiting", queue: { pending: 0, running: 0, done: 1, total: 1, autoRun: true, sync: { state: "conflict", parents: ["p"], files: ["a.ts", "b.ts", "c.ts", "d.ts"] } } }),
			session("cut", { queue: { pending: 1, running: 0, done: 0, total: 1, autoRun: false, interrupted: 2 } }),
			session("quiet"),
		];
		const items = needsYou(sessions, []);
		assert.deepEqual(
			items.map(i => [i.session, i.kind]),
			[
				["ask-old", "approval"],
				["ask-new", "question"],
				["conflict", "conflict"],
				["cut", "interrupted"],
				["failed", "failed"],
			],
		);
		assert.equal(items.find(i => i.session === "conflict")?.detail, "Merge conflict: a.ts, b.ts, c.ts +1");
		assert.equal(items.find(i => i.session === "ask-old")?.detail, "Run rm -rf?");
		assert.equal(items.find(i => i.session === "cut")?.detail, "2 tasks cut short: never re-run unattended");
		assert.equal(items.find(i => i.session === "failed")?.requeue, true);
		assert.equal(items.find(i => i.session === "ask-new")?.requeue, undefined);
	});
	test("a running orchestrator that asks counts; a stopped one does not", () => {
		const orch = (id: string, active: boolean): OverviewOrchestrator => ({ projectId: id, projectName: id, id: `o-${id}`, active, status: "waiting", displayStatus: "Needs input", updatedAt: NOW, question: { title: "Which branch?", approval: false }, counts: { workers: 0, working: 0, needsInput: 0, idle: 0, stopped: 0, openPrs: 0 } });
		const items = needsYou([], [orch("a", true), orch("b", false)]);
		assert.deepEqual(
			items.map(i => [i.session, i.orchestrator, i.detail]),
			[["o-a", "a", "Which branch?"]],
		);
	});
	test("a Hermes card rides along", () => {
		const items = needsYou([session("h", { status: "waiting", card: { board: "lightscale", card: "t_1" } })], []);
		assert.deepEqual(items[0].card, { board: "lightscale", card: "t_1" });
	});
});

describe("workingNow", () => {
	test("working and starting sessions, longest running first, with queue progress", () => {
		const items = workingNow([
			session("b", { status: "working", updatedAt: NOW - MIN }),
			session("a", { status: "starting", updatedAt: NOW - 20 * MIN, queue: { pending: 1, running: 1, done: 2, total: 4, autoRun: true, failed: 1 } }),
			session("idle"),
			session("waiting", { status: "waiting" }),
		]);
		assert.deepEqual(
			items.map(i => i.session),
			["a", "b"],
		);
		assert.deepEqual(items[0].progress, { done: 2, total: 4, failed: 1 });
		assert.equal(items[1].progress, undefined);
	});
});

describe("nextUp", () => {
	const known = new Set(["s1", "s2"]);
	test("timeline order: slot queue by position, scheduled by time, then blocked, then paused", () => {
		const p = plan(
			[
				task("paused", "paused"),
				task("blocked", "blocked", { blockedBy: ["scheduled-late", "gone"], waitReason: "waits for Task scheduled-late" }),
				task("late", "scheduled", { waitUntil: NOW + 5 * HOUR }),
				task("soon", "scheduled", { waitUntil: NOW + 2 * HOUR + 10 * MIN }),
				task("second", "waiting", { position: 2 }),
				task("first", "waiting", { position: 1 }),
				task("running", "running"),
				task("held", "held", { waitReason: "retry backoff", waitUntil: NOW + MIN }),
				task("done", "done"),
			],
			{ lanes: [lane("l1", { title: "Docs", session: "s1" })] },
		);
		const items = nextUp(p, known);
		assert.deepEqual(
			items.map(i => i.task),
			["first", "second", "soon", "late", "blocked", "paused"],
		);
		const soon = items.find(i => i.task === "soon");
		assert.equal(soon?.at, NOW + 2 * HOUR + 10 * MIN);
		const blocked = items.find(i => i.task === "blocked");
		assert.deepEqual(blocked?.blockedBy, [
			{ id: "scheduled-late", title: "missing task scheduled-late" },
			{ id: "gone", title: "missing task gone" },
		]);
	});
	test("a task finds its chat through its own session or its queue's, only when AO has it", () => {
		const p = plan([task("a", "waiting", { position: 1, session: "s2" }), task("b", "waiting", { position: 2, lane: "l1" }), task("c", "waiting", { position: 3, lane: "l2" }), task("d", "waiting", { position: 4, session: "ghost" })], { lanes: [lane("l1", { session: "s1", title: "Docs" }), lane("l2", { session: "ghost" })] });
		const items = nextUp(p, known);
		assert.deepEqual(
			items.map(i => [i.task, i.session, i.queue]),
			[
				["a", "s2", undefined],
				["b", "s1", "Docs"],
				["c", undefined, "l2"],
				["d", undefined, undefined],
			],
		);
	});
	test("orderNextUp is stable for equal keys and puts a missing time last", () => {
		const item = (task: string, state: NextItem["state"], extra: Partial<NextItem> = {}): NextItem => ({ task, title: task, state, blockedBy: [], ...extra });
		const out = orderNextUp([item("x", "scheduled"), item("y", "scheduled", { at: 5 }), item("p", "paused"), item("q", "paused"), item("w", "waiting")]);
		assert.deepEqual(
			out.map(i => i.task),
			["w", "y", "x", "p", "q"],
		);
	});
	test("an urgent priority is carried, normal is not", () => {
		const items = nextUp(plan([task("u", "waiting", { position: 1, priority: "urgent" }), task("n", "waiting", { position: 2, priority: "normal" })]), known);
		assert.equal(items[0].priority, "urgent");
		assert.equal(items[1].priority, undefined);
	});
});

describe("heldGroups", () => {
	const known = new Set(["s1"]);
	test("tasks group by cause; the earliest lift wins; a rate limit names its provider", () => {
		const p = plan(
			[
				task("a", "held", { waitReason: "rate-limit anthropic until 14:05", waitUntil: NOW + 4 * HOUR, session: "s1" }),
				task("b", "held", { waitReason: "rate-limit anthropic until 13:30", waitUntil: NOW + 3 * HOUR }),
				task("c", "held", { waitReason: "rate-limit openai until 10:00", waitUntil: NOW + HOUR }),
				task("d", "held", { waitReason: "budget day 21.50/20 USD", waitUntil: NOW + 2 * HOUR }),
				task("e", "held", { waitReason: "retry backoff", waitUntil: NOW + 5 * MIN }),
				task("f", "held", { waitReason: "retry backoff", waitUntil: NOW + 20 * MIN }),
				task("g", "waiting", { position: 1 }),
			],
			{ status: status({ limits: [{ provider: "anthropic", until: NOW + 3 * HOUR, since: NOW - HOUR, failures: 2, reason: "429 too many requests" }] }) },
		);
		const groups = heldGroups(p, known, NOW);
		assert.deepEqual(
			groups.map(g => [g.kind, g.title, g.tasks.map(t => t.task), g.until, g.provider]),
			[
				["rate-limit", "openai rate limit", ["c"], NOW + HOUR, "openai"],
				["rate-limit", "anthropic rate limit", ["a", "b"], NOW + 3 * HOUR, "anthropic"],
				["budget", "day budget", ["d"], NOW + 2 * HOUR, undefined],
				["backoff", "Retry backoff", ["e", "f"], NOW + 5 * MIN, undefined],
			],
		);
		assert.equal(groups[1].detail, "429 too many requests");
		assert.equal(groups[1].tasks[0].session, "s1");
	});
	test("a limit, a full usage window or a reached cap shows even when it holds nothing yet; expired limits do not", () => {
		const p = plan([], {
			status: status({
				limits: [
					{ provider: "anthropic", until: NOW + HOUR, since: NOW - HOUR, failures: 1, reason: "rate limited", guessed: true },
					{ provider: "old", until: NOW - 1, since: NOW - HOUR, failures: 1, reason: "expired" },
				],
				usageWindows: [
					{ provider: "anthropic", window: "5h", usedPercent: 97, resetsAt: NOW + 2 * HOUR },
					{ provider: "anthropic", window: "week", usedPercent: 40, resetsAt: NOW + 24 * HOUR },
				],
				spend: [
					{ window: "day", cap: 20, spent: 21.5, over: true, freesAt: NOW + 6 * HOUR },
					{ window: "hour", cap: 5, spent: 1, over: false },
				],
			}),
		});
		const groups = heldGroups(p, new Set(), NOW);
		assert.deepEqual(
			groups.map(g => [g.kind, g.title, g.tasks.length, g.until]),
			[
				["rate-limit", "anthropic rate limit", 0, NOW + HOUR],
				["usage", "anthropic 5h usage", 0, NOW + 2 * HOUR],
				["budget", "day budget", 0, NOW + 6 * HOUR],
			],
		);
		assert.match(groups[0].detail, /a guess/);
		assert.equal(groups[1].detail, "97% used");
	});
	test("a usage-held task joins the window's group", () => {
		const p = plan([task("t", "held", { waitReason: "usage anthropic 5h 97% until 11:00", waitUntil: NOW + 2 * HOUR })], {
			status: status({ usageWindows: [{ provider: "anthropic", window: "5h", usedPercent: 97, resetsAt: NOW + 2 * HOUR }] }),
		});
		const groups = heldGroups(p, new Set(), NOW);
		assert.equal(groups.length, 1);
		assert.deepEqual(groups[0].tasks.map(t => t.task), ["t"]);
	});
});

describe("schedulerView", () => {
	test("budget and usage as meters, active limits only, thresholds carried", () => {
		const s = schedulerView(
			status({
				running: 1,
				waiting: 2,
				paused: true,
				maxConcurrent: 0,
				spend: [{ window: "day", cap: 20, spent: 5, over: false }, { window: "week", cap: 100, spent: 130, over: true, freesAt: NOW + HOUR }],
				usageWindows: [{ provider: "a", window: "5h", usedPercent: 61.6, resetsAt: NOW + HOUR }, { provider: "a", window: "week", usedPercent: 99.5, resetsAt: NOW - HOUR }, { provider: "b", window: "5h", usedPercent: 10 }],
				limits: [{ provider: "a", until: NOW + HOUR, since: NOW, failures: 1, reason: "r" }, { provider: "x", until: NOW - 1, since: NOW, failures: 1, reason: "r" }],
				ao: { connected: false, error: "ECONNREFUSED" },
				defaults: { model: "anthropic/claude" },
			}),
			NOW,
		);
		assert.equal(s.limit, 0);
		assert.equal(s.paused, true);
		assert.deepEqual(s.budget.map(b => [b.window, b.percent, b.over]), [["day", 25, false], ["week", 100, true]]);
		assert.deepEqual(s.usage.map(u => [u.provider, u.window, u.percent, u.level, u.resetsAt]), [["a", "5h", 62, "warn", NOW + HOUR], ["a", "week", 100, "hold", undefined], ["b", "5h", 10, "ok", undefined]]);
		assert.deepEqual(s.limits.map(l => l.provider), ["a"]);
		assert.equal(s.aoConnected, false);
		assert.equal(s.aoError, "ECONNREFUSED");
		assert.equal(s.defaultModel, "anthropic/claude");
	});
});

describe("prsNeedingAttention and orchestratorItems", () => {
	test("failing CI, changes requested and conflicts; finished and healthy PRs stay out; newest first", () => {
		const items = prsNeedingAttention([
			session("a", { prs: [pr(1, { ci: "failing" }), pr(2), pr(3, { state: "merged", ci: "failing" })] }),
			session("b", { prs: [pr(4, { review: "changes_requested", mergeability: "conflicting" }), pr(5, { state: "draft", ci: "failing" })] }),
		]);
		assert.deepEqual(
			items.map(i => [i.session, i.number, i.reasons]),
			[
				["a", 1, ["CI failing"]],
				["b", 4, ["changes requested", "conflicts"]],
				["b", 5, ["CI failing"]],
			],
		);
		assert.match(items[1].summary, /^#4 open/);
	});
	test("running orchestrators first, then the most recently active", () => {
		const o = (id: string, active: boolean, updatedAt: number): OverviewOrchestrator => ({ projectId: id, projectName: id, id: `o-${id}`, active, status: "idle", displayStatus: "", updatedAt, counts: { workers: 1, working: 0, needsInput: 0, idle: 1, stopped: 0, openPrs: 0 } });
		assert.deepEqual(
			orchestratorItems([o("old", false, 9), o("slow", true, 1), o("fast", true, 5)]).map(i => i.projectId),
			["fast", "slow", "old"],
		);
	});
});

describe("buildOverview", () => {
	test("nothing from the planner while it is unreachable; everything else still shows", () => {
		const m = buildOverview({ now: NOW, sessions: [session("a", { status: "waiting", question: { title: "?", approval: false } })], orchestrators: [], plan: undefined, plannerError: "no answer" });
		assert.deepEqual(m.planner, { reachable: false, error: "no answer" });
		assert.equal(m.scheduler, undefined);
		assert.deepEqual(m.nextUp, []);
		assert.deepEqual(m.held, []);
		assert.equal(m.needsYou.length, 1);
	});
	test("the dependency graph holds sessions with dependencies and the ones they wait for, with their state", () => {
		const p = plan([]);
		const m = buildOverview({
			now: NOW,
			plan: p,
			orchestrators: [],
			sessions: [
				session("parent", { status: "working", createdAt: NOW - 3 * HOUR }),
				session("child", { createdAt: NOW - 2 * HOUR, queue: { pending: 1, running: 0, done: 0, total: 1, autoRun: true, state: "blocked", after: ["parent"], blockedBy: ["parent"] } }),
				session("lonely"),
			],
		});
		assert.deepEqual(
			m.graph.map(g => [g.id, g.state, g.after, g.blockedBy]),
			[
				["parent", "working", undefined, undefined],
				["child", "queued", ["parent"], ["parent"]],
			],
		);
	});
});
