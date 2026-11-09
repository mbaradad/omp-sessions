// Folder → AO project (MAPPING.md D2). A session in a folder runs in the AO project whose path is
// that folder's git root; the first session in a repo registers it. A folder outside git has no
// project: the session is standalone (an AO scratch dir).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AoClient, AoProject } from "./client";

function git(cwd: string, ...args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function realpath(p: string): string {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return path.resolve(p);
	}
}

/** The git work tree root containing `dir`, or undefined outside git. */
export function gitRoot(dir: string): string | undefined {
	const root = git(dir, "rev-parse", "--show-toplevel");
	return root ? realpath(root) : undefined;
}

/**
 * The branch AO bases session worktrees on: the remote's default (`origin/HEAD`), else the checked-out
 * branch, else `main`. AO cannot resolve one in a repo without a remote, so a new project records it.
 */
export function gitDefaultBranch(root: string): string {
	const remoteHead = git(root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
	if (remoteHead) return remoteHead.replace(/^origin\//, "");
	const current = git(root, "symbolic-ref", "--quiet", "--short", "HEAD");
	return current ?? "main";
}

export interface AoProjectForFolderOptions {
	/** Register the repo as a project when none has its path. Default true. */
	create?: boolean;
	/** Display name of a created project (default: AO's, the folder name). */
	name?: string;
}

/** The AO project of `dir`'s git repo (registered on first use), or undefined when `dir` is outside git. */
export async function projectForFolder(client: AoClient, dir: string, options: AoProjectForFolderOptions = {}): Promise<AoProject | undefined> {
	const root = gitRoot(dir);
	if (!root) return undefined;
	const existing = (await client.listProjects()).find(p => realpath(p.path) === root);
	if (existing || options.create === false) return existing;
	const project = await client.addProject({ path: root, ...(options.name && { name: options.name }) });
	await client.setProjectConfig(project.id, { defaultBranch: gitDefaultBranch(root), worker: { agent: "omp" } });
	return (await client.listProjects()).find(p => p.id === project.id);
}
