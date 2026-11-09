import assert from "node:assert/strict";
import { test } from "node:test";
import type { AoConversation, AoSessionView } from "../../src/ao/client";
import { type AoSessionModel, sessionModel } from "../../src/ao/model";
import { completeOps, dependencyOps, laneQueue, launchFlags, metaOf, parentBranches, priorityOps, rerunTaskIds, splitArgs, statusOf, taskTransitions, withQueue } from "../../src/ext/session-view";
import type { LaneView, PlanView, TaskView } from "../../src/planner/types";
import { pairingLink, pairingPending, pairingReady, reachSummary } from "../../src/shared/phone-pairing";

const T = "2026-11-09T15:00:00Z";

const view = (v: Partial<AoSessionView> = {}): AoSessionView => ({
	id: "repo-1",
	activity: { state: "idle", lastActivityAt: T },
	autoInjectCI: true,
	autoInjectReview: true,
	autoReviewEnabled: false,
	chatProviderPreserved: true,
	createdAt: T,
	displayStatus: "Awaiting PR",
	displayName: "fix the parser",
	isPinned: false,
	isTerminated: false,
	kanbanColumn: "building",
	kind: "worker",
	lastEventAt: T,
	mode: "chat",
	outputType: "none",
	prs: [],
	status: "idle",
	statusReadiness: "ready",
	terminateOnPrMerge: false,
	updatedAt: T,
	provisionState: "ready",
	...v,
});

const model = (m: Partial<AoSessionModel> = {}): AoSessionModel => ({ ...sessionModel(view()), ...m });

test("statusOf: the five view statuses; queued/scheduled/interrupted read as idle (their detail is elsewhere)", () => {
	assert.equal(statusOf("starting"), "starting");
	assert.equal(statusOf("working"), "working");
	assert.equal(statusOf("needs_input"), "waiting");
	assert.equal(statusOf("stopped"), "stopped");
	for (const s of ["idle", "queued", "scheduled", "interrupted"] as const) assert.equal(statusOf(s), "idle");
});

test("splitArgs: whitespace separates arguments", () => {
	assert.deepEqual(splitArgs("  --plan-yolo\t--advisor \n--profile work "), ["--plan-yolo", "--advisor", "--profile", "work"]);
	assert.deepEqual(splitArgs(" "), []);
});

test("launchFlags: model, thinking and mode are session settings; every other flag is an extra omp argument", () => {
	assert.deepEqual(launchFlags(["--model", "anthropic/sonnet", "--thinking=high", "--approval-mode", "plan", "--advisor", "--profile", "work"]), {
		model: "anthropic/sonnet",
		effort: "high",
		mode: "plan",
		rest: ["--advisor", "--profile", "work"],
		ignored: [],
	});
	assert.deepEqual(launchFlags(["--approval-mode=yolo"]), { rest: [], ignored: ["--approval-mode yolo"] });
	assert.deepEqual(launchFlags([]), { rest: [], ignored: [] });
});

test("metaOf: the mode file wins over AO's approval setting (every session is bypass-permissions in AO)", () => {
	const bypass = model({ conversation: { settings: { approvalMode: "bypass-permissions" } } as AoSessionModel["conversation"] });
	assert.equal(metaOf(bypass, "").permissionMode, "auto");
	assert.equal(metaOf(bypass, "", undefined, "ask").permissionMode, "ask");
});

test("metaOf: the record the tree and board read", () => {
	const meta = metaOf(model({ state: "working", cost: 0.25, model: "anthropic/sonnet", changedFiles: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }] }), "/ao/worktrees/repo/repo-1", {
		aoSessionId: "repo-1",
		ompSessionId: "abc",
		sessionFile: "/home/u/.omp/agent/sessions/x/abc.jsonl",
	});
	assert.equal(meta.id, "repo-1");
	assert.equal(meta.title, "fix the parser");
	assert.equal(meta.status, "working");
	assert.equal(meta.cwd, "/ao/worktrees/repo/repo-1");
	assert.equal(meta.cost, 0.25);
	assert.equal(meta.changedFiles, 1);
	assert.equal(meta.ompSessionFile, "/home/u/.omp/agent/sessions/x/abc.jsonl");
	assert.equal(meta.exitCode, undefined);
});

test("metaOf: a stop with a reason is an error exit (red icon, exit notification); a plain stop is not", () => {
	assert.equal(metaOf(model({ state: "stopped", exitReason: "provisioning failed" }), "").exitCode, 1);
	assert.equal(metaOf(model({ state: "stopped" }), "").exitCode, undefined);
	// An interrupted turn keeps its reason but is not an exit.
	const interrupted = metaOf(model({ state: "interrupted", exitReason: "The daemon lost this turn while it ran." }), "");
	assert.equal(interrupted.status, "idle");
	assert.equal(interrupted.exitCode, undefined);
	assert.equal(interrupted.exitReason, "The daemon lost this turn while it ran.");
});

test("metaOf: last reply clipped for tooltips; a provider that needs a login is an auth problem; the mode comes from the conversation", () => {
	const conversation = { settings: { approvalMode: "bypass-permissions" }, account: { authenticationState: "required", reauthReason: "token expired" } } as unknown as AoConversation;
	const meta = metaOf(model({ reply: "x".repeat(700), conversation }), "");
	assert.equal(meta.lastText?.length, 601);
	assert.ok(meta.lastText?.endsWith("…"));
	assert.equal(meta.authProblem, "token expired");
	assert.equal(meta.permissionMode, "auto");
});

const lan = { kind: "lan", host: "192.168.1.20", port: 3011, secure: false };
const tunnel = { kind: "tunnel", host: "abc.trycloudflare.com", port: 443, secure: true };

test("pairingLink: AO's v2 offer with every endpoint, base64url in the fragment", () => {
	const link = pairingLink({ enabled: true, hostId: "h_1", password: "pw-123", endpoints: [lan, tunnel] }) ?? "";
	assert.ok(link.startsWith("aomobile://pair#"));
	const fragment = link.slice(link.indexOf("#") + 1);
	assert.doesNotMatch(fragment, /[+/=]/);
	assert.deepEqual(JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")), { v: 2, hostId: "h_1", name: "192.168.1.20", platform: "", endpoints: [lan, tunnel], token: "pw-123" });
});

test("laneQueue: a session's queue summary from the planner lanes that continue it", () => {
	const lane = (l: Partial<LaneView>): LaneView => ({ id: "l_1", autoRun: true, createdAt: 1, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...l });
	const task = (t: Partial<TaskView>): TaskView => ({ id: "t", title: "t", subtasks: [], status: "pending", createdAt: 5, state: "waiting", ...t });
	const plan = {
		rev: 1,
		lanes: [lane({ id: "repo-1", pending: 2, done: 1, total: 3 }), lane({ id: "l_2", session: "repo-1", autoRun: false, startAt: 9000, pending: 1, total: 1 }), lane({ id: "l_3", session: "repo-2", pending: 4, total: 4 })],
		tasks: [task({ id: "a", lane: "repo-1", position: 2, createdAt: 7 }), task({ id: "b", lane: "repo-1", state: "interrupted" }), task({ id: "c", lane: "l_2", state: "scheduled", waitUntil: 8000 }), task({ id: "d", lane: "l_3", position: 1 })],
		recurring: [],
		status: {} as PlanView["status"],
	} satisfies PlanView;
	assert.deepEqual(laneQueue(plan, "repo-1"), { pending: 3, running: 0, done: 1, total: 4, autoRun: true, startAt: 8000, interrupted: 1, waiting: { position: 2, since: 7 } });
	assert.equal(laneQueue(plan, "repo-9"), undefined);
	assert.equal(laneQueue(undefined, "repo-1"), undefined);
});

test("laneQueue: dependencies map planner task ids to sessions; failed tasks are counted", () => {
	const lane = (l: Partial<LaneView>): LaneView => ({ id: "l_1", autoRun: true, createdAt: 1, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...l });
	const task = (t: Partial<TaskView>): TaskView => ({ id: "t", title: "t", subtasks: [], status: "pending", createdAt: 5, state: "waiting", ...t });
	const plan = {
		rev: 1,
		lanes: [lane({ id: "repo-2", pending: 1, total: 1 }), lane({ id: "l_a", session: "repo-1", failed: 1, total: 1 })],
		tasks: [
			task({ id: "b", lane: "repo-2", state: "blocked", after: ["a", "free"], blockedBy: ["a"] }),
			task({ id: "a", lane: "l_a", status: "failed", state: "failed" }),
			task({ id: "free", session: "repo-9", status: "done", state: "done" }),
		],
		recurring: [],
		status: {} as PlanView["status"],
	} satisfies PlanView;
	assert.deepEqual(laneQueue(plan, "repo-2")?.after, ["repo-1", "repo-9"]);
	assert.deepEqual(laneQueue(plan, "repo-2")?.blockedBy, ["repo-1"]);
	assert.equal(laneQueue(plan, "repo-1")?.failed, 1);
	assert.equal(laneQueue(plan, "repo-1")?.after, undefined);
});

test("pairing readiness: no code without an address or a password; pending while the tunnel starts", () => {
	assert.equal(pairingLink({ enabled: true, password: "pw", endpoints: [] }), undefined);
	assert.equal(pairingReady({ enabled: false, password: "pw", endpoints: [lan] }), false);
	assert.equal(pairingReady({ enabled: true, password: "", endpoints: [lan] }), false);
	assert.equal(pairingPending({ enabled: true, endpoints: [] }), true);
	assert.equal(pairingPending({ enabled: true, endpoints: [lan], tunnel: { supported: true, running: true, ready: false } }), true);
	assert.equal(pairingPending({ enabled: true, endpoints: [lan], noPublicTunnel: true, tunnel: { supported: true, running: false, ready: false } }), false);
	assert.equal(pairingPending({ enabled: true, endpoints: [lan], tunnel: { supported: true, running: true, ready: false, lastError: "no network" } }), false);
	assert.equal(reachSummary({ enabled: true, endpoints: [lan], tunnel: { supported: false, running: false, ready: false } }), "this network · no public tunnel: cloudflared isn't installed");
	assert.equal(reachSummary({ enabled: true, endpoints: [lan, tunnel] }), "this network · anywhere (Cloudflare tunnel)");
});

test("withQueue: an unresolved merge conflict is needs-input (waiting); other sync states and stopped sessions keep their status", () => {
	const base = metaOf(model({ state: "idle" }), "");
	const queue = (state: "conflict" | "merged" | "upstream-changed") => ({ pending: 0, running: 0, done: 1, total: 1, autoRun: true, sync: { state, parents: ["repo-1"] } });
	assert.equal(withQueue(base, queue("conflict"), "idle").status, "waiting");
	assert.equal(withQueue(base, queue("merged"), "idle").status, "idle");
	assert.equal(withQueue(base, queue("upstream-changed"), "idle").status, "idle");
	assert.equal(withQueue(base, queue("conflict"), "stopped").status, "stopped");
	// Resolved: the queue loses its conflict and the session goes back to what AO says.
	const conflicted = withQueue(base, queue("conflict"), "idle");
	assert.equal(withQueue(conflicted, queue("merged"), "idle").status, "idle");
	assert.equal(withQueue(conflicted, undefined, "idle").queue, undefined);
});

test("laneQueue: the worst parent-edge sync state of a session's tasks, with the parent sessions in it", () => {
	const lane = (l: Partial<LaneView>): LaneView => ({ id: "l_1", autoRun: true, createdAt: 1, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...l });
	const task = (t: Partial<TaskView>): TaskView => ({ id: "t", title: "t", subtasks: [], status: "done", createdAt: 5, state: "done", ...t });
	const plan = {
		rev: 1,
		lanes: [lane({ id: "repo-3", done: 1, total: 1 }), lane({ id: "repo-1" }), lane({ id: "repo-2" })],
		tasks: [
			task({ id: "c", lane: "repo-3", after: ["a", "b"], sync: { a: { state: "upstream-changed", at: 1 }, b: { state: "conflict", at: 1, files: ["x.ts"] } } }),
			task({ id: "a", lane: "repo-1" }),
			task({ id: "b", lane: "repo-2" }),
		],
		recurring: [],
		status: {} as PlanView["status"],
	} satisfies PlanView;
	assert.deepEqual(laneQueue(plan, "repo-3")?.sync, { state: "conflict", parents: ["repo-2"], edges: { "repo-1": "upstream-changed", "repo-2": "conflict" }, files: ["x.ts"] });
	assert.equal(laneQueue(plan, "repo-1")?.sync, undefined);
	const clean: PlanView = { ...plan, tasks: plan.tasks.map(t => (t.id === "c" ? { ...t, sync: { a: { state: "in-sync" as const, at: 1 }, b: { state: "in-sync" as const, at: 1 } } } : t)) };
	assert.equal(laneQueue(clean, "repo-3")?.sync, undefined);
	assert.deepEqual(rerunTaskIds(plan, "repo-3"), ["c"]);
	assert.deepEqual(rerunTaskIds(plan, "repo-1"), []);
	assert.deepEqual(rerunTaskIds(clean, "repo-3"), []);
});

test("priorityOps: update the lane that continues a session, else add one named after it; normal clears", () => {
	const lane = (l: Partial<LaneView>): LaneView => ({ id: "l_1", autoRun: true, createdAt: 1, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...l });
	const plan = { rev: 1, lanes: [lane({ id: "repo-1" }), lane({ id: "l_x", session: "repo-2" })], tasks: [], recurring: [], status: {} as PlanView["status"] } satisfies PlanView;
	assert.deepEqual(priorityOps(plan, ["repo-1", "repo-2", "repo-3"], "urgent"), [
		{ op: "lane.update", id: "repo-1", priority: "urgent" },
		{ op: "lane.update", id: "l_x", priority: "urgent" },
		{ op: "lane.add", id: "repo-3", session: "repo-3", priority: "urgent" },
	]);
	assert.deepEqual(priorityOps(plan, ["repo-1", "repo-3"], "normal"), [
		{ op: "lane.update", id: "repo-1", priority: null },
		{ op: "lane.add", id: "repo-3", session: "repo-3" },
	]);
	assert.deepEqual(priorityOps(undefined, ["repo-3"], "low"), [{ op: "lane.add", id: "repo-3", session: "repo-3", priority: "low" }]);
});

test("dependencyOps: pending tasks wait for every task of the picked sessions; other after entries stay; nothing pending = undefined", () => {
	const lane = (id: string) => ({ id, session: id.toUpperCase(), autoRun: true, createdAt: 0, pending: 1, running: 0, done: 0, failed: 0, total: 1 });
	const plan = {
		rev: 1,
		lanes: [lane("a"), lane("b"), lane("c")],
		tasks: [
			{ id: "ta1", lane: "a", status: "done", state: "done" },
			{ id: "ta2", lane: "a", status: "pending", state: "waiting", after: ["ta1", "tx"] },
			{ id: "tb1", lane: "b", status: "pending", state: "waiting", after: ["tc1"] },
			{ id: "tc1", lane: "c", status: "pending", state: "waiting" },
			{ id: "tc2", lane: "c", status: "skipped", state: "skipped" },
		],
	} as unknown as PlanView;
	// A waits for C: ta2 keeps its same-lane and non-session entries (ta1, tx), gains C's live tasks.
	assert.deepEqual(dependencyOps(plan, "A", ["C"]), [{ op: "after", id: "ta2", ids: ["ta1", "tx", "tc1"] }]);
	// B drops its wait for C.
	assert.deepEqual(dependencyOps(plan, "B", []), [{ op: "after", id: "tb1", ids: [] }]);
	assert.equal(dependencyOps(plan, "C", ["A"])?.length, 1);
	assert.equal(dependencyOps({ ...plan, tasks: plan.tasks.filter(t => t.lane !== "b") }, "B", ["A"]), undefined);
	assert.equal(dependencyOps(undefined, "A", ["B"]), undefined);
});

test("completeOps / laneQueue: the marker is the planner's lane.complete; a session without a lane gets one", () => {
	const lane = (id: string, extra: Partial<LaneView> = {}): LaneView => ({ id, session: id.toUpperCase(), autoRun: true, createdAt: 0, pending: 0, running: 0, done: 1, failed: 0, total: 1, ...extra });
	const plan = { rev: 1, lanes: [lane("a", { completed: true, completedAt: 99 }), lane("b")], tasks: [], recurring: [], status: {} as PlanView["status"] } satisfies PlanView;
	assert.deepEqual(completeOps(plan, ["A", "C"], true), [{ op: "lane.complete", id: "a", completed: true }, { op: "lane.add", id: "C", session: "C" }, { op: "lane.complete", id: "C", completed: true }]);
	assert.deepEqual(completeOps(plan, ["B"], false), [{ op: "lane.complete", id: "b", completed: false }]);
	assert.deepEqual([laneQueue(plan, "A")?.completed, laneQueue(plan, "A")?.completedAt], [true, 99]);
	assert.equal(laneQueue(plan, "B")?.completed, undefined);
});

test("taskTransitions: only tasks that were known and changed state; the next map covers the whole plan", () => {
	const task = (id: string, state: TaskView["state"], extra: Partial<TaskView> = {}): TaskView => ({ id, title: id, subtasks: [], status: "pending", createdAt: 0, state, ...extra });
	const plan = (...tasks: TaskView[]): PlanView => ({ rev: 1, lanes: [{ id: "l", session: "S", autoRun: true, createdAt: 0, pending: 0, running: 0, done: 0, failed: 0, total: 0 }], tasks, recurring: [], status: {} as PlanView["status"] });
	const first = taskTransitions(new Map(), plan(task("a", "running"), task("b", "waiting", { lane: "l" })));
	assert.deepEqual(first.changes, []);
	const second = taskTransitions(first.next, plan(task("a", "done", { session: "S1" }), task("b", "waiting", { lane: "l" }), task("c", "running")));
	assert.deepEqual(second.changes.map(c => [c.task.id, c.from, c.sessionId]), [["a", "running", "S1"]]);
	assert.deepEqual([...second.next], [["a", "done"], ["b", "waiting"], ["c", "running"]]);
	// No plan (planner unreachable): nothing fires and what was known is kept.
	assert.deepEqual(taskTransitions(second.next, undefined), { next: second.next, changes: [] });
	// A task in a lane resolves its session through the lane.
	const third = taskTransitions(second.next, plan(task("a", "done"), task("b", "failed", { lane: "l" }), task("c", "running")));
	assert.deepEqual(third.changes.map(c => [c.task.id, c.sessionId]), [["b", "S"]]);
});

test("parentBranches: the branches of the tasks another session's tasks build on; its own lane's tasks do not count", () => {
	const lane = (id: string): LaneView => ({ id, session: id.toUpperCase(), autoRun: true, createdAt: 0, pending: 0, running: 0, done: 1, failed: 0, total: 1 });
	const task = (id: string, extra: Partial<TaskView>): TaskView => ({ id, title: `task ${id}`, subtasks: [], status: "done", createdAt: 0, state: "done", ...extra });
	const git = (branch: string) => ({ repo: "/r", branch });
	const plan: PlanView = {
		rev: 1,
		lanes: [lane("p"), lane("q"), lane("c")],
		tasks: [task("tp", { lane: "p", git: git("switchyard/tp") }), task("tq", { lane: "q" }), task("tc1", { lane: "c", git: git("switchyard/tc1") }), task("tc2", { lane: "c", after: ["tc1", "tp", "tq"] })],
		recurring: [],
		status: {} as PlanView["status"],
	};
	assert.deepEqual(parentBranches(plan, "C"), [{ title: "task tp", branch: "switchyard/tp" }]);
	assert.deepEqual(parentBranches(plan, "P"), []);
	assert.deepEqual(parentBranches(undefined, "C"), []);
});
