// A session host running in a linked git worktree: the first prompt arrives as a bare `rpc` frame
// (how worktree/best-of-N sessions get their task before any chat connects), the agent's edits
// land in the worktree only, and the git helpers see them as the branch's changes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { changedSince, diffBase, findProject, headOf } from "../../src/ext/worktree-git";
import { sendToHost } from "../../src/shared/launch";
import { Host, isRecord, textOf, until } from "./harness";

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };

function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("worktree session: first prompt via a bare rpc frame; edits stay on the worktree branch", async t => {
	const h = new Host(`wt${process.pid}`);
	t.after(() => h.dispose());
	// The sandbox's working folder becomes a linked worktree of a fresh repository next to it.
	const main = path.join(h.root, "main");
	fs.mkdirSync(main);
	sh(main, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(main, "readme.md"), "hi\n");
	sh(main, "add", "-A");
	sh(main, "commit", "-q", "-m", "init");
	fs.rmSync(h.cwd, { recursive: true, force: true });
	sh(main, "worktree", "add", "-q", "--no-track", "-b", "omp/smoke", h.cwd, "main");
	const baseCommit = sh(main, "rev-parse", "main");
	await h.start();

	assert.equal(await sendToHost(h.meta(), { t: "rpc", cmd: { type: "prompt", message: "write notes/todo.txt from the worktree" } }), true);
	await until(() => fs.existsSync(path.join(h.cwd, "notes", "todo.txt")), "the agent's file in the worktree");
	assert.equal(fs.existsSync(path.join(main, "notes")), false, "main checkout untouched");

	const { snapshot } = await h.connect();
	const user = snapshot.messages.find(m => isRecord(m) && m.role === "user");
	assert.equal(textOf(user), "write notes/todo.txt from the worktree");
	assert.equal(snapshot.meta.cwd, h.cwd);

	const project = findProject(snapshot.meta.cwd);
	assert.equal(project.root, main, "groups under the main repository");
	assert.equal(project.worktree?.root, h.cwd);
	assert.equal(project.worktree && headOf(project.worktree.gitDir), "omp/smoke");
	const rev = await diffBase(h.cwd, { base: "main", baseCommit });
	assert.deepEqual(await changedSince(h.cwd, rev), [{ status: "?", path: "notes/todo.txt" }]);
});
