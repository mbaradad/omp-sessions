// Git plumbing for worktree sessions (no `vscode` import, so it is unit-testable): naming,
// worktree → main repository mapping, and the git commands the worktree commands run.
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sessionDir, stateRoot } from "../shared/protocol";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs git without a shell; never rejects (a missing git binary is a non-zero result). */
export function git(cwd: string, args: string[]): Promise<GitResult> {
	const { promise, resolve } = Promise.withResolvers<GitResult>();
	execFile(
		"git",
		args,
		{ cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
		(err, stdout, stderr) => {
			if (!err) return resolve({ code: 0, stdout, stderr });
			const code = typeof err.code === "number" ? err.code : 1;
			resolve({ code, stdout, stderr: stderr.trim() || err.message });
		},
	);
	return promise;
}

/** Like `git`, but throws with git's message on failure; returns trimmed stdout. */
export async function gitOk(cwd: string, args: string[]): Promise<string> {
	const res = await git(cwd, args);
	if (res.code !== 0) throw new Error(res.stderr.trim() || `git ${args[0]} failed (${res.code})`);
	return res.stdout.trim();
}

// ---------- naming ----------

/** Branch/folder-safe slug of a task description: lowercase ASCII words joined by `-`, ≤ 40 chars. */
export function slugify(text: string, max = 40): string {
	const words = text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	let slug = "";
	for (const w of words) {
		const next = slug ? `${slug}-${w}` : w;
		if (next.length > max) {
			if (!slug) slug = w.slice(0, max);
			break;
		}
		slug = next;
	}
	return slug || "task";
}

/** Session title from a task: its first line, shortened. */
export function taskTitle(task: string, max = 60): string {
	const line = task.trim().split("\n")[0].replace(/\s+/g, " ");
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export const BRANCH_PREFIX = "omp/";

/** `slug`, else `slug-2`, `slug-3`, … — the first candidate `taken` rejects not. */
export function firstFree(slug: string, taken: (candidate: string) => boolean, limit = 1000): string {
	for (let i = 1; i <= limit; i++) {
		const candidate = i === 1 ? slug : `${slug}-${i}`;
		if (!taken(candidate)) return candidate;
	}
	throw new Error(`No free name for ${slug}`);
}

/**
 * Folder that holds a repository's worktrees: `<parent>/<repo>.worktrees` next to the main
 * checkout, or — when that parent is not writable (repository at a filesystem root, read-only
 * mounts) — a per-repository folder under the extension's state directory.
 */
export function worktreesDir(mainRoot: string): string {
	const parent = path.dirname(mainRoot);
	const name = path.basename(mainRoot) || "repo";
	if (parent !== mainRoot) {
		try {
			fs.accessSync(parent, fs.constants.W_OK);
			return path.join(parent, `${name}.worktrees`);
		} catch {
			/* fall back below */
		}
	}
	const hash = crypto.createHash("sha1").update(mainRoot).digest("hex").slice(0, 8);
	return path.join(stateRoot(), "worktrees", `${name}-${hash}`);
}

// ---------- worktree → main repository (synchronous; used while rendering the tree) ----------

export interface ProjectInfo {
	/** Main repository root (for linked worktrees too), else the folder itself. */
	root: string;
	isRepo: boolean;
	/** Set when the folder is inside a linked worktree. */
	worktree?: { root: string; gitDir: string };
}

/**
 * The linked worktree whose root is `dir`, read from git's own files: `<dir>/.git` is a file
 * `gitdir: <main>/.git/worktrees/<name>`, and that directory's `commondir` points at the main
 * `.git` — exactly what `git rev-parse --git-common-dir` reports, without spawning git. A `.git`
 * file without `commondir` (a submodule) is not a worktree.
 */
export function linkedWorktreeAt(dir: string): { mainRoot: string; gitDir: string } | undefined {
	let text: string;
	try {
		text = fs.readFileSync(path.join(dir, ".git"), "utf8");
	} catch {
		return undefined; // a directory (main checkout) or nothing
	}
	const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
	if (!m) return undefined;
	const gitDir = path.resolve(dir, m[1]);
	let common: string;
	try {
		common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
	} catch {
		return undefined;
	}
	// Non-bare repositories keep the common dir at `<root>/.git`; bare ones are the root.
	const mainRoot = path.basename(common) === ".git" ? path.dirname(common) : common;
	return { mainRoot, gitDir };
}

/** Project a folder belongs to: the enclosing git repository (its main checkout for worktrees), else the folder. */
export function findProject(cwd: string, stopAt = os.homedir()): ProjectInfo {
	let dir = cwd;
	while (dir !== path.dirname(dir) && dir !== stopAt) {
		if (fs.existsSync(path.join(dir, ".git"))) {
			const linked = linkedWorktreeAt(dir);
			return linked ? { root: linked.mainRoot, isRepo: true, worktree: { root: dir, gitDir: linked.gitDir } } : { root: dir, isRepo: true };
		}
		dir = path.dirname(dir);
	}
	return { root: cwd, isRepo: false };
}

/** Checked-out branch of a worktree from its `HEAD` file; a short commit id when detached. */
export function headOf(gitDir: string): string | undefined {
	try {
		const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
		const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return ref ? ref[1] : head.slice(0, 8) || undefined;
	} catch {
		return undefined;
	}
}

// ---------- repository queries ----------

/** Main repository root of any folder inside a repository or one of its worktrees (`git rev-parse --git-common-dir`). */
export async function mainRepoRoot(cwd: string): Promise<string | undefined> {
	const res = await git(cwd, ["rev-parse", "--git-common-dir"]);
	if (res.code !== 0) return undefined;
	const common = path.resolve(cwd, res.stdout.trim());
	return path.basename(common) === ".git" ? path.dirname(common) : common;
}

/** Current branch name, undefined when detached (or not a repository). */
export async function currentBranch(cwd: string): Promise<string | undefined> {
	const res = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	return res.code === 0 ? res.stdout.trim() || undefined : undefined;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
	return (await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

/** Local branches, most recently committed first. */
export async function localBranches(cwd: string): Promise<string[]> {
	const res = await git(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]);
	return res.code === 0 ? res.stdout.split("\n").filter(Boolean) : [];
}

/** Uncommitted changes; untracked files count unless `trackedOnly`. */
export async function isDirty(cwd: string, trackedOnly = false): Promise<boolean> {
	const res = await git(cwd, ["status", "--porcelain", ...(trackedOnly ? ["--untracked-files=no"] : [])]);
	return res.code === 0 && res.stdout.trim() !== "";
}

// ---------- creating worktrees ----------

export interface WorktreeInfo {
	mainRoot: string;
	/** Worktree root folder. */
	worktree: string;
	branch: string;
	/** What the branch was created from (branch name or commit), shown to the user and diffed against. */
	base: string;
	/** Commit `base` pointed at when the worktree was created (fallback when `base` moved away or was deleted). */
	baseCommit: string;
	createdAt: number;
	/** Shared by the sessions of one best-of-N run. */
	batch?: string;
}

export interface CreatedWorktree extends WorktreeInfo {
	/** Folder to run omp in: the worktree, or the same subfolder the user picked in the main checkout. */
	cwd: string;
}

/** Base to branch from: the given ref, else the current branch of `cwd`, else its detached commit. */
export async function resolveBase(cwd: string, base?: string): Promise<{ base: string; baseCommit: string }> {
	const name = base?.trim() || (await currentBranch(cwd)) || "HEAD";
	const res = await git(cwd, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
	if (res.code !== 0) {
		const unborn = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).code !== 0;
		throw new Error(unborn ? "The repository has no commits yet; commit something first." : `Unknown base branch or commit: ${name}`);
	}
	const baseCommit = res.stdout.trim();
	return { base: name === "HEAD" ? baseCommit.slice(0, 12) : name, baseCommit };
}

/**
 * `git worktree add -b omp/<slug> <repo>.worktrees/<slug> <base>`, suffixing the slug while the
 * branch or folder already exists. `from` may be any folder inside the repository or one of its
 * worktrees; the returned `cwd` keeps its position relative to the checkout root.
 */
export async function createWorktree(opts: { from: string; slug: string; base?: string; baseCommit?: string }): Promise<CreatedWorktree> {
	const mainRoot = await mainRepoRoot(opts.from);
	if (!mainRoot) throw new Error(`${opts.from} is not inside a git repository.`);
	const top = (await git(opts.from, ["rev-parse", "--show-toplevel"])).stdout.trim();
	const { base, baseCommit } = opts.baseCommit ? { base: opts.base ?? opts.baseCommit, baseCommit: opts.baseCommit } : await resolveBase(opts.from, opts.base);
	const parent = worktreesDir(mainRoot);
	fs.mkdirSync(parent, { recursive: true });
	const branches = new Set((await git(mainRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout.split("\n").filter(Boolean));
	const slug = firstFree(opts.slug, s => branches.has(`${BRANCH_PREFIX}${s}`) || fs.existsSync(path.join(parent, s)));
	const branch = `${BRANCH_PREFIX}${slug}`;
	const worktree = path.join(parent, slug);
	await gitOk(mainRoot, ["worktree", "add", "--no-track", "-b", branch, worktree, baseCommit]);
	const rel = top ? path.relative(top, opts.from) : "";
	const sub = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join(worktree, rel) : worktree;
	return { mainRoot, worktree, branch, base, baseCommit, createdAt: Date.now(), cwd: fs.existsSync(sub) ? sub : worktree };
}

// ---------- comparing ----------

export interface ChangedFile {
	/** git status letter: A, M, D, R, C, T, U, or `?` for untracked. */
	status: string;
	/** Path relative to the worktree root (forward slashes). */
	path: string;
	/** Path before a rename/copy. */
	from?: string;
}

/** Commit to diff against: the merge base of `base` (else `baseCommit`) and the worktree's HEAD. */
export async function diffBase(worktree: string, info: Pick<WorktreeInfo, "base" | "baseCommit">): Promise<string> {
	for (const rev of [info.base, info.baseCommit]) {
		if (!rev) continue;
		const res = await git(worktree, ["merge-base", rev, "HEAD"]);
		if (res.code === 0) return res.stdout.trim();
	}
	throw new Error(`Cannot find the base (${info.base}) of this worktree.`);
}

/** Parses `git diff --name-status -z` output. */
export function parseNameStatus(out: string): ChangedFile[] {
	const parts = out.split("\0");
	const files: ChangedFile[] = [];
	for (let i = 0; i + 1 < parts.length; ) {
		const code = parts[i++];
		if (!code) continue;
		const status = code[0];
		if (status === "R" || status === "C") {
			const from = parts[i++];
			files.push({ status, from, path: parts[i++] });
		} else files.push({ status, path: parts[i++] });
	}
	return files;
}

/** Everything the worktree changed since `rev`: commits on the branch, uncommitted edits and untracked files. */
export async function changedSince(worktree: string, rev: string): Promise<ChangedFile[]> {
	const tracked = parseNameStatus(await gitOk(worktree, ["-c", "core.quotepath=off", "diff", "--name-status", "-z", "-M", rev, "--"]));
	const untracked = (await gitOk(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
	return [...tracked, ...untracked.map(p => ({ status: "?", path: p }))].sort((a, b) => a.path.localeCompare(b.path));
}

/** Number of commits on `branch` that `into` does not have. */
export async function aheadCount(cwd: string, into: string, branch: string): Promise<number> {
	const res = await git(cwd, ["rev-list", "--count", `${into}..${branch}`]);
	return res.code === 0 ? Number(res.stdout.trim()) || 0 : 0;
}

/** Files with unresolved merge conflicts. */
export async function conflictedFiles(cwd: string): Promise<string[]> {
	const res = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
	return res.code === 0 ? res.stdout.split("\n").filter(Boolean) : [];
}

// ---------- per-session metadata ----------

const WORKTREE_FILE = "worktree.json";

function isWorktreeInfo(v: unknown): v is WorktreeInfo {
	if (typeof v !== "object" || v === null) return false;
	const r: Record<string, unknown> = { ...v };
	return (
		typeof r.mainRoot === "string" &&
		typeof r.worktree === "string" &&
		typeof r.branch === "string" &&
		typeof r.base === "string" &&
		typeof r.baseCommit === "string" &&
		typeof r.createdAt === "number" &&
		(r.batch === undefined || typeof r.batch === "string")
	);
}

export function readWorktreeInfo(sessionId: string): WorktreeInfo | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(sessionDir(sessionId), WORKTREE_FILE), "utf8"));
		return isWorktreeInfo(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function writeWorktreeInfo(sessionId: string, info: WorktreeInfo): void {
	const { mainRoot, worktree, branch, base, baseCommit, createdAt, batch } = info;
	fs.mkdirSync(sessionDir(sessionId), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(sessionDir(sessionId), WORKTREE_FILE), JSON.stringify({ mainRoot, worktree, branch, base, baseCommit, createdAt, batch }, null, 1));
}
