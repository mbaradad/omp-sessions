// Wire contract of the per-user `omp-sessions` server (`<root>/server.sock`, a named pipe on Windows):
// newline-delimited JSON. A client sends `ServerRequest`s and gets one `ServerResponse` per id;
// `subscribe` keeps the connection streaming `ServerEvent`s until the client disconnects.
// The CLI runs the same operations in-process (src/shared/control.ts) when no server is running.
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { OrgColor, Priority } from "./organize";
import type { PermissionMode } from "./permissions";
import { type QueueOp, type SessionMeta, type TaskQueue, stateRoot } from "./protocol";
import type { RemoteStatus } from "./remote";
import type { SchedulerConfig } from "./scheduler";

/** Board column of a session (kanban + `omp-sessions board`). */
export type Column = "waiting" | "working" | "input" | "idle" | "stopped";

export const COLUMNS: ReadonlyArray<{ id: Column; label: string }> = [
	{ id: "waiting", label: "Waiting" },
	{ id: "working", label: "Working" },
	{ id: "input", label: "Needs input" },
	{ id: "idle", label: "Idle" },
	{ id: "stopped", label: "Stopped" },
];

/** A session as listed by the server/CLI: meta plus queue, organization and scheduling state. */
export interface SessionInfo {
	meta: SessionMeta;
	column: Column;
	/** Queue summary from queue.json (meta.queue can be stale for stopped sessions). */
	queue: NonNullable<SessionMeta["queue"]>;
	priority: Priority;
	/** 0-based position in the scheduling order over all listed sessions. */
	order: number;
	group?: string;
	color?: OrgColor;
	archived?: boolean;
	tags?: string[];
	/**
	 * Waiting for a concurrency slot: `position` 1-based among all waiters. `launch`: a stopped
	 * session the server will start when a slot frees (no omp process meanwhile).
	 */
	waiting?: { position: number; since?: number; launch?: boolean };
}

export interface SchedulerStatus extends SchedulerConfig {
	/** Live slot leases (queued tasks running now). */
	running: number;
	/** Hosts waiting for a slot plus stopped sessions waiting to be launched. */
	waiting: number;
	/** The server is up (it launches stopped sessions; without it only running hosts take slots). */
	server: boolean;
}

export interface CreateArgs {
	cwd: string;
	title?: string;
	/** omp arguments (default: the extension's `omp.extraArgs` + project defaults). */
	ompArgs?: string[];
	/** `--model` shortcut, appended to ompArgs. */
	model?: string;
	/** Prompt sent once the host is up (starts the host now). */
	prompt?: string;
	/**
	 * Queue-only: the session is created stopped with this auto-run task in its queue; the
	 * scheduler (server) starts it when a slot is free. Without a server/limit it starts now.
	 */
	task?: string;
	/** Subtasks of `task`. */
	subtasks?: string[];
	/** Notes of `task` (omp gets them under the task title). */
	notes?: string;
	/** Queue-only: don't start `task` before this time (epoch ms); the server launches it then. */
	startAt?: number;
	priority?: Priority;
	/** Starting permission mode: appended as the `--approval-mode` launch flag. */
	mode?: PermissionMode;
	/** Session tags (organize.json), e.g. to link a session to the card or ticket it works on. */
	tags?: string[];
	/** Group name (organize.json); created when no group has that name. */
	group?: string;
}

export type OrganizeAction =
	| { action: "priority"; priority: Priority }
	| { action: "up" }
	| { action: "down" }
	| { action: "top" }
	| { action: "bottom" }
	| { action: "color"; color: OrgColor | null }
	| { action: "group"; name: string | null }
	| { action: "archive"; value: boolean };

/** Every operation: `args` in, `result` out. */
export interface ServerOps {
	ping: { args: Record<string, never>; result: { pid: number; version: string; root: string; startedAt: number } };
	list: { args: { all?: boolean }; result: SessionInfo[] };
	create: { args: CreateArgs; result: { id: string; started: boolean } };
	stop: { args: { id: string }; result: { stopped: boolean } };
	resume: { args: { id: string }; result: { started: boolean } };
	remove: { args: { id: string }; result: Record<string, never> };
	/** `mode`: what to do while omp is busy (default steer). */
	prompt: { args: { id: string; text: string; mode?: "steer" | "followUp" }; result: { sent: boolean } };
	abort: { args: { id: string }; result: { sent: boolean } };
	getQueue: { args: { id: string }; result: TaskQueue };
	queue: { args: { id: string; ops: QueueOp[] }; result: TaskQueue };
	organize: { args: { id: string } & OrganizeAction; result: { changed: boolean } };
	scheduler: { args: { set?: Partial<SchedulerConfig> }; result: SchedulerStatus };
	/** Re-reads remote.json, applies it to the HTTP listener and reports what it does. */
	remote: { args: Record<string, never>; result: RemoteStatus };
	/** Stops the server (sessions keep running). */
	shutdown: { args: Record<string, never>; result: Record<string, never> };
}

export type OpName = keyof ServerOps;

export interface ServerRequest {
	id: number;
	op: OpName | "subscribe";
	args?: unknown;
}

export type SubscribeArgs = { topic: "sessions" } | { topic: "events"; id: string };

export type ServerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export type ServerEvent =
	/** `subscribe sessions`: the full list whenever it changes. */
	| { id: number; event: "sessions"; sessions: SessionInfo[] }
	/** `subscribe events`: host messages of one session (snapshot first), omp frames included. */
	| { id: number; event: "host"; msg: unknown }
	| { id: number; event: "end"; reason: string };

export function serverSocketPath(): string {
	const tag = crypto.createHash("sha256").update(stateRoot()).digest("hex").slice(0, 16);
	// A fixed name, like server.sock: renamed, a running server would hide from the next version
	// during an upgrade (its pid file still blocks a second one). Not the command name.
	if (process.platform === "win32") return `\\\\.\\pipe\\omp-vs-${tag}`;
	const preferred = path.join(stateRoot(), "server.sock");
	// sun_path is ~104 bytes: deep state dirs fall back to a private tmp dir (like session hosts).
	if (Buffer.byteLength(preferred) < 100) return preferred;
	return path.join(os.tmpdir(), `ompv-${process.getuid?.() ?? "u"}`, `server-${tag}.sock`);
}

export function serverPidPath(): string {
	return path.join(stateRoot(), "server.pid");
}

export function serverLogPath(): string {
	return path.join(stateRoot(), "server.log");
}
