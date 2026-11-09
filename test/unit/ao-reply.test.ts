import assert from "node:assert/strict";
import { test } from "node:test";
import { AoClient, type AoConversation, type AoEventStreamOptions, type AoMessage, type AoSessionView, type AoTurn, type AoWorkspaceManifest } from "../../src/ao/client";
import { AoSessionWatcher, replyPending, sessionModel, turnReply } from "../../src/ao/model";
import { virtualClock } from "./ao-clock";

const T = "2026-11-09T15:00:00Z";
const turn = (id: string, state: AoTurn["state"]): AoTurn => ({ id, state, requestedAt: T });
const assistant = (sequence: number, turnId: string, text: string, streaming: boolean): AoMessage => ({ kind: "message", id: `m${sequence}`, sequence, revision: 0, role: "assistant", origin: "provider", text, editAvailable: false, streaming, createdAt: T, turnId });
/** `bare` lists the turns with no user prompt (a compaction turn; a replayed history turn): every other turn gets the prompt a real one has. */
const conv = (turns: AoTurn[], messages: AoMessage[], bare: string[] = []): AoConversation => ({
	activities: [],
	branchedFromEarlierMessage: false,
	continueTurnId: "",
	controller: "ready",
	conversationId: "c",
	hasMoreBefore: false,
	latestSequence: 9,
	messages: [
		...turns.filter(t => !bare.includes(t.id)).map((t, i): AoMessage => ({ ...assistant(-1 - i, t.id, `prompt ${t.id}`, false), role: "user", origin: "human" })),
		...messages,
	],
	mode: "chat",
	nativeForkAvailableAfterSequence: 0,
	sessionId: "repo-1",
	settings: {},
	turns,
});
const view = (): AoSessionView => ({
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
});

test("turnReply: a completed turn's reply is final only once its last assistant message stopped streaming (test-infra's race)", () => {
	const before = assistant(1, "t1", "FIRST", false);
	// AO says t2 completed; its message is still streaming (half a reply), or not there at all.
	const streaming = conv([turn("t1", "completed"), turn("t2", "completed")], [before, assistant(2, "t2", "SEC", true)]);
	assert.deepEqual(turnReply(streaming, "t2"), { text: "SEC", final: false });
	const missing = conv([turn("t1", "completed"), turn("t2", "completed")], [before]);
	assert.deepEqual(turnReply(missing, "t2"), { final: false });
	// The old behaviour this guards against: the session-level reply is the previous turn's.
	assert.equal(sessionModel(view(), missing).reply, "FIRST");
	assert.equal(sessionModel(view(), missing).replyPending, true);
	assert.equal(replyPending(streaming), true);
	// Final once the flag flips.
	const done = conv([turn("t1", "completed"), turn("t2", "completed")], [before, assistant(2, "t2", "SECOND", false)]);
	assert.deepEqual(turnReply(done, "t2"), { text: "SECOND", final: true });
	assert.equal(replyPending(done), false);
	assert.equal(sessionModel(view(), done).replyPending, undefined);
	// A turn still running is not final, whatever its messages say; a turn that ended with no text never is.
	assert.equal(turnReply(conv([turn("t1", "running")], [assistant(1, "t1", "x", false)]), "t1").final, false);
	assert.deepEqual(turnReply(conv([turn("t1", "failed")], []), "t1"), { final: false });
	// Only the turn asked about counts: a streaming message of another turn does not hold this one back.
	assert.equal(turnReply(conv([turn("t1", "completed"), turn("t2", "running")], [assistant(1, "t1", "ONE", false), assistant(2, "t2", "part", true)]), "t1").final, true);
	assert.equal(turnReply(conv([], []), "nope").final, false);
});

test("AoClient.awaitTurnReply: reads until the reply is final, or gives up after the grace period with what there is", async () => {
	const clock = virtualClock();
	try {
		const answers = [
			conv([turn("t1", "completed")], []),
			conv([turn("t1", "completed")], [assistant(1, "t1", "HAL", true)]),
			conv([turn("t1", "completed")], [assistant(1, "t1", "HALF DONE", false)]),
		];
		let reads = 0;
		const fetch = async (): Promise<Response> => new Response(JSON.stringify(answers[Math.min(reads++, answers.length - 1)]), { status: 200, headers: { "content-type": "application/json" } });
		const ao = new AoClient({ baseUrl: "http://127.0.0.1:1", fetch });
		const polled = ao.awaitTurnReply("repo-1", "t1", { pollMs: 1 });
		assert.deepEqual(await clock.resolve(polled), { text: "HALF DONE", final: true });
		assert.equal(reads, 3);
		// A turn that ends with no assistant text: the wait is bounded, and what there is comes back, but not before the grace period.
		answers.length = 0;
		answers.push(conv([turn("t1", "failed")], []));
		let done = false;
		const bounded = ao.awaitTurnReply("repo-1", "t1", { graceMs: 60, pollMs: 10 }).then(r => ((done = true), r));
		await clock.advance(50);
		assert.equal(done, false, "still inside the grace period");
		assert.deepEqual(await clock.resolve(bounded), { final: false });
	} finally {
		clock.stop();
	}
});

test("AoSessionWatcher: a completed turn whose reply is not final is read again, so the model ends with the real reply", async () => {
	const clock = virtualClock();
	const first = conv([turn("t1", "completed")], [assistant(1, "t1", "FIRST", false)]);
	// The conversation AO answers next: t2 completed, its message not there yet, then streaming, then final.
	const script = [
		conv([turn("t1", "completed"), turn("t2", "completed")], [assistant(1, "t1", "FIRST", false)]),
		conv([turn("t1", "completed"), turn("t2", "completed")], [assistant(1, "t1", "FIRST", false), assistant(2, "t2", "SEC", true)]),
		conv([turn("t1", "completed"), turn("t2", "completed")], [assistant(1, "t1", "FIRST", false), assistant(2, "t2", "SECOND", false)]),
	];
	let stage = 0;
	let count = 0;
	let stream: Pick<AoEventStreamOptions, "onEvent" | "onStatus"> | undefined;
	const manifest: AoWorkspaceManifest = { degraded: false, refreshing: false, stale: false, truncated: false, sessionId: "repo-1", workspaceVersion: "v", sections: {} as never, summary: { files: 0, additions: 0, deletions: 0 }, files: [] };
	const fake = {
		events: (options: Pick<AoEventStreamOptions, "onEvent" | "onStatus">) => ((stream = options), { lastEventId: undefined, close: () => undefined }),
		listSessions: async () => ({ sessions: [view()] }),
		getSession: async () => view(),
		getConversation: async () => (count++, stage === 0 ? first : script[stage - 1]),
		workspacePath: async () => "/wt",
		workspaceManifest: async () => manifest,
	};
	// changedFiles off: this is about the reply re-reads; the files' own safety reads (3.4 s later) would also re-fetch the conversation.
	const watcher = new AoSessionWatcher(fake as unknown as AoClient, { debounceMs: 1, settleMs: 20, changedFiles: false });
	await watcher.start();
	try {
		assert.equal(watcher.get("repo-1")?.reply, "FIRST");
		assert.equal(watcher.get("repo-1")?.replyPending, undefined);
		// The event for t2's completion; AO's answer is the one with no reply of its own yet. No event follows.
		stage = 1;
		stream?.onEvent({ seq: 1, projectId: "repo", sessionId: "repo-1", type: "session_updated", payload: {}, createdAt: T }, 1);
		await clock.advance(5);
		assert.equal(watcher.get("repo-1")?.conversation?.turns.length, 2);
		assert.equal(watcher.get("repo-1")?.reply, "FIRST", "the previous turn's reply, for now");
		assert.equal(watcher.get("repo-1")?.replyPending, true);
		// settleMs later the message exists but still streams; then it is final: the model follows with no event.
		stage = 2;
		await clock.advance(25);
		assert.equal(watcher.get("repo-1")?.reply, "SEC");
		assert.equal(watcher.get("repo-1")?.replyPending, true);
		stage = 3;
		await clock.advance(25);
		assert.equal(watcher.get("repo-1")?.reply, "SECOND");
		assert.equal(watcher.get("repo-1")?.replyPending, undefined);
		// Final: no more reads on its account.
		const settled = count;
		await clock.advance(5_000);
		assert.equal(count, settled);
	} finally {
		watcher.close();
		clock.stop();
	}
});

test("AoSessionWatcher: a turn that never gets a reply is re-read a few times, not forever", async () => {
	const clock = virtualClock();
	let count = 0;
	const manifest: AoWorkspaceManifest = { degraded: false, refreshing: false, stale: false, truncated: false, sessionId: "repo-1", workspaceVersion: "v", sections: {} as never, summary: { files: 0, additions: 0, deletions: 0 }, files: [] };
	const fake = {
		events: () => ({ lastEventId: undefined, close: () => undefined }),
		listSessions: async () => ({ sessions: [view()] }),
		getSession: async () => view(),
		getConversation: async () => (count++, conv([turn("t1", "completed")], [])),
		workspacePath: async () => "/wt",
		workspaceManifest: async () => manifest,
	};
	const watcher = new AoSessionWatcher(fake as unknown as AoClient, { debounceMs: 1, settleMs: 15 });
	await watcher.start();
	try {
		await clock.advance(400);
		// The first read plus four more, then it stops.
		assert.equal(count, 5);
		assert.equal(watcher.get("repo-1")?.replyPending, true);
		await clock.advance(5_000);
		assert.equal(count, 5, "gave up");
	} finally {
		watcher.close();
		clock.stop();
	}
});

test("replyPending: a compaction turn (no messages) and a replayed history turn are not 'the last turn' (G33 repro, live shapes)", () => {
	const history = { ...turn("hist", "recovered"), providerTurnId: "acp-history-turn:41:abc:root36:def" };
	// Live: the prompt turn answered "2999"; POST /compact added a completed turn with no messages at all; a restart
	// replayed the 2999 reply as a history turn holding only an assistant message.
	const bare = ["compact", "hist"];
	const afterCompaction = conv([turn("ask", "completed"), turn("compact", "completed"), history], [assistant(2, "ask", "2999", false), assistant(3, "hist", "2999", false)], bare);
	assert.equal(replyPending(afterCompaction), false);
	assert.equal(sessionModel(view(), afterCompaction).replyPending, undefined);
	assert.equal(sessionModel(view(), afterCompaction).reply, "2999");
	// The same conversation while the prompted turn's reply really is not final: still pending, whatever follows it.
	const streaming = conv([turn("ask", "completed"), turn("compact", "completed"), history], [assistant(2, "ask", "29", true), assistant(3, "hist", "2999", false)], bare);
	assert.equal(replyPending(streaming), true);
	// A prompted turn that ended with no assistant text is still pending (it has its user message); the empty compaction turn does not change that.
	assert.equal(replyPending(conv([turn("ask", "completed"), turn("compact", "completed")], [], ["compact"])), true);
	// Nothing but a compaction turn: nothing was asked.
	assert.equal(replyPending(conv([turn("compact", "completed")], [], ["compact"])), false);
});
