// Filters of the `list` server op (`omp-sessions ls --project/--cwd/--group/--tag/--state`). Node-only.
import * as path from "node:path";
import { findProject } from "../ext/worktree-git";
import type { SessionInfo } from "./server-protocol";
import { SETTLED_STATES, agentState } from "./session-report";

export interface ListFilter {
	/** Folder name or path of the session's folder or of its project root (as `projects` lists them). */
	project?: string;
	/** Absolute folder: sessions in it or below it. */
	cwd?: string;
	/** Group name (case-insensitive). */
	group?: string;
	/** Every one of these tags. */
	tags?: string[];
	/** Agent state (`show`: `working`, `needs_input`, `stopped`, …); other names match the board column or session status (`input`). */
	state?: string;
}

function inside(dir: string, root: string): boolean {
	const rel = path.relative(root, dir);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function hasFilter(f: ListFilter): boolean {
	return !!(f.project || f.cwd || f.group || f.tags?.length || f.state);
}

/** The session's folder or its project root (git checkout) is `project`: a folder name or a path. */
function inProject(cwd: string, project: string, roots: Map<string, string>): boolean {
	let root = roots.get(cwd);
	if (root === undefined) roots.set(cwd, (root = findProject(cwd).root));
	const want = path.isAbsolute(project) ? path.resolve(project) : undefined;
	return [cwd, root].some(dir => (want ? path.resolve(dir) === want : path.basename(dir) === project));
}

export function filterSessions(infos: SessionInfo[], f: ListFilter): SessionInfo[] {
	if (!hasFilter(f)) return infos;
	const group = f.group?.toLowerCase();
	const state = f.state?.toLowerCase().replace("-", "_");
	// A state name matches the state only: every scheduled, queued or interrupted session is `stopped` by status.
	const isState = state !== undefined && Object.hasOwn(SETTLED_STATES, state);
	const roots = new Map<string, string>();
	return infos.filter(i => {
		const cwd = i.meta.cwd;
		if (f.project && !inProject(cwd, f.project, roots)) return false;
		if (f.cwd && !inside(path.resolve(cwd), path.resolve(f.cwd))) return false;
		if (group !== undefined && i.group?.toLowerCase() !== group) return false;
		if (f.tags?.length && !f.tags.every(t => i.tags?.includes(t))) return false;
		if (state && (isState ? agentState(i) !== state : i.column !== state && i.meta.status !== state)) return false;
		return true;
	});
}
