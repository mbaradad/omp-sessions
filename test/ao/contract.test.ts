// Live contract test of src/ao against a real AO daemon running real omp (`npm run test:ao`).
// It talks to the daemon that discovery finds (AO_RUN_FILE / AO_PORT pick another one) and works in
// a scratch git repo under /tmp/ao-smoke-foundation, which it registers as an AO project.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { after, before, test } from "node:test";
import { type AoEvent, AoClient, AoError, sessionStateFile } from "../../src/ao/client";
import { isolatedHome } from "../../src/ao/daemon";
import { type AoSessionModel, AoSessionWatcher } from "../../src/ao/model";

const REPO = "/tmp/ao-smoke-foundation/repo";
const TURN_TIMEOUT_MS = 90_000;

let ao: AoClient;
let watcher: AoSessionWatcher;
let sessionId: string | undefined;
const events: AoEvent[] = [];
let stream: { close(): void; readonly lastEventId: number | undefined } | undefined;

function scratchRepo(): void {
	if (fs.existsSync(`${REPO}/.git`)) return;
	fs.mkdirSync(REPO, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", REPO, ...args], { stdio: "ignore" });
	git("init", "-q", "-b", "main");
	fs.writeFileSync(`${REPO}/README.md`, "scratch repo for the src/ao contract test\n");
	git("add", "-A");
	git("-c", "user.name=ao-smoke", "-c", "user.email=ao-smoke@localhost", "commit", "-qm", "init");
}

/** Resolves with the session's model once `done` holds for it; fails after TURN_TIMEOUT_MS. */
function until(id: string, done: (m: AoSessionModel) => boolean, what: string): Promise<AoSessionModel> {
	const now = watcher.get(id);
	if (now && done(now)) return Promise.resolve(now);
	const { promise, resolve, reject } = Promise.withResolvers<AoSessionModel>();
	const timer = setTimeout(() => {
		off();
		reject(new Error(`${id} not ${what} after ${TURN_TIMEOUT_MS} ms; last: ${JSON.stringify(watcher.get(id) && { state: watcher.get(id)?.state, reply: watcher.get(id)?.reply })}`));
	}, TURN_TIMEOUT_MS);
	const off = watcher.onChange(({ changed }) => {
		const m = changed.find(c => c.id === id);
		if (m && done(m)) {
			clearTimeout(timer);
			off();
			resolve(m);
		}
	});
	return promise;
}

before(async () => {
	// CONTRACT.md "Isolated HOME": run through `npm run test:ao`, which sets one up.
	assert.ok(isolatedHome(), "run this test with an isolated HOME (npm run test:ao), never the real one");
	ao = await AoClient.connect();
	scratchRepo();
	watcher = new AoSessionWatcher(ao, { query: { active: true } });
	await watcher.start();
	stream = ao.events({ onEvent: e => events.push(e) });
});

after(async () => {
	stream?.close();
	watcher?.close();
	if (sessionId) {
		await ao.killSession(sessionId).catch(() => undefined);
		await ao.deleteSession(sessionId).catch(() => undefined);
	}
});

test("a scratch repo maps to one AO project", async () => {
	const project = await ao.projectForFolder(`${REPO}/`);
	assert.ok(project, "a git repo has a project");
	assert.equal(fs.realpathSync(project.path), fs.realpathSync(REPO));
	// Found, not registered again.
	assert.equal((await ao.projectForFolder(REPO))?.id, project.id);
	assert.equal(await ao.projectForFolder("/tmp"), undefined);
});

test("spawn an omp chat session, prompt it, read state, reply, cost and events", async () => {
	const project = await ao.projectForFolder(REPO);
	assert.ok(project);
	const spawned = await ao.spawnSession({ projectId: project.id, harness: "omp", mode: "chat", kind: "worker", displayName: "src/ao contract", prompt: "Reply with exactly: PONG", approvalMode: "auto" });
	sessionId = spawned.session.id;
	const id = sessionId;
	assert.equal(spawned.session.harness, "omp");

	const first = await until(id, m => m.state === "idle" && (m.reply ?? "").includes("PONG"), "idle with PONG");
	assert.equal(first.title, "src/ao contract");
	assert.equal(first.projectId, project.id);
	// The session's own worktree, not the repo it came from.
	assert.ok(first.cwd?.endsWith(`/${id}`) && fs.existsSync(first.cwd), `cwd ${first.cwd}`);
	assert.equal(first.queue.done, 1);
	assert.equal(first.question, undefined);
	assert.equal(typeof first.cost, "number", "omp reports cost through ACP usage");

	// A second prompt through steer-or-send (no turn runs: it is sent).
	const sent = await ao.steerOrSend(id, { text: "Reply with exactly: SECOND" });
	assert.equal(sent.outcome, "sent");
	const second = await until(id, m => m.state === "idle" && (m.reply ?? "").includes("SECOND"), "idle with SECOND");
	assert.equal(second.queue.done, 2);
	assert.ok((second.cost ?? 0) >= (first.cost ?? 0));

	const conversation = await ao.getConversation(id);
	assert.deepEqual(
		conversation.messages.filter(m => m.role === "user").map(m => m.text),
		["Reply with exactly: PONG", "Reply with exactly: SECOND"],
	);
	assert.ok(conversation.turns.every(t => t.state === "completed"));

	// The change stream named the session, in sequence order.
	const mine = events.filter(e => e.sessionId === id);
	assert.ok(mine.some(e => e.type === "session_created"), "session_created arrived");
	assert.ok(mine.some(e => e.type === "session_updated"), "session_updated arrived");
	const seqs = events.map(e => e.seq);
	assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

	// Durable replay: a new subscription from before the spawn sees the same events again.
	const firstSeq = mine[0].seq;
	const replayed: AoEvent[] = [];
	const { promise, resolve } = Promise.withResolvers<void>();
	const lastMine = mine.at(-1)?.seq ?? firstSeq;
	const replay = ao.events({
		after: firstSeq - 1,
		onEvent: e => {
			if (e.sessionId === id) replayed.push(e);
			if (e.seq >= lastMine) resolve();
		},
	});
	await promise;
	replay.close();
	assert.deepEqual(
		replayed.filter(e => e.seq <= lastMine).map(e => e.seq),
		mine.map(e => e.seq),
	);
});

test("changed files come from the session's workspace", async () => {
	assert.ok(sessionId, "the spawn test ran");
	const id = sessionId;
	// Real omp (the shared dev daemon). omp's chat turns carry no `diff`, so this only passes through the manifest.
	await ao.sendMessage(id, { text: "Create the file hello.txt containing the word hi using your write tool, then reply DONE." });
	const done = await until(id, m => m.state === "idle" && (m.reply ?? "").includes("DONE") && m.changedFiles.some(f => f.path === "hello.txt"), "idle with hello.txt changed").catch(async (error: Error) => {
		// Tell "omp did not write it" from "the model missed it": the disk, AO's manifest and the model's own list.
		const cwd = watcher.get(id)?.cwd;
		const onDisk = cwd ? fs.existsSync(`${cwd}/hello.txt`) : "unknown";
		const manifest = (await ao.workspaceManifest(id).catch(() => undefined))?.files.map(f => `${f.path}:${f.status}`);
		throw new Error(`${error.message}; hello.txt on disk: ${onDisk}; manifest: ${JSON.stringify(manifest)}; model changedFiles: ${JSON.stringify(watcher.get(id)?.changedFiles.map(f => f.path))}`);
	});
	assert.deepEqual(done.changedFiles.find(f => f.path === "hello.txt")?.status, "added");
});

test("stop and resume the agent (MAPPING D4)", async () => {
	assert.ok(sessionId, "the spawn test ran");
	const id = sessionId;
	await ao.exitAgent(id);
	await until(id, m => m.state === "stopped", "stopped");
	await ao.resumeAgent(id);
	await until(id, m => m.state === "idle", "idle after resume");
	const messages = (await ao.getConversation(id)).messages.map(m => m.text);
	assert.ok(messages.some(t => t.includes("SECOND")), "the transcript is still there");
});

test("spawnSwitchyard (D11): bypass launch, mode file, options, prompt, idempotent retry; a bad option leaves nothing", async () => {
	const opts = { dir: REPO, displayName: "src/ao spawn", thinking: "off", mode: "edits" as const, prompt: "Reply with exactly: SPAWNED", clientRequestId: `contract-${Date.now()}`, clientMessageId: `contract-msg-${Date.now()}` };
	const first = await ao.spawnSwitchyard(opts);
	const id = first.session.id;
	try {
		const settled = await until(id, m => m.state === "idle" && (m.reply ?? "").includes("SPAWNED"), "idle with SPAWNED");
		assert.equal(settled.conversation?.settings.approvalMode, "bypass-permissions", "AO runs it unguarded: the omp extension's gate is the only one");
		assert.equal(fs.readFileSync(sessionStateFile(id, "mode"), "utf8"), "edits\n");
		const thinking = (await ao.configOptions(id)).options.find(o => o.id === "thinking");
		assert.equal(thinking?.currentValue, "off");
		// Retrying with the same ids is the same session and the same message.
		const again = await ao.spawnSwitchyard(opts);
		assert.equal(again.session.id, id);
		assert.equal(again.sent?.duplicate, true);
		assert.equal((await ao.getConversation(id)).turns.length, 1);
		// An option the agent does not offer: refused, and no session (not even a terminated row) is left.
		const before = (await ao.listSessions({ project: first.project?.id })).sessions.map(s => s.id);
		await assert.rejects(ao.spawnSwitchyard({ dir: REPO, thinking: "ludicrous" }), /Unknown thinking level "ludicrous"/);
		await assert.rejects(ao.spawnSwitchyard({ dir: REPO, model: "nope/model" }), /not in AO's model catalog/);
		assert.deepEqual((await ao.listSessions({ project: first.project?.id })).sessions.map(s => s.id), before);
	} finally {
		await ao.killSession(id).catch(() => undefined);
		await ao.deleteSession(id).catch(() => undefined);
	}
});

test("errors carry AO's code", async () => {
	await assert.rejects(ao.getSession("no-such-session-1"), (e: unknown) => e instanceof AoError && e.status === 404 && e.code === "SESSION_NOT_FOUND");
});
