// What the VS Code SessionManager holds when an orchestrator exists, on a real, isolated AO daemon: the watcher
// (configured as SessionManager configures it) sees the orchestrator that submitTask starts, its chat model
// carries the question it asks, the views' record marks it, and the worker lists leave it out. The vscode-dependent
// SessionManager itself only adds `workersOf` over these records.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, before, test } from "node:test";
import { AoClient } from "../../src/ao/client";
import { type AoSessionModel, AoSessionWatcher, answerQuestion } from "../../src/ao/model";
import { orchestratorOf, resolveProject, submitTask } from "../../src/ao/orchestrator";
import { metaOf, workersOf } from "../../src/ext/session-view";
import { findProject } from "../../src/ext/worktree-git";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

let ao: AoFixture;
let client: AoClient;
let watcher: AoSessionWatcher;
let repo: string;
let projectId: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	repo = ao.scratchRepo("orch");
	projectId = await ao.createProject(repo, "orch");
	// As SessionManager: every session (orchestrators included), conversations of 20 messages.
	watcher = new AoSessionWatcher(client, { conversationLimit: 20 });
	await watcher.start();
});

after(async () => {
	watcher?.close();
	await ao?.stop();
});

/** Resolves with the session's model once `pred` holds (checked on every watcher change); the timer only bounds a hang. */
function waitFor(sessionId: () => string | undefined, what: string, pred: (m: AoSessionModel) => boolean, timeoutMs = 30_000): Promise<AoSessionModel> {
	const { promise, resolve, reject } = Promise.withResolvers<AoSessionModel>();
	const check = () => {
		const id = sessionId();
		const m = id ? watcher.get(id) : undefined;
		if (!m || !pred(m)) return;
		clearTimeout(timer);
		off();
		resolve(m);
	};
	const off = watcher.onChange(check);
	const timer = setTimeout(() => {
		off();
		reject(new Error(`timed out waiting for ${what}\n${ao.daemonLog().split("\n").slice(-15).join("\n")}`));
	}, timeoutMs);
	check();
	return promise;
}

test("an orchestrator started by submitTask reaches the watcher, asks its question like any session, and stays out of the worker lists", { skip }, async () => {
	const project = await resolveProject(client, "orch", "/");
	assert.equal(await orchestratorOf(client, project), undefined);
	const sent = await submitTask(client, project, "ask Ship it? | yes | no");

	const asking = await waitFor(() => sent.orchestrator, "the orchestrator's question", m => m.state === "needs_input" && !!m.question);
	assert.equal(asking.view.kind, "orchestrator");
	assert.equal(asking.projectId, projectId);
	const meta = metaOf(asking, asking.cwd ?? "");
	assert.equal(meta.kind, "orchestrator");
	assert.equal(meta.status, "waiting", "a question of the orchestrator is needs-input for the alerts, like a worker's");
	assert.equal(meta.turnId, asking.question?.id, "the sounds' dedupe key is the question");
	assert.ok(meta.cwd, "the chat panel and the alerts know its folder");
	assert.equal(findProject(meta.cwd).root, fs.realpathSync(repo), "the orchestrator's folder belongs to the project's repository: a window on it is notified");

	// The existing answer path (the chat panel's) answers it.
	assert.ok(asking.question);
	await answerQuestion(client, sent.orchestrator, asking.question, "yes");
	const done = await waitFor(() => sent.orchestrator, "the orchestrator idle again", m => m.state === "idle");
	assert.equal(metaOf(done, done.cwd ?? "").status, "idle");

	// A worker beside it: the views' lists keep it and drop the orchestrator.
	const { session } = await client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName: "Billing worker", approvalMode: "default", prompt: "echo from a worker" });
	const worker = await waitFor(() => session.id, "the worker", m => m.state === "idle");
	const metas = [metaOf(done, done.cwd ?? ""), metaOf(worker, worker.cwd ?? "")];
	assert.deepEqual(metas.map(m => m.id).sort(), [sent.orchestrator, session.id].sort(), "the watcher holds both");
	assert.deepEqual(workersOf(metas).map(m => m.id), [session.id]);
	assert.equal(workersOf(metas)[0].kind, undefined);
});
