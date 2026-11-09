// The fake omp edits and commits in the AO worktree it runs in, and resolves a merge when a prompt it
// didn't script asks it to (FAKE_OMP_RULES): what graph propagation tests (GRAPH-PROPAGATION.md) build on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AoClient } from "../../src/ao/client";
import { lastReply } from "../../src/ao/model";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

let ao: AoFixture;
let client: AoClient;
let repo: string;
let projectId: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	repo = ao.scratchRepo();
	projectId = await ao.createProject(repo);
});

after(async () => {
	await ao?.stop();
});

// Spawns pass an explicit `branch`: without one AO renames the session branch (ao/<slug-of-prompt>/root)
// a moment after start, and an agent that commits meanwhile fails with "cannot lock ref 'HEAD'".
function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}

/** Polls (real time: the daemon and fake run on it) until the session's `turns`-th turn is final; its reply. */
async function replyOf(sessionId: string, turns: number): Promise<string | undefined> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const conv = await client.getConversation(sessionId);
		const turn = conv.turns[turns - 1];
		if (turn && turn.state !== "queued" && turn.state !== "running") return lastReply(conv);
		if (Date.now() > deadline) throw new Error(`turn ${turns} of ${sessionId} still ${turn?.state ?? "missing"}`);
		await sleep(100);
	}
}

/** The worktree the fake's omp runs in for the session spawned after frame `mark`. */
function worktreeSince(mark: number): string {
	const created = ao.fakeOmpFrames().slice(mark).find(f => f.dir === "in" && f.msg?.method === "session/new");
	assert.ok(created, "session/new reached the fake");
	return created.msg.params.cwd;
}

test("the fake edits files and commits them in its AO worktree", { skip }, async () => {
	const mark = ao.fakeOmpFrames().length;
	const { session } = await client.spawnSession({
		projectId,
		harness: "omp",
		mode: "chat",
		kind: "worker",
		displayName: "fake git",
		branch: "fake-git",
		approvalMode: "bypass-permissions",
		prompt: ["write x.txt line one", "commit add x", "append x.txt line two", "edit x.txt line one => line ONE", "commit edit x", "echo done"].join("\n"),
	});
	assert.equal(await replyOf(session.id, 1), "done");
	const wt = worktreeSince(mark);
	assert.notEqual(path.resolve(wt), path.resolve(repo), "AO runs the session in its own worktree");
	assert.deepEqual(git(wt, "log", "--format=%s").split("\n"), ["edit x", "add x", "init"]);
	assert.equal(git(wt, "status", "--porcelain"), "");
	assert.equal(fs.readFileSync(path.join(wt, "x.txt"), "utf8"), "line ONE\nline two\n");
});

test("a rule-scripted resolve task merges a conflicting parent branch and leaves no MERGE_HEAD", { skip }, async () => {
	const mark = ao.fakeOmpFrames().length;
	const { session } = await client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName: "fake merge", branch: "fake-merge", approvalMode: "bypass-permissions", prompt: "write x.txt child line\ncommit child edit\necho child done" });
	assert.equal(await replyOf(session.id, 1), "child done");
	const wt = worktreeSince(mark);
	// A parent branch that changed the same file, made beside the session (worktrees share refs).
	const parentWt = path.join(ao.root, "parent-wt");
	git(repo, "worktree", "add", "-q", "-b", "parent", parentWt, "main");
	fs.writeFileSync(path.join(parentWt, "x.txt"), "parent line\n");
	git(parentWt, "add", "-A");
	git(parentWt, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "parent edit");

	// The prompt is the test's stand-in for a planner's resolve task; the rule scripts the agent's answer.
	ao.setFakeRules([{ match: "resolve the merge of (\\S+)", script: "bash git merge --no-edit $1\nresolve union\necho resolved $1" }]);
	await client.sendMessage(session.id, { text: "Upstream task changed: resolve the merge of parent into your branch, then commit." });
	assert.equal(await replyOf(session.id, 2), "resolved parent");

	const merge = spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: wt });
	assert.notEqual(merge.status, 0, "no merge left in progress");
	assert.equal(git(wt, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "HEAD is a merge commit");
	assert.equal(git(wt, "status", "--porcelain"), "");
	const x = fs.readFileSync(path.join(wt, "x.txt"), "utf8");
	assert.match(x, /child line/);
	assert.match(x, /parent line/);
	assert.doesNotMatch(x, /^(<<<<<<<|=======|>>>>>>>)/m);
});
