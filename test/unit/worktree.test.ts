// Worktree sessions: naming, worktree → main repository mapping and the git operations behind the
// worktree commands, against real throwaway git repositories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import {
	aheadCount,
	changedSince,
	conflictedFiles,
	createWorktree,
	currentBranch,
	diffBase,
	findProject,
	firstFree,
	headOf,
	isDirty,
	linkedWorktreeAt,
	mainRepoRoot,
	parseNameStatus,
	readWorktreeInfo,
	resolveBase,
	slugify,
	taskTitle,
	worktreesDir,
	writeWorktreeInfo,
} from "../../src/ext/worktree-git";

let tmp = "";
let n = 0;

before(() => {
	// .native: Windows expands 8.3 short names (RUNNER~1), as git and the code under test report paths.
	tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "omp-worktree-test-"));
	// Isolate from the user's git config and identity; keep the extension state in the temp dir.
	const globalConfig = path.join(tmp, "gitconfig");
	fs.writeFileSync(globalConfig, "");
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		SWITCHYARD_HOME: path.join(tmp, "state"),
	});
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Fresh repository `<tmp>/<n>/<name>` on branch main with one commit (a.txt, sub/b.txt). */
function repo(name = "app"): string {
	const dir = path.join(tmp, String(++n), name);
	fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
	sh(dir, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	fs.writeFileSync(path.join(dir, "sub", "b.txt"), "bee\n");
	sh(dir, "add", "-A");
	sh(dir, "commit", "-q", "-m", "init");
	return dir;
}

function commit(dir: string, file: string, content: string, message = `edit ${file}`): void {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), content);
	sh(dir, "add", "-A");
	sh(dir, "commit", "-q", "-m", message);
}

// ---------- naming ----------

test("slugify: lowercase ASCII words, accents folded, punctuation collapsed", () => {
	assert.equal(slugify("Fix the Login bug!"), "fix-the-login-bug");
	assert.equal(slugify("  Café  déjà-vu: ÜBER  "), "cafe-deja-vu-uber");
	assert.equal(slugify("refactor src/ext/panel.ts (part 2)"), "refactor-src-ext-panel-ts-part-2");
});

test("slugify: cuts at a word boundary, falls back to 'task'", () => {
	const slug = slugify("add retries with exponential backoff to the upload client and tests");
	assert.ok(slug.length <= 40, slug);
	assert.equal(slug, "add-retries-with-exponential-backoff-to");
	assert.equal(slugify("a".repeat(60)), "a".repeat(40));
	assert.equal(slugify("!!! ???"), "task");
	assert.equal(slugify("日本語のタスク"), "task");
	assert.equal(slugify("one two three", 7), "one-two");
});

test("slugify: result is a valid git branch name", () => {
	for (const text of ["x..y", "@{lock}", "end.lock", "-leading", "a//b", "~^:?*[\\"]) {
		const branch = `omp/${slugify(text)}`;
		assert.doesNotThrow(() => execFileSync("git", ["check-ref-format", "--branch", branch], { stdio: "ignore" }), branch);
	}
});

test("taskTitle: first line, whitespace collapsed, shortened with an ellipsis", () => {
	assert.equal(taskTitle("  Fix   it\nmore details"), "Fix it");
	const long = taskTitle("x".repeat(100), 20);
	assert.equal(long.length, 20);
	assert.ok(long.endsWith("…"));
});

test("firstFree: suffixes -2, -3 … until free", () => {
	assert.equal(firstFree("a", () => false), "a");
	const taken: Record<string, true> = { a: true, "a-2": true };
	assert.equal(firstFree("a", s => taken[s] === true), "a-3");
	assert.throws(() => firstFree("a", () => true, 3));
});

test("worktreesDir: sibling <repo>.worktrees, else under the state dir when the parent is read-only", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
	const parent = path.join(tmp, String(++n));
	const root = path.join(parent, "proj");
	fs.mkdirSync(root, { recursive: true });
	assert.equal(worktreesDir(root), path.join(parent, "proj.worktrees"));
	fs.chmodSync(parent, 0o555);
	try {
		const fallback = worktreesDir(root);
		assert.ok(fallback.startsWith(path.join(tmp, "state", "worktrees", "proj-")), fallback);
		assert.equal(worktreesDir(root), fallback, "stable per repository");
	} finally {
		fs.chmodSync(parent, 0o755);
	}
});

// ---------- creating worktrees ----------

test("createWorktree: sibling folder, omp/<slug> branch from the current branch", async () => {
	const main = repo();
	const wt = await createWorktree({ from: main, slug: "fix-login" });
	assert.equal(wt.mainRoot, main);
	assert.equal(wt.worktree, path.join(path.dirname(main), "app.worktrees", "fix-login"));
	assert.equal(wt.cwd, wt.worktree);
	assert.equal(wt.branch, "omp/fix-login");
	assert.equal(wt.base, "main");
	assert.equal(wt.baseCommit, sh(main, "rev-parse", "main"));
	assert.equal(sh(wt.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "omp/fix-login");
	assert.equal(fs.readFileSync(path.join(wt.worktree, "a.txt"), "utf8"), "one\n");
	assert.equal(await currentBranch(main), "main", "main checkout untouched");
	assert.throws(() => sh(main, "config", "--get", "branch.omp/fix-login.remote"), "no upstream tracking");
});

test("createWorktree: existing branch or folder gets a numeric suffix", async () => {
	const main = repo();
	const first = await createWorktree({ from: main, slug: "task" });
	const second = await createWorktree({ from: main, slug: "task" });
	assert.equal(second.branch, "omp/task-2");
	assert.equal(second.worktree, path.join(path.dirname(first.worktree), "task-2"));
	// A leftover folder without a branch, and a branch without a folder, are both avoided.
	fs.mkdirSync(path.join(path.dirname(first.worktree), "task-3"));
	sh(main, "branch", "omp/task-4");
	const fifth = await createWorktree({ from: main, slug: "task" });
	assert.equal(fifth.branch, "omp/task-5");
});

test("createWorktree: from a subfolder or from another worktree keeps the relative folder and the main repo", async () => {
	const main = repo();
	const wt = await createWorktree({ from: path.join(main, "sub"), slug: "sub-task" });
	assert.equal(wt.cwd, path.join(wt.worktree, "sub"));
	assert.equal(wt.mainRoot, main);
	commit(wt.worktree, "sub/c.txt", "see\n");
	const nested = await createWorktree({ from: path.join(wt.worktree, "sub"), slug: "follow-up" });
	assert.equal(nested.mainRoot, main);
	assert.equal(path.dirname(nested.worktree), path.dirname(wt.worktree), "all worktrees live next to the main checkout");
	assert.equal(nested.base, "omp/sub-task", "defaults to the branch of the folder it was started from");
	assert.ok(fs.existsSync(path.join(nested.worktree, "sub", "c.txt")));
});

test("createWorktree: explicit base branch, tag or commit", async () => {
	const main = repo();
	const first = sh(main, "rev-parse", "HEAD");
	sh(main, "tag", "v1");
	commit(main, "a.txt", "two\n");
	const fromTag = await createWorktree({ from: main, slug: "t", base: "v1" });
	assert.equal(fromTag.base, "v1");
	assert.equal(fromTag.baseCommit, first);
	assert.equal(fs.readFileSync(path.join(fromTag.worktree, "a.txt"), "utf8"), "one\n");
	sh(main, "checkout", "-q", "--detach", first);
	const detached = await resolveBase(main);
	assert.equal(detached.baseCommit, first);
	assert.equal(detached.base, first.slice(0, 12));
	await assert.rejects(createWorktree({ from: main, slug: "x", base: "no-such-branch" }), /Unknown base/);
});

test("createWorktree: refuses folders outside git and repositories without commits", async () => {
	const plain = path.join(tmp, String(++n), "plain");
	fs.mkdirSync(plain, { recursive: true });
	await assert.rejects(createWorktree({ from: plain, slug: "x" }), /not inside a git repository/);
	assert.equal(await mainRepoRoot(plain), undefined);
	const empty = path.join(tmp, String(++n), "empty");
	fs.mkdirSync(empty, { recursive: true });
	sh(empty, "init", "-q", "-b", "main");
	await assert.rejects(createWorktree({ from: empty, slug: "x" }), /no commits/);
});

// ---------- mapping ----------

test("findProject: worktrees map to the main repository, like git rev-parse --git-common-dir", async () => {
	const main = repo();
	const wt = await createWorktree({ from: main, slug: "map" });
	assert.deepEqual(findProject(main), { root: main, isRepo: true });
	assert.deepEqual(findProject(path.join(main, "sub")), { root: main, isRepo: true });
	const linked = findProject(path.join(wt.worktree, "sub"));
	assert.equal(linked.root, main);
	assert.equal(linked.isRepo, true);
	assert.equal(linked.worktree?.root, wt.worktree);
	assert.equal(linked.worktree && headOf(linked.worktree.gitDir), "omp/map");
	for (const dir of [main, path.join(main, "sub"), wt.worktree, path.join(wt.worktree, "sub")]) {
		assert.equal(await mainRepoRoot(dir), main, dir);
		assert.equal(findProject(dir).root, main, dir);
	}
	const plain = path.join(tmp, String(++n), "plain");
	fs.mkdirSync(plain, { recursive: true });
	assert.deepEqual(findProject(plain), { root: plain, isRepo: false });
});

test("findProject: a .git file without commondir (submodule) is its own project", () => {
	const dir = path.join(tmp, String(++n));
	const module = path.join(dir, "modules", "lib");
	const checkout = path.join(dir, "lib");
	fs.mkdirSync(module, { recursive: true });
	fs.mkdirSync(checkout);
	fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${path.relative(checkout, module)}\n`);
	assert.equal(linkedWorktreeAt(checkout), undefined);
	assert.deepEqual(findProject(checkout), { root: checkout, isRepo: true });
});

test("findProject: worktrees of a bare repository group under the bare directory", async () => {
	const source = repo();
	const bare = path.join(path.dirname(source), "bare.git");
	sh(path.dirname(source), "clone", "-q", "--bare", source, bare);
	const wt = await createWorktree({ from: bare, slug: "bare-task" });
	assert.equal(wt.mainRoot, bare);
	assert.equal(findProject(wt.worktree).root, bare);
	assert.equal(await mainRepoRoot(wt.worktree), bare);
});

test("headOf: branch name, or a short commit when detached", async () => {
	const main = repo();
	const wt = await createWorktree({ from: main, slug: "head" });
	const gitDir = findProject(wt.worktree).worktree?.gitDir ?? "";
	assert.equal(headOf(gitDir), "omp/head");
	sh(wt.worktree, "checkout", "-q", "--detach");
	assert.equal(headOf(gitDir), sh(main, "rev-parse", "HEAD").slice(0, 8));
	assert.equal(headOf(path.join(tmp, "missing")), undefined);
});

// ---------- comparing and merging ----------

test("parseNameStatus: plain, rename and copy records", () => {
	assert.deepEqual(parseNameStatus("M\0a.txt\0R100\0old name.ts\0new name.ts\0A\0x/y\0C75\0p\0q\0"), [
		{ status: "M", path: "a.txt" },
		{ status: "R", from: "old name.ts", path: "new name.ts" },
		{ status: "A", path: "x/y" },
		{ status: "C", from: "p", path: "q" },
	]);
	assert.deepEqual(parseNameStatus(""), []);
});

test("changedSince: commits, uncommitted edits, deletions, renames and untracked files vs the merge base", async () => {
	const main = repo();
	const wt = await createWorktree({ from: main, slug: "work" });
	commit(wt.worktree, "new.txt", "new\n");
	fs.renameSync(path.join(wt.worktree, "sub", "b.txt"), path.join(wt.worktree, "sub", "renamed.txt"));
	sh(wt.worktree, "add", "-A");
	sh(wt.worktree, "commit", "-q", "-m", "rename");
	fs.writeFileSync(path.join(wt.worktree, "a.txt"), "changed\n");
	fs.writeFileSync(path.join(wt.worktree, "loose file.md"), "untracked\n");
	fs.writeFileSync(path.join(wt.worktree, ".gitignore"), "*.log\n");
	fs.writeFileSync(path.join(wt.worktree, "ignored.log"), "x\n");
	// The base branch moving on must not show up as changes of the worktree branch.
	commit(main, "main-only.txt", "main\n");
	const rev = await diffBase(wt.worktree, wt);
	assert.equal(rev, wt.baseCommit);
	const files = await changedSince(wt.worktree, rev);
	assert.deepEqual(files, [
		{ status: "?", path: ".gitignore" },
		{ status: "M", path: "a.txt" },
		{ status: "?", path: "loose file.md" },
		{ status: "A", path: "new.txt" },
		{ status: "R", from: "sub/b.txt", path: "sub/renamed.txt" },
	]);
	assert.equal(await isDirty(wt.worktree), true);
	assert.equal(await isDirty(main), false);
});

test("diffBase: falls back to the recorded commit when the base branch is gone", async () => {
	const main = repo();
	sh(main, "branch", "feature");
	const wt = await createWorktree({ from: main, slug: "gone", base: "feature" });
	sh(main, "branch", "-D", "feature");
	assert.equal(await diffBase(wt.worktree, wt), wt.baseCommit);
	await assert.rejects(diffBase(wt.worktree, { base: "nope", baseCommit: "" }), /Cannot find the base/);
});

test("merge: ahead count, clean merge, and conflicts reported by conflictedFiles", async () => {
	const main = repo();
	const ok = await createWorktree({ from: main, slug: "ok" });
	const clash = await createWorktree({ from: main, slug: "clash" });
	assert.equal(await aheadCount(main, "main", ok.branch), 0);
	commit(ok.worktree, "feature.txt", "feature\n");
	commit(clash.worktree, "a.txt", "theirs\n");
	assert.equal(await aheadCount(main, "main", ok.branch), 1);
	sh(main, "merge", "--no-ff", "-q", "-m", "merge ok", ok.branch);
	assert.equal(await aheadCount(main, "main", ok.branch), 0);
	commit(main, "a.txt", "ours\n");
	assert.throws(() => sh(main, "merge", "--no-ff", "-q", "-m", "merge clash", clash.branch));
	assert.deepEqual(await conflictedFiles(main), ["a.txt"]);
	sh(main, "merge", "--abort");
	assert.deepEqual(await conflictedFiles(main), []);
	assert.equal(await isDirty(main, true), false);
});

// ---------- per-session metadata ----------

test("worktree.json: round trip in the session dir; missing or malformed files read as undefined", async () => {
	const main = repo();
	const wt = await createWorktree({ from: main, slug: "meta" });
	writeWorktreeInfo("s1", { ...wt, batch: "b1" });
	const stored = readWorktreeInfo("s1");
	assert.deepEqual(stored, { mainRoot: wt.mainRoot, worktree: wt.worktree, branch: wt.branch, base: wt.base, baseCommit: wt.baseCommit, createdAt: wt.createdAt, batch: "b1" });
	const file = path.join(tmp, "state", "sessions", "s1", "worktree.json");
	assert.ok(fs.existsSync(file));
	assert.equal(readWorktreeInfo("nope"), undefined);
	fs.writeFileSync(file, "{ torn");
	assert.equal(readWorktreeInfo("s1"), undefined);
	fs.writeFileSync(file, JSON.stringify({ mainRoot: 1 }));
	assert.equal(readWorktreeInfo("s1"), undefined);
});
