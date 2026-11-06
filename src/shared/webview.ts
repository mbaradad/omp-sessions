// Extension <-> webview postMessage contract.
import type { FileDiff } from "./diff";
import type { FileChange, OmpFrame, RunningTool, SessionMeta, UiRequest } from "./protocol";

export interface SlimState {
	model?: { provider: string; id: string; name?: string; contextWindow?: number; reasoning?: boolean };
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionName?: string;
	fastModeEnabled?: boolean;
	autoCompactionEnabled?: boolean;
	contextUsage?: { tokens: number; contextWindow: number; percent: number };
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
	| { type: "fileSuggestions"; reqId: number; files: string[] }
	| { type: "models"; models: Array<{ provider: string; id: string; name?: string }>; levels: string[] }
	| { type: "insertText"; text: string }
	| { type: "focusComposer" }
	| { type: "bashResult"; command: string; output: string; exitCode?: number; cancelled?: boolean }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string; markdown?: boolean }
	| { type: "attachFiles"; images: ImageAttachment[]; files: FileAttachment[] }
	| { type: "commands"; commands: SlashCommand[] }
	| { type: "error"; message: string };

export type PanelCommand =
	| "compact"
	| "newSession"
	| "newInPlace"
	| "stopSession"
	| "resumeSession"
	| "resumeTranscript"
	| "rename"
	| "sessionChanges"
	| "reviewChanges"
	| "openLog"
	| "fork"
	| "rewind"
	| "export"
	| "stats"
	| "copyLast"
	| "toggleFast"
	| "toggleAutoCompact"
	| "goal"
	| "login"
	| "logout"
	| "agents"
	| "help"
	| "settings";

export type FromWebview =
	| { type: "ready" }
	| { type: "prompt"; text: string; images?: ImageAttachment[]; files?: FileAttachment[] }
	| { type: "abort" }
	| { type: "uiResponse"; res: { id: string; [k: string]: unknown } }
	| { type: "openFile"; path: string; line?: number; column?: number }
	| { type: "openDiff"; toolCallId: string; path?: string }
	| { type: "openLink"; url: string }
	| { type: "resolvePaths"; reqId: number; candidates: string[] }
	| { type: "suggestFiles"; reqId: number; query: string }
	| { type: "getModels" }
	| { type: "setModel"; provider: string; id: string }
	| { type: "setThinking"; level: string }
	| { type: "removeQueued"; text: string; queue: "steering" | "followUp" }
	| { type: "command"; name: PanelCommand }
	| { type: "copy"; text: string }
	| { type: "pickFiles" }
	/** Rewind / fork the conversation at the user message with this text. */
	| { type: "rewindTo"; text: string }
	| { type: "forkFrom"; text: string }
	/** Restore one file to its content before a given tool call. */
	| { type: "revertFile"; toolCallId: string; path: string };
