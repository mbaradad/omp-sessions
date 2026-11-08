// "Open in VS Code" from outside VS Code (the Hermes page, `omp-sessions vscode`): a session opens in a
// VS Code window on this machine, which may be a Remote-SSH window on another computer.
//
// - Every window records itself in vscode-window.json when it gains focus: its remote authority ("" for a
//   local window), URI scheme and open folders. One record per window, so windows of different remote
//   authorities (two computers connected to this machine) don't overwrite each other.
// - The requester picks a window (readWindow): one with the caller's authority when known (the extension
//   puts it in its terminals' environment as WINDOW_AUTHORITY_ENV), preferring one that has the session's
//   folder open, else the last used. It writes vscode-open.json (session + time) and hands the user a link.
// - Remote window: the link opens the folder holding the session (that window's workspace, else the
//   enclosing git checkout or worktree, else its cwd) over the authority, which focuses the window holding it
//   or opens one; that window takes the request when it gains focus or sees the session. Local window: the
//   extension's own URI handler opens the session directly.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "./bridge";
import { stateRoot } from "./protocol";

/** A request older than this is ignored: the user gave up, or no window took it. */
export const OPEN_REQUEST_TTL_MS = 2 * 60_000;
export const EXTENSION_ID = "mbaradad.omp-sessions";
/** Set in the extension's integrated terminals: the remote authority of their window ("" for a local one). */
export const WINDOW_AUTHORITY_ENV = "OMP_SESSIONS_VSCODE_AUTHORITY";
/** Windows kept in vscode-window.json; older records go first. */
const MAX_WINDOWS = 16;

/** What the URI handler and requests accept as a session id. */
export function isSessionId(s: string): boolean {
	return /^[A-Za-z0-9_-]{1,128}$/.test(s);
}

export interface VscodeWindow {
	/** VS Code's id of the window's session (vscode.env.sessionId); "" for a record from an older extension. */
	id: string;
	/** Remote authority of the window (`ssh-remote+ws`, `wsl+Ubuntu`); "" for a local window. */
	authority: string;
	/** `vscode`, `vscode-insiders`, … (vscode.env.uriScheme). */
	scheme: string;
	at: number;
	/** Folders open in the window, as paths on this machine. */
	folders: string[];
	/** The window's .code-workspace file, when it has one. */
	workspace?: string;
}

export interface OpenRequest {
	session: string;
	at: number;
}

export const OPEN_REQUEST_FILE = "vscode-open.json";
const windowFile = () => path.join(stateRoot(), "vscode-window.json");
const requestFile = () => path.join(stateRoot(), OPEN_REQUEST_FILE);

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
	fs.renameSync(tmp, file);
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return isRecord(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

function toWindow(v: unknown): VscodeWindow | undefined {
	if (!isRecord(v) || typeof v.authority !== "string" || typeof v.at !== "number") return undefined;
	return {
		id: typeof v.id === "string" ? v.id : "",
		authority: v.authority,
		scheme: typeof v.scheme === "string" && /^[a-z][a-z0-9+.-]*$/.test(v.scheme) ? v.scheme : "vscode",
		at: v.at,
		folders: Array.isArray(v.folders) ? v.folders.filter((f): f is string => typeof f === "string" && path.isAbsolute(f)) : [],
		...(typeof v.workspace === "string" && path.isAbsolute(v.workspace) ? { workspace: v.workspace } : {}),
	};
}

/** Recorded windows, last used first. Reads the single record older versions wrote too. */
export function readWindows(): VscodeWindow[] {
	const v = readJson(windowFile());
	if (!v) return [];
	const list = Array.isArray(v.windows) ? v.windows : [v];
	return list
		.map(toWindow)
		.filter((w): w is VscodeWindow => !!w)
		.sort((a, b) => b.at - a.at);
}

/** Records (or refreshes) a window as the last used one; drops a record from an older extension (no id). */
export function recordWindow(win: Omit<VscodeWindow, "at">, now = Date.now()): void {
	const others = readWindows().filter(w => w.id && w.id !== win.id);
	const windows = [{ ...win, at: now }, ...others].slice(0, MAX_WINDOWS);
	writeJson(windowFile(), { windows });
}

function within(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The innermost folder of `win` holding `cwd`. */
function folderHolding(win: VscodeWindow, cwd: string): string | undefined {
	return win.folders.filter(f => within(cwd, f)).sort((a, b) => b.length - a.length)[0];
}

/**
 * The window to open a session in: among windows with the caller's authority (`want.authority`, else
 * WINDOW_AUTHORITY_ENV; all windows when none has it), the last used one holding `want.cwd`, else the
 * last used one. Undefined when no window was recorded.
 */
export function readWindow(want: { authority?: string; cwd?: string } = {}, env: NodeJS.ProcessEnv = process.env): VscodeWindow | undefined {
	const all = readWindows();
	const authority = want.authority ?? env[WINDOW_AUTHORITY_ENV];
	const mine = authority === undefined ? [] : all.filter(w => w.authority === authority);
	const pool = mine.length ? mine : all;
	const cwd = want.cwd;
	return (cwd ? pool.find(w => folderHolding(w, cwd)) : undefined) ?? pool[0];
}

/** A remote authority as VS Code writes it (`ssh-remote+box`, `wsl+Ubuntu`, `dev-container+…`): kind, `+`, host; nothing a link could break on. */
export function isAuthority(s: string): boolean {
	return /^[a-z][a-z0-9-]*\+[^\s/\\?#%\u0000-\u001f\u007f]+$/i.test(s);
}

/**
 * readWindow, except that an explicit `want.authority` ("" for local) that no recorded window has still
 * gets a window to link over (`at` 0: never seen); VS Code opens one for it. Throws on an authority
 * isAuthority refuses.
 */
export function windowFor(want: { authority?: string; cwd?: string }, env: NodeJS.ProcessEnv = process.env): VscodeWindow | undefined {
	const { authority } = want;
	if (authority !== undefined && authority !== "" && !isAuthority(authority)) throw new Error(`not a VS Code remote authority (like ssh-remote+box or wsl+Ubuntu; "" for a local window): "${authority}"`);
	const win = readWindow(want, env);
	return authority === undefined || win?.authority === authority ? win : { id: "", authority, scheme: win?.scheme ?? "vscode", at: 0, folders: [] };
}

export function requestOpen(session: string, now = Date.now()): void {
	writeJson(requestFile(), { session, at: now } satisfies OpenRequest);
}

/**
 * The pending request's session when `has(session)` (this window can open it) and it is fresh; the
 * request is removed so only one window acts on it. A stale request is removed too.
 */
export function takeOpenRequest(has: (session: string) => boolean, now = Date.now()): string | undefined {
	const v = readJson(requestFile());
	if (!v || typeof v.session !== "string" || typeof v.at !== "number") return undefined;
	const fresh = now - v.at <= OPEN_REQUEST_TTL_MS && v.at - now <= OPEN_REQUEST_TTL_MS;
	if (fresh && !has(v.session)) return undefined;
	try {
		// Whoever unlinks it first acts on it.
		fs.unlinkSync(requestFile());
	} catch {
		return undefined;
	}
	return fresh ? v.session : undefined;
}

/** Drops the pending request when it is for `session` (opened another way, e.g. the URI handler). */
export function clearOpenRequest(session: string): void {
	if (readJson(requestFile())?.session !== session) return;
	try {
		fs.unlinkSync(requestFile());
	} catch {
		/* taken meanwhile */
	}
}

/** The git checkout or linked worktree holding `cwd` (nearest folder with a `.git`, below the home folder), else `cwd`. */
export function checkoutRoot(cwd: string, stopAt = os.homedir()): string {
	if (!path.isAbsolute(cwd)) return cwd;
	for (let dir = cwd; dir !== stopAt && path.dirname(dir) !== dir; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
	}
	return cwd;
}

/**
 * Folder path as a URI path, each segment percent-encoded: POSIX as is, `C:\x` as `/C:/x`, a UNC path
 * `\\server\share\x` as `//server/share/x` (what VS Code turns back into the UNC path on a Windows remote).
 */
export function uriPath(folder: string): string {
	const p = /^[A-Za-z]:[\\/]/.test(folder) ? `/${folder.replace(/\\/g, "/")}` : /^[\\/]{2}[^\\/]/.test(folder) ? folder.replace(/\\/g, "/") : folder;
	return p
		.split("/")
		.map(s => encodeURIComponent(s).replace(/%3A/gi, ":"))
		.join("/");
}

/** The folder `win` should open for `cwd`: its workspace when one of its folders holds `cwd`, else the checkout or worktree holding `cwd`. */
export function folderTarget(cwd: string, win: VscodeWindow | undefined): string {
	const held = win && folderHolding(win, cwd);
	return held ? (win.workspace ?? held) : checkoutRoot(cwd);
}

/**
 * The link that opens `session` in `win` (from readWindow; none: a local VS Code). A remote window gets the
 * folder to open (folderTarget) over its authority; a local one the extension's URI handler.
 */
export function vscodeLink(session: { id: string; cwd: string }, win: VscodeWindow | undefined): string {
	const scheme = win?.scheme ?? "vscode";
	if (win?.authority) return `${scheme}://vscode-remote/${win.authority}${uriPath(folderTarget(session.cwd, win))}`;
	return `${scheme}://${EXTENSION_ID}/open?session=${encodeURIComponent(session.id)}`;
}

/** Why `folder` can't be opened in VS Code (not an absolute path to an existing folder, control characters); undefined when it can. */
export function folderProblem(folder: string): string | undefined {
	if (/[\u0000-\u001f\u007f]/.test(folder)) return "the path contains control characters";
	if (!path.isAbsolute(folder)) return `not an absolute path: ${folder}`;
	try {
		if (!fs.statSync(folder).isDirectory()) return `not a folder: ${folder}`;
	} catch {
		return `no such folder: ${folder}`;
	}
	return undefined;
}

/**
 * The link that opens a project folder (no session) in VS Code: the checkout or worktree holding `folder`, or
 * `win`'s workspace when it already has it open, so VS Code focuses that window instead of opening another;
 * `exact`: `folder` itself. Remote window: `<scheme>://vscode-remote/<authority><path>`; local (or none
 * recorded): `<scheme>://file<path>`. Throws when folderProblem has an objection.
 */
export function vscodeFolderLink(folder: string, win: VscodeWindow | undefined, opts: { exact?: boolean } = {}): string {
	const problem = folderProblem(folder);
	if (problem) throw new Error(problem);
	const scheme = win?.scheme ?? "vscode";
	const target = uriPath(opts.exact ? folder : folderTarget(folder, win));
	return win?.authority ? `${scheme}://vscode-remote/${win.authority}${target}` : `${scheme}://file${target}`;
}
