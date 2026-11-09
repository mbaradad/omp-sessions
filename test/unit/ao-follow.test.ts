import assert from "node:assert/strict";
import { test } from "node:test";
import type { AoActivity, AoConversation, AoConversationQuery, AoEventStreamOptions, AoMessage, AoSessionView, AoTurn } from "../../src/ao/client";
import { type AoConversationUpdate, deltaCursor, followConversation, mergeConversation, questionOf, sessionModel, sessionReport } from "../../src/ao/model";

const T = "2026-11-09T15:00:00Z";
const turn = (id: string, state: AoTurn["state"]): AoTurn => ({ id, state, requestedAt: T });
const msg = (sequence: number, role: AoMessage["role"], text: string, turnId: string, m: Partial<AoMessage> = {}): AoMessage => ({
	kind: "message",
	id: `m${sequence}`,
	sequence,
	revision: 0,
	role,
	origin: role === "user" ? "human" : "provider",
	text,
	editAvailable: false,
	streaming: false,
	createdAt: T,
	turnId,
	...m,
});
const act = (sequence: number, status: AoActivity["status"], turnId: string, a: Partial<AoActivity> = {}): AoActivity => ({ kind: "activity", id: `a${sequence}`, activityKind: "command", status, summary: "echo hi", revision: 0, sequence, createdAt: T, turnId, ...a });
const conv = (c: Partial<AoConversation>): AoConversation => ({
	activities: [],
	branchedFromEarlierMessage: false,
	continueTurnId: "",
	controller: "ready",
	conversationId: "c1",
	hasMoreBefore: false,
	latestSequence: 0,
	messages: [],
	mode: "chat",
	nativeForkAvailableAfterSequence: 0,
	sessionId: "repo-1",
	settings: {},
	turns: [],
	...c,
});

// As read live: a turn streams message 4 in place and runs command 5; neither gets a new sequence when it changes.
const running = conv({
	latestSequence: 5,
	controller: "busy",
	turns: [turn("t1", "completed"), turn("t2", "running")],
	messages: [msg(1, "user", "hi", "t1"), msg(2, "assistant", "PONG", "t1"), msg(3, "user", "count", "t2"), msg(4, "assistant", "1 2 3", "t2", { streaming: true })],
	activities: [act(5, "pending", "t2")],
});

test("deltaCursor: reads from below the oldest item that can still change", () => {
	assert.equal(deltaCursor(running), 2);
	assert.equal(deltaCursor(conv({ latestSequence: 6, turns: [turn("t1", "completed")], messages: [msg(6, "assistant", "x", "t1")] })), 6);
	// A still-streaming message outside any open turn (a provider-owned turn) keeps the cursor below it.
	assert.equal(deltaCursor(conv({ latestSequence: 9, messages: [msg(8, "assistant", "x", "t9", { streaming: true })] })), 7);
});

test("mergeConversation: newer revisions replace items in place, new items append, stale ones are ignored", () => {
	const delta = conv({
		latestSequence: 6,
		controller: "ready",
		turns: [turn("t2", "completed")],
		messages: [msg(3, "user", "count", "t2"), msg(4, "assistant", "1 2 3 4 5", "t2", { revision: 2 }), msg(6, "assistant", "DONE", "t2")],
		activities: [act(5, "completed", "t2", { revision: 1 })],
	});
	const { conversation, changed } = mergeConversation(running, delta);
	assert.deepEqual(conversation.messages.map(m => [m.sequence, m.text]), [[1, "hi"], [2, "PONG"], [3, "count"], [4, "1 2 3 4 5"], [6, "DONE"]]);
	assert.deepEqual(conversation.activities.map(a => a.status), ["completed"]);
	assert.deepEqual(conversation.turns.map(t => [t.id, t.state]), [["t1", "completed"], ["t2", "completed"]]);
	assert.equal(conversation.controller, "ready");
	assert.equal(conversation.latestSequence, 6);
	// Unchanged items (message 3, same revision) are not reported.
	assert.deepEqual(changed.map(i => i.sequence), [4, 5, 6]);
	// An out-of-order older revision does not roll an item back.
	const stale = mergeConversation(conversation, conv({ latestSequence: 6, messages: [msg(4, "assistant", "1 2", "t2", { revision: 1 })] }));
	assert.equal(stale.conversation.messages.find(m => m.sequence === 4)?.text, "1 2 3 4 5");
	assert.deepEqual(stale.changed, []);
});

test("mergeConversation: queued turns take the daemon's (reordered) order", () => {
	const base = conv({ turns: [turn("t1", "running"), turn("a", "queued"), turn("b", "queued"), turn("c", "queued")] });
	const { conversation } = mergeConversation(base, conv({ turns: [turn("t1", "running"), turn("c", "queued"), turn("a", "queued"), turn("b", "queued")] }));
	assert.deepEqual(conversation.turns.map(t => t.id), ["t1", "c", "a", "b"]);
});

/** A client whose reads and change stream the test drives. */
function fakeClient(reads: AoConversation[]) {
	const queries: AoConversationQuery[] = [];
	let stream: Pick<AoEventStreamOptions, "onEvent" | "onStatus"> | undefined;
	return {
		queries,
		emit: (sessionId: string) => stream?.onEvent({ seq: 1, projectId: "repo", sessionId, type: "session_updated", payload: {}, createdAt: T }),
		open: () => stream?.onStatus?.({ state: "open", cursor: 0, resumed: true, reset: false }),
		client: {
			getConversation: async (_id: string, query: AoConversationQuery = {}) => {
				queries.push(query);
				const next = reads.shift();
				if (!next) throw new Error("no more reads");
				return next;
			},
			events: (options: Omit<AoEventStreamOptions, "baseUrl" | "fetch">) => {
				stream = options;
				return { lastEventId: undefined, close: () => undefined };
			},
		},
	};
}

test("followConversation: snapshot, a delta read per change of this session, a whole read after a reconnect", async () => {
	const after = conv({ latestSequence: 6, turns: [turn("t2", "completed")], messages: [msg(4, "assistant", "1 2 3 4", "t2", { revision: 1 }), msg(6, "assistant", "DONE", "t2")], activities: [act(5, "completed", "t2", { revision: 1 })] });
	const fake = fakeClient([running, after, conv({ latestSequence: 7, messages: [msg(7, "user", "again", "t3")] })]);
	const updates: AoConversationUpdate[] = [];
	const { promise: third, resolve } = Promise.withResolvers<void>();
	const follow = followConversation(fake.client, "repo-1", {
		debounceMs: 1,
		onUpdate: u => {
			updates.push(u);
			if (updates.length === 3) resolve();
		},
	});
	assert.equal((await follow.ready).latestSequence, 5);
	fake.open();
	// Another session's change reads nothing.
	fake.emit("repo-2");
	fake.emit("repo-1");
	await new Promise<void>(r => {
		const check = () => (updates.length >= 2 ? r() : setImmediate(check));
		check();
	});
	fake.open();
	await third;
	follow.close();
	assert.deepEqual(fake.queries, [{ limit: 100 }, { afterSequence: 2 }, { limit: 100 }]);
	assert.deepEqual(updates.map(u => u.reset), [true, false, true]);
	assert.deepEqual(updates[1].changed.map(i => i.sequence), [4, 5, 6]);
	assert.equal(follow.conversation?.latestSequence, 7);
});

test("followConversation: an empty conversation is read whole (AO refuses afterSequence=0)", async () => {
	const fake = fakeClient([conv({}), conv({ latestSequence: 1, turns: [turn("t1", "running")], messages: [msg(1, "user", "hi", "t1")] })]);
	const { promise, resolve } = Promise.withResolvers<AoConversationUpdate>();
	const follow = followConversation(fake.client, "repo-1", { debounceMs: 1, onUpdate: u => !u.reset && resolve(u) });
	await follow.ready;
	fake.emit("repo-1");
	const update = await promise;
	follow.close();
	assert.deepEqual(fake.queries, [{ limit: 100 }, { limit: 100 }]);
	assert.deepEqual(update.changed.map(i => i.sequence), [1]);
});

test("sessionReport: today's show --json shape from an AO session", () => {
	const view: AoSessionView = {
		id: "repo-1",
		displayName: "fix the build",
		activity: { state: "waiting_input", lastActivityAt: T },
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
		status: "needs_input",
		statusReadiness: "ready",
		terminateOnPrMerge: false,
		updatedAt: T,
	};
	const ask = act(5, "pending", "t2", {
		activityKind: "user_input",
		requestId: "req-1",
		summary: "Answer 2 questions",
		detail: { schema: { type: "object", properties: { q0: { title: "Color?", type: "string", oneOf: [{ const: "red", title: "red" }] }, q0__other: { type: "string" }, q1: { title: "Sizes?", type: "array", items: { anyOf: [{ const: "S", title: "S" }] } } } } },
	});
	const c = conv({ ...running, activities: [ask], settings: { approvalMode: "accept-edits", model: "anthropic/opus" }, usage: { cachedTokens: 0, contextUsed: 0, contextWindow: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0.5 } });
	const report = sessionReport({ ...sessionModel(view, c), cwd: "/wt/repo-1" }, { tags: ["ci"] });
	assert.deepEqual(report, {
		id: "repo-1",
		title: "fix the build",
		cwd: "/wt/repo-1",
		state: "needs_input",
		status: "waiting",
		changedFiles: 0,
		queue: { pending: 0, running: 1, done: 1, total: 2, autoRun: true },
		tags: ["ci"],
		createdAt: Date.parse(T),
		updatedAt: Date.parse(T),
		mode: "edits",
		model: "anthropic/opus",
		cost: 0.5,
		question: {
			id: "req-1",
			title: "Answer 2 questions",
			kind: "ask",
			questions: [
				{ question: "Color?", options: ["red"], multi: false },
				{ question: "Sizes?", options: ["S"], multi: true },
			],
		},
		reply: "1 2 3",
	});
	// An approval is a select among its decisions; no question once nothing waits.
	const approval = questionOf(act(6, "pending", "t2", { activityKind: "approval", requestId: "r2", detail: { decisions: [{ id: "a", label: "Allow" }, { id: "d", label: "Deny" }] } }));
	assert.deepEqual(sessionReport({ ...sessionModel(view, c), question: approval }).question, { id: "r2", title: "echo hi", kind: "select", options: ["Allow", "Deny"] });
	assert.equal(sessionReport(sessionModel({ ...view, activity: { state: "idle", lastActivityAt: T } }, conv({ ...running, turns: [turn("t1", "completed")] }))).question, undefined);
});
