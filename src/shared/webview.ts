// Extension <-> webview postMessage contract.
import type { PlaySoundMessage } from "./completion-sound";
import type { FileDiff } from "./diff";
import type { HermesOrigin } from "./hermes-origin";
import type { PermissionMode } from "./permissions";
import type { FileChange, OmpFrame, QueueOp, RunningTool, SessionMeta, TaskQueue, UiRequest } from "./protocol";

export interface SlimState {
	model?: { provider: string; id: string; name?: string; contextWindow?: number; reasoning?: boolean };
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionName?: string;
	fastModeEnabled?: boolean;
	autoCompactionEnabled?: boolean;
	contextUsage?: { tokens: number; contextWindow: number; percent: number };
	/** Provider quota windows of the session's model (the planner's `omp usage` reading), `resetsAtSec` in epoch seconds. */
	usageWindows?: Array<{ window: string; usedPercent: number; resetsAtSec?: number }>;
	queuedMessages?: { steering: string[]; followUp: string[] };
	todoPhases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
	goal?: { objective?: string; status?: string; [key: string]: unknown } | null;
	[key: string]: unknown;
}

export interface SlashCommand {
	name: string;
	description?: string;
	input?: { hint?: string };
	/** Implemented by the VS Code extension rather than omp's RPC command table. */
	local?: boolean;
}

/** Per-file structured diffs keyed by absolute path. */
export type DiffsByPath = Record<string, FileDiff>;

export interface ImageAttachment {
	data: string;
	mimeType: string;
	name?: string;
}

/**
 * Non-image attachment (PDF, docs, archives, code…). Pasted/dropped files carry `data` and are
 * written next to the session on the remote; files picked from the remote disk carry `path`.
 */
export interface FileAttachment {
	name: string;
	mimeType?: string;
	size?: number;
	data?: string;
	path?: string;
}

export type ToWebview =
	| {
			type: "init";
			meta: SessionMeta;
			messages: unknown[];
			inflight: { messageId: string; message: unknown } | null;
			runningTools: RunningTool[];
			pendingUi: UiRequest[];
			state: SlimState | null;
			commands: SlashCommand[];
			changes: FileChange[];
			diffs: Record<string, DiffsByPath>;
			connected: boolean;
			home: string;
			queue: TaskQueue | null;
	  }
	| { type: "event"; ev: OmpFrame }
	| { type: "state"; state: SlimState | null }
	| { type: "meta"; meta: SessionMeta }
	| { type: "change"; change: FileChange; diffs: DiffsByPath }
	| { type: "diffs"; toolCallId: string; diffs: DiffsByPath }
	| { type: "uiResolved"; id: string }
	| { type: "reset"; messages: unknown[]; state: SlimState | null; diffs: Record<string, DiffsByPath> }
	| { type: "connection"; connected: boolean }
	| { type: "pathsResolved"; reqId: number; resolved: Record<string, string> }
	/** Lazy chat symbol link resolution (inline code like `FooBar`, `foo.bar()`). */
	| { type: "symbolInfo"; name: string; found: boolean; location?: string; kind?: string; hover?: string }
	| { type: "fileSuggestions"; reqId: number; files: string[] }
	/** `starred`: `provider/id` keys the person pinned to the top of the picker. */
	| { type: "models"; models: Array<{ provider: string; id: string; name?: string }>; levels: string[]; starred: string[] }
	| { type: "insertText"; text: string }
	| { type: "focusComposer" }
	| { type: "bashResult"; command: string; output: string; exitCode?: number; cancelled?: boolean }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string; markdown?: boolean }
	| { type: "attachFiles"; images: ImageAttachment[]; files: FileAttachment[] }
	| { type: "commands"; commands: SlashCommand[] }
	| { type: "queue"; queue: TaskQueue }
	/** `switchyard.chat.*` settings the webview applies (sent after init and on change). */
	| { type: "chatConfig"; toolCardsCollapsed: boolean }
	/** Checkpoint redo stack of this chat (non-empty after restoring a checkpoint). */
	| { type: "checkpoints"; redo: number }
	/** Where the session came from in Hermes (its tags); null for sessions Hermes didn't start. */
	| { type: "origin"; hermes: HermesOrigin | null }
	/** Empty the composer when it still holds exactly `text` (a redo makes the restored prompt stale). */
	| { type: "clearComposerIf"; text: string }
	| { type: "error"; message: string }
	/** Play a session cue (src/ext/sounds.ts picks one open omp webview). */
	| PlaySoundMessage;

export type PanelCommand =
	| "compact"
	| "newSession"
	| "stopSession"
	| "resumeSession"
	| "rename"
	| "sessionChanges"
	| "reviewChanges"
	| "exportMarkdownCopy"
	| "exportMarkdownSave"
	| "stats"
	| "copyLast"
	| "login"
	| "logout"
	| "help"
	| "settings"
	| "undoTurn"
	| "redoTurn"
	| "openTui"
	| "openHermesCard"
	| "showHermesCard";

export type FromWebview =
	| { type: "ready" }
	| { type: "prompt"; text: string; images?: ImageAttachment[]; files?: FileAttachment[] }
	| { type: "abort" }
	| { type: "uiResponse"; res: { id: string; [k: string]: unknown } }
	| { type: "openFile"; path: string; line?: number; column?: number }
	| { type: "openDiff"; toolCallId: string; path?: string }
	| { type: "openLink"; url: string }
	| { type: "resolvePaths"; reqId: number; candidates: string[] }
	| { type: "symbolInfo"; name: string }
	| { type: "openSymbol"; name: string }
	| { type: "suggestFiles"; reqId: number; query: string }
	| { type: "getModels" }
	| { type: "setModel"; provider: string; id: string }
	| { type: "setThinking"; level: string }
	| { type: "removeQueued"; text: string; queue: "steering" | "followUp" }
	| { type: "command"; name: PanelCommand }
	| { type: "copy"; text: string }
	| { type: "pickFiles" }
	/** Insert prompt snippet `name` (without the `p:` prefix) with its placeholders expanded. */
	| { type: "expandSnippet"; name: string }
	/** Rewind the conversation to the user message with this text (edit & resend). */
	| { type: "rewindTo"; text: string; turnId?: string }
	/** Restore one file to its content before a given tool call. */
	| { type: "revertFile"; toolCallId: string; path: string }
	| { type: "queueOp"; ops: QueueOp[] }
	| { type: "focusTasks" }
	| { type: "setMode"; mode: PermissionMode }
	/** Restore the checkpoint before the prompt with this text: files and conversation. */
	| { type: "restoreCheckpoint"; text: string; turnId?: string }
	| { type: "starModel"; provider: string; id: string };
