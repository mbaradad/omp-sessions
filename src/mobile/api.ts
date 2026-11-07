// The phone app's side of the remote API (docs/REMOTE-API.md). The browser is paired once: the
// server sets an HttpOnly cookie, so this code never holds the token.
import type { PermissionMode } from "../shared/permissions";
import type { SessionMeta } from "../shared/protocol";
import type { SessionInfo } from "../shared/server-protocol";
import { isRecord, str } from "./dom";

/** The browser is not paired (or the token was rotated). */
export class AuthError extends Error {}

export async function call(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<unknown> {
	// Writes always carry a JSON body: the server refuses cookie-authenticated non-JSON posts.
	const init: RequestInit = method === "POST" ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) } : { method };
	const res = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
	let data: unknown;
	try {
		data = await res.json();
	} catch {
		data = undefined;
	}
	const error = isRecord(data) ? str(data.error) : "";
	if (res.status === 401) throw new AuthError(error || "not paired");
	if (!res.ok) throw new Error(error || `HTTP ${res.status}`);
	return data;
}

export function isSessionMeta(v: unknown): v is SessionMeta {
	return isRecord(v) && typeof v.id === "string" && typeof v.cwd === "string" && typeof v.status === "string";
}

export function isSessionInfo(v: unknown): v is SessionInfo {
	return isRecord(v) && isSessionMeta(v.meta) && typeof v.column === "string" && isRecord(v.queue);
}

export function sessionList(v: unknown): SessionInfo[] {
	return Array.isArray(v) ? v.filter(isSessionInfo) : [];
}

export async function listSessions(): Promise<SessionInfo[]> {
	return sessionList(await call("GET", "/api/sessions"));
}

export interface Project {
	path: string;
	name: string;
	lastUsed: number;
	sessions: number;
}

export async function listProjects(): Promise<Project[]> {
	const data = await call("GET", "/api/projects");
	if (!Array.isArray(data)) return [];
	return data.flatMap(p => (isRecord(p) && typeof p.path === "string" ? [{ path: p.path, name: str(p.name) || p.path, lastUsed: Number(p.lastUsed) || 0, sessions: Number(p.sessions) || 0 }] : []));
}

export async function pair(token: string): Promise<void> {
	await call("POST", "/api/pair", { token });
}

export async function createSession(args: { cwd: string; prompt?: string; task?: string; title?: string; mode?: PermissionMode }): Promise<string> {
	const data = await call("POST", "/api/sessions", args);
	if (!isRecord(data) || typeof data.id !== "string") throw new Error("unexpected answer from the server");
	return data.id;
}

export function action(id: string, name: "prompt" | "abort" | "stop" | "resume" | "mode" | "ui", body: Record<string, unknown> = {}): Promise<unknown> {
	return call("POST", `/api/sessions/${encodeURIComponent(id)}/${name}`, body);
}
