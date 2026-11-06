// Conversation → Markdown (chat "Copy/Save as Markdown"). Built from omp's transcript messages:
// user/assistant text, tool calls summarized with their arguments, edits as ```diff blocks,
// images replaced by a placeholder. Pure.
import { type FileDiff, diffTexts, parseOmpDiff } from "./diff";
import { fence } from "./mentions";

export interface ExportOptions {
	title: string;
	cwd?: string;
	/** Stamp in the header; omitted when undefined (tests). */
	exportedAt?: Date;
	/** Formats message timestamps; omitted when undefined. */
	formatTime?: (ms: number) => string;
}

const MAX_ARGS = 1_500;
const MAX_OUTPUT_LINES = 40;
const MAX_DIFF_LINES = 400;
const EDIT_TOOLS: Record<string, true> = { edit: true, ast_edit: true, write: true, notebook: true };

function rec(v: unknown): Record<string, unknown> | undefined {
	// JSON objects from omp's transcript; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function blocks(content: unknown): Record<string, unknown>[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content.map(b => rec(b) ?? {}) : [];
}

function contentText(content: unknown): string {
	return blocks(content)
		.filter(b => b.type === "text")
		.map(b => str(b.text))
		.join("\n");
}

function relative(p: string, cwd?: string): string {
	return cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
}

function headLines(text: string, max: number): string {
	const lines = text.replace(/\n+$/, "").split("\n");
	return lines.length <= max ? lines.join("\n") : `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines)`;
}

/** Unified diff text for a FileDiff (`@@ -a,b +c,d @@` hunks). */
export function unifiedDiff(diff: FileDiff, path: string): string {
	const out = [`--- a/${path}`, `+++ b/${path}`];
	for (const hunk of diff.hunks) {
		const oldCount = hunk.lines.filter(l => l.t !== "+").length;
		const newCount = hunk.lines.filter(l => l.t !== "-").length;
		out.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`);
		for (const l of hunk.lines) out.push(`${l.t}${l.s}`);
	}
	return headLines(out.join("\n"), MAX_DIFF_LINES);
}

/** Paths an edit-like tool call touches (args `path`, hashline `[path#tag]` and apply-patch headers). */
function editPaths(args: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const k of ["path", "file", "file_path"]) if (typeof args[k] === "string") out.push(str(args[k]));
	const input = str(args.input) || str(args.patch);
	for (const m of input.matchAll(/^\[([^\]\n#]+)#[0-9A-Za-z]{2,8}\]/gm)) out.push(m[1].trim());
	for (const m of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
	return [...new Set(out)];
}

/** Diffs recorded in an edit tool's result details (full texts preferred over omp's display rows). */
function resultDiffs(details: Record<string, unknown> | undefined, fallbackPath: string): Array<{ path: string; diff: FileDiff }> {
	if (!details) return [];
	const entries = Array.isArray(details.perFileResults) ? details.perFileResults.map(f => rec(f) ?? {}) : [details];
	const out: Array<{ path: string; diff: FileDiff }> = [];
	for (const e of entries) {
		const path = str(e.path) || fallbackPath;
		if (typeof e.oldText === "string" && typeof e.newText === "string") out.push({ path, diff: diffTexts(e.oldText, e.newText) });
		else if (typeof e.diff === "string" && e.diff) out.push({ path, diff: parseOmpDiff(e.diff) });
	}
	return out;
}

function toolArgsSummary(name: string, args: Record<string, unknown>, cwd?: string): string {
	if (name === "bash") return fence(str(args.command), "sh");
	if (EDIT_TOOLS[name]) return editPaths(args).map(p => `\`${relative(p, cwd)}\``).join(", ");
	const shown = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "i" && k !== "intent"));
	if (!Object.keys(shown).length) return "";
	const json = JSON.stringify(shown, null, 2);
	return fence(json.length > MAX_ARGS ? `${json.slice(0, MAX_ARGS)}\n… (truncated)` : json, "json");
}

function toolSection(call: Record<string, unknown>, result: Record<string, unknown> | undefined, cwd?: string): string {
	const name = str(call.name) || "tool";
	const args = rec(call.arguments) ?? {};
	const intent = str(call.intent) || str(args.i);
	const parts = [`**Tool \`${name}\`**${intent ? ` — ${intent}` : ""}${result?.isError ? " · ⚠ failed" : ""}`];
	const summary = toolArgsSummary(name, args, cwd);
	if (summary) parts.push(summary);
	if (EDIT_TOOLS[name]) {
		const diffs = resultDiffs(rec(result?.details), editPaths(args)[0] ?? "");
		if (!diffs.length && name === "write" && typeof args.content === "string" && !result?.isError) diffs.push({ path: editPaths(args)[0] ?? "", diff: diffTexts("", args.content) });
		for (const { path, diff } of diffs) if (diff.hunks.length) parts.push(fence(unifiedDiff(diff, relative(path, cwd)), "diff"));
	}
	const output = contentText(result?.content).trim();
	if (output && (name === "bash" || result?.isError)) parts.push(fence(headLines(output, MAX_OUTPUT_LINES), "text"));
	return parts.join("\n\n");
}

function heading(label: string, m: Record<string, unknown>, opts: ExportOptions): string {
	const ts = typeof m.timestamp === "number" ? m.timestamp : typeof m.timestamp === "string" ? Date.parse(m.timestamp) : Number.NaN;
	return `## ${label}${opts.formatTime && Number.isFinite(ts) ? ` · ${opts.formatTime(ts)}` : ""}`;
}

/** Markdown document for a conversation (omp transcript messages, oldest first). */
export function conversationMarkdown(messages: unknown[], opts: ExportOptions): string {
	const results = new Map<string, Record<string, unknown>>();
	for (const raw of messages) {
		const m = rec(raw);
		if (m?.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
	}
	const out: string[] = [`# ${opts.title}`];
	const meta = [opts.cwd ? `Folder: \`${opts.cwd}\`` : "", opts.exportedAt ? `Exported ${opts.exportedAt.toISOString()}` : ""].filter(Boolean);
	if (meta.length) out.push(meta.join(" · "));
	for (const raw of messages) {
		const m = rec(raw);
		if (!m || m.display === false) continue;
		switch (m.role) {
			case "user": {
				const parts = blocks(m.content).map(b => (b.type === "text" ? str(b.text) : b.type === "image" ? "*[image omitted]*" : ""));
				const text = parts.filter(Boolean).join("\n\n").trim();
				if (text) out.push(heading(m.attribution === "agent" ? "User (sent by agent)" : "User", m, opts), text);
				break;
			}
			case "assistant": {
				const parts: string[] = [];
				for (const b of blocks(m.content)) {
					if (b.type === "text" && str(b.text).trim()) parts.push(str(b.text).trim());
					else if (b.type === "toolCall") parts.push(toolSection(b, results.get(str(b.id)), opts.cwd));
					else if (b.type === "image") parts.push("*[image omitted]*");
				}
				if (m.stopReason === "error") parts.push(`> ⚠ ${str(m.errorMessage) || "The model request failed."}`);
				if (m.stopReason === "aborted") parts.push("> Interrupted");
				if (parts.length) out.push(heading(`Assistant${str(m.model) ? ` (${str(m.model)})` : ""}`, m, opts), parts.join("\n\n"));
				break;
			}
			case "bashExecution": {
				const output = str(m.output).trim();
				out.push(heading("Shell", m, opts), [fence(`$ ${str(m.command)}`, "sh"), output ? fence(headLines(output, MAX_OUTPUT_LINES), "text") : "", typeof m.exitCode === "number" && m.exitCode !== 0 ? `Exit code ${m.exitCode}` : ""].filter(Boolean).join("\n\n"));
				break;
			}
			case "compactionSummary":
				out.push("---\n\n*Context compacted*");
				break;
			case "branchSummary":
				out.push("---\n\n*Branch summary*");
				break;
		}
	}
	return `${out.join("\n\n")}\n`;
}
