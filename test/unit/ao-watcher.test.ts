import assert from "node:assert/strict";
import { test } from "node:test";
import type { AoClient, AoConversation, AoEventStreamOptions, AoSessionView, AoWorkspaceManifest } from "../../src/ao/client";
import { type AoSessionModel, AoSessionWatcher } from "../../src/ao/model";

const T = "2026-11-09T15:00:00Z";
const view: AoSessionView = {
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
};
const conversation = (turn: "running" | "completed", latestSequence: number): AoConversation => ({
	activities: [],
	branchedFromEarlierMessage: false,
	continueTurnId: "",
	controller: "ready",
	conversationId: "c1",
	hasMoreBefore: false,
	latestSequence,
	messages: [],
	mode: "chat",
	nativeForkAvailableAfterSequence: 0,
	sessionId: "repo-1",
	settings: {},
	turns: [{ id: "t1", state: turn, requestedAt: T }],
});
const manifest = (paths: string[], flags: { stale?: boolean } = {}): AoWorkspaceManifest => ({
	degraded: false,
	refreshing: false,
	stale: flags.stale ?? false,
	truncated: false,
	sessionId: "repo-1",
	workspaceVersion: "v",
	sections: {} as never,
	summary: { files: paths.length, additions: paths.length, deletions: 0 },
	files: paths.map(path => ({ path, status: "added" as const, additions: 1, deletions: 0, binary: false, editable: true, fileFingerprint: "", size: 1 })),
});

/** A daemon the test steps through: the conversation and the manifest answers are whatever the test says. */
function fakeDaemon() {
	/** `i` steps through `manifests`, one per read, the last one repeating; the test resets it with each new script. */
	const state = { turn: "running" as "running" | "completed", seq: 3, manifests: [manifest([])], i: 0 };
	let reads = 0;
	let stream: Pick<AoEventStreamOptions, "onEvent" | "onStatus"> | undefined;
	const fake = {
		events: (options: Pick<AoEventStreamOptions, "onEvent" | "onStatus">) => ((stream = options), { lastEventId: undefined, close: () => undefined }),
		listSessions: async () => ({ sessions: [view] }),
		getSession: async () => view,
		getConversation: async () => conversation(state.turn, state.seq),
		workspacePath: async () => "/wt/repo-1",
		workspaceManifest: async () => (reads++, state.manifests[Math.min(state.i++, state.manifests.length - 1)]),
	};
	// The watcher uses only these methods of AoClient; the fake has exactly them.
	return { ao: fake as unknown as AoClient, state, emit: () => stream?.onEvent({ seq: state.seq, projectId: "repo", sessionId: "repo-1", type: "session_updated", payload: {}, createdAt: T }, state.seq), reads: () => reads };
}

const next = (watcher: AoSessionWatcher, until: (m: AoSessionModel) => boolean): Promise<AoSessionModel> => {
	const hit = watcher.get("repo-1");
	if (hit && until(hit)) return Promise.resolve(hit);
	const { promise, resolve } = Promise.withResolvers<AoSessionModel>();
	const off = watcher.onChange(({ changed }) => {
		const m = changed.find(c => c.id === "repo-1");
		if (m && until(m)) (off(), resolve(m));
	});
	return promise;
};

test("AoSessionWatcher: the changed files read as a turn settles can be stale; a session that just settled is read once more", async () => {
	const daemon = fakeDaemon();
	const watcher = new AoSessionWatcher(daemon.ao, { debounceMs: 1, settleMs: 40 });
	await watcher.start();
	try {
		// Loaded while a turn runs: one read, final for this state (no second read for a session we only just saw).
		assert.equal(daemon.reads(), 1);
		await new Promise(r => setTimeout(r, 80));
		assert.equal(daemon.reads(), 1, "an open session is not read again without an event");

		// The turn writes hello.txt and settles. AO's answer at that instant is still the empty one; the file shows up right after.
		daemon.state.turn = "completed";
		daemon.state.seq = 6;
		daemon.state.manifests = [manifest([]), manifest(["hello.txt"])];
		daemon.state.i = 0;
		daemon.emit();
		const settled = await next(watcher, m => m.conversation?.turns[0].state === "completed");
		assert.deepEqual(settled.changedFiles, [], "the settle-time read was stale");
		// No event follows. The confirming read, a little later, corrects the model by itself.
		const corrected = await next(watcher, m => m.changedFiles.some(f => f.path === "hello.txt"));
		assert.deepEqual(corrected.changedFiles.map(f => f.path), ["hello.txt"]);
		assert.equal(daemon.reads(), 3);
		// Confirmed: no more reads without a change.
		await new Promise(r => setTimeout(r, 120));
		assert.equal(daemon.reads(), 3);
	} finally {
		watcher.close();
	}
});

test("AoSessionWatcher: a manifest AO flags stale is not trusted, but only a few tries are made", async () => {
	const daemon = fakeDaemon();
	daemon.state.turn = "completed";
	daemon.state.manifests = [{ ...manifest([]), stale: true }];
	const watcher = new AoSessionWatcher(daemon.ao, { debounceMs: 1, settleMs: 15 });
	await watcher.start();
	try {
		await new Promise(r => setTimeout(r, 250));
		// Four reads, then it settles for the answer it has (AO that never stops saying stale must not be polled forever).
		assert.equal(daemon.reads(), 4);
		await new Promise(r => setTimeout(r, 100));
		assert.equal(daemon.reads(), 4);
	} finally {
		watcher.close();
	}
});
