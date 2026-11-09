// The CLI on AO: `ls` filters, session lookup, the planner's lane state on top of AO's, and the
// attach follower printing only what a new snapshot adds.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AoActivity, AoConversation, AoMessage, AoSessionView } from "../../src/ao/client";
import { sessionModel } from "../../src/ao/model";
import type { PlanView } from "../../src/planner/types";
import { edgesOfRef, graphEdges, laneSummaries, tasksOfRef, worstEdgeState } from "../../src/cli/plan";
import { ConversationFollower } from "../../src/cli/render";
import { type Session, filterSessions, plannedState, reportOf, resolveSession } from "../../src/cli/sessions";
import { setColor } from "../../src/cli/term";

setColor(false);
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

const message = (seq: number, role: AoMessage["role"], text: string, streaming = false): AoMessage => ({
	kind: "message",
	id: `m${seq}`,
	sequence: seq,
	revision: 0,
	role,
	origin: role === "user" ? "human" : "provider",
	text,
	editAvailable: false,
	streaming,
	createdAt: T,
});

const activity = (a: Partial<AoActivity>): AoActivity => ({ kind: "activity", id: "a1", activityKind: "command", status: "running", summary: "$ ls", revision: 0, sequence: 9, createdAt: T, ...a });

const conversation = (c: Partial<AoConversation> = {}): AoConversation => ({
	activities: [],
	branchedFromEarlierMessage: false,
	continueTurnId: "",
	controller: "ready",
	conversationId: "c1",
	hasMoreBefore: false,
	latestSequence: 1,
	messages: [],
	mode: "chat",
	nativeForkAvailableAfterSequence: 0,
	sessionId: "repo-1",
	settings: {},
	turns: [],
	...c,
});

const session = (id: string, title: string, s: Partial<Session> = {}): Session => {
	const model = sessionModel(view({ id, displayName: title, updatedAt: s.model?.view.updatedAt ?? T }));
	return { id, title, cwd: `/w/${id}`, model, state: model.state, priority: "normal", tags: [], ...s };
};

test("resolveSession: exact id beats a prefix; ambiguous prefixes and titles are errors; . is the session working here", () => {
	const all = [session("repo-1", "Fix checkout"), session("repo-12", "Fix login"), session("other-3", "Docs")];
	assert.equal((resolveSession("repo-1", all, "/") as Session).id, "repo-1");
	assert.match((resolveSession("repo", all, "/") as { error: string }).error, /matches 2 sessions/);
	assert.equal((resolveSession("login", all, "/") as Session).id, "repo-12");
	assert.match((resolveSession("fix", all, "/") as { error: string }).error, /matches 2/);
	assert.equal((resolveSession(".", all, "/w/other-3/src") as Session).id, "other-3");
	assert.match((resolveSession(".", all, "/elsewhere") as { error: string }).error, /no session for/);
});

test("filterSessions: project by id, name or path; folder; group; every tag; state words", () => {
	const project = { id: "app", name: "My App", path: "/src/app", kind: "single_repo" as const, folderMissing: false, sessionPrefix: "app" };
	const waiting = sessionModel(view({ id: "c", activity: { state: "waiting_input", lastActivityAt: T } }));
	const all = [
		session("a", "a", { project, cwd: "/ao/worktrees/app/a" }),
		session("b", "b", { project, cwd: "/ao/worktrees/app/b", group: "Ops", tags: ["x", "y"] }),
		session("c", "c", { cwd: "/ao/scratch/c", model: waiting, state: waiting.state }),
	];
	const ids = (f: Parameters<typeof filterSessions>[1]) => filterSessions(all, f).map(s => s.id);
	assert.deepEqual(ids({}), ["a", "b", "c"]);
	assert.deepEqual(ids({ project: "app" }), ["a", "b"]);
	assert.deepEqual(ids({ project: "My App" }), ["a", "b"]);
	assert.deepEqual(ids({ project: "/src/app" }), ["a", "b"]);
	assert.deepEqual(ids({ cwd: "/src" }), ["a", "b"], "a folder holding the project");
	assert.deepEqual(ids({ cwd: "/ao/scratch" }), ["c"]);
	assert.deepEqual(ids({ group: "ops" }), ["b"]);
	assert.deepEqual(ids({ tags: ["x", "y"] }), ["b"]);
	assert.deepEqual(ids({ tags: ["x", "z"] }), []);
	assert.deepEqual(ids({ state: "needs_input" }), ["c"]);
	assert.deepEqual(ids({ state: "input" }), ["c"], "the board column");
	assert.deepEqual(ids({ state: "waiting" }), ["c"], "the old status word");
});

const plan = (tasks: Array<Partial<PlanView["tasks"][number]>>, lane: Partial<PlanView["lanes"][number]> = {}): PlanView =>
	({
		rev: 1,
		tasks: tasks.map((t, i) => ({ id: `t${i}`, title: `t${i}`, subtasks: [], status: "pending", createdAt: 0, lane: "repo-1", state: "waiting", ...t })),
		lanes: [{ id: "repo-1", autoRun: true, createdAt: 0, pending: 1, running: 0, done: 0, failed: 0, total: 1, ...lane }],
		recurring: [],
		status: {} as PlanView["status"],
	}) as PlanView;

test("laneSummaries: the lane's next task says waiting (with its slot position), scheduled or interrupted", () => {
	assert.deepEqual(laneSummaries(plan([{ status: "done", state: "done" }, { state: "waiting", position: 2 }])).get("repo-1")?.waiting, { position: 2 });
	assert.equal(laneSummaries(plan([{ state: "scheduled" }], { autoRun: false, startAt: 5 })).get("repo-1")?.scheduled, true);
	assert.equal(laneSummaries(plan([{ state: "interrupted", interrupted: 42 }], { autoRun: false })).get("repo-1")?.interrupted, 42, "when it was cut short");
	assert.equal(laneSummaries(plan([{ state: "paused" }], { autoRun: false })).get("repo-1")?.waiting, undefined, "a paused lane waits for nobody");
	assert.ok(laneSummaries(plan([{}], { id: "l_1", session: "repo-9" })).has("repo-9"), "a lane continuing a session is keyed by that session");
});

test("plannedState: the planner's word goes on top of an idle or stopped session only (MAPPING D3)", () => {
	const lane = { pending: 1, running: 0, done: 0, total: 1, autoRun: false };
	assert.equal(plannedState({ ...lane, scheduled: true, startAt: 1 }), "scheduled");
	assert.equal(plannedState({ ...lane, waiting: { position: 1 } }), "queued");
	assert.equal(plannedState({ ...lane, interrupted: 1 }), "interrupted");
	assert.equal(plannedState(lane), undefined);
	const idle = view({ activity: { state: "exited", lastActivityAt: T } });
	assert.equal(sessionModel(idle, undefined, plannedState({ ...lane, waiting: { position: 1 } })).state, "queued");
	const busy = view({ activity: { state: "active", lastActivityAt: T } });
	assert.equal(sessionModel(busy, undefined, plannedState({ ...lane, waiting: { position: 1 } })).state, "working");
});

test("ConversationFollower: streams the growing reply, prints a tool once and its failure, skips prompts typed here", () => {
	let written = "";
	// A function, not the variable: `assert.equal` narrows its argument to the expected literal.
	const out = () => written;
	const echoed = new Set(["typed here"]);
	const f = new ConversationFollower(s => (written += s), () => 80, echoed);
	f.seen(conversation({ messages: [message(1, "user", "old prompt")] }));
	f.update(conversation({ messages: [message(1, "user", "old prompt"), message(2, "user", "typed here"), message(3, "assistant", "Hel", true)] }));
	assert.equal(out(), "Hel");
	assert.ok(f.isMidLine());
	f.update(conversation({ messages: [message(3, "assistant", "Hello wor", true)], activities: [activity({ id: "x", sequence: 4 })] }));
	assert.equal(out(), "Hello wor\n  ▸ $ ls\n");
	f.update(conversation({ messages: [message(3, "assistant", "Hello world", false)], activities: [activity({ id: "x", sequence: 4, status: "failed" })] }));
	assert.equal(out(), "Hello wor\n  ▸ $ ls\nld\n  ✗ $ ls\n");
	f.update(conversation({ messages: [message(3, "assistant", "Hello world", false), message(5, "user", "from the phone")] }));
	assert.ok(out().endsWith("› from the phone\n"), out());
});

test("graphEdges: one edge per parent a task has propagation state for; refs name tasks by id, session or lane", () => {
	const view = plan(
		[
			{ id: "ta", session: "repo-1", lane: "repo-1", git: { repo: "/r", branch: "b-a", head: "aaaaaaaa11" } },
			{ id: "tb", session: "repo-2", lane: "repo-2", after: ["ta"], git: { repo: "/r", branch: "b-b", head: "bbbbbbbb22" }, sync: { ta: { state: "conflict", head: "aaaaaaaa11", pendingHead: "aaaaaaaa33", files: ["x.txt"], at: 5 } } },
			{ id: "tc", session: "repo-3", lane: "repo-3", after: ["ta"] },
		],
		{ id: "repo-1" },
	);
	assert.deepEqual(graphEdges(view), [{ parent: "ta", parentSession: "repo-1", child: "tb", childSession: "repo-2", state: "conflict", files: ["x.txt"], parentHead: "aaaaaaaa33", childHead: "bbbbbbbb22", at: 5 }], "tc has no propagation state (not in git): no edge");
	assert.deepEqual(tasksOfRef(view, "repo-2").map(t => t.id), ["tb"]);
	assert.deepEqual(tasksOfRef(view, "ta").map(t => t.id), ["ta"]);
	assert.deepEqual(tasksOfRef(view, "t").length, 3, "a unique-enough id prefix");
	assert.equal(edgesOfRef(view, "repo-1").length, 1, "as the parent");
	assert.equal(edgesOfRef(view, "repo-3").length, 0);
	// The child's session carries its worst incoming edge (a free task's session has no lane of its own).
	assert.deepEqual(laneSummaries(view).get("repo-2")?.upstream, { state: "conflict", edges: graphEdges(view) });
	assert.equal(laneSummaries(view).get("repo-3")?.upstream, undefined);
	assert.equal(worstEdgeState([{ state: "merged" }, { state: "upstream-changed" }, { state: "in-sync" }]), "upstream-changed");
});

test("reportOf: the changed-file count of a graph child says it includes what its parents merged in (G43); a free session says nothing", () => {
	const lane = { pending: 0, running: 0, done: 0, total: 0, autoRun: false };
	const edge = { parent: "t1", child: "t2", state: "merged", at: 1 };
	const child = reportOf(session("repo-2", "Child", { lane: { ...lane, upstream: { state: "merged", edges: [edge] } } }));
	assert.equal(child.changedFilesIncludeUpstream, true);
	assert.equal(child.upstreamState, "merged");
	assert.equal(reportOf(session("repo-1", "Free", { lane })).changedFilesIncludeUpstream, undefined);
});

test("reportOf: a reply AO has not finalized is left out (replyPending) instead of the previous turn's text; a final one is reported", () => {
	const base = session("repo-1", "Task");
	const final = reportOf({ ...base, model: { ...base.model, reply: "done: v2" } });
	assert.equal(final.reply, "done: v2");
	assert.equal(final.replyPending, undefined);
	const pending = reportOf({ ...base, model: { ...base.model, reply: "done: v1 (the turn before)", replyPending: true } });
	assert.equal(pending.reply, undefined, "never the previous turn's text as this turn's result");
	assert.equal(pending.replyPending, true);
});
