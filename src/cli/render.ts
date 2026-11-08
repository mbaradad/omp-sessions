// Plain-terminal rendering of omp transcript messages and live events for `omp-sessions attach/tail`.
import { c, oneLine, truncate } from "./term";

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** One-line description of a tool call: the command, path or first string argument. */
export function toolSummary(name: string, args: unknown, width = 100): string {
	const a = rec(args);
	const pick = str(a.command) || str(a.path) || str(a.file_path) || str(a.pattern) || str(a.query) || str(a.url) || str(a.description) || str(Object.values(a).find(v => typeof v === "string"));
	return truncate(oneLine(`${name}${pick ? ` ${pick}` : ""}`), width);
}

/** Text of a message's content (string or blocks). */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(b => rec(b))
		.filter(b => b.type === "text")
		.map(b => str(b.text))
		.join("");
}

const USER = () => c.cyan(c.bold("›"));
const TOOL = () => c.dim("▸");

/** Lines for one transcript message (no trailing newline). */
export function renderMessage(raw: unknown, width = 100): string[] {
	const m = rec(raw);
	switch (m.role) {
		case "user": {
			const text = textOf(m.content).trim();
			return text ? [`${USER()} ${c.bold(text)}`] : [];
		}
		case "assistant": {
			const out: string[] = [];
			for (const block of Array.isArray(m.content) ? m.content : []) {
				const b = rec(block);
				if (b.type === "text" && str(b.text).trim()) out.push(str(b.text).trimEnd());
				else if (b.type === "toolCall") out.push(`  ${TOOL()} ${c.dim(toolSummary(str(b.name), b.arguments, width - 4))}`);
			}
			const error = str(m.errorMessage);
			if (error) out.push(c.red(`  ✗ ${oneLine(error)}`));
			return out;
		}
		case "toolResult":
			return m.isError ? [c.red(`  ✗ ${str(m.toolName)}: ${truncate(oneLine(textOf(m.content)), width - 8)}`)] : [];
		case "bashExecution":
			return [`${c.dim("$")} ${str(m.command)}`, ...str(m.output).trimEnd().split("\n").slice(-20).map(l => c.dim(l))];
		case "commandOutput":
			return str(m.text) ? [c.dim(str(m.text).trimEnd())] : [];
		case "notice": {
			const color = m.level === "error" ? c.red : m.level === "warning" ? c.yellow : c.blue;
			return [color(`ⓘ ${oneLine(str(m.message))}`)];
		}
		case "compactionSummary":
			return [c.dim("── context compacted ──")];
		default:
			return [];
	}
}

/**
 * Incremental renderer for live host events: streams assistant text deltas, prints tool calls
 * as they start and failed results as they end.
 */
export class LiveRenderer {
	/** Mid-line: assistant text was streamed without a final newline. */
	private midLine = false;
	private readonly toolNames = new Map<string, string>();

	constructor(
		/** Raw output sink (also for callers' own lines, after `endLine`). */
		readonly write: (s: string) => void,
		private readonly width: () => number,
	) {}

	private line(s: string): void {
		this.endLine();
		this.write(`${s}\n`);
	}

	isMidLine(): boolean {
		return this.midLine;
	}

	endLine(): void {
		if (this.midLine) this.write("\n");
		this.midLine = false;
	}

	message(raw: unknown): void {
		for (const l of renderMessage(raw, this.width())) this.line(l);
	}

	/** One omp event frame (`{t:"event"}` payload). */
	event(raw: unknown): void {
		const ev = rec(raw);
		switch (ev.type) {
			case "message_update": {
				const a = rec(ev.assistantMessageEvent);
				if (a.type === "text_delta" && str(a.delta)) {
					this.write(str(a.delta));
					this.midLine = !str(a.delta).endsWith("\n");
				}
				return;
			}
			case "message_end": {
				const m = rec(ev.message);
				if (m.role === "assistant") {
					this.endLine();
					const error = str(m.errorMessage);
					if (error) this.line(c.red(`  ✗ ${oneLine(error)}`));
				} else if (m.role !== "toolResult") this.message(m);
				return;
			}
			case "tool_execution_start": {
				const name = str(ev.toolName);
				this.toolNames.set(str(ev.toolCallId), name);
				this.line(`  ${TOOL()} ${c.dim(toolSummary(name, ev.args, this.width() - 4))}`);
				return;
			}
			case "tool_execution_end": {
				const name = this.toolNames.get(str(ev.toolCallId)) ?? str(ev.toolName);
				this.toolNames.delete(str(ev.toolCallId));
				if (ev.isError) this.line(c.red(`  ✗ ${name}: ${truncate(oneLine(textOf(rec(ev.result).content)), this.width() - 8)}`));
				return;
			}
			case "notice":
				this.message({ role: "notice", level: ev.level, message: ev.message });
				return;
			case "auto_retry_start":
				this.line(c.yellow(`ⓘ retrying: ${oneLine(str(ev.errorMessage))}`));
				return;
			case "command_output":
				if (str(ev.text)) this.line(c.dim(str(ev.text).trimEnd()));
				return;
		}
	}
}
