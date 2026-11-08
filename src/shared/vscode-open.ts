// "Open in VS Code" from outside VS Code (the Hermes page, `omp-sessions vscode`): a session opens in the
// VS Code window last used on this machine, which may be a Remote-SSH window on another computer.
//
// - Every window records itself in vscode-window.json when it gains focus: its remote authority
//   ("" for a local window) and URI scheme. That is enough to build a link the user's computer opens.
// - The requester writes vscode-open.json (session + time) and hands the user that link.
// - Remote window: the link opens the session's folder (`vscode://vscode-remote/<authority><cwd>`),
//   which focuses the window holding it or opens one; that window takes the request when it gains
//   focus or activates. Local window: the extension's own URI handler opens the session directly.
import * as fs from "node:fs";
import * as path from "node:path";
import { stateRoot } from "./protocol";

/** A request older than this is ignored: the user gave up, or no window took it. */
export const OPEN_REQUEST_TTL_MS = 2 * 60_000;
export const EXTENSION_ID = "mbaradad.omp-sessions";

export interface VscodeWindow {
	/** Remote authority of the window (`ssh-remote+ws`, `wsl+Ubuntu`); "" for a local window. */
	authority: string;
	/** `vscode`, `vscode-insiders`, … (vscode.env.uriScheme). */
	scheme: string;
	at: number;
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
		return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function recordWindow(authority: string, scheme: string, now = Date.now()): void {
	writeJson(windowFile(), { authority, scheme, at: now } satisfies VscodeWindow);
}

export function readWindow(): VscodeWindow | undefined {
	const v = readJson(windowFile());
	if (!v || typeof v.authority !== "string" || typeof v.at !== "number") return undefined;
	return { authority: v.authority, scheme: typeof v.scheme === "string" && /^[a-z][a-z0-9+.-]*$/.test(v.scheme) ? v.scheme : "vscode", at: v.at };
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

/** Folder path as a URI path: POSIX as is, `C:\x` as `/C:/x`; each segment percent-encoded. */
function uriPath(cwd: string): string {
	const p = /^[A-Za-z]:[\\/]/.test(cwd) ? `/${cwd.replace(/\\/g, "/")}` : cwd;
	return p
		.split("/")
		.map(s => encodeURIComponent(s).replace(/%3A/gi, ":"))
		.join("/");
}

/** The link that opens `session` in `win` (the window last used here; none: a local VS Code). */
export function vscodeLink(session: { id: string; cwd: string }, win: VscodeWindow | undefined): string {
	const scheme = win?.scheme ?? "vscode";
	if (win?.authority) return `${scheme}://vscode-remote/${win.authority}${uriPath(session.cwd)}`;
	return `${scheme}://${EXTENSION_ID}/open?session=${encodeURIComponent(session.id)}`;
}
