// Which sessions a window lists (`switchyard.sessionScope`): those in its workspace folders, or every session on the
// machine. Pure path logic (no vscode import): unit-tested.
import * as path from "node:path";

export type SessionScope = "workspace" | "all";

export function isSessionScope(v: unknown): v is SessionScope {
	return v === "workspace" || v === "all";
}

/**
 * Whether one of `dirs` is one of `folders` or inside one: `/a/b` holds `/a/b/c` but not `/a/bc`. Windows paths
 * compare case-insensitively (path.win32.relative).
 */
export function withinAny(dirs: readonly string[], folders: readonly string[], platform: string = process.platform): boolean {
	const p = platform === "win32" ? path.win32 : path.posix;
	return dirs.some(dir =>
		folders.some(folder => {
			const rel = p.relative(folder, dir);
			return rel === "" || (rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
		}),
	);
}
