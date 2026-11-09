// Editor power tools: "Edit with omp" on a selection/function, change hovers, fix-problems
// prompts, fixing failed terminal commands, and explain/test/document actions.

import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { EMPTY_BLOB, type FileChange, type FileChangeEntry, type SessionMeta, blobPath, sessionDir } from "../shared/protocol";
import type { OmpApi } from "./api";
import {
	CappedOutput,
	type CodeRef,
	type DiagnosticInfo,
	type FileDiagnostics,
	type Severity,
	type SymbolNode,
	addDocsPrompt,
	addedTexts,
	attributeLine,
	changedLines,
	displayPath,
	editPrompt,
	excerpt,
	explainFilePrompt,
	failedCommandPrompt,
	fixFilePrompt,
	fixWorkspacePrompt,
	isFailure,
	isWithin,
	lineSpan,
	promptsByToolCall,
	relativeTime,
	symbolForAction,
	writeTestsPrompt,
} from "./editor-plus-core";
import type { ChatPanel } from "./panel";
import { checkoutRoot, inCheckout } from "./checkout";
import { plain } from "./plain";

const HISTORY_KEY = "omp.editWithOmp.history";
const HISTORY_MAX = 20;
/** Give up waiting for an "Edit with omp" turn that never started. */
const EDIT_START_TIMEOUT_MS = 60_000;
const HINT_MS = 15_000;
const FILE_DIAGNOSTICS_CAP = 40;
const WORKSPACE_ERRORS_CAP = 50;
const FAILED_COMMAND_CONTEXT = "omp.hasFailedCommand";

export function registerEditorPlus(api: OmpApi): void {
	const { context, sessions } = api;
	const reg = (name: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));

	async function panelFor(cwdHint: string | undefined): Promise<ChatPanel | undefined> {
		const panel = await api.targetPanel(cwdHint);
		if (!panel) void vscode.window.showInformationMessage("Open or start an omp session first.");
		return panel;
	}

	function folderOf(uri: vscode.Uri): string {
		return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
	}

	function fileEditor(): vscode.TextEditor | undefined {
		const editor = vscode.window.activeTextEditor;
		if (editor?.document.uri.scheme === "file") return editor;
		void vscode.window.showInformationMessage("Open a file in the editor first.");
		return undefined;
	}

	// ---------- code targets ----------
	async function documentSymbols(uri: vscode.Uri): Promise<SymbolNode[]> {
		let raw: Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined;
		try {
			raw = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>("vscode.executeDocumentSymbolProvider", uri);
		} catch {
			return [];
		}
		const convert = (s: vscode.DocumentSymbol | vscode.SymbolInformation): SymbolNode => {
			const range = "range" in s ? s.range : s.location.range;
			const children = "children" in s ? s.children.map(convert) : undefined;
			return { name: s.name, kind: s.kind, startLine: range.start.line, endLine: range.end.line, children };
		};
		return (raw ?? []).map(convert);
	}

	/** Whole lines covered by `range` (a selection ending at column 0 excludes that line). */
	function fullLines(doc: vscode.TextDocument, range: vscode.Range): vscode.Range {
		const endLine = range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
		return new vscode.Range(range.start.line, 0, endLine, doc.lineAt(endLine).text.length);
	}

	/**
	 * Lines an action applies to: the selection, else the enclosing function (or class for "unit"),
	 * else the current line for "edit" and nothing for "unit".
	 */
	async function codeTarget(editor: vscode.TextEditor, purpose: "edit" | "unit"): Promise<{ range: vscode.Range; symbol?: string } | undefined> {
		const doc = editor.document;
		if (!editor.selection.isEmpty) return { range: fullLines(doc, editor.selection) };
		const line = editor.selection.active.line;
		const symbol = symbolForAction(await documentSymbols(doc.uri), line, purpose);
		if (symbol) return { range: fullLines(doc, new vscode.Range(symbol.startLine, 0, Math.min(symbol.endLine, doc.lineCount - 1), 0)), symbol: symbol.name };
		return purpose === "edit" ? { range: fullLines(doc, new vscode.Range(line, 0, line, 0)) } : undefined;
	}

	function codeRef(doc: vscode.TextDocument, target: { range: vscode.Range; symbol?: string }, cwd: string | undefined): CodeRef {
		return {
			path: displayPath(doc.uri.fsPath, cwd),
			startLine: target.range.start.line + 1,
			endLine: target.range.end.line + 1,
			code: doc.getText(target.range),
			languageId: doc.languageId,
			symbol: target.symbol,
		};
	}

	// ---------- Edit with omp ----------
	function editHistory(): string[] {
		const h = context.globalState.get<unknown>(HISTORY_KEY);
		return Array.isArray(h) ? h.filter((x): x is string => typeof x === "string") : [];
	}

	function rememberInstruction(text: string): void {
		const next = [text, ...editHistory().filter(h => h !== text)].slice(0, HISTORY_MAX);
		void context.globalState.update(HISTORY_KEY, next);
	}

	/** Free-text input with recent instructions offered as picks. */
	function askInstruction(title: string): Promise<string | undefined> {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const history = editHistory();
		const qp = vscode.window.createQuickPick();
		const recent = (except: string): vscode.QuickPickItem[] => history.filter(h => h !== except).map(h => ({ label: h, description: "recent", iconPath: new vscode.ThemeIcon("history") }));
		qp.title = title;
		qp.placeholder = history.length ? "Describe the change, or pick a recent instruction" : "Describe the change, e.g. “handle the empty case”";
		qp.ignoreFocusOut = true;
		qp.items = recent("");
		qp.onDidChangeValue(value => {
			const typed = value.trim();
			qp.items = typed ? [{ label: typed, alwaysShow: true, iconPath: new vscode.ThemeIcon("sparkle") }, ...recent(typed)] : recent("");
		});
		let result: string | undefined;
		qp.onDidAccept(() => {
			result = (qp.selectedItems[0]?.label ?? qp.value).trim() || undefined;
			qp.hide();
		});
		qp.onDidHide(() => {
			qp.dispose();
			resolve(result);
		});
		qp.show();
		return promise;
	}

	interface PendingEdit {
		sessionId: string;
		file: string;
		label: string;
		sentAt: number;
		/** Document text when the prompt was sent: the left side of the result diff. */
		before: string;
		sawBusy: boolean;
		/** Session's last assistant text when sent: a new one means a turn completed. */
		lastText: string | undefined;
		/** Editor column the user edited in: the result diff opens there. */
		column: vscode.ViewColumn | undefined;
	}
	const pendingEdits = new Set<PendingEdit>();
	const editStatus = vscode.window.createStatusBarItem("omp.editWithOmp", vscode.StatusBarAlignment.Left, 49);
	editStatus.name = "omp Edit";
	context.subscriptions.push(editStatus);

	function updateEditStatus(): void {
		const all = [...pendingEdits];
		if (all.length === 0) {
			editStatus.hide();
			return;
		}
		editStatus.text = all.length === 1 ? `$(sync~spin) omp: editing ${all[0].label}` : `$(sync~spin) omp: ${all.length} edits`;
		editStatus.tooltip = `${all.map(e => `${e.label} — ${sessions.get(e.sessionId)?.title ?? e.sessionId}`).join("\n")}\nClick to open the chat.`;
		editStatus.command = { command: "omp.openSession", title: "Open chat", arguments: [all[all.length - 1].sessionId] };
		editStatus.show();
	}

	function editChangedFile(edit: PendingEdit): boolean {
		return sessions.changes(edit.sessionId).some(c => c.timestamp >= edit.sentAt && c.files.some(f => f.path === edit.file));
	}

	async function finishEdit(edit: PendingEdit, outcome: "idle" | "stopped" | "timeout"): Promise<void> {
		pendingEdits.delete(edit);
		updateEditStatus();
		if (editChangedFile(edit)) {
			const left = api.snapshots.textUri(edit.file, edit.before, "before omp edit");
			const right = fs.existsSync(edit.file) ? vscode.Uri.file(edit.file) : api.snapshots.textUri(edit.file, "", "deleted");
			await vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(edit.file)} (omp edit)`, { preview: true, viewColumn: edit.column ?? vscode.ViewColumn.Active });
			vscode.window.setStatusBarMessage(`$(check) omp edited ${edit.label}`, 5000);
			return;
		}
		const why = outcome === "stopped" ? "The session stopped before changing" : outcome === "timeout" ? "omp did not start working on" : "omp finished without changing";
		const choice = await vscode.window.showInformationMessage(plain(`${why} ${edit.label}.`), "Open Chat");
		if (choice) await vscode.commands.executeCommand("omp.openSession", edit.sessionId);
	}

	function checkEdits(): void {
		for (const edit of [...pendingEdits]) {
			const meta = sessions.get(edit.sessionId);
			if (!meta || meta.status === "stopped") {
				void finishEdit(edit, "stopped");
				continue;
			}
			if (meta.status === "working" || meta.status === "waiting") {
				edit.sawBusy = true;
				continue;
			}
			// Idle: done once the turn ran. A short turn can finish between two status polls, so a new
			// assistant reply or a recorded change to the file counts too; a turn that never started times out.
			if (edit.sawBusy || meta.lastText !== edit.lastText || editChangedFile(edit)) void finishEdit(edit, "idle");
			else if (Date.now() - edit.sentAt > EDIT_START_TIMEOUT_MS) void finishEdit(edit, "timeout");
		}
	}

	const editPoll = setInterval(() => {
		if (pendingEdits.size > 0) checkEdits();
	}, 2000);
	context.subscriptions.push(
		sessions.onDidChange(() => {
			if (pendingEdits.size > 0) checkEdits();
		}),
		sessions.onDidTransition(({ meta }) => {
			if (meta.status === "working" || meta.status === "waiting") for (const e of pendingEdits) if (e.sessionId === meta.id) e.sawBusy = true;
		}),
		{ dispose: () => clearInterval(editPoll) },
	);

	reg("omp.editWithOmp", async () => {
		const editor = fileEditor();
		if (!editor) return;
		const doc = editor.document;
		const target = await codeTarget(editor, "edit");
		if (!target) return;
		const where = `${path.basename(doc.uri.fsPath)}:${lineSpan(target.range.start.line + 1, target.range.end.line + 1)}${target.symbol ? ` (${target.symbol})` : ""}`;
		const instruction = await askInstruction(`Edit with omp — ${where}`);
		if (!instruction) return;
		rememberInstruction(instruction);
		const panel = await panelFor(folderOf(doc.uri));
		if (!panel) return;
		const meta = panel.meta;
		if (!meta || meta.status === "stopped") {
			void vscode.window.showWarningMessage(plain(`Session "${meta?.title ?? "omp"}" is not running. Resume it first.`));
			return;
		}
		const before = doc.getText();
		const edit: PendingEdit = { sessionId: meta.id, file: doc.uri.fsPath, label: where, sentAt: Date.now(), before, sawBusy: meta.status === "working" || meta.status === "waiting", lastText: meta.lastText, column: editor.viewColumn };
		await panel.sendPrompt(inCheckout(editPrompt(codeRef(doc, target, undefined), instruction), doc.uri.fsPath));
		pendingEdits.add(edit);
		updateEditStatus();
		// sendPrompt reveals the chat; keep the user in the code they are editing.
		await vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, selection: editor.selection, preserveFocus: false });
	});

	// ---------- tests / docs / explain ----------
	async function sendUnitPrompt(build: (ref: CodeRef) => string, what: string): Promise<void> {
		const editor = fileEditor();
		if (!editor) return;
		const target = await codeTarget(editor, "unit");
		if (!target) {
			void vscode.window.showInformationMessage(`Select code or place the cursor inside a function or class to ${what}.`);
			return;
		}
		const panel = await panelFor(folderOf(editor.document.uri));
		if (!panel) return;
		await panel.sendPrompt(inCheckout(build(codeRef(editor.document, target, undefined)), editor.document.uri.fsPath));
	}

	reg("omp.writeTests", () => sendUnitPrompt(writeTestsPrompt, "write tests"));
	reg("omp.addDocs", () => sendUnitPrompt(addDocsPrompt, "add docs"));

	reg("omp.explainFile", async (arg?: unknown) => {
		const uri = arg instanceof vscode.Uri ? arg : fileEditor()?.document.uri;
		if (!uri || uri.scheme !== "file") return;
		const panel = await panelFor(folderOf(uri));
		if (!panel) return;
		await panel.sendPrompt(inCheckout(explainFilePrompt(uri.fsPath), uri.fsPath));
	});

	// ---------- problems ----------
	const severityName: Record<vscode.DiagnosticSeverity, Severity> = {
		[vscode.DiagnosticSeverity.Error]: "error",
		[vscode.DiagnosticSeverity.Warning]: "warning",
		[vscode.DiagnosticSeverity.Information]: "info",
		[vscode.DiagnosticSeverity.Hint]: "hint",
	};

	function diagnosticInfo(d: vscode.Diagnostic): DiagnosticInfo {
		const code = typeof d.code === "object" ? d.code.value : d.code;
		return { line: d.range.start.line, character: d.range.start.character, severity: severityName[d.severity], message: d.message, source: d.source, code: code === undefined ? undefined : String(code) };
	}

	/** Line lookup from the open document, else from disk (read lazily, once). */
	function lineReader(uri: vscode.Uri): (line: number) => string | undefined {
		const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
		if (open) return line => (line < open.lineCount ? open.lineAt(line).text : undefined);
		let lines: string[] | undefined;
		return line => {
			if (!lines) {
				try {
					lines = fs.readFileSync(uri.fsPath, "utf8").split(/\r?\n/);
				} catch {
					lines = [];
				}
			}
			return lines[line];
		};
	}

	reg("omp.fixFileProblems", async (arg?: unknown) => {
		const uri = arg instanceof vscode.Uri ? arg : fileEditor()?.document.uri;
		if (!uri || uri.scheme !== "file") return;
		const diagnostics = vscode.languages.getDiagnostics(uri).map(diagnosticInfo);
		const name = path.basename(uri.fsPath);
		if (!diagnostics.some(d => d.severity === "error" || d.severity === "warning")) {
			void vscode.window.showInformationMessage(plain(`No errors or warnings in ${name}.`));
			return;
		}
		const panel = await panelFor(folderOf(uri));
		if (!panel) return;
		const prompt = fixFilePrompt({ path: uri.fsPath, diagnostics, lineText: lineReader(uri) }, FILE_DIAGNOSTICS_CAP);
		if (prompt) await panel.sendPrompt(inCheckout(prompt, uri.fsPath));
	});

	reg("omp.fixWorkspaceProblems", async () => {
		const withErrors = vscode.languages
			.getDiagnostics()
			.filter(([uri, diags]) => uri.scheme === "file" && diags.some(d => d.severity === vscode.DiagnosticSeverity.Error))
			.sort(([a], [b]) => a.fsPath.localeCompare(b.fsPath));
		if (withErrors.length === 0) {
			void vscode.window.showInformationMessage("No errors in the workspace.");
			return;
		}
		const active = vscode.window.activeTextEditor?.document.uri;
		const hint = active?.scheme === "file" ? folderOf(active) : folderOf(withErrors[0][0]);
		const panel = await panelFor(hint);
		if (!panel) return;
		const cwd = checkoutRoot(hint);
		// The checkout's files only, when it has errors there; the active file first.
		const inside = withErrors.filter(([uri]) => isWithin(uri.fsPath, cwd));
		const chosen = (inside.length > 0 ? inside : withErrors).sort(([a], [b]) => Number(b.toString() === active?.toString()) - Number(a.toString() === active?.toString()));
		const files: FileDiagnostics[] = chosen.map(([uri, diags]) => ({ path: uri.fsPath, diagnostics: diags.map(diagnosticInfo), lineText: lineReader(uri) }));
		const prompt = fixWorkspacePrompt(files, WORKSPACE_ERRORS_CAP);
		if (prompt) await panel.sendPrompt(inCheckout(prompt, hint));
	});

	// ---------- failed terminal commands ----------
	interface Failure {
		sessionId: string;
		terminal: vscode.Terminal;
		commandLine: string;
		cwd: string;
		exitCode: number;
		output: string;
	}
	const captures = new Map<vscode.TerminalShellExecution, { output: CappedOutput; done: Promise<void> }>();
	const failures = new Map<vscode.Terminal, Failure>();
	let lastFailure: Failure | undefined;
	const hint = vscode.window.createStatusBarItem("omp.fixFailedCommand", vscode.StatusBarAlignment.Left, 48);
	hint.name = "omp Failed Command";
	hint.text = "$(lightbulb) omp: fix failed command?";
	hint.command = "omp.fixLastFailedCommand";
	let hintTimer: NodeJS.Timeout | undefined;
	context.subscriptions.push(hint, { dispose: () => clearTimeout(hintTimer) });

	function hideHint(): void {
		clearTimeout(hintTimer);
		hint.hide();
	}

	function setHasFailure(): void {
		void vscode.commands.executeCommand("setContext", FAILED_COMMAND_CONTEXT, failures.size > 0);
	}

	/** The running session whose folder contains `dir` (deepest folder wins). */
	function sessionAt(dir: string): SessionMeta | undefined {
		return sessions
			.all()
			.filter(m => m.status !== "stopped" && isWithin(dir, m.cwd))
			.sort((a, b) => b.cwd.length - a.cwd.length)[0];
	}

	context.subscriptions.push(
		vscode.window.onDidStartTerminalShellExecution(e => {
			const output = new CappedOutput();
			const done = (async () => {
				for await (const chunk of e.execution.read()) output.append(chunk);
			})().catch(() => undefined);
			captures.set(e.execution, { output, done });
		}),
		vscode.window.onDidEndTerminalShellExecution(async e => {
			const capture = captures.get(e.execution);
			captures.delete(e.execution);
			if (!isFailure(e.exitCode)) {
				if (lastFailure?.terminal === e.terminal) hideHint();
				return;
			}
			const cwdUri = e.execution.cwd ?? e.terminal.shellIntegration?.cwd;
			if (cwdUri?.scheme !== "file") return;
			const meta = sessionAt(cwdUri.fsPath);
			if (!meta) return;
			// The output stream can trail the end event slightly.
			if (capture) await Promise.race([capture.done, sleep(500)]);
			const failure: Failure = {
				sessionId: meta.id,
				terminal: e.terminal,
				commandLine: e.execution.commandLine.value,
				cwd: cwdUri.fsPath,
				exitCode: e.exitCode,
				output: capture?.output.text() ?? "",
			};
			failures.set(e.terminal, failure);
			lastFailure = failure;
			setHasFailure();
			if (!vscode.workspace.getConfiguration("omp").get<boolean>("terminalHints", true)) return;
			hint.tooltip = `\`${excerpt(failure.commandLine, 60)}\` exited with ${failure.exitCode}. Send it to "${meta.title}".`;
			hint.show();
			clearTimeout(hintTimer);
			hintTimer = setTimeout(() => hint.hide(), HINT_MS);
		}),
		vscode.window.onDidCloseTerminal(t => {
			failures.delete(t);
			if (lastFailure?.terminal === t) {
				lastFailure = undefined;
				hideHint();
			}
			setHasFailure();
		}),
	);

	reg("omp.fixLastFailedCommand", async (arg?: unknown) => {
		const terminal = [...failures.keys()].find(t => t === arg) ?? vscode.window.activeTerminal;
		const failure = (terminal && failures.get(terminal)) ?? lastFailure;
		if (!failure) {
			void vscode.window.showInformationMessage("No failed command recorded yet. omp watches commands that fail in a terminal inside a running session's folder (needs VS Code shell integration).");
			return;
		}
		hideHint();
		const panel = await panelFor(failure.cwd);
		if (!panel) return;
		await panel.sendPrompt(
			inCheckout(
				failedCommandPrompt({
					commandLine: failure.commandLine || "(command line not reported by the shell)",
					cwd: failure.cwd,
					exitCode: failure.exitCode,
					output: failure.output,
				}),
				failure.cwd,
			),
		);
	});

	// ---------- change hovers ----------
	interface FileEdit {
		change: FileChange;
		entry: FileChangeEntry;
	}
	/** Per session: changes.jsonl stamp → that session's edits per file. */
	const editsCache = new Map<string, { stamp: string; byFile: Map<string, FileEdit[]> }>();
	/** toolCallId + path → texts that edit added (immutable once recorded). */
	const addedCache = new Map<string, Set<string>>();
	/** Transcript file → stamp + tool call → prompt. */
	const promptCache = new Map<string, { stamp: string; prompts: Map<string, string> }>();
	/** document + session → changed lines for a document version. */
	const linesCache = new Map<string, { version: number; stamp: string; lines: Set<number> }>();

	function stampOf(file: string): string | undefined {
		try {
			const st = fs.statSync(file);
			return `${st.size}:${st.mtimeMs}`;
		} catch {
			return undefined;
		}
	}

	function editsFor(sessionId: string, file: string): { stamp: string; edits: FileEdit[] } | undefined {
		const stamp = stampOf(path.join(sessionDir(sessionId), "changes.jsonl"));
		if (!stamp) return undefined;
		let cached = editsCache.get(sessionId);
		if (cached?.stamp !== stamp) {
			const byFile = new Map<string, FileEdit[]>();
			for (const change of sessions.changes(sessionId))
				for (const entry of change.files) {
					const list = byFile.get(entry.path) ?? [];
					list.push({ change, entry });
					byFile.set(entry.path, list);
				}
			cached = { stamp, byFile };
			editsCache.set(sessionId, cached);
		}
		const edits = cached.byFile.get(file);
		return edits?.length ? { stamp, edits } : undefined;
	}

	function blobText(sessionId: string, hash: string | null): string {
		if (!hash || hash === EMPTY_BLOB) return "";
		try {
			return fs.readFileSync(blobPath(sessionId, hash), "utf8");
		} catch {
			return "";
		}
	}

	function addedBy(sessionId: string, edit: FileEdit): Set<string> {
		const key = `${sessionId}\0${edit.change.toolCallId}\0${edit.entry.path}`;
		let added = addedCache.get(key);
		if (!added) {
			added = addedTexts(blobText(sessionId, edit.entry.before), blobText(sessionId, edit.entry.after));
			addedCache.set(key, added);
		}
		return added;
	}

	async function promptOf(meta: SessionMeta, toolCallId: string): Promise<string | undefined> {
		const file = meta.ompSessionFile;
		if (!file) return undefined;
		const stamp = stampOf(file);
		if (!stamp) return undefined;
		let cached = promptCache.get(file);
		if (cached?.stamp !== stamp) {
			try {
				cached = { stamp, prompts: promptsByToolCall(await fs.promises.readFile(file, "utf8")) };
			} catch {
				return undefined;
			}
			promptCache.set(file, cached);
		}
		return cached.prompts.get(toolCallId);
	}

	function commandLink(label: string, command: string, args: unknown[], tooltip: string): string {
		return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))} "${tooltip}")`;
	}

	context.subscriptions.push(
		vscode.languages.registerHoverProvider(
			{ scheme: "file" },
			{
				async provideHover(doc, position) {
					if (!vscode.workspace.getConfiguration("omp").get<boolean>("showChangeDecorations", true)) return undefined;
					const file = doc.uri.fsPath;
					const candidates = sessions.all().filter(m => m.changedFiles > 0 && (m.status !== "stopped" || sessions.inWorkspace(m)));
					for (const meta of candidates) {
						const found = editsFor(meta.id, file);
						if (!found) continue;
						const key = `${doc.uri.toString()}\0${meta.id}`;
						let lines = linesCache.get(key);
						if (lines?.version !== doc.version || lines.stamp !== found.stamp) {
							lines = { version: doc.version, stamp: found.stamp, lines: changedLines(blobText(meta.id, found.edits[0].entry.before), doc.getText()) };
							linesCache.set(key, lines);
						}
						if (!lines.lines.has(position.line + 1)) continue;
						const index = attributeLine(
							doc.lineAt(position.line).text,
							found.edits.map(e => ({ added: addedBy(meta.id, e) })),
						);
						const { change } = found.edits[index];
						const prompt = await promptOf(meta, change.toolCallId);
						const md = new vscode.MarkdownString();
						md.isTrusted = { enabledCommands: ["omp.openSession", "omp.openSessionFileDiff", "omp.revertFile"] };
						md.supportThemeIcons = true;
						md.appendMarkdown("$(sparkle) **Changed by omp** — ");
						md.appendText(meta.title);
						md.appendMarkdown("\n\n");
						if (prompt) {
							md.appendText(`“${excerpt(prompt, 100)}”`);
							md.appendMarkdown(" · ");
						}
						md.appendText(`${change.toolName} · ${relativeTime(change.timestamp)}`);
						md.appendMarkdown(
							`\n\n${[
								commandLink("Open chat", "omp.openSession", [meta.id], "Open the session's chat"),
								commandLink("Diff", "omp.openSessionFileDiff", [meta.id, file], "Diff against the content before the session touched this file"),
								commandLink("Revert file", "omp.revertFile", [meta.id, file], "Restore the content from before the session touched this file"),
							].join(" · ")}`,
						);
						return new vscode.Hover(md, doc.lineAt(position.line).range);
					}
					return undefined;
				},
			},
		),
		vscode.workspace.onDidCloseTextDocument(doc => {
			const prefix = `${doc.uri.toString()}\0`;
			for (const key of linesCache.keys()) if (key.startsWith(prefix)) linesCache.delete(key);
		}),
		sessions.onDidChange(() => {
			const live = new Set(sessions.all().map(m => m.id));
			for (const id of editsCache.keys()) if (!live.has(id)) editsCache.delete(id);
		}),
	);
}
