// Plain-terminal rendering of AO conversations for `switchyard attach/tail`: messages and tool
// activity in sequence order, and a follower that prints only what changed between two snapshots
// (AO streams by rewriting the assistant message in place; its events only say "refetch").
import type { AoActivity, AoConversation, AoMessage } from "../ao/client";
import { c, oneLine, truncate } from "./term";

/** A timeline entry: a message or a tool activity, in conversation order. */
export type Item = { kind: "message"; m: AoMessage } | { kind: "activity"; a: AoActivity };

export function timeline(conversation: AoConversation): Item[] {
	const items: Item[] = [...conversation.messages.map(m => ({ kind: "message" as const, m })), ...conversation.activities.map(a => ({ kind: "activity" as const, a }))];
	return items.sort((x, y) => (x.kind === "message" ? x.m.sequence : x.a.sequence) - (y.kind === "message" ? y.m.sequence : y.a.sequence));
}

const USER = () => c.cyan(c.bold("›"));
const TOOL = () => c.dim("▸");

/** Lines for one tool activity as it starts (or as history); questions are the caller's (they get answered). */
export function activityLines(a: AoActivity, width: number): string[] {
	const failed = a.status === "failed";
	switch (a.activityKind) {
		case "command":
		case "file_change":
		case "mcp_tool":
			return [failed ? c.red(`  ✗ ${truncate(oneLine(a.summary), width - 4)}`) : `  ${TOOL()} ${c.dim(truncate(oneLine(a.summary), width - 4))}`];
		case "error":
			return [c.red(`  ✗ ${oneLine(a.summary)}`)];
		case "system":
			return [c.blue(`ⓘ ${oneLine(a.summary)}`)];
		default:
			return [];
	}
}

/** Lines for one whole message (history, `tail`). */
export function messageLines(m: AoMessage): string[] {
	const text = m.text.trim();
	if (!text) return [];
	return m.role === "user" ? [`${USER()} ${c.bold(text)}`] : text.split("\n");
}

export function itemLines(item: Item, width: number): string[] {
	return item.kind === "message" ? messageLines(item.m) : activityLines(item.a, width);
}

/**
 * Prints a conversation as it changes: new messages and activities once, the growing tail of a
 * streaming assistant message as it grows, and a tool that failed after it started.
 */
export class ConversationFollower {
	/** Characters of each message already printed. */
	private readonly printed = new Map<string, number>();
	private readonly activities = new Map<string, AoActivity["status"]>();
	/** The message whose text is being streamed on the current line(s). */
	private streaming: string | undefined;
	private midLine = false;

	constructor(
		/** Raw output sink (also for callers' own lines, after `endLine`). */
		readonly write: (s: string) => void,
		private readonly width: () => number,
		/** User prompts typed here are on screen already. */
		private readonly echoed: Set<string> = new Set(),
	) {}

	isMidLine(): boolean {
		return this.midLine;
	}

	endLine(): void {
		if (this.midLine) this.write("\n");
		this.midLine = false;
		this.streaming = undefined;
	}

	private line(s: string): void {
		this.endLine();
		this.write(`${s}\n`);
	}

	/** Marks everything in `conversation` as shown without printing it (history printed elsewhere, or skipped). */
	seen(conversation: AoConversation): void {
		for (const m of conversation.messages) this.printed.set(m.id, m.text.length);
		for (const a of conversation.activities) this.activities.set(a.id, a.status);
	}

	/** Prints what `conversation` adds to what was shown. */
	update(conversation: AoConversation): void {
		for (const item of timeline(conversation)) {
			if (item.kind === "activity") {
				const { a } = item;
				const before = this.activities.get(a.id);
				this.activities.set(a.id, a.status);
				if (before === undefined) for (const l of activityLines(a, this.width())) this.line(l);
				else if (a.status === "failed" && before !== "failed" && (a.activityKind === "command" || a.activityKind === "mcp_tool" || a.activityKind === "file_change")) this.line(c.red(`  ✗ ${truncate(oneLine(a.summary), this.width() - 4)}`));
				continue;
			}
			const { m } = item;
			const done = this.printed.get(m.id);
			if (m.role === "user") {
				if (done !== undefined) continue;
				this.printed.set(m.id, m.text.length);
				if (this.echoed.delete(m.text.trim())) continue;
				for (const l of messageLines(m)) this.line(l);
				continue;
			}
			if (done !== undefined && m.text.length <= done) {
				if (!m.streaming && this.streaming === m.id) this.endLine();
				continue;
			}
			const from = done ?? 0;
			// A message earlier than the one streaming now (rare): print its new text on its own line.
			if (this.streaming !== m.id) this.endLine();
			let chunk = m.text.slice(from);
			if (from === 0) chunk = chunk.replace(/^\s+/, "");
			this.printed.set(m.id, m.text.length);
			if (!chunk) continue;
			this.write(chunk);
			this.midLine = !chunk.endsWith("\n");
			this.streaming = m.id;
			if (!m.streaming) this.endLine();
		}
	}
}
