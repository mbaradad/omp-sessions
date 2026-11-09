// How real omp 18.12.6 asks for permission over ACP (VALIDATION.md), through AO: bash → session/request_permission
// (an `approval` activity); with `always-ask`, write/edit → an "Allow tool: …" elicitation form (a `user_input`
// activity) offering [Approve, Approve <tool> for this session, Deny].
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { AoClient } from "../../src/ao/client";
import { type AoSessionModel, AoSessionWatcher, answerQuestion } from "../../src/ao/model";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

let ao: AoFixture;
let client: AoClient;
let watcher: AoSessionWatcher;
let repo: string;
let projectId: string;

before(async () => {
	if (skip) return;
	// A user whose omp config says always-ask: AO launches omp without an approval flag, so the mode comes from the env.
	ao = await startAoFixture({ fakeOmpEnv: { FAKE_OMP_APPROVAL_MODE: "always-ask" } });
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	repo = ao.scratchRepo();
	projectId = await ao.createProject(repo);
	watcher = new AoSessionWatcher(client);
	await watcher.start();
});

after(async () => {
	watcher?.close();
	await ao?.stop();
});

function waitFor(sessionId: string, what: string, pred: (m: AoSessionModel) => boolean, timeoutMs = 30_000): Promise<AoSessionModel> {
	const { promise, resolve, reject } = Promise.withResolvers<AoSessionModel>();
	const check = (m: AoSessionModel | undefined) => {
		if (!m || !pred(m)) return;
		clearTimeout(timer);
		off();
		resolve(m);
	};
	const off = watcher.onChange(({ changed }) => {
		for (const m of changed) if (m.id === sessionId) check(m);
	});
	const timer = setTimeout(() => {
		off();
		const m = watcher.get(sessionId);
		reject(new Error(`timed out waiting for ${what}: state ${m?.state}, question ${JSON.stringify(m?.question?.title)}`));
	}, timeoutMs);
	void watcher.refresh(sessionId).then(check, () => undefined);
	return promise;
}

const worktreeOf = (mark: number): string => {
	const created = ao.fakeOmpFrames().slice(mark).find(f => f.dir === "in" && f.msg?.method === "session/new");
	assert.ok(created);
	return created.msg.params.cwd;
};

test("always-ask: write asks 'Allow tool: write' as a form; Approve for this session silences the next write; bash still uses session/request_permission", { skip }, async () => {
	const mark = ao.fakeOmpFrames().length;
	const { session } = await client.spawnSession({
		projectId,
		harness: "omp",
		mode: "chat",
		kind: "worker",
		displayName: "always ask",
		branch: "always-ask",
		approvalMode: "default",
		prompt: ["write a.txt one", "write b.txt two", "bash true", "echo finished"].join("\n"),
	});

	// 1. The write asks through a form.
	const first = await waitFor(session.id, "the first write approval", m => m.question?.title.startsWith("Allow tool: write") ?? false);
	// AO delivers it as a user_input form; src/ao presents it as an approval with the enum's choices.
	assert.deepEqual(first.question?.options, ["Approve", "Approve write for this session", "Deny"]);
	assert.equal(first.state, "needs_input");
	const wt = worktreeOf(mark);
	assert.ok(!fs.existsSync(path.join(wt, "a.txt")), "nothing is written before the answer");
	await answerQuestion(client, session.id, first.question!, "Approve write for this session");

	// 2. The session-wide approval covers b.txt; bash then asks the other way, as an approval.
	const bash = await waitFor(session.id, "the bash approval", m => m.question?.title === "$ true");
	assert.deepEqual(bash.question?.decisions?.map(d => d.kind), ["allow_once", "allow_always", "reject_once", "reject_always"]);
	assert.ok(fs.existsSync(path.join(wt, "a.txt")) && fs.existsSync(path.join(wt, "b.txt")), "both writes ran after one answer");
	await answerQuestion(client, session.id, bash.question!, "yes");
	await waitFor(session.id, "the end of the turn", m => m.state === "idle" && m.reply === "finished");

	const asks = ao.fakeOmpFrames().slice(mark).filter(f => f.dir === "out" && f.msg?.method === "elicitation/create");
	assert.equal(asks.length, 1, "one form for two writes");
});

test("always-ask: Deny fails the write and writes nothing", { skip }, async () => {
	const mark = ao.fakeOmpFrames().length;
	const { session } = await client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName: "deny", branch: "always-ask-deny", approvalMode: "default", prompt: "write denied.txt no\necho after" });
	const ask = await waitFor(session.id, "the write approval", m => m.question?.title.startsWith("Allow tool: write") ?? false);
	await answerQuestion(client, session.id, ask.question!, "Deny");
	const done = await waitFor(session.id, "the end of the turn", m => m.state === "idle" && m.reply === "after");
	assert.ok(!fs.existsSync(path.join(worktreeOf(mark), "denied.txt")));
	assert.equal(done.conversation?.activities.find(a => a.summary.startsWith("write:"))?.status, "failed");
});
