// Recent project folders: where sessions ran (and their git roots), newest first. Feeds the phone's
// new-session picker, `omp-sessions projects` and agents choosing where to start a session. Node-only.
import * as fs from "node:fs";
import * as path from "node:path";
import { findProject } from "../ext/worktree-git";
import { listMetas } from "./launch";

export interface RecentProject {
	path: string;
	name: string;
	/** Latest activity of a session there (epoch ms). */
	lastUsed: number;
	sessions: number;
}

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function recentProjects(limit = 50): RecentProject[] {
	const byPath = new Map<string, RecentProject>();
	const add = (dir: string, at: number) => {
		const p = byPath.get(dir) ?? { path: dir, name: path.basename(dir) || dir, lastUsed: 0, sessions: 0 };
		p.lastUsed = Math.max(p.lastUsed, at);
		p.sessions++;
		byPath.set(dir, p);
	};
	for (const meta of listMetas()) {
		add(meta.cwd, meta.updatedAt);
		const root = findProject(meta.cwd).root;
		if (root !== meta.cwd) add(root, meta.updatedAt);
	}
	return [...byPath.values()]
		.filter(p => isDir(p.path))
		.sort((a, b) => b.lastUsed - a.lastUsed)
		.slice(0, limit);
}
