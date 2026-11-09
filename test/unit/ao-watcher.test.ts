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
	const watcher = new AoSessionWatcher(daemon.ao, { debounceMs: 1, settleMs: 40, manifestCacheMs: 150 });
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
		// Not final yet: the last read comes once AO's manifest cache has surely expired (`manifestCacheMs`), and then it stops.
		await new Promise(r => setTimeout(r, 300));
		assert.equal(daemon.reads(), 4);
		await new Promise(r => setTimeout(r, 200));
		assert.equal(daemon.reads(), 4);
	} finally {
		watcher.close();
	}
});

/**
 * AO's real behaviour (`workspaceCacheTTL`, session/workspace_manifest_index.go): a manifest is computed on a
 * read when none is cached or the cached one is older than the TTL, and is otherwise returned as it was,
 * flagged fresh (`stale: false`) unless a filesystem watcher marked it, and nobody holds that stream here.
 */
function cachingDaemon(ttlMs: number, now: () => number = Date.now) {
	const state = { turn: "running" as "running" | "completed", seq: 3, disk: [] as string[] };
	let cached: { at: number; files: string[] } | undefined;
	let computes = 0;
	let reads = 0;
	let stream: Pick<AoEventStreamOptions, "onEvent" | "onStatus"> | undefined;
	const fake = {
		events: (options: Pick<AoEventStreamOptions, "onEvent" | "onStatus">) => ((stream = options), { lastEventId: undefined, close: () => undefined }),
		listSessions: async () => ({ sessions: [view] }),
		getSession: async () => view,
		getConversation: async () => conversation(state.turn, state.seq),
		workspacePath: async () => "/wt/repo-1",
		workspaceManifest: async () => {
			reads++;
			if (!cached || now() - cached.at > ttlMs) (computes++, (cached = { at: now(), files: [...state.disk] }));
			return manifest(cached.files);
		},
	};
	return { ao: fake as unknown as AoClient, state, emit: () => stream?.onEvent({ seq: state.seq, projectId: "repo", sessionId: "repo-1", type: "session_updated", payload: {}, createdAt: T }, state.seq), reads: () => reads, computes: () => computes };
}

test("AoSessionWatcher: AO serves a manifest computed while the turn ran, unflagged, for its whole 3 s cache; only a read after that is fresh", async () => {
	// Scaled down: AO's cache lives 500 ms here. The turn writes hello.txt and settles at about 100 ms, while the
	// manifest was computed at 0. A re-read at settleMs (60) still gets that cache; the one after the cache expired does not.
	const daemon = cachingDaemon(500);
	const watcher = new AoSessionWatcher(daemon.ao, { debounceMs: 1, settleMs: 60, manifestCacheMs: 560 });
	await watcher.start();
	try {
		assert.equal(daemon.computes(), 1, "computed once, before the file existed");
		await new Promise(r => setTimeout(r, 100));
		daemon.state.disk = ["hello.txt"];
		daemon.state.turn = "completed";
		daemon.state.seq = 6;
		daemon.emit();
		// The settle-time read and the quick re-read both come out of AO's cache: the model is stale, with nothing flagged.
		const settled = await next(watcher, m => m.conversation?.turns[0].state === "completed");
		assert.deepEqual(settled.changedFiles, []);
		await new Promise(r => setTimeout(r, 90));
		assert.deepEqual(watcher.get("repo-1")?.changedFiles, [], "the quick re-read was still inside AO's cache");
		// The final read, after the cache expired, recomputes: no event, and the model corrects itself.
		const fresh = await next(watcher, m => m.changedFiles.some(f => f.path === "hello.txt"));
		assert.deepEqual(fresh.changedFiles.map(f => f.path), ["hello.txt"]);
		assert.equal(daemon.computes(), 2);
		// Final: nothing more is read.
		const done = daemon.reads();
		await new Promise(r => setTimeout(r, 400));
		assert.equal(daemon.reads(), done);
	} finally {
		watcher.close();
	}
});

/**
 * The e2e's shape: the agent writes hello.txt, then appends to README.md, with events in between. AO's cache lives 200
 * "ms" of a clock the test moves by hand (not the real one), so the outcome cannot depend on how loaded the machine is;
 * each step waits until the watcher has handled the event instead of sleeping.
 */
async function twoWrites(options: { liveFiles?: boolean }) {
	const clock = { t: 0 };
	const daemon = cachingDaemon(200, () => clock.t);
	const watcher = new AoSessionWatcher(daemon.ao, { debounceMs: 1, settleMs: 500, manifestCacheMs: 700, ...options });
	await watcher.start();
	clock.t = 250; // the manifest read at the start has expired in AO by now
	const readsBefore = daemon.reads();
	daemon.state.disk = ["hello.txt"];
	daemon.state.seq = 4;
	daemon.emit();
	await next(watcher, m => m.conversation?.latestSequence === 4);
	daemon.state.disk = ["README.md", "hello.txt"];
	daemon.state.seq = 5;
	daemon.emit();
	await next(watcher, m => m.conversation?.latestSequence === 5);
	const midTurnReads = daemon.reads() - readsBefore;
	daemon.state.turn = "completed";
	daemon.state.seq = 6;
	daemon.emit();
	const settled = await next(watcher, m => m.conversation?.turns[0].state === "completed");
	return { watcher, settled, midTurnReads, clock };
}

test("AoSessionWatcher: no manifest reads while a turn runs, so the read at the settle is fresh at once", async () => {
	const { watcher, settled, midTurnReads } = await twoWrites({});
	try {
		assert.equal(midTurnReads, 0, "events during the turn left AO's manifest cache alone");
		// Settled: the first read computes the manifest after both writes (settleMs is 500, so this is not the safety re-read).
		const files = await next(watcher, m => m.changedFiles.length === 2);
		assert.deepEqual(files.changedFiles.map(f => f.path).sort(), ["README.md", "hello.txt"]);
		assert.ok(settled.changedFiles.length === 2, "complete in the model the settle itself produced");
	} finally {
		watcher.close();
	}
});

test("AoSessionWatcher: liveFiles reads mid-turn, and AO then serves a half-done manifest to the settle read (the e2e's partial list)", async () => {
	const { watcher, settled, midTurnReads, clock } = await twoWrites({ liveFiles: true });
	try {
		assert.ok(midTurnReads >= 1);
		// The cache from the read between the two writes: hello.txt is there, the appended README.md is not.
		assert.deepEqual(settled.changedFiles.map(f => f.path), ["hello.txt"]);
		// AO's cache expires (the fake's clock moves on); the safety reads then correct it.
		clock.t += 300;
		const fresh = await next(watcher, m => m.changedFiles.length === 2);
		assert.deepEqual(fresh.changedFiles.map(f => f.path).sort(), ["README.md", "hello.txt"]);
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

/** The fake daemon with a manifest endpoint that fails the first `failures` reads after the start (a busy daemon), then answers. */
function flakyManifest(failures: number) {
	const daemon = fakeDaemon();
	let calls = 0;
	const ao = {
		...daemon.ao,
		workspaceManifest: async () => {
			calls++;
			if (calls > 1 && calls <= 1 + failures) throw new Error("daemon busy");
			return manifest(calls > 1 + failures || failures === 0 ? ["hello.txt"] : []);
		},
	} as unknown as AoClient;
	return { daemon, ao, calls: () => calls };
}

test("AoSessionWatcher: a manifest read that fails at the settle is tried again, not left stale until the next event", async () => {
	const { daemon, ao, calls } = flakyManifest(2);
	const watcher = new AoSessionWatcher(ao, { debounceMs: 1, settleMs: 20, manifestCacheMs: 60 });
	await watcher.start();
	try {
		assert.equal(calls(), 1, "the first-sight read, while the turn runs");
		daemon.state.turn = "completed";
		daemon.state.seq = 6;
		daemon.emit();
		// Two reads fail, the third answers: no event follows the settle, the retries alone bring the file in.
		const files = await next(watcher, m => m.changedFiles.length > 0);
		assert.deepEqual(files.changedFiles.map(f => f.path), ["hello.txt"]);
	} finally {
		watcher.close();
	}
});

test("AoSessionWatcher: a manifest that keeps failing is tried a few times, not forever", async () => {
	const { daemon, ao, calls } = flakyManifest(1_000);
	const watcher = new AoSessionWatcher(ao, { debounceMs: 1, settleMs: 15, manifestCacheMs: 40 });
	await watcher.start();
	try {
		daemon.state.turn = "completed";
		daemon.state.seq = 6;
		daemon.emit();
		await new Promise(r => setTimeout(r, 300));
		const reads = calls();
		assert.ok(reads > 1 && reads <= 6, `${reads} reads`);
		await new Promise(r => setTimeout(r, 200));
		assert.equal(calls(), reads, "gave up");
		assert.deepEqual(watcher.get("repo-1")?.changedFiles, []);
	} finally {
		watcher.close();
	}
});
