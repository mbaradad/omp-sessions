import assert from "node:assert/strict";
import { test } from "node:test";
import type { AoActivity, AoConversation, AoMessage, AoSessionView, AoTurn } from "../../src/ao/client";
import { agentState, answerFor, changedFiles, lastReply, questionOf, queueOf, sessionModel } from "../../src/ao/model";

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

const turn = (id: string, state: AoTurn["state"], t: Partial<AoTurn> = {}): AoTurn => ({ id, state, requestedAt: T, ...t });
const message = (seq: number, role: AoMessage["role"], text: string, turnId?: string): AoMessage => ({
	kind: "message",
	id: `m${seq}`,
	sequence: seq,
	revision: 0,
	role,
	origin: role === "user" ? "human" : "provider",
	text,
	editAvailable: false,
	streaming: false,
	createdAt: T,
	...(turnId && { turnId }),
});
const activity = (a: Partial<AoActivity>): AoActivity => ({ kind: "activity", id: "a1", activityKind: "approval", status: "pending", summary: "Run `rm -rf build`?", revision: 0, sequence: 9, createdAt: T, requestId: "req-1", ...a });

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

// omp's `ask` tool as AO receives it over ACP: one elicitation, `q<n>` per question plus a free-text `q<n>__other`.
const askSchema = {
	type: "object",
	properties: {
		q0: { title: "Which color do you prefer?", description: "Color", type: "string", oneOf: [{ const: "red", title: "Red" }, { const: "blue", title: "Blue" }] },
		q0__other: { title: "Other (type your own)", type: "string" },
		q1: { title: "Which sizes do you want?", description: "Sizes", type: "array", items: { anyOf: [{ const: "S", title: "S" }, { const: "M", title: "M" }, { const: "L", title: "L" }] } },
		q1__other: { title: "Other (type your own)", type: "string" },
	},
};
const ask = activity({ activityKind: "user_input", requestId: "req-ask", summary: "Answer 2 questions", detail: { inputMode: "form", message: "Answer 2 questions", schema: askSchema, elicitationId: "" } });
const approval = activity({
	detail: {
		decisions: [
			{ id: "allow", label: "Allow once", kind: "allow_once" },
			{ id: "always", label: "Always allow", kind: "allow_always" },
			{ id: "deny", label: "Reject", kind: "reject_once" },
		],
	},
});

test("agentState: session lifecycle before and after the conversation", () => {
	assert.equal(agentState(view({ isTerminated: true, status: "terminated" }), conversation()), "stopped");
	assert.equal(agentState(view({ provisionState: "provisioning" })), "starting");
	assert.equal(agentState(view({ provisionState: "failed", provisionError: "no omp" })), "stopped");
	// Without a conversation (TUI sessions, list-only views): AO's activity signal.
	assert.equal(agentState(view({ activity: { state: "active", lastActivityAt: T }, status: "working" })), "working");
	assert.equal(agentState(view({ activity: { state: "blocked", lastActivityAt: T }, status: "needs_input" })), "needs_input");
	assert.equal(agentState(view({ activity: { state: "exited", lastActivityAt: T }, status: "exited" })), "stopped");
	// A chat session with a pending question reports waiting_input (AO's own status: needs_input).
	assert.equal(agentState(view({ activity: { state: "waiting_input", lastActivityAt: T }, status: "needs_input" })), "needs_input");
	assert.equal(agentState(view({ status: "pr_open" })), "idle");
});

test("agentState: the conversation decides once there is one", () => {
	const v = view();
	assert.equal(agentState(v, conversation({ turns: [turn("t1", "completed")] })), "idle");
	assert.equal(agentState(v, conversation({ turns: [turn("t1", "running")], controller: "busy" })), "working");
	// A pending approval wins over the running turn it belongs to.
	assert.equal(agentState(v, conversation({ turns: [turn("t1", "running")], activities: [approval] })), "needs_input");
	assert.equal(agentState(v, conversation({ turns: [turn("t1", "running")], activities: [{ ...approval, status: "resolved" }] })), "working");
	// Queued turns dispatch on their own while the agent is connected; they wait while it is not.
	assert.equal(agentState(v, conversation({ turns: [turn("t1", "completed"), turn("t2", "queued")] })), "working");
	assert.equal(agentState(v, conversation({ turns: [turn("t2", "queued")], controller: "hibernated" })), "queued");
	assert.equal(agentState(v, conversation({ turns: [turn("t2", "queued")], controller: "connecting" })), "starting");
	assert.equal(agentState(v, conversation({ controller: "recovering" })), "starting");
	// The daemon lost a running turn (restart, agent died): someone has to look.
	assert.equal(agentState(v, conversation({ turns: [turn("t1", "recovered")] })), "interrupted");
	// A person stopping a turn is not an interruption.
	assert.equal(agentState(v, conversation({ turns: [turn("t1", "interrupted")] })), "idle");
	assert.equal(agentState(view({ activity: { state: "exited", lastActivityAt: T } }), conversation({ turns: [turn("t1", "completed")] })), "stopped");
	// A stale activity signal does not override a settled conversation.
	assert.equal(agentState(view({ activity: { state: "active", lastActivityAt: T }, status: "working" }), conversation({ turns: [turn("t1", "completed")] })), "idle");
	assert.equal(agentState(v, conversation({ turns: [turn("t1", "completed")], controller: "busy" })), "working");
});

test("agentState: the planner's lane state wins only while the session itself is idle or stopped", () => {
	const idle = conversation({ turns: [turn("t1", "completed")] });
	assert.equal(agentState(view(), idle, "scheduled"), "scheduled");
	assert.equal(agentState(view(), idle, "queued"), "queued");
	assert.equal(agentState(view({ activity: { state: "exited", lastActivityAt: T } }), idle, "interrupted"), "interrupted");
	assert.equal(agentState(view(), conversation({ turns: [turn("t1", "running")] }), "queued"), "working");
	assert.equal(agentState(view(), conversation({ turns: [turn("t1", "running")], activities: [approval] }), "scheduled"), "needs_input");
});

test("questionOf: omp's ask elicitation becomes one question per field, Other folded in", () => {
	const q = questionOf(ask);
	assert.equal(q.id, "req-ask");
	assert.equal(q.kind, "input");
	assert.equal(q.title, "Answer 2 questions");
	assert.equal(q.message, undefined);
	assert.deepEqual(
		q.questions?.map(f => ({ key: f.key, question: f.question, options: f.options, multi: f.multi, otherKey: f.otherKey })),
		[
			{ key: "q0", question: "Which color do you prefer?", options: ["Red", "Blue"], multi: false, otherKey: "q0__other" },
			{ key: "q1", question: "Which sizes do you want?", options: ["S", "M", "L"], multi: true, otherKey: "q1__other" },
		],
	);
});

test("questionOf: approvals carry their decisions", () => {
	const q = questionOf(approval);
	assert.equal(q.kind, "approval");
	assert.equal(q.id, "req-1");
	assert.deepEqual(q.options, ["Allow once", "Always allow", "Reject"]);
});

test("answerFor: approvals by number, label or yes/no", () => {
	const q = questionOf(approval);
	assert.deepEqual(answerFor(q, "2"), { kind: "approval", decisionId: "always" });
	assert.deepEqual(answerFor(q, "reject"), { kind: "approval", decisionId: "deny" });
	assert.deepEqual(answerFor(q, "yes"), { kind: "approval", decisionId: "allow" });
	assert.deepEqual(answerFor(q, "n"), { kind: "approval", decisionId: "deny" });
	assert.ok("error" in answerFor(q, "4"));
	assert.ok("error" in answerFor(q, "maybe"));
});

test("answerFor: ask answers per question, values not labels, free text into Other", () => {
	const q = questionOf(ask);
	assert.deepEqual(answerFor(q, "2|1,3"), { kind: "input", body: { action: "accept", content: { q0: "blue", q1: ["S", "L"] } } });
	assert.deepEqual(answerFor(q, "red | M"), { kind: "input", body: { action: "accept", content: { q0: "red", q1: ["M"] } } });
	assert.deepEqual(answerFor(q, "green|S, XXL"), { kind: "input", body: { action: "accept", content: { q0__other: "green", q1: ["S"], q1__other: "XXL" } } });
	const wrongCount = answerFor(q, "red");
	assert.ok("error" in wrongCount && /2 things/.test(wrongCount.error));
});

test("answerFor: single-field questions and typed fields", () => {
	const choice = questionOf(activity({ activityKind: "user_input", requestId: "r", detail: { schema: { type: "object", required: ["env"], properties: { env: { type: "string", enum: ["dev", "prod"] } } } } }));
	assert.deepEqual(choice.options, ["dev", "prod"]);
	assert.deepEqual(answerFor(choice, "2"), { kind: "input", body: { action: "accept", content: { env: "prod" } } });
	assert.ok("error" in answerFor(choice, "staging"));
	const typed = questionOf(activity({ activityKind: "user_input", requestId: "r", detail: { schema: { type: "object", properties: { ok: { type: "boolean" }, n: { type: "integer" } } } } }));
	assert.deepEqual(answerFor(typed, "yes|3"), { kind: "input", body: { action: "accept", content: { ok: true, n: 3 } } });
	assert.ok("error" in answerFor(typed, "yes|3.5"));
	const free = questionOf(activity({ activityKind: "user_input", requestId: "r", detail: { schema: { type: "object", properties: { name: { type: "string" } } } } }));
	// Free text keeps its pipes: a single field takes the whole answer.
	assert.deepEqual(answerFor(free, "a | b"), { kind: "input", body: { action: "accept", content: { name: "a | b" } } });
});

test("queueOf: queued turns in order with their prompts", () => {
	const c = conversation({
		turns: [turn("t1", "completed"), turn("t2", "running"), turn("t4", "queued"), turn("t3", "queued"), turn("t0", "cancelled")],
		messages: [message(1, "user", "first", "t1"), message(2, "assistant", "done", "t1"), message(3, "user", "second", "t2"), message(4, "user", "fourth", "t4"), message(5, "user", "third", "t3")],
	});
	const q = queueOf(c);
	assert.deepEqual({ pending: q.pending, running: q.running, done: q.done, total: q.total }, { pending: 2, running: 1, done: 1, total: 4 });
	assert.deepEqual(q.items.map(i => [i.turnId, i.text]), [["t4", "fourth"], ["t3", "third"]]);
});

test("changedFiles: per-turn diffs merged; rolled back turns and files left out", () => {
	const c = conversation({
		turns: [
			turn("t1", "completed", { diff: { files: [{ path: "a.ts", status: "added", additions: 10, deletions: 0 }, { path: "b.ts", status: "modified", additions: 1, deletions: 1 }] } }),
			turn("t2", "completed", { rolledBack: true, diff: { files: [{ path: "c.ts", status: "added", additions: 5, deletions: 0 }] } }),
			turn("t3", "completed", { diff: { files: [{ path: "a.ts", status: "modified", additions: 2, deletions: 1 }, { path: "d.ts", status: "deleted", additions: 0, deletions: 3, rolledBack: true }] } }),
			turn("t4", "completed", { diff: { files: [{ path: "e.ts", oldPath: "b.ts", status: "renamed", additions: 0, deletions: 0 }] } }),
		],
	});
	assert.deepEqual(changedFiles(c), [
		// Created in this session, then edited: still new.
		{ path: "a.ts", status: "added", additions: 12, deletions: 1 },
		{ path: "e.ts", oldPath: "b.ts", status: "renamed", additions: 1, deletions: 1 },
	]);
});

test("lastReply and sessionModel", () => {
	const c = conversation({
		turns: [turn("t1", "completed")],
		messages: [message(1, "user", "hi", "t1"), message(2, "assistant", "PONG", "t1"), message(3, "assistant", "  ", "t1")],
		usage: { cachedTokens: 0, contextUsed: 0, contextWindow: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0.25, currency: "USD" },
		settings: { model: "anthropic/claude" },
		activities: [ask],
	});
	assert.equal(lastReply(c), "PONG");
	assert.equal(lastReply(conversation({ messages: [message(1, "assistant", "abcdef")] }), 3), "abc…");
	const m = sessionModel(view({ displayName: "my task", model: "other" }), c);
	assert.equal(m.title, "my task");
	assert.equal(m.state, "needs_input");
	assert.equal(m.question?.id, "req-ask");
	assert.equal(m.reply, "PONG");
	assert.equal(m.cost, 0.25);
	assert.equal(m.model, "anthropic/claude");
	assert.equal(sessionModel(view()).title, "repo-1");
});
