// Git operations of graph propagation (GRAPH-PROPAGATION.md): commit a task's work on its branch, seed
// a child branch from its parent, merge a parent's branch into a child's worktree (aborting cleanly on
// conflict). Every operation on one repo runs under that repo's lock. Never force, never rebase, never
// touch a branch outside the plan. Node-only.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export class GitError extends Error {
	constructor(
		message: string,
		readonly stderr: string,
	) {
		super(message);
	}
}

/** Runs git in `cwd`; resolves stdout (trimmed), rejects with GitError. */
export function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
		if (err) reject(new GitError(`git ${args.join(" ")}: ${(stderr || err.message).trim()}`, String(stderr)));
		else resolve(String(stdout).trim());
	});
	return promise;
}

const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier locked call on `repo` settled. */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(repo) ?? Promise.resolve();
	const next = prev.catch(() => undefined).then(fn);
	locks.set(
		repo,
		next.catch(() => undefined),
	);
	return next;
}

/** The repo's top-level folder for `dir`, undefined outside git. */
export async function gitRoot(dir: string): Promise<string | undefined> {
	try {
		return fs.realpathSync.native(await git(dir, ["rev-parse", "--show-toplevel"]));
	} catch {
		return undefined;
	}
}

export async function revParse(cwd: string, ref: string): Promise<string | undefined> {
	try {
		return await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	} catch {
		return undefined;
	}
}

/** Worktree path that has `branch` checked out, undefined when none has. */
export async function worktreeOf(repo: string, branch: string): Promise<string | undefined> {
	const out = await git(repo, ["worktree", "list", "--porcelain"]);
	let current: string | undefined;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
		else if (line === `branch refs/heads/${branch}` && current) return current;
	}
	return undefined;
}

export async function isAncestor(repo: string, ancestor: string, of: string): Promise<boolean> {
	try {
		await git(repo, ["merge-base", "--is-ancestor", ancestor, of]);
		return true;
	} catch {
		return false;
	}
}

/** `-c user.name/email` when the repo has no identity configured (isolated homes, CI). */
async function identity(cwd: string): Promise<string[]> {
	try {
		await git(cwd, ["config", "user.email"]);
		return [];
	} catch {
		return ["-c", "user.name=Switchyard", "-c", "user.email=switchyard@localhost"];
	}
}

/** Commits everything uncommitted in `worktree` (message + Switchyard-Task trailer); returns HEAD. */
export async function commitAll(worktree: string, title: string, taskId: string): Promise<{ head: string; committed: boolean }> {
	await git(worktree, ["add", "-A"]);
	const staged = await git(worktree, ["diff", "--cached", "--name-only"]);
	if (staged) await git(worktree, [...(await identity(worktree)), "commit", "-q", "--no-verify", "-m", `switchyard: ${title.slice(0, 200)}`, "-m", `Switchyard-Task: ${taskId}`]);
	return { head: await git(worktree, ["rev-parse", "HEAD"]), committed: !!staged };
}

/** Creates `branch` at `at` unless it exists already (then it is left alone). */
export async function ensureBranch(repo: string, branch: string, at: string): Promise<void> {
	if (await revParse(repo, `refs/heads/${branch}`)) return;
	await git(repo, ["branch", branch, at]);
}

export interface MergeResult {
	ok: boolean;
	head: string;
	/** Conflicted files (merge aborted). */
	conflicts?: string[];
}

/** Merges `ref` into the branch checked out in `worktree`; on conflict aborts, leaving no MERGE_HEAD. */
export async function merge(worktree: string, ref: string, message: string): Promise<MergeResult> {
	try {
		await git(worktree, [...(await identity(worktree)), "merge", "--no-ff", "--no-edit", "-m", message, ref]);
		return { ok: true, head: await git(worktree, ["rev-parse", "HEAD"]) };
	} catch (err) {
		const conflicts = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
		await abortMerge(worktree);
		if (!conflicts.length) throw err;
		return { ok: false, head: await git(worktree, ["rev-parse", "HEAD"]), conflicts };
	}
}

/** Aborts a merge in progress, if any. */
export async function abortMerge(worktree: string): Promise<void> {
	if (await revParse(worktree, "MERGE_HEAD")) await git(worktree, ["merge", "--abort"]);
}

export async function mergeInProgress(worktree: string): Promise<boolean> {
	return !!(await revParse(worktree, "MERGE_HEAD"));
}

/** Subjects and changed files between two commits (for the follow-up prompt). */
export async function changesBetween(repo: string, from: string | undefined, to: string): Promise<{ subjects: string[]; files: string[] }> {
	const range = from ? `${from}..${to}` : to;
	const subjects = (await git(repo, ["log", "--format=%s", "-n", "20", range]).catch(() => "")).split("\n").filter(Boolean);
	const files = from ? (await git(repo, ["diff", "--name-only", from, to]).catch(() => "")).split("\n").filter(Boolean) : [];
	return { subjects, files };
}

/**
 * Seeds `branch` for a task with several parents: at the first parent's head, then the other parents
 * merged in a temporary worktree (removed again, so AO can check the branch out). Returns the parents
 * whose merge conflicted (their merge is left to the child agent).
 */
export async function seedBranch(repo: string, branch: string, parents: readonly { branch: string; head: string }[], message: (parentBranch: string) => string): Promise<{ conflicts: Array<{ branch: string; files: string[] }> }> {
	const [first, ...rest] = parents;
	const existed = !!(await revParse(repo, `refs/heads/${branch}`));
	await ensureBranch(repo, branch, first.head);
	if (existed || !rest.length) return { conflicts: [] };
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-seed-"));
	fs.rmSync(tmp, { recursive: true, force: true });
	await git(repo, ["worktree", "add", "-q", tmp, branch]);
	const conflicts: Array<{ branch: string; files: string[] }> = [];
	try {
		for (const p of rest) {
			const res = await merge(tmp, p.head, message(p.branch));
			if (!res.ok) conflicts.push({ branch: p.branch, files: res.conflicts ?? [] });
		}
	} finally {
		await git(repo, ["worktree", "remove", "--force", tmp]).catch(() => fs.rmSync(tmp, { recursive: true, force: true }));
		await git(repo, ["worktree", "prune"]).catch(() => undefined);
	}
	return { conflicts };
}
