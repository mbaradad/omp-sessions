// Extension <-> webview postMessage contract.
import type { FileChange, OmpFrame, RunningTool, SessionMeta, UiRequest } from "./protocol";

export interface SlimState {
	model?: { provider: string; id: string; name?: string; contextWindow?: number; reasoning?: boolean };
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionName?: string;
	contextUsage?: { tokens: number; contextWindow: number; percent: number };
	queuedMessages?: { steering: string[]; followUp: string[] };
	todoPhases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
	[key: string]: unknown;
}

export interface SlashCommand {
	name: string;
	description?: string;
	input?: { hint?: string };
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
			connected: boolean;
			home: string;
	  }
	| { type: "event"; ev: OmpFrame }
	| { type: "state"; state: SlimState | null }
	| { type: "meta"; meta: SessionMeta }
	| { type: "change"; change: FileChange }
	| { type: "uiResolved"; id: string }
	| { type: "reset"; messages: unknown[]; state: SlimState | null }
	| { type: "connection"; connected: boolean }
	| { type: "pathsResolved"; reqId: number; resolved: Record<string, string> }
	| { type: "fileSuggestions"; reqId: number; files: string[] }
	| { type: "models"; models: Array<{ provider: string; id: string; name?: string }>; levels: string[] }
	| { type: "insertText"; text: string }
	| { type: "focusComposer" }
	| { type: "error"; message: string };

export type PanelCommand = "compact" | "newSession" | "stopSession" | "resumeSession" | "rename" | "sessionChanges" | "openLog";

export type FromWebview =
	| { type: "ready" }
	| { type: "prompt"; text: string }
	| { type: "abort" }
	| { type: "uiResponse"; res: { id: string; [k: string]: unknown } }
	| { type: "openFile"; path: string; line?: number; column?: number }
	| { type: "openDiff"; toolCallId: string; path?: string }
	| { type: "resolvePaths"; reqId: number; candidates: string[] }
	| { type: "suggestFiles"; reqId: number; query: string }
	| { type: "getModels" }
	| { type: "setModel"; provider: string; id: string }
	| { type: "setThinking"; level: string }
	| { type: "removeQueued"; text: string; queue: "steering" | "followUp" }
	| { type: "command"; name: PanelCommand }
	| { type: "openUrl"; url: string };
