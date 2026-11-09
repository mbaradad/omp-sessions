// Wire contracts shared by the session host, the VS Code extension, and the webview.
// Host <-> extension: newline-delimited JSON over a per-session Unix socket.
// Extension <-> webview: VS Code postMessage.

import * as os from "node:os";
import * as path from "node:path";
import type { PermissionMode } from "./permissions";

export type SessionStatus = "starting" | "idle" | "working" | "waiting" | "stopped";

/** How a child task's worktree stands against a parent's changes (GRAPH-PROPAGATION.md rule 7); one per graph edge. */
export type SyncState = "in-sync" | "pending" | "merged" | "resolving" | "conflict" | "upstream-changed";

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
	/** Earlier omp transcripts of this session (a fresh-context task or /new switched files), oldest first. */
	ompSessionFiles?: string[];
	ompSessionId?: string;
	model?: string;
	exitCode?: number | null;
	exitReason?: string;
	/** Number of distinct files the agent changed in this session. */
	changedFiles: number;
	/** Last assistant text (truncated), for tree tooltips. */
	lastText?: string;
	/** Model cost (USD) of this session's transcripts: main agent, subagents and side calls (src/shared/cost.ts). */
	cost?: number;
	/** Task queue summary for tree badges. `waiting`: the next task waits for a global concurrency slot
	 * (`position` 1-based among waiting sessions, `since` epoch ms). `interrupted`: pending tasks a host
	 * crash or reboot cut short (see QueueTask.interrupted). */
	queue?: { pending: number; running: number; done: number; total: number; autoRun: boolean; startAt?: number; interrupted?: number; waiting?: { position: number; since: number }; /** Failed tasks (requeue). */ failed?: number; /** Marked completed (the planner's lane.complete, every lane of the session); `completedAt` when (0 = unknown). */ completed?: boolean; completedAt?: number; /** Sessions whose queues must finish first (dependencies); `blockedBy`: the unfinished ones. */ after?: string[]; blockedBy?: string[]; /** Worst sync state over the incoming graph edges, and the parent sessions in that state (propagation). */ sync?: { state: SyncState; parents: string[]; /** Worst state of each parent session's edges that are not in sync (the board graph colours its arrows with it). */ edges?: Record<string, SyncState>; /** Files of the merge conflicts behind `state`. */ files?: string[] } };
	/** omp's own todo plan (phases → tasks), mirrored for the Tasks view. */
	plan?: Array<{ name: string; tasks: Array<{ content: string; status: string; blocker?: string }> }>;
	/** Extension version whose host.js runs this session (absent: hosts that predate the field). */
	hostVersion?: string;
	/** host.js running this session. */
	hostPath?: string;
	/** Set while omp reports it cannot use any model (no provider logged in, missing API key). */
	authProblem?: string;
	/** Who started this host when not a person (e.g. "scheduler": the omp-sessions server ran its queue). */
	launchedBy?: string;
	/** Clients attached right now that are people (chat panels, `omp-sessions attach`), not the omp-sessions server. */
	viewers?: number;
	/** Last time a person prompted, steered, aborted or answered a dialog in this session (epoch ms). */
	userActiveAt?: number;
	/** How the host answers omp's tool-approval prompts (absent: hosts that predate permission modes). */
	permissionMode?: PermissionMode;
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
	/** Final assistant text when the task finished, or the error that stopped it. */
	summary?: string;
	/** How the host runs this task; absent = session defaults, one attempt, no time limit. */
	options?: QueueTaskOptions;
	/** Failed attempts of the current run (auto-retry counter); reset when the task is re-queued. */
	attempts?: number;
	/** Wall time spent running (all attempts of the current run). */
	durationMs?: number;
	/** Model cost (USD) of the current run, subagents and side calls included (src/shared/cost.ts). */
	cost?: number;
	/**
	 * Epoch ms when the host died (crash, reboot) while this task ran: it went back to pending and
	 * the queue stopped (auto-run off), because interrupted tasks never rerun unattended. Cleared
	 * when the task runs again.
	 */
	interrupted?: number;
}

export interface QueueTaskOptions {
	/** `provider/modelId` to switch to for this task; the previous model is restored afterwards. */
	model?: string;
	/** Thinking level for this task; restored afterwards. */
	thinking?: string;
	/** Start the task in a new omp session (clean context); the chat transcript continues there. */
	freshContext?: boolean;
	/** Automatic retries after a failure or timeout (with backoff). */
	retries?: number;
	/** Abort the task (→ failed) when it runs longer than this. */
	timeoutMinutes?: number;
}

export interface TaskQueue {
	tasks: QueueTask[];
	/** When on, the host feeds the next pending task to omp whenever the session is idle. */
	autoRun: boolean;
	/** Epoch ms at which the host arms autoRun by itself (cleared when it fires or the queue is started/paused). */
	startAt?: number;
}

export type QueueOp =
	| { op: "add"; title: string; notes?: string; subtasks?: Array<string | { title: string; done?: boolean }>; index?: number; options?: QueueTaskOptions; done?: boolean }
	| { op: "update"; id: string; title?: string; notes?: string; status?: QueueTaskStatus }
	| { op: "remove"; id: string }
	| { op: "move"; id: string; index: number }
	| { op: "addSubtask"; id: string; title: string }
	| { op: "updateSubtask"; id: string; subtaskId: string; title?: string; done?: boolean }
	| { op: "removeSubtask"; id: string; subtaskId: string }
	| { op: "moveSubtask"; id: string; subtaskId: string; index: number }
	| { op: "run"; id?: string }
	| { op: "autoRun"; value: boolean }
	| { op: "clearDone" }
	/** Replaces the task's options (normalized; empty clears them). */
	| { op: "setOptions"; id: string; options: QueueTaskOptions }
	/** Inserts a pending copy (title, notes, subtasks unchecked, options) right after the task. */
	| { op: "duplicate"; id: string }
	/** Every failed task back to pending. */
	| { op: "retryFailed" }
	/** Start the queue at this time (epoch ms); null cancels. */
	| { op: "schedule"; at: number | null };

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
	/** Switch the permission mode; applies to pending approval prompts too. */
	| { t: "mode"; mode: PermissionMode }
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
