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

export function action(id: string, name: "prompt" | "abort" | "stop" | "resume" | "continue" | "mode" | "ui" | "vscode" | "model", body: Record<string, unknown> = {}): Promise<unknown> {
	return call("POST", `/api/sessions/${encodeURIComponent(id)}/${name}`, body);
}

/** What the phone shows of `GET /api/status` (the `omp-sessions status` overview). */
export interface MachineSummary {
	ok: boolean;
	problems: string[];
	version: string;
	startedAt?: number;
	byState: Record<string, number>;
	maxConcurrent: number;
	paused: boolean;
	pending: number;
}

export async function machineStatus(): Promise<MachineSummary | undefined> {
	const s = await call("GET", "/api/status");
	if (!isRecord(s) || !isRecord(s.server) || !isRecord(s.sessions) || !isRecord(s.scheduler) || !isRecord(s.tasks)) return undefined;
	const byState: Record<string, number> = {};
	if (isRecord(s.sessions.byState)) for (const [k, v] of Object.entries(s.sessions.byState)) if (typeof v === "number") byState[k] = v;
	return {
		ok: s.ok === true,
		problems: Array.isArray(s.problems) ? s.problems.filter((p): p is string => typeof p === "string") : [],
		version: str(s.server.version),
		startedAt: typeof s.server.startedAt === "number" ? s.server.startedAt : undefined,
		byState,
		maxConcurrent: typeof s.scheduler.maxConcurrent === "number" ? s.scheduler.maxConcurrent : 0,
		paused: s.scheduler.paused === true,
		pending: typeof s.tasks.pending === "number" ? s.tasks.pending : 0,
	};
}

export interface PhoneModel {
	selector: string;
	name: string;
	isDefault: boolean;
}

/** omp's models (GET /api/models), the omp Sessions default marked. */
export async function listModels(): Promise<PhoneModel[]> {
	const data = await call("GET", "/api/models");
	if (!isRecord(data) || !Array.isArray(data.models)) return [];
	return data.models.flatMap(m => (isRecord(m) && typeof m.selector === "string" ? [{ selector: m.selector, name: str(m.name) || m.selector, isDefault: m.default === true }] : []));
}
