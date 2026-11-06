// VS Code side of composer context: @selection / @file / @problems / @git / @terminal mention
// providers and `{{selection}}` / `{{file}}` snippet placeholder values. Tracks the last text
// editor (a focused chat tab clears `activeTextEditor`) and recent terminal command output
// (shell integration) from activation on.
import * as cp from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { type Expansion, type MentionProviders, type MentionResult, cleanTerminalText, expandMentions } from "../shared/mentions";
import type { PlaceholderValues } from "../shared/snippets";
import type { OmpApi } from "./api";

const MAX_PROBLEMS = 200;
const TERMINAL_RUNS = 5;
const TERMINAL_RUN_CHARS = 32_000;

let lastEditor: vscode.TextEditor | undefined;
interface TerminalRun {
	command: string;
	output: string;
	exitCode?: number;
}
const terminalRuns = new Map<vscode.Terminal, TerminalRun[]>();

export function registerChatContext(api: OmpApi): void {
	lastEditor = vscode.window.activeTextEditor;
	api.context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(e => {
			if (e && e.document.uri.scheme !== "output") lastEditor = e;
		}),
		vscode.window.onDidStartTerminalShellExecution(e => void recordRun(e)),
		vscode.window.onDidEndTerminalShellExecution(e => {
			const run = terminalRuns.get(e.terminal)?.find(r => r.command === e.execution.commandLine.value && r.exitCode === undefined);
			if (run) run.exitCode = e.exitCode;
		}),
		vscode.window.onDidCloseTerminal(t => terminalRuns.delete(t)),
	);
}

async function recordRun(e: vscode.TerminalShellExecutionStartEvent): Promise<void> {
	const run: TerminalRun = { command: e.execution.commandLine.value, output: "" };
	const runs = terminalRuns.get(e.terminal) ?? [];
	runs.push(run);
	if (runs.length > TERMINAL_RUNS) runs.shift();
	terminalRuns.set(e.terminal, runs);
	try {
		for await (const chunk of e.execution.read()) {
			run.output += chunk;
			if (run.output.length > TERMINAL_RUN_CHARS * 2) run.output = run.output.slice(-TERMINAL_RUN_CHARS);
		}
	} catch {
		/* terminal closed mid-command */
	}
}

/** The editor the user means: the active one, else the last one focused before the chat. */
function currentEditor(): vscode.TextEditor | undefined {
	const active = vscode.window.activeTextEditor;
	if (active && active.document.uri.scheme !== "output") return active;
	if (lastEditor && !lastEditor.document.isClosed) return lastEditor;
	return vscode.window.visibleTextEditors.find(e => e.document.uri.scheme !== "output");
}

function displayPath(uri: vscode.Uri, cwd: string | undefined): string {
	if (uri.scheme !== "file") return uri.scheme === "untitled" ? uri.path : uri.toString();
	if (!cwd) return uri.fsPath;
	const rel = path.relative(cwd, uri.fsPath);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : uri.fsPath;
}

function selectionMention(cwd: string | undefined): MentionResult {
	const editor = currentEditor();
	if (!editor) return { unavailable: "no editor is open" };
	const doc = editor.document;
	const file = displayPath(doc.uri, cwd);
	const parts = editor.selections.filter(s => !s.isEmpty).sort((a, b) => a.start.compareTo(b.start));
	if (!parts.length) return { unavailable: `nothing is selected in ${file}` };
	const range = (s: vscode.Selection) => {
		// A selection ending at column 0 does not include that line.
		const end = s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
		return end > s.start.line + 1 ? `${s.start.line + 1}-${end}` : `${s.start.line + 1}`;
	};
	return {
		label: `\`${file}:${parts.map(range).join(",")}\``,
		body: parts.map(s => doc.getText(s)).join("\n…\n"),
		lang: doc.languageId,
	};
}

function fileMention(cwd: string | undefined): MentionResult {
	const editor = currentEditor();
	if (!editor) return { unavailable: "no editor is open" };
	const doc = editor.document;
	return { label: `\`${displayPath(doc.uri, cwd)}\` (${doc.lineCount} lines${doc.isDirty ? ", unsaved changes included" : ""})`, body: doc.getText(), lang: doc.languageId };
}

function problemsMention(cwd: string | undefined): MentionResult {
	const sev: Record<number, string> = { [vscode.DiagnosticSeverity.Error]: "error", [vscode.DiagnosticSeverity.Warning]: "warning" };
	const rows: Array<{ severity: number; file: string; line: number; text: string }> = [];
	for (const [uri, diags] of vscode.languages.getDiagnostics()) {
		if (cwd && uri.scheme === "file") {
			const rel = path.relative(cwd, uri.fsPath);
			if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
		}
		const file = displayPath(uri, cwd);
		for (const d of diags) {
			const label = sev[d.severity];
			if (!label) continue;
			const code = typeof d.code === "object" ? d.code.value : d.code;
			const origin = [d.source, code === undefined ? "" : String(code)].filter(Boolean).join(" ");
			rows.push({ severity: d.severity, file, line: d.range.start.line, text: `${file}:${d.range.start.line + 1}:${d.range.start.character + 1} ${label}${origin ? ` [${origin}]` : ""}: ${d.message.replace(/\s*\n\s*/g, " ")}` });
		}
	}
	const errors = rows.filter(r => r.severity === vscode.DiagnosticSeverity.Error).length;
	const warnings = rows.length - errors;
	const where = cwd ? `in \`${path.basename(cwd)}\`` : "in the workspace";
	if (!rows.length) return { label: `no errors or warnings ${where}`, body: "VS Code reports no errors or warnings.", lang: "text" };
	rows.sort((a, b) => a.severity - b.severity || a.file.localeCompare(b.file) || a.line - b.line);
	const shown = rows.slice(0, MAX_PROBLEMS).map(r => r.text);
	if (rows.length > MAX_PROBLEMS) shown.push(`… ${rows.length - MAX_PROBLEMS} more not shown`);
	return { label: `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} ${where}`, body: shown.join("\n"), lang: "text" };
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; out: string; err: string }>();
	cp.execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 15_000, windowsHide: true }, (error, stdout, stderr) =>
		resolve({ ok: !error, out: String(stdout), err: String(stderr) || (error ? error.message : "") }),
	);
	return promise;
}

async function gitMention(cwd: string | undefined): Promise<MentionResult> {
	if (!cwd) return { unavailable: "the session has no folder" };
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) return { unavailable: /not a git repository/i.test(top.err) ? "not a git repository" : `git failed: ${top.err.trim().split("\n")[0]}` };
	const flags = ["--no-color", "--no-ext-diff"];
	let diff = await git(cwd, ["diff", "HEAD", ...flags]);
	if (!diff.ok) {
		// No commits yet: staged and unstaged separately.
		const [staged, unstaged] = await Promise.all([git(cwd, ["diff", "--cached", ...flags]), git(cwd, ["diff", ...flags])]);
		diff = { ok: staged.ok && unstaged.ok, out: `${staged.out}${unstaged.out}`, err: staged.err || unstaged.err };
		if (!diff.ok) return { unavailable: `git diff failed: ${diff.err.trim().split("\n")[0]}` };
	}
	const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).out.split("\n").filter(Boolean);
	const lines = untracked.slice(0, 50).map(f => `# untracked: ${f}`);
	if (untracked.length > 50) lines.push(`# … ${untracked.length - 50} more untracked files`);
	const body = [diff.out.trimEnd(), lines.join("\n")].filter(Boolean).join("\n");
	const files = new Set([...diff.out.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map(m => m[1])).size;
	const repo = path.basename(top.out.trim());
	if (!body) return { label: `\`${repo}\`: no uncommitted changes`, body: "Working tree clean.", lang: "text" };
	return { label: `\`${repo}\`: ${files} changed file${files === 1 ? "" : "s"}${untracked.length ? `, ${untracked.length} untracked` : ""} (staged + unstaged vs HEAD)`, body, lang: "diff" };
}

/** Text selected in the active terminal, read through the clipboard (restored afterwards). */
async function terminalSelection(): Promise<string | undefined> {
	if (!vscode.window.activeTerminal) return undefined;
	const saved = await vscode.env.clipboard.readText();
	const sentinel = `\u0000omp-no-terminal-selection-${Date.now()}`;
	await vscode.env.clipboard.writeText(sentinel);
	try {
		await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
		const got = await vscode.env.clipboard.readText();
		return got && got !== sentinel ? got : undefined;
	} catch {
		return undefined;
	} finally {
		await vscode.env.clipboard.writeText(saved);
	}
}

async function terminalMention(): Promise<MentionResult> {
	const terminal = vscode.window.activeTerminal;
	if (!terminal) return { unavailable: "no terminal is open" };
	const selected = await terminalSelection();
	if (selected?.trim()) return { label: `selection in terminal \`${terminal.name}\``, body: cleanTerminalText(selected), lang: "text", tail: true };
	const runs = terminalRuns.get(terminal) ?? [];
	if (!runs.length) return { unavailable: `no selection in terminal "${terminal.name}" and no command output recorded (needs shell integration; select text in the terminal instead)` };
	const body = runs.map(r => `$ ${r.command}\n${cleanTerminalText(r.output).trimEnd()}${r.exitCode ? `\n[exit code ${r.exitCode}]` : ""}`).join("\n\n");
	return { label: `last ${runs.length} command${runs.length === 1 ? "" : "s"} in terminal \`${terminal.name}\``, body, lang: "text", tail: true };
}

/** Expands context @mentions in a prompt about to be sent from a chat whose session runs in `cwd`. */
export function expandContextMentions(text: string, cwd: string | undefined): Promise<Expansion> {
	const providers: MentionProviders = {
		selection: async () => selectionMention(cwd),
		file: async () => fileMention(cwd),
		problems: async () => problemsMention(cwd),
		git: () => gitMention(cwd),
		terminal: () => terminalMention(),
	};
	return expandMentions(text, providers);
}

/** Values for `{{selection}}` / `{{file}}` in prompt snippets. */
export function placeholderValues(cwd: string | undefined): PlaceholderValues {
	const editor = currentEditor();
	if (!editor) return {};
	const selection = editor.selections
		.filter(s => !s.isEmpty)
		.map(s => editor.document.getText(s))
		.join("\n");
	return { selection: selection || undefined, file: displayPath(editor.document.uri, cwd) };
}
