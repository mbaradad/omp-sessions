// Pure helpers behind editor-plus.ts (no `vscode` import, so unit tests can load them): prompt
// builders, diagnostic formatting/capping, enclosing-symbol selection, terminal output capture,
// and change attribution for hovers.

import * as path from "node:path";
import { diffTexts } from "../shared/diff";

/** True when `child` is `parent` or inside it. */
export function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Path as a session sees it: relative to its folder when inside it, else absolute. */
export function displayPath(file: string, cwd: string | undefined): string {
	if (!cwd) return file;
	const rel = path.relative(cwd, file);
	if (rel === "") return ".";
	return rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}

// ---------- formatting ----------

/** Markdown code fence that survives backticks inside `text`. */
export function fence(text: string, lang = ""): string {
	let ticks = "```";
	while (text.includes(ticks)) ticks += "`";
	return `${ticks}${lang}\n${text.replace(/\n$/, "")}\n${ticks}`;
}

/** First non-empty line of `text`, whitespace-collapsed and cut to `max` characters. */
export function excerpt(text: string, max = 80): string {
	const line = text
		.split("\n")
		.map(l => l.trim())
		.find(l => l.length > 0);
	if (!line) return "";
	const flat = line.replace(/\s+/g, " ");
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** `12` or `12-20` (1-based, inclusive). */
export function lineSpan(startLine: number, endLine: number): string {
	return endLine > startLine ? `${startLine}-${endLine}` : String(startLine);
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function relativeTime(ts: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 45) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	return `${Math.round(h / 24)} d ago`;
}

// ---------- code references & prompts ----------

/** A piece of a file as the session should see it. Lines are 1-based and inclusive. */
export interface CodeRef {
	/** Path relative to the session's folder when inside it, else absolute. */
	path: string;
	startLine: number;
	endLine: number;
	code: string;
	languageId?: string;
	/** Enclosing symbol the range was derived from, if any. */
	symbol?: string;
}

function describeRef(ref: CodeRef): string {
	return `${ref.path}:${lineSpan(ref.startLine, ref.endLine)}${ref.symbol ? ` (${ref.symbol})` : ""}`;
}

function refBlock(ref: CodeRef): string {
	return `${describeRef(ref)}\n${fence(ref.code, ref.languageId ?? "")}`;
}

export function editPrompt(ref: CodeRef, instruction: string): string {
	const span = lineSpan(ref.startLine, ref.endLine);
	return [
		`Edit ${describeRef(ref)}: ${instruction.trim()}`,
		"",
		`Change only lines ${span} of ${ref.path} (current content below) and leave the rest of the file as it is. If the change strictly needs edits elsewhere (imports, callers), keep them minimal and say so. Do not reformat unrelated code. Reply with a one-line summary when done.`,
		"",
		fence(ref.code, ref.languageId ?? ""),
	].join("\n");
}

export function explainFilePrompt(path: string): string {
	return `Explain ${path}: read it, then describe its purpose, its main parts and how they interact, how it fits into the rest of the project (who uses it, what it depends on), and anything non-obvious or risky. Do not change any files.`;
}

export function writeTestsPrompt(ref: CodeRef): string {
	return [
		`Write tests for ${describeRef(ref)}.`,
		"",
		"First find how this repository tests code (test framework, file locations and naming, helpers, fixtures, how tests are run) and follow those conventions exactly; put the tests where the existing ones for this area live. Cover the main behavior and the edge cases. Do not change the code under test unless a test exposes a real bug — then say so. Run the new tests and report the result.",
		"",
		fence(ref.code, ref.languageId ?? ""),
	].join("\n");
}

export function addDocsPrompt(ref: CodeRef): string {
	return [
		`Add documentation comments to ${describeRef(ref)}.`,
		"",
		"Use the docstring/doc-comment style this file and language already use (e.g. JSDoc/TSDoc, Python docstrings, rustdoc). Document purpose, parameters, return value, errors and non-obvious behavior; be concise and do not restate the obvious. Change only comments within this range: no code changes.",
		"",
		fence(ref.code, ref.languageId ?? ""),
	].join("\n");
}

// ---------- enclosing symbol ----------

/** Minimal document symbol: 0-based inclusive line range, `kind` as `vscode.SymbolKind`. */
export interface SymbolNode {
	name: string;
	kind: number;
	startLine: number;
	endLine: number;
	children?: SymbolNode[];
}

/** `vscode.SymbolKind` values (a stable public enum) used to pick code units. */
export const SymbolKinds = { Module: 1, Namespace: 2, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, Struct: 22 } as const;

const CALLABLE: ReadonlySet<number> = new Set([SymbolKinds.Function, SymbolKinds.Method, SymbolKinds.Constructor]);
/** Kinds that are code units only when they span several lines (arrow functions, object literals). */
const VALUE: ReadonlySet<number> = new Set([SymbolKinds.Variable, SymbolKinds.Constant, SymbolKinds.Property, SymbolKinds.Field]);
const TYPE: ReadonlySet<number> = new Set([SymbolKinds.Class, SymbolKinds.Interface, SymbolKinds.Enum, SymbolKinds.Struct]);

/** Longest symbol "Edit with omp" sends whole; beyond it the current line is used instead. */
export const MAX_EDIT_SYMBOL_LINES = 400;

/**
 * The innermost accepted symbol containing `line` (0-based). Works on nested trees
 * (DocumentSymbol) and flat lists (SymbolInformation): the smallest containing span wins, the
 * deeper one on ties.
 */
export function enclosingSymbol(symbols: readonly SymbolNode[], line: number, accept: (s: SymbolNode) => boolean): SymbolNode | undefined {
	let best: SymbolNode | undefined;
	let bestSpan = Number.POSITIVE_INFINITY;
	const visit = (nodes: readonly SymbolNode[]) => {
		for (const s of nodes) {
			if (line < s.startLine || line > s.endLine) continue;
			const span = s.endLine - s.startLine + 1;
			if (span <= bestSpan && accept(s)) {
				best = s;
				bestSpan = span;
			}
			if (s.children) visit(s.children);
		}
	};
	visit(symbols);
	return best;
}

/**
 * Code unit around the cursor for an action: "edit" takes the innermost function/method (or a
 * multi-line variable such as an arrow function) up to MAX_EDIT_SYMBOL_LINES; "unit" (tests, docs)
 * also accepts classes/interfaces/enums of any size.
 */
export function symbolForAction(symbols: readonly SymbolNode[], line: number, purpose: "edit" | "unit"): SymbolNode | undefined {
	return enclosingSymbol(symbols, line, s => {
		const lines = s.endLine - s.startLine + 1;
		if (purpose === "edit" && lines > MAX_EDIT_SYMBOL_LINES) return false;
		if (CALLABLE.has(s.kind)) return true;
		if (VALUE.has(s.kind)) return lines >= 2;
		return purpose === "unit" && TYPE.has(s.kind);
	});
}

// ---------- diagnostics ----------

export type Severity = "error" | "warning" | "info" | "hint";

export interface DiagnosticInfo {
	/** 0-based. */
	line: number;
	/** 0-based. */
	character: number;
	severity: Severity;
	message: string;
	source?: string;
	code?: string;
}

export interface FileDiagnostics {
	path: string;
	diagnostics: DiagnosticInfo[];
	/** 0-based line → text, for snippets. */
	lineText: (line: number) => string | undefined;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };
const MAX_MESSAGE = 400;
const MAX_SNIPPET_LINE = 200;

/** Errors first, then by position; duplicates (same line, message) dropped. */
export function sortDiagnostics(diags: readonly DiagnosticInfo[]): DiagnosticInfo[] {
	const seen = new Set<string>();
	return [...diags]
		.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line || a.character - b.character)
		.filter(d => {
			const key = `${d.line}\0${d.message}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `- L12:5 error (ts 2304): message` plus the offending source line. */
export function formatDiagnostic(d: DiagnosticInfo, lineText?: string): string {
	const origin = [d.source, d.code].filter(Boolean).join(" ");
	const message = cut(d.message.replace(/\s*\n\s*/g, " ").trim(), MAX_MESSAGE);
	const head = `- L${d.line + 1}:${d.character + 1} ${d.severity}${origin ? ` (${origin})` : ""}: ${message}`;
	const src = lineText?.trim();
	return src ? `${head}\n  \`${cut(src, MAX_SNIPPET_LINE).replace(/`/g, "'")}\`` : head;
}

/** Keeps errors and warnings of one file, errors first, at most `cap`. */
export function selectFileDiagnostics(diags: readonly DiagnosticInfo[], cap: number): { kept: DiagnosticInfo[]; omitted: number } {
	const relevant = sortDiagnostics(diags.filter(d => d.severity === "error" || d.severity === "warning"));
	return { kept: relevant.slice(0, cap), omitted: Math.max(0, relevant.length - cap) };
}

export function fixFilePrompt(file: FileDiagnostics, cap = 40): string | undefined {
	const { kept, omitted } = selectFileDiagnostics(file.diagnostics, cap);
	if (kept.length === 0) return undefined;
	const errors = kept.filter(d => d.severity === "error").length;
	const warnings = kept.length - errors;
	const counts = [errors ? `${errors} error${errors === 1 ? "" : "s"}` : "", warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
	return [
		`Fix the problems VS Code reports in ${file.path} (${counts}${omitted ? `; ${omitted} more not listed` : ""}):`,
		"",
		...kept.map(d => formatDiagnostic(d, file.lineText(d.line))),
		"",
		"Fix the root causes rather than silencing them (no blanket ignores/casts), keep changes minimal, and re-check the file afterwards.",
	].join("\n");
}

/** Errors only, grouped by file in input order, at most `cap` in total. */
export function fixWorkspacePrompt(files: readonly FileDiagnostics[], cap = 50): string | undefined {
	let budget = cap;
	let total = 0;
	const sections: string[] = [];
	let fileCount = 0;
	for (const f of files) {
		const errors = sortDiagnostics(f.diagnostics.filter(d => d.severity === "error"));
		if (errors.length === 0) continue;
		total += errors.length;
		fileCount++;
		if (budget <= 0) continue;
		const kept = errors.slice(0, budget);
		budget -= kept.length;
		const more = errors.length - kept.length;
		sections.push([`### ${f.path}`, ...kept.map(d => formatDiagnostic(d, f.lineText(d.line))), ...(more ? [`- … ${more} more in this file`] : [])].join("\n"));
	}
	if (total === 0) return undefined;
	const shown = Math.min(total, cap);
	return [
		`Fix the ${total} error${total === 1 ? "" : "s"} VS Code reports across ${fileCount} file${fileCount === 1 ? "" : "s"}${total > shown ? ` (first ${shown} listed)` : ""}:`,
		"",
		sections.join("\n\n"),
		"",
		"Work through them file by file, fix root causes (one cause often explains many errors), keep changes minimal, and re-run the project's type check/build afterwards.",
	].join("\n");
}

// ---------- terminal output ----------

// CSI (incl. private modes), OSC (BEL or ST terminated, e.g. shell-integration 633), DCS/PM/APC
// strings, charset selection, and remaining two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_][^\x1b]*(?:\x1b\\)?|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_=>]|\x9b[0-?]*[ -/]*[@-~]/g;

/** Plain text from raw terminal output: no escape sequences, `\r`-overwritten text resolved, no other control characters. */
export function stripAnsi(raw: string): string {
	const noEsc = raw.replace(ANSI, "");
	return noEsc
		.replace(/\r+\n/g, "\n")
		.split("\n")
		.map(line => {
			// A bare \r returns to column 0: the last non-empty segment is what's visible (approximately).
			const parts = line.split("\r").filter(p => p.length > 0);
			const visible = parts.length ? parts[parts.length - 1] : "";
			// Apply backspaces, then drop other C0 controls except tab.
			let out = "";
			for (const ch of visible) {
				if (ch === "\b") out = out.slice(0, -1);
				else if (ch === "\t" || ch >= " ") out += ch;
			}
			return out.trimEnd();
		})
		.join("\n");
}

/**
 * Bounded capture of a command's output: keeps the first `headMax` and last `tailMax` characters
 * (compilers print the first error first; most tools print the summary last).
 */
export class CappedOutput {
	private head = "";
	private tail = "";
	private dropped = 0;

	constructor(
		private readonly headMax = 4000,
		private readonly tailMax = 12000,
	) {}

	append(chunk: string): void {
		if (this.head.length < this.headMax) {
			const room = this.headMax - this.head.length;
			this.head += chunk.slice(0, room);
			chunk = chunk.slice(room);
		}
		if (!chunk) return;
		this.tail += chunk;
		if (this.tail.length > this.tailMax * 2) this.trimTail();
	}

	private trimTail(): void {
		const extra = this.tail.length - this.tailMax;
		if (extra <= 0) return;
		this.dropped += extra;
		this.tail = this.tail.slice(extra);
	}

	get truncated(): boolean {
		this.trimTail();
		return this.dropped > 0;
	}

	/** Captured text with escape sequences stripped; a marker shows where output was dropped. */
	text(): string {
		this.trimTail();
		if (this.dropped === 0) return stripAnsi(this.head + this.tail).replace(/^\n+|\n+$/g, "");
		const tail = stripAnsi(this.tail);
		// The cut is mid-line: drop the partial first line of the tail.
		const nl = tail.indexOf("\n");
		const cleanTail = nl >= 0 ? tail.slice(nl + 1) : tail;
		return `${stripAnsi(this.head).replace(/\n+$/, "")}\n… (${this.dropped} characters of output omitted) …\n${cleanTail.replace(/\n+$/, "")}`;
	}
}

/** Exit codes worth offering a fix for: non-zero, but not a Ctrl+C (130) interrupt. */
export function isFailure(exitCode: number | undefined): exitCode is number {
	return exitCode !== undefined && exitCode !== 0 && exitCode !== 130;
}

export interface FailedCommand {
	commandLine: string;
	/** Display path of the working directory (relative to the session folder when inside). */
	cwd: string;
	exitCode: number;
	output: string;
}

export function failedCommandPrompt(f: FailedCommand): string {
	const out = f.output.trim();
	return [
		`This command failed with exit code ${f.exitCode} in ${f.cwd}:`,
		fence(f.commandLine.trim(), "sh"),
		out ? `Output:\n${fence(out, "text")}` : "It produced no output (or the terminal did not report any).",
		"",
		"Find the cause and fix it. If the fix is in the code, change it and re-run the command to confirm; if the command itself is wrong, tell me the right one.",
	].join("\n");
}

// ---------- change attribution (hovers) ----------

/** 1-based line numbers in `current` that are added or modified relative to `baseline`. */
export function changedLines(baseline: string, current: string): Set<number> {
	const out = new Set<number>();
	for (const h of diffTexts(baseline, current, 0).hunks) for (const l of h.lines) if (l.t === "+" && l.n !== undefined) out.add(l.n);
	return out;
}

/** Texts (trimmed) of the lines a single edit added or modified. */
export function addedTexts(before: string, after: string): Set<string> {
	const out = new Set<string>();
	for (const h of diffTexts(before, after, 0).hunks) for (const l of h.lines) if (l.t === "+") out.add(l.s.trim());
	return out;
}

/**
 * Index of the edit that most likely wrote `lineText`: the newest one (edits ordered oldest first)
 * that added that exact text, else the newest edit.
 */
export function attributeLine(lineText: string, edits: ReadonlyArray<{ added: ReadonlySet<string> }>): number {
	const want = lineText.trim();
	if (want) for (let i = edits.length - 1; i >= 0; i--) if (edits[i].added.has(want)) return i;
	return edits.length - 1;
}

/**
 * For an omp transcript (.jsonl), maps each tool call id to the user prompt that started its turn.
 * Lines that are not user messages or tool results are skipped without parsing.
 */
export function promptsByToolCall(jsonl: string): Map<string, string> {
	const out = new Map<string, string>();
	let prompt = "";
	for (const line of jsonl.split("\n")) {
		if (line.includes('"role":"user"')) {
			try {
				const text = userText(JSON.parse(line));
				if (text) prompt = text;
			} catch {
				/* torn line */
			}
			continue;
		}
		if (!line.includes('"role":"toolResult"')) continue;
		const id = /"toolCallId":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
		if (id && prompt && !out.has(id)) out.set(id, prompt);
	}
	return out;
}

/** Text of a transcript `message` entry when it is a user message, else "". */
function userText(entry: unknown): string {
	if (!entry || typeof entry !== "object" || !("message" in entry)) return "";
	const message = entry.message;
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user" || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const c of content) if (c && typeof c === "object" && "type" in c && c.type === "text" && "text" in c && typeof c.text === "string") texts.push(c.text);
	return texts.join("\n").trim();
}
