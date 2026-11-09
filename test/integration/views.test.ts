// What the Sessions views read from a real, isolated AO daemon (test/ao-fixture.mjs, scripted fake omp):
// the SessionMeta record `metaOf` builds, its status through ask, stop and resume (MAPPING D3/D4), the workspace
// folder and the worktree's changed files. The vscode-dependent SessionManager is covered by the VS Code e2e.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AoClient } from "../../src/ao/client";
import { type AoSessionModel, AoSessionWatcher, answerQuestion } from "../../src/ao/model";
import { metaOf } from "../../src/ext/session-view";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";


let ao: AoFixture;
let client: AoClient;
let watcher: AoSessionWatcher;
let projectId: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
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
		reject(new Error(`timed out waiting for ${what}: state ${watcher.get(sessionId)?.state}\n${ao.daemonLog().split("\n").slice(-15).join("\n")}`));
	}, timeoutMs);
	void watcher.refresh(sessionId).then(check, () => undefined);
	return promise;
}

test("SessionMeta follows an omp session: working → needs input (waiting) → idle → stopped → idle; its folder is the AO worktree", { skip }, async () => {
	const { session } = await client.spawnSession({
		projectId,
		harness: "omp",
		mode: "chat",
		kind: "worker",
		displayName: "views fixture",
		approvalMode: "default",
		prompt: ["write notes.txt hello", "ask Ship it? | yes | no"].join("\n"),
	});
	const id = session.id;
	const workspace = (await client.api.GET("/api/v1/desktop/sessions/{sessionId}/workspace", { params: { path: { sessionId: id } } })).data?.workspacePath ?? "";
	assert.ok(workspace.includes(id), `AO's worktree is named after the session: ${workspace}`);

	const asking = await waitFor(id, "the question", m => m.state === "needs_input");
	const waiting = metaOf(asking, workspace);
	assert.equal(waiting.status, "waiting");
	assert.equal(waiting.title, "views fixture");
	assert.equal(waiting.cwd, workspace);

	assert.ok(asking.question);
	await answerQuestion(client, id, asking.question, "yes");
	const done = await waitFor(id, "idle after the answer", m => m.state === "idle");
	assert.equal(metaOf(done, workspace).status, "idle");

	// The worktree's changed files come from the manifest (omp's turns carry no diff for created files).
	const files = (await client.api.GET("/api/v1/sessions/{sessionId}/workspace/files", { params: { path: { sessionId: id } } })).data?.files ?? [];
	assert.ok(files.some(f => f.path === "notes.txt" && f.status === "added"), JSON.stringify(files));

	// Stop = exit-agent: the session stays (not terminated), the views show it stopped.
	assert.ok((await client.api.POST("/api/v1/sessions/{sessionId}/exit-agent", { params: { path: { sessionId: id } } })).response.ok);
	const stopped = await waitFor(id, "stopped", m => m.state === "stopped");
	assert.equal(metaOf(stopped, workspace).status, "stopped");
	assert.equal(stopped.view.isTerminated, false);

	// Resume = resume-agent.
	assert.ok((await client.api.POST("/api/v1/sessions/{sessionId}/resume-agent", { params: { path: { sessionId: id } } })).response.ok);
	const back = await waitFor(id, "idle after resume", m => m.state === "idle", 60_000);
	assert.equal(metaOf(back, workspace).status, "idle");

	// Rename and pin come back through the list.
	await client.renameSession(id, "renamed");
	assert.ok((await client.api.POST("/api/v1/sessions/{sessionId}/pin", { params: { path: { sessionId: id } } })).response.ok);
	const renamed = await waitFor(id, "rename and pin", m => m.title === "renamed" && m.pinned);
	assert.equal(metaOf(renamed, workspace).title, "renamed");
});
