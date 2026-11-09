// Context @mentions in the chat composer (@selection, @file, @problems, @git, @terminal).
// The webview completes them; the extension expands them at send time into fenced blocks
// appended to the prompt. Pure: the VS Code side injects the providers.

export type MentionKind = "selection" | "file" | "problems" | "git" | "terminal";

export const CONTEXT_MENTIONS: ReadonlyArray<{ name: MentionKind; description: string }> = [
	{ name: "selection", description: "Selected text in the active editor (with path:lines)" },
	{ name: "file", description: "The active editor's file" },
	{ name: "problems", description: "Errors and warnings in the session folder" },
	{ name: "git", description: "Uncommitted changes (staged + unstaged diff)" },
	{ name: "terminal", description: "Terminal selection, else recent terminal output" },
];

/** What a provider returns: content to fence, or why it is unavailable. */
export interface MentionContent {
	/** Short description shown after the mention, e.g. `src/a.ts:10-20`. */
	label: string;
	body: string;
	/** Fence language. */
	lang?: string;
	/** Keep the end rather than the start when truncating (logs, terminal output). */
	tail?: boolean;
}
export type MentionResult = MentionContent | { unavailable: string };
export type MentionProviders = Partial<Record<MentionKind, () => Promise<MentionResult>>>;

/** Per-mention character caps; the whole expansion is also limited to TOTAL_CAP. */
export const MENTION_CAPS: Record<MentionKind, number> = { selection: 30_000, file: 60_000, problems: 12_000, git: 60_000, terminal: 16_000 };
export const TOTAL_CAP = 150_000;

/** First line of the appended context section; the webview splits user messages on it. */
export const CONTEXT_MARKER = "**Context from VS Code**";
const SECTION_SEP = `\n\n---\n${CONTEXT_MARKER}`;

const NAMES = CONTEXT_MENTIONS.map(m => m.name).join("|");

/** Blanks out fenced and inline code so mentions inside code are not expanded. */
function blankCode(text: string): string {
	const blank = (s: string) => s.replace(/[^\n]/g, " ");
	return text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

/** Context mentions in `text` (unique, in order of first use), ignoring code spans and blocks. */
export function findMentions(text: string): MentionKind[] {
	const out: MentionKind[] = [];
	const re = new RegExp(`(^|[\\s(\\[{,;])@(${NAMES})(?![\\w/-]|\\.\\w)`, "g");
	for (const m of blankCode(text).matchAll(re)) {
		const kind = m[2] as MentionKind;
		if (!out.includes(kind)) out.push(kind);
	}
	return out;
}

/** Fence that cannot be closed by backticks inside `body`. */
export function fence(body: string, lang = ""): string {
	let longest = 0;
	for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}${lang}\n${body}${body.endsWith("\n") || !body ? "" : "\n"}${ticks}`;
}

/**
 * Cuts `text` to at most `max` characters on a line boundary (keeping the start, or the end
 * with `tail`). Returns the note describing what was dropped, if anything.
 */
export function capText(text: string, max: number, tail = false): { text: string; note?: string } {
	if (text.length <= max) return { text };
	const lines = text.split("\n");
	const kept: string[] = [];
	let size = 0;
	const order = tail ? [...lines].reverse() : lines;
	for (const line of order) {
		if (size + line.length + 1 > max) break;
		kept.push(line);
		size += line.length + 1;
	}
	// A single line longer than the cap: keep a slice of it.
	if (!kept.length) kept.push(tail ? (lines[lines.length - 1] ?? "").slice(-max) : (lines[0] ?? "").slice(0, max));
	if (tail) kept.reverse();
	const out = kept.join("\n");
	const omittedLines = lines.length - kept.length;
	const omittedChars = text.length - out.length;
	const where = tail ? "earlier" : "more";
	const note = omittedLines > 0 ? `truncated: ${omittedLines} ${where} line${omittedLines === 1 ? "" : "s"} omitted` : `truncated: ${omittedChars} chars omitted`;
	return { text: out, note };
}

export interface Expansion {
	/** Prompt to send: the user's text plus the context section (unchanged when nothing matched). */
	text: string;
	/** Mentions that produced content. */
	expanded: MentionKind[];
	/** Mentions that could not be expanded, with the reason. */
	unavailable: Array<{ kind: MentionKind; reason: string }>;
}

/** Appends a fenced block for every context mention in `text`. The user's text is kept as typed. */
export async function expandMentions(text: string, providers: MentionProviders, caps: Record<MentionKind, number> = MENTION_CAPS, totalCap = TOTAL_CAP): Promise<Expansion> {
	const kinds = findMentions(text);
	const result: Expansion = { text, expanded: [], unavailable: [] };
	if (!kinds.length) return result;
	const blocks: string[] = [];
	let budget = totalCap;
	for (const kind of kinds) {
		const provider = providers[kind];
		let res: MentionResult;
		try {
			res = provider ? await provider() : { unavailable: "not supported here" };
		} catch (e) {
			res = { unavailable: e instanceof Error ? e.message : String(e) };
		}
		if ("unavailable" in res) {
			result.unavailable.push({ kind, reason: res.unavailable });
			blocks.push(`**@${kind}** · _not available: ${res.unavailable}_`);
			continue;
		}
		const limit = Math.max(0, Math.min(caps[kind], budget));
		const capped = limit > 0 ? capText(res.body, limit, res.tail) : { text: "", note: "truncated: context budget used up by earlier mentions" };
		budget -= capped.text.length;
		result.expanded.push(kind);
		blocks.push(`**@${kind}** · ${res.label}\n${fence(capped.text, res.lang ?? "")}${capped.note ? `\n_(${capped.note})_` : ""}`);
	}
	result.text = appendContext(text, "expanded from the @mentions above", blocks);
	return result;
}

/** Adds `blocks` to the context section of a prompt, opening the section (with `note`) when the prompt has none yet. */
export function appendContext(text: string, note: string, blocks: string[]): string {
	if (!blocks.length) return text;
	return text.includes(SECTION_SEP) ? `${text}\n\n${blocks.join("\n\n")}` : `${text}${SECTION_SEP} (${note})\n\n${blocks.join("\n\n")}`;
}

/** Splits a sent prompt into what the user typed and the appended context section (if any). */
export function splitContext(text: string): { text: string; context?: string } {
	const i = text.indexOf(SECTION_SEP);
	if (i < 0) return { text };
	return { text: text.slice(0, i), context: text.slice(i + SECTION_SEP.length).replace(/^[^\n]*\n+/, "") };
}

/** Terminal output as plain text: ANSI/OSC sequences removed, `\r` progress redraws collapsed. */
export function cleanTerminalText(raw: string): string {
	return (
		raw
			// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, "")
			.replace(/\r+\n/g, "\n")
			.split("\n")
			.map(line => line.slice(line.lastIndexOf("\r") + 1))
			.join("\n")
	);
}
