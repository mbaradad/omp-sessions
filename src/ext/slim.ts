// Shrinks omp frames before they cross the (possibly remote) webview channel.
import type { OmpFrame } from "../shared/protocol";

const MAX_TEXT = 40_000;
const MAX_LIVE_TEXT = 12_000;
const MAX_DIFF = 80_000;
const MAX_PRIMITIVE_STRING = 4_000;

function rec(v: unknown): Record<string, unknown> | undefined {
	// JSON objects from omp frames; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function clip(text: string, max: number, tail = false): string {
	if (text.length <= max) return text;
	const dropped = text.length - max;
	return tail ? `… [${dropped} chars hidden]\n${text.slice(-max)}` : `${text.slice(0, max)}\n… [${dropped} chars hidden]`;
}

function slimDetails(details: unknown): Record<string, unknown> | undefined {
	const d = rec(details);
	if (!d) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(d)) {
		if (k === "oldText" || k === "newText") {
			out.hasTexts = true;
			continue;
		}
		if (k === "diff" && typeof v === "string") out.diff = clip(v, MAX_DIFF);
		else if (typeof v === "string") out[k] = clip(v, MAX_PRIMITIVE_STRING);
		else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
	}
	if (Array.isArray(d.perFileResults)) {
		out.perFileResults = d.perFileResults.map(f => {
			const r = rec(f) ?? {};
			return { path: r.path, op: r.op, firstChangedLine: r.firstChangedLine, diff: typeof r.diff === "string" ? clip(r.diff, MAX_DIFF / 4) : undefined };
		});
	}
	const source = rec(rec(d.meta)?.source);
	if (source && typeof source.value === "string") out.sourcePath = source.value;
	const diagnostics = rec(d.diagnostics);
	if (diagnostics && typeof diagnostics.summary === "string") out.diagnosticsSummary = diagnostics.summary;
	return out;
}

function slimContent(content: unknown, maxText: number, tail: boolean): unknown {
	if (typeof content === "string") return clip(content, maxText, tail);
	if (!Array.isArray(content)) return [];
	return content.map(block => {
		const b = rec(block);
		if (!b) return block;
		switch (b.type) {
			case "text":
				return { type: "text", text: clip(String(b.text ?? ""), maxText, tail) };
			case "thinking":
				return { type: "thinking", thinking: clip(String(b.thinking ?? ""), maxText) };
			case "toolCall":
				return { type: "toolCall", id: b.id, name: b.name, arguments: slimArgs(b.arguments), intent: b.intent };
			case "image":
				return { type: "image", mimeType: b.mimeType, data: typeof b.data === "string" && b.data.length < 2_000_000 ? b.data : undefined };
			default:
				return { type: b.type };
		}
	});
}

function slimArgs(args: unknown): unknown {
	const a = rec(args);
	if (!a) return args;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(a)) {
		out[k] = typeof v === "string" ? clip(v, MAX_TEXT) : v;
	}
	return out;
}

export function slimMessage(message: unknown, live = false): unknown {
	const m = rec(message);
	if (!m) return message;
	const out: Record<string, unknown> = {
		role: m.role,
		content: slimContent(m.content, live ? MAX_LIVE_TEXT : MAX_TEXT, false),
		timestamp: m.timestamp,
	};
	for (const k of ["stopReason", "errorMessage", "toolCallId", "toolName", "isError", "attribution", "turnId", "model", "customType", "display", "command", "output", "exitCode", "cancelled", "summary", "text", "record", "level", "message", "markdown"]) {
		const v = m[k];
		if (v !== undefined) out[k] = typeof v === "string" ? clip(v, MAX_TEXT) : v;
	}
	if (m.details !== undefined) out.details = slimDetails(m.details);
	const usage = rec(m.usage);
	const cost = rec(usage?.cost);
	if (usage) out.usage = { totalTokens: usage.totalTokens, cost: cost?.total };
	return out;
}

function slimResult(result: unknown, live: boolean): unknown {
	const r = rec(result);
	if (!r) return result;
	return { content: slimContent(r.content, live ? MAX_LIVE_TEXT : MAX_TEXT, live), details: slimDetails(r.details) };
}

/** Returns null for frames the webview never needs. */
export function slimFrame(ev: OmpFrame): OmpFrame | null {
	switch (ev.type) {
		case "message_start":
		case "message_update":
		case "message_end":
			return { type: ev.type, messageId: ev.messageId, message: slimMessage(ev.message, ev.type !== "message_end") };
		case "tool_execution_start":
			return { type: ev.type, toolCallId: ev.toolCallId, toolName: ev.toolName, args: slimArgs(ev.args), intent: ev.intent };
		case "tool_execution_update":
			return { type: ev.type, toolCallId: ev.toolCallId, toolName: ev.toolName, partialResult: slimResult(ev.partialResult, true) };
		case "tool_execution_end":
			return { type: ev.type, toolCallId: ev.toolCallId, toolName: ev.toolName, result: slimResult(ev.result, false), isError: ev.isError };
		case "turn_end":
		case "turn_start":
		case "advisor_cost_changed":
		case "available_commands_update":
		case "tool_stream_update":
			return null;
		default:
			return ev;
	}
}

export function slimRunningTool(t: { toolCallId: string; toolName: string; args: unknown; intent?: string; partialResult?: unknown }): {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
} {
	return { ...t, args: slimArgs(t.args), partialResult: t.partialResult === undefined ? undefined : slimResult(t.partialResult, true) };
}
