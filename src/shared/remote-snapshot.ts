// Session snapshots and host messages sized for remote clients (phones on mobile data): the last
// messages only, long tool output and file contents clipped, frames nobody renders dropped.
// Stopped sessions get a snapshot rebuilt from omp's transcript file. Node-only.
import { readTranscriptText } from "./transcript-files";
import { slimFrame, slimMessage, slimRunningTool } from "../ext/slim";
import { isRecord } from "./bridge";
import type { HostToClient, SessionMeta } from "./protocol";

type Snapshot = Extract<HostToClient, { t: "snapshot" }>;

/** Messages a remote snapshot keeps (the newest). */
export const REMOTE_MESSAGES = 80;
/** Tool output text a remote client gets per block (the webview gets more). */
const MAX_TOOL_TEXT = 4000;

/** What remote clients get instead of a host snapshot: no commands/changes lists, last messages only. */
export interface RemoteSnapshot {
	t: "snapshot";
	meta: SessionMeta;
	messages: unknown[];
	/** Messages before the kept ones. */
	omitted: number;
	inflight: { messageId: string; message: unknown } | null;
	runningTools: Snapshot["runningTools"];
	pendingUi: Snapshot["pendingUi"];
	state: unknown;
	queue?: Snapshot["queue"];
}

/** Transcript entries of an omp session file (a stopped session's history). */
export function transcriptMessages(file: string | undefined): unknown[] {
	if (!file) return [];
	const text = readTranscriptText(file);
	const out: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line.includes('"message"')) continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (entry && typeof entry === "object" && "message" in entry && entry.message && typeof entry.message === "object") out.push(entry.message);
		} catch {
			/* torn line */
		}
	}
	return out;
}

/** `holder` (a tool result or toolResult message) with its text blocks clipped for phones. */
function clipToolText(holder: unknown): unknown {
	if (!isRecord(holder) || !Array.isArray(holder.content)) return holder;
	const content = holder.content.map(b => {
		if (!isRecord(b) || b.type !== "text" || typeof b.text !== "string" || b.text.length <= MAX_TOOL_TEXT) return b;
		return { ...b, text: `${b.text.slice(0, MAX_TOOL_TEXT)}\n… [${b.text.length - MAX_TOOL_TEXT} chars hidden]` };
	});
	return { ...holder, content };
}

/** slimMessage plus tighter tool output (phones show a preview). */
function phoneMessage(message: unknown, live = false): unknown {
	const m = slimMessage(message, live);
	return isRecord(m) && m.role === "toolResult" ? clipToolText(m) : m;
}

function lastMessages(messages: readonly unknown[], max: number): { messages: unknown[]; omitted: number } {
	const kept = messages.slice(-max);
	return { messages: kept.map(m => phoneMessage(m)), omitted: messages.length - kept.length };
}

export function slimSnapshot(s: Snapshot, max = REMOTE_MESSAGES): RemoteSnapshot {
	return {
		t: "snapshot",
		meta: s.meta,
		...lastMessages(s.messages, max),
		inflight: s.inflight ? { messageId: s.inflight.messageId, message: phoneMessage(s.inflight.message, true) } : null,
		runningTools: s.runningTools.map(slimRunningTool),
		pendingUi: s.pendingUi,
		state: s.state,
		...(s.queue ? { queue: s.queue } : {}),
	};
}

/** Snapshot of a stopped session: its transcript, nothing in flight. */
export function stoppedSnapshot(meta: SessionMeta, max = REMOTE_MESSAGES): RemoteSnapshot {
	return { t: "snapshot", meta, ...lastMessages(transcriptMessages(meta.ompSessionFile), max), inflight: null, runningTools: [], pendingUi: [], state: null };
}

/** A host message for remote clients; undefined for ones they never need. */
export function slimHostMessage(msg: HostToClient, max = REMOTE_MESSAGES): RemoteSnapshot | HostToClient | undefined {
	switch (msg.t) {
		case "snapshot":
			return slimSnapshot(msg, max);
		case "event": {
			const ev = slimFrame(msg.ev);
			if (!ev) return undefined;
			if ((ev.type === "message_start" || ev.type === "message_update" || ev.type === "message_end") && isRecord(ev.message) && ev.message.role === "toolResult") {
				return { t: "event", ev: { ...ev, message: clipToolText(ev.message) } };
			}
			if (ev.type === "tool_execution_end") return { t: "event", ev: { ...ev, result: clipToolText(ev.result) } };
			if (ev.type === "tool_execution_update") return { t: "event", ev: { ...ev, partialResult: clipToolText(ev.partialResult) } };
			return { t: "event", ev };
		}
		case "reset": {
			const { messages } = lastMessages(msg.messages, max);
			return { t: "reset", messages, state: msg.state };
		}
		case "change":
			return undefined;
		default:
			return msg;
	}
}
