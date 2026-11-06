// Wire contracts shared by the session host, the VS Code extension, and the webview.
// Host <-> extension: newline-delimited JSON over a per-session Unix socket.
// Extension <-> webview: VS Code postMessage.

import * as os from "node:os";
import * as path from "node:path";

export type SessionStatus = "starting" | "idle" | "working" | "waiting" | "stopped";

export interface SessionMeta {
	id: string;
	cwd: string;
	title: string;
	status: SessionStatus;
	pid: number;
	ompPid?: number;
	socket: string;
	createdAt: number;
	updatedAt: number;
	ompSessionFile?: string;
	ompSessionId?: string;
	model?: string;
	exitCode?: number | null;
	exitReason?: string;
	/** Number of distinct files the agent changed in this session. */
	changedFiles: number;
	/** Last assistant text (truncated), for tree tooltips. */
	lastText?: string;
	/** Accumulated model cost (USD) of assistant turns seen by this host. */
	cost?: number;
	/** Task queue summary for tree badges. */
	queue?: { pending: number; running: number; done: number; total: number; autoRun: boolean };
	/** omp's own todo plan (phases → tasks), mirrored for the Tasks view. */
	plan?: Array<{ name: string; tasks: Array<{ content: string; status: string; blocker?: string }> }>;
}

/** One file touched by one tool call. `before`/`after` are blob hashes; null = file absent. */
export interface FileChangeEntry {
	path: string;
	op: "create" | "update" | "delete";
	before: string | null;
	after: string | null;
}

export interface FileChange {
	toolCallId: string;
	toolName: string;
	timestamp: number;
	files: FileChangeEntry[];
}

export const EMPTY_BLOB = "empty";

// ---- task queue (owned by the host, so it keeps running while VS Code is away) ----
export type QueueTaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface QueueSubtask {
	id: string;
	title: string;
	done: boolean;
}

export interface QueueTask {
	id: string;
	title: string;
	notes?: string;
	subtasks: QueueSubtask[];
	status: QueueTaskStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Last assistant text when the task finished, or the error that stopped it. */
	summary?: string;
}

export interface TaskQueue {
	tasks: QueueTask[];
	/** When on, the host feeds the next pending task to omp whenever the session is idle. */
	autoRun: boolean;
}

export type QueueOp =
	| { op: "add"; title: string; notes?: string; subtasks?: string[]; index?: number }
	| { op: "update"; id: string; title?: string; notes?: string; status?: QueueTaskStatus }
	| { op: "remove"; id: string }
	| { op: "move"; id: string; index: number }
	| { op: "addSubtask"; id: string; title: string }
	| { op: "updateSubtask"; id: string; subtaskId: string; title?: string; done?: boolean }
	| { op: "removeSubtask"; id: string; subtaskId: string }
	| { op: "moveSubtask"; id: string; subtaskId: string; index: number }
	| { op: "run"; id?: string }
	| { op: "autoRun"; value: boolean }
	| { op: "clearDone" };

// ---- host -> client ----
export type HostToClient =
	| {
			t: "snapshot";
			meta: SessionMeta;
			messages: unknown[];
			inflight: { messageId: string; message: unknown } | null;
			runningTools: RunningTool[];
			pendingUi: UiRequest[];
			state: unknown;
			commands: unknown[];
			changes: FileChange[];
			queue?: TaskQueue;
	  }
	| { t: "event"; ev: OmpFrame }
	| { t: "response"; res: OmpFrame }
	| { t: "meta"; meta: SessionMeta }
	| { t: "change"; change: FileChange }
	| { t: "ui_resolved"; id: string }
	| { t: "reset"; messages: unknown[]; state: unknown }
	| { t: "state"; state: unknown }
	| { t: "queue"; queue: TaskQueue };

export interface RunningTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
}

export interface UiRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	[key: string]: unknown;
}

// ---- client -> host ----
export type ClientToHost =
	| { t: "hello"; client: string }
	| { t: "rpc"; cmd: { id?: string; type: string; [k: string]: unknown } }
	| { t: "ui_response"; res: { id: string; [k: string]: unknown } }
	| { t: "rename"; title: string }
	/** Persist an extension-generated notice into the session timeline (shown again after reloads). */
	| { t: "note"; level: "info" | "warning" | "error"; message: string; markdown?: boolean }
	| { t: "queue"; ops: QueueOp[] }
	| { t: "stop" };

/** UI request methods that need an answer from the user. */
export const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };

/** One JSONL frame written by `omp --mode rpc-ui`; shape varies by `type`. */
export interface OmpFrame {
	type: string;
	[key: string]: unknown;
}

export function stateRoot(): string {
	return process.env.OMP_VSCODE_HOME || path.join(os.homedir(), ".omp", "vscode");
}

export function sessionsRoot(): string {
	return path.join(stateRoot(), "sessions");
}

export function sessionDir(id: string): string {
	return path.join(sessionsRoot(), id);
}

export function blobPath(sessionId: string, hash: string): string {
	return path.join(sessionDir(sessionId), "blobs", hash);
}
