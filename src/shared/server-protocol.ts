// Wire contract of the per-user `omp-sessions` server (`<root>/server.sock`, a named pipe on Windows):
// newline-delimited JSON. A client sends `ServerRequest`s and gets one `ServerResponse` per id;
// `subscribe` keeps the connection streaming `ServerEvent`s until the client disconnects.
// The CLI runs the same operations in-process (src/shared/control.ts) when no server is running.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OrgColor, Priority } from "./organize";
import type { PermissionMode } from "./permissions";
import { type QueueOp, type SessionMeta, type TaskQueue, stateRoot } from "./protocol";
import type { ListFilter } from "./list-filter";
import type { RemoteStatus } from "./remote";
import type { MachineStatus } from "./server-status";
import type { AgentState } from "./session-report";
import type { SchedulerConfig } from "./scheduler";

/** Board column of a session (kanban + `omp-sessions board`). `scheduled`: pending tasks wait for a start time. */
export type Column = "waiting" | "scheduled" | "working" | "input" | "idle" | "stopped";

export const COLUMNS: ReadonlyArray<{ id: Column; label: string }> = [
	{ id: "waiting", label: "Waiting" },
	{ id: "scheduled", label: "Scheduled" },
	{ id: "working", label: "Working" },
	{ id: "input", label: "Needs input" },
	{ id: "idle", label: "Idle" },
	{ id: "stopped", label: "Stopped" },
];

/** A session as listed by the server/CLI: meta plus queue, organization and scheduling state. */
export interface SessionInfo {
	meta: SessionMeta;
	column: Column;
	/** What the session is doing for agents and scripts (session-report.ts agentState). */
	state: AgentState;
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
	/** Sessions whose pending tasks wait for a scheduled start time. */
	scheduled: number;
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
	/** `all`: archived sessions too; the filters narrow the list (`omp-sessions ls --project …`). */
	list: { args: { all?: boolean } & ListFilter; result: SessionInfo[] };
	create: { args: CreateArgs; result: { id: string; started: boolean } };
	/**
	 * Stops a running session. Either way, queued work the server would start on its own (auto-run,
	 * a scheduled start) is paused (`unqueued`), so a stopped session stays stopped.
	 */
	stop: { args: { id: string }; result: { stopped: boolean; unqueued?: boolean } };
	resume: { args: { id: string }; result: { started: boolean } };
	remove: { args: { id: string }; result: Record<string, never> };
	/** `mode`: what to do while omp is busy (default followUp). */
	prompt: { args: { id: string; text: string; mode?: "steer" | "followUp" }; result: { sent: boolean } };
	abort: { args: { id: string }; result: { sent: boolean } };
	getQueue: { args: { id: string }; result: TaskQueue };
	queue: { args: { id: string; ops: QueueOp[] }; result: TaskQueue };
	organize: { args: { id: string } & OrganizeAction; result: { changed: boolean } };
	scheduler: { args: { set?: Partial<SchedulerConfig> }; result: SchedulerStatus };
	/** Re-reads remote.json, applies it to the HTTP listener and reports what it does. */
	remote: { args: Record<string, never>; result: RemoteStatus };
	/** The machine overview (`omp-sessions status`, `GET /api/status`). */
	status: { args: Record<string, never>; result: MachineStatus };
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

/**
 * `<tmp>/ompv-<uid>`: where Unix sockets go when their normal path exceeds sun_path (~104 bytes).
 * Created 0700; an existing one must be a real folder (no symlink) owned by this user with no
 * group/other access, else this throws: another local user who made it first could swap our sockets.
 */
export function privateSocketDir(): string {
	const dir = path.join(os.tmpdir(), `ompv-${process.getuid?.() ?? "u"}`);
	try {
		fs.mkdirSync(dir, { mode: 0o700 });
	} catch (err) {
		if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
	}
	const st = fs.lstatSync(dir);
	const uid = process.getuid?.();
	const problem = !st.isDirectory() ? "is not a folder (or is a symlink)" : uid !== undefined && st.uid !== uid ? `belongs to another user (uid ${st.uid})` : (st.mode & 0o077) !== 0 ? `is accessible to other users (mode ${(st.mode & 0o777).toString(8)})` : undefined;
	if (problem) throw new Error(`unsafe socket folder: ${dir} ${problem}; remove it, or set OMP_VSCODE_HOME or TMPDIR to a shorter path`);
	return dir;
}

/**
 * A fresh, unguessable Windows pipe name (`prefix-<32 hex>`), made at every start. Pipe names are
 * global and listable by any local user: a fixed name could be created first by another user (after
 * a reboot or a stop) and receive our prompts. Whoever needs the name reads it from a user-only file
 * (session meta for hosts, `server.pipe` for the server).
 */
export function randomPipeName(prefix: string): string {
	return `\\\\.\\pipe\\${prefix}-${crypto.randomBytes(16).toString("hex")}`;
}

function rootTag(): string {
	return crypto.createHash("sha256").update(stateRoot()).digest("hex").slice(0, 16);
}

/** `<root>/server.pipe`: the pipe the running Windows server listens on (it writes it once listening, removes it on exit). */
export function serverPipeFile(): string {
	return path.join(stateRoot(), "server.pipe");
}

const SERVER_PIPE = /^\\\\\.\\pipe\\omp-sessions-[0-9a-f]{32}$/;

/** Where the server listens: the fixed Unix socket, or a fresh random pipe on Windows (recordServerPipe once listening). */
export function serverListenPath(): string {
	if (process.platform === "win32") return randomPipeName("omp-sessions");
	// server.sock keeps a fixed name: renamed, a running server would hide from the next version
	// during an upgrade (its pid file still blocks a second one).
	const preferred = path.join(stateRoot(), "server.sock");
	// sun_path is ~104 bytes: deep state dirs fall back to a private tmp dir (like session hosts).
	if (Buffer.byteLength(preferred) < 100) return preferred;
	return path.join(privateSocketDir(), `server-${rootTag()}.sock`);
}

/** Where clients find the server: its Unix socket, or the pipe the Windows server recorded (undefined: none recorded, so none runs). */
export function serverSocketPath(): string | undefined {
	if (process.platform !== "win32") return serverListenPath();
	try {
		const name = fs.readFileSync(serverPipeFile(), "utf8").trim();
		return SERVER_PIPE.test(name) ? name : undefined;
	} catch {
		return undefined;
	}
}

/** Windows: records the pipe this server listens on, atomically and readable by this user only. */
export function recordServerPipe(name: string): void {
	const file = serverPipeFile();
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, name, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Windows: forgets the recorded pipe when it is still `name` (a successor's record stays). */
export function forgetServerPipe(name: string): void {
	if (serverSocketPath() === name) fs.rmSync(serverPipeFile(), { force: true });
}

/** The guessable fixed Windows pipe of servers before 0.6: a new server stops one still running there. */
export function legacyServerPipe(): string | undefined {
	return process.platform === "win32" ? `\\\\.\\pipe\\omp-vs-${rootTag()}` : undefined;
}

export function serverPidPath(): string {
	return path.join(stateRoot(), "server.pid");
}

export function serverLogPath(): string {
	return path.join(stateRoot(), "server.log");
}
