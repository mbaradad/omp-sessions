// An omp Chat session on a real, isolated AO daemon (test/ao-fixture.mjs) running the scripted ACP
// fake (test/fake-omp-acp.mjs), driven only through src/ao: create, stream, approve, answer, steer.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { AoClient, unwrap } from "../../src/ao/client";
import { type AoSessionModel, AoSessionWatcher, answerQuestion } from "../../src/ao/model";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

let ao: AoFixture;
let client: AoClient;
let watcher: AoSessionWatcher;
let projectId: string;

before(async () => {
	if (skip) return;
	// 250 ms between streamed chunks: long enough for the watcher to see the reply mid-stream.
	ao = await startAoFixture({ fakeOmpEnv: { FAKE_OMP_DELAY: "250" } });
	// Discovery, as clients do it: the fixture's run file names its port.
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	assert.equal(client.baseUrl, ao.baseUrl);
	projectId = await ao.createProject(ao.scratchRepo());
	watcher = new AoSessionWatcher(client);
	await watcher.start();
});

after(async () => {
	watcher?.close();
	await ao?.stop();
});

/** Resolves with the session's model once `pred` holds (checked on every watcher change); the timer only bounds a hang. */
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
		reject(new Error(`timed out waiting for ${what}: state ${m?.state}, question ${m?.question?.kind}, reply ${JSON.stringify(m?.reply)}\n${ao.daemonLog().split("\n").slice(-20).join("\n")}`));
	}, timeoutMs);
	void watcher.refresh(sessionId).then(check, () => undefined);
	return promise;
}

const STREAMED = "Streaming a scripted reply from the fake omp";

test("omp chat session: streams a reply, resolves an approval and an ask", { skip }, async () => {
	// Every assistant text the watcher saw while its message was still streaming.
	const partials: string[] = [];
	const off = watcher.onChange(({ changed }) => {
		for (const m of changed) for (const msg of m.conversation?.messages ?? []) if (msg.role === "assistant" && msg.streaming) partials.push(msg.text ?? "");
	});
	const { session } = await client.spawnSession({
		projectId,
		harness: "omp",
		mode: "chat",
		kind: "worker",
		displayName: "fixture chat",
		approvalMode: "default",
		prompt: [`echo ${STREAMED}`, "bash touch approved.txt", "ask Ship it? | yes | no"].join("\n"),
	});

	const approval = await waitFor(session.id, "the bash approval", m => m.question?.kind === "approval");
	assert.equal(approval.state, "needs_input");
	assert.equal(approval.question?.title, "$ touch approved.txt");
	assert.deepEqual(
		approval.question?.decisions?.map(d => d.kind),
		["allow_once", "allow_always", "reject_once", "reject_always"],
	);
	// Streamed: clients saw the reply grow before it was complete.
	off();
	const streamed = approval.conversation?.messages.find(m => m.role === "assistant" && m.text === STREAMED);
	assert.ok(streamed, `assistant message "${STREAMED}" in ${JSON.stringify(approval.conversation?.messages.map(m => m.text))}`);
	assert.ok(
		partials.some(t => t.length > 0 && t.length < STREAMED.length && STREAMED.startsWith(t)),
		`a partial reply among ${JSON.stringify(partials)}`,
	);
	await answerQuestion(client, session.id, approval.question!, "yes");

	const ask = await waitFor(session.id, "the ask", m => m.question?.kind === "input");
	assert.equal(ask.question?.questions?.[0]?.question, "Ship it?");
	assert.deepEqual(ask.question?.questions?.[0]?.options, ["yes", "no"]);
	await answerQuestion(client, session.id, ask.question!, "no");

	const done = await waitFor(session.id, "the end of the turn", m => m.state === "idle" && m.reply === "chose no");
	const tool = done.conversation?.activities.find(a => a.activityKind === "command");
	assert.equal(tool?.status, "completed", JSON.stringify(tool));
	assert.ok((done.cost ?? 0) > 0, `cost ${done.cost}`);

	// What the fake saw: the approval resolved as allow_once, the ask answered "no".
	const replies = ao.fakeOmpFrames().filter(f => f.dir === "in" && f.msg?.result && f.msg.id !== undefined);
	assert.ok(replies.some(f => f.msg.result.outcome?.optionId === "allow_once"));
	assert.ok(replies.some(f => f.msg.result.action === "accept" && f.msg.result.content?.q0 === "no"));
	const chunks = ao.fakeOmpFrames().filter(f => f.dir === "out" && f.msg?.params?.update?.sessionUpdate === "agent_message_chunk");
	assert.ok(chunks.length >= 3);
});

test("omp chat session: steering joins the running turn", { skip }, async () => {
	const { session } = await client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName: "fixture steer", approvalMode: "default", prompt: "slow 1500" });
	await waitFor(session.id, "the running tool", m => m.state === "working" && (m.conversation?.activities.some(a => a.status === "running" || a.status === "pending") ?? false));
	const res = await client.steerOrSend(session.id, { text: "also say hi", clientMessageId: randomUUID() });
	assert.equal(res.outcome, "steered");
	const done = await waitFor(session.id, "the steered reply", m => m.state === "idle" && m.reply === "steered: also say hi");
	assert.equal(done.conversation?.turns.length, 1, "steering joined the running turn instead of starting another");
	assert.ok(ao.fakeOmpFrames().some(f => f.dir === "in" && f.msg?.method === "_session/steering"));
});

test("omp chat session: a restarted chat host reloads the omp session", { skip }, async () => {
	const seen = ao.fakeOmpFrames().length;
	const { session } = await client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName: "fixture reload", approvalMode: "default", prompt: "echo before the restart" });
	await waitFor(session.id, "the first reply", m => m.state === "idle" && m.reply === "before the restart");
	const created = ao
		.fakeOmpFrames()
		.slice(seen)
		.flatMap(f => (f.dir === "out" && f.msg?.result?.sessionId && f.msg.result.configOptions ? [f.msg.result.sessionId] : []));
	assert.ok(created.length > 0, "session/new answered");
	// The chat host dies with its omp (a crash): AO sees the agent exit; resuming it starts a new
	// host and omp, which loads the omp session (history replayed) instead of starting a new one.
	assert.ok(ao.killChatHosts(session.id) > 0, "a chat host to kill");
	await waitFor(session.id, "the agent exit", m => m.state === "stopped");
	const restarted = ao.fakeOmpFrames().length;
	await unwrap(client.api.POST("/api/v1/sessions/{sessionId}/resume-agent", { params: { path: { sessionId: session.id } } }));
	await client.sendMessage(session.id, { text: "echo after the restart" });
	const done = await waitFor(session.id, "the reply after the restart", m => m.state === "idle" && m.reply === "after the restart");
	const load = ao.fakeOmpFrames().slice(restarted).find(f => f.dir === "in" && f.msg?.method === "session/load");
	assert.ok(load, "AO restored the session with session/load");
	assert.ok(created.includes(load.msg.params.sessionId), `loaded ${load.msg.params.sessionId}, created ${created}`);
	assert.ok(done.conversation?.messages.some(m => m.text === "before the restart"));
});
