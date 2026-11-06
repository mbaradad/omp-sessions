import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { diffTexts } from "../shared/diff";
import { EMPTY_BLOB, type SessionMeta, blobPath } from "../shared/protocol";
import type { SnapshotProvider } from "./diff";
import type { ChatPanel } from "./panel";
import type { SessionManager } from "./sessions";

export interface IntegrationApi {
	sessions: SessionManager;
	snapshots: SnapshotProvider;
	targetPanel(cwdHint?: string): Promise<ChatPanel | undefined>;
}

/** Files a session touched, with the content hash before the session first touched each (null = absent). */
interface SessionFiles {
	changedFiles: number;
	baseline: Map<string, string | null>;
}

const SNIPPET_CONTEXT = 3;

function decorationsEnabled(): boolean {
	return vscode.workspace.getConfiguration("omp").get<boolean>("showChangeDecorations", true);
}

/** Path as the session sees it: relative to its cwd when inside it, else absolute. */
function sessionPath(file: string, cwd: string | undefined): string {
	if (!cwd) return file;
	const rel = path.relative(cwd, file);
	if (rel === "") return ".";
	return rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}

function fence(text: string, lang = ""): string {
	const ticks = text.includes("```") ? "````" : "```";
	return `${ticks}${lang}\n${text.replace(/\n$/, "")}\n${ticks}`;
}

function baselineText(sessionId: string, hash: string | null): string {
	if (!hash || hash === EMPTY_BLOB) return "";
	try {
		return fs.readFileSync(blobPath(sessionId, hash), "utf8");
	} catch {
		return "";
	}
}

function isFileNode(arg: unknown): arg is { kind: "file"; sessionId: string; file: string } {
	return !!arg && typeof arg === "object" && "kind" in arg && arg.kind === "file" && "sessionId" in arg && typeof arg.sessionId === "string" && "file" in arg && typeof arg.file === "string";
}

export function registerEditorIntegration(context: vscode.ExtensionContext, api: IntegrationApi): void {
	const { sessions } = api;
	const reg = (name: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));

	async function panelFor(uri: vscode.Uri | undefined): Promise<ChatPanel | undefined> {
		const panel = await api.targetPanel(uri ? vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath : undefined);
		if (!panel) void vscode.window.showInformationMessage("Open or start an omp session first.");
		return panel;
	}

	// ---------- code actions ----------
	function snippet(doc: vscode.TextDocument, range: vscode.Range, cwd: string | undefined): string {
		const first = Math.max(0, range.start.line - SNIPPET_CONTEXT);
		const last = Math.min(doc.lineCount - 1, range.end.line + SNIPPET_CONTEXT);
		const text = doc.getText(new vscode.Range(first, 0, last, doc.lineAt(last).text.length));
		return `${sessionPath(doc.uri.fsPath, cwd)}:${first + 1}-${last + 1}\n${fence(text, doc.languageId)}`;
	}

	function selectionRef(doc: vscode.TextDocument, range: vscode.Range, cwd: string | undefined): string {
		const a = range.start.line + 1;
		const b = range.end.character === 0 && range.end.line > range.start.line ? range.end.line : range.end.line + 1;
		return `${sessionPath(doc.uri.fsPath, cwd)}:${b !== a ? `${a}-${b}` : a}\n${fence(doc.getText(range), doc.languageId)}`;
	}

	function describeDiagnostic(d: vscode.Diagnostic): string {
		const code = typeof d.code === "object" ? d.code.value : d.code;
		const origin = [d.source, code !== undefined ? String(code) : ""].filter(Boolean).join(" ");
		const severity = vscode.DiagnosticSeverity[d.severity].toLowerCase();
		return `- line ${d.range.start.line + 1}: ${severity}${origin ? ` (${origin})` : ""}: ${d.message}`;
	}

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ scheme: "file" },
			{
				provideCodeActions(doc, range, ctx) {
					const actions: vscode.CodeAction[] = [];
					if (ctx.diagnostics.length > 0) {
						const fix = new vscode.CodeAction(`Fix with omp${ctx.diagnostics.length > 1 ? ` (${ctx.diagnostics.length} problems)` : ""}`, vscode.CodeActionKind.QuickFix);
						fix.diagnostics = [...ctx.diagnostics];
						fix.isPreferred = false;
						fix.command = { command: "omp.fixDiagnostics", title: "Fix with omp", arguments: [doc.uri, range, [...ctx.diagnostics]] };
						actions.push(fix);
					}
					if (!range.isEmpty) {
						const explain = new vscode.CodeAction("Explain with omp", vscode.CodeActionKind.Empty);
						explain.command = { command: "omp.explainSelection", title: "Explain with omp", arguments: [doc.uri, range] };
						const ask = new vscode.CodeAction("Ask omp about this…", vscode.CodeActionKind.Empty);
						ask.command = { command: "omp.askAboutSelection", title: "Ask omp about this…", arguments: [doc.uri, range] };
						actions.push(explain, ask);
					}
					return actions;
				},
			},
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty] },
		),
	);

	/** Command args from a code action, or the active editor's selection when run from the palette/menu. */
	async function resolveTarget(uriArg: unknown, rangeArg: unknown): Promise<{ doc: vscode.TextDocument; range: vscode.Range } | undefined> {
		if (uriArg instanceof vscode.Uri && rangeArg instanceof vscode.Range) return { doc: await vscode.workspace.openTextDocument(uriArg), range: rangeArg };
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.scheme !== "file") return undefined;
		return { doc: editor.document, range: editor.selection };
	}

	reg("omp.fixDiagnostics", async (uriArg?: unknown, rangeArg?: unknown, diagArg?: unknown) => {
		const target = await resolveTarget(uriArg, rangeArg);
		if (!target) return;
		const { doc, range } = target;
		const diagnostics = Array.isArray(diagArg)
			? diagArg.filter((d): d is vscode.Diagnostic => d instanceof vscode.Diagnostic)
			: vscode.languages.getDiagnostics(doc.uri).filter(d => d.range.intersection(range) !== undefined);
		if (diagnostics.length === 0) {
			void vscode.window.showInformationMessage("No problems at the cursor.");
			return;
		}
		const panel = await panelFor(doc.uri);
		if (!panel) return;
		const cwd = panel.meta?.cwd;
		const span = diagnostics.reduce((acc, d) => acc.union(d.range), diagnostics[0].range);
		const where = `${sessionPath(doc.uri.fsPath, cwd)}:${span.start.line + 1}`;
		const text = `Fix ${diagnostics.length === 1 ? "this problem" : "these problems"} in ${where}:\n${diagnostics.map(describeDiagnostic).join("\n")}\n\n${snippet(doc, span, cwd)}`;
		await panel.sendPrompt(text);
	});

	reg("omp.explainSelection", async (uriArg?: unknown, rangeArg?: unknown) => {
		const target = await resolveTarget(uriArg, rangeArg);
		if (!target || target.range.isEmpty) return;
		const panel = await panelFor(target.doc.uri);
		if (!panel) return;
		await panel.sendPrompt(`Explain this code:\n${selectionRef(target.doc, target.range, panel.meta?.cwd)}`);
	});

	reg("omp.askAboutSelection", async (uriArg?: unknown, rangeArg?: unknown) => {
		const target = await resolveTarget(uriArg, rangeArg);
		if (!target || target.range.isEmpty) return;
		const panel = await panelFor(target.doc.uri);
		if (!panel) return;
		panel.reveal();
		panel.insertText(`${selectionRef(target.doc, target.range, panel.meta?.cwd)}\n`);
		panel.focusComposer();
	});

	// ---------- add to chat ----------
	reg("omp.addToChat", async (uriArg?: unknown, urisArg?: unknown) => {
		let uris: vscode.Uri[] = [];
		if (Array.isArray(urisArg)) uris = urisArg.filter((u): u is vscode.Uri => u instanceof vscode.Uri);
		if (uris.length === 0 && uriArg instanceof vscode.Uri) uris = [uriArg];
		if (uris.length === 0) {
			const active = vscode.window.activeTextEditor?.document.uri;
			if (active) uris = [active];
		}
		uris = uris.filter(u => u.scheme === "file");
		if (uris.length === 0) return;
		const panel = await panelFor(uris[0]);
		if (!panel) return;
		const cwd = panel.meta?.cwd;
		const refs = await Promise.all(
			uris.map(async u => {
				let dir = false;
				try {
					dir = ((await vscode.workspace.fs.stat(u)).type & vscode.FileType.Directory) !== 0;
				} catch {
					/* treat as file */
				}
				const p = sessionPath(u.fsPath, cwd);
				return `@${dir && !p.endsWith("/") ? `${p}/` : p}`;
			}),
		);
		panel.reveal();
		panel.insertText(`${refs.join(" ")} `);
		panel.focusComposer();
	});

	// ---------- terminal selection ----------
	reg("omp.sendTerminalSelection", async () => {
		const previous = await vscode.env.clipboard.readText();
		let selection = "";
		try {
			await vscode.env.clipboard.writeText("");
			await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
			selection = await vscode.env.clipboard.readText();
		} finally {
			await vscode.env.clipboard.writeText(previous);
		}
		if (!selection.trim()) {
			void vscode.window.showInformationMessage("Select some terminal output first.");
			return;
		}
		const cwd = vscode.window.activeTerminal?.shellIntegration?.cwd;
		const panel = await panelFor(cwd?.scheme === "file" ? cwd : vscode.window.activeTextEditor?.document.uri);
		if (!panel) return;
		panel.reveal();
		panel.insertText(`${fence(selection, "text")}\n`);
		panel.focusComposer();
	});

	// ---------- per-session file baselines ----------
	const fileCache = new Map<string, SessionFiles>();

	/** Files touched by `meta`, re-reading changes.jsonl only when the session's distinct-file count moved. */
	function filesOf(meta: SessionMeta): SessionFiles {
		const cached = fileCache.get(meta.id);
		if (cached && cached.changedFiles === meta.changedFiles) return cached;
		const baseline = new Map<string, string | null>();
		if (meta.changedFiles > 0) for (const c of sessions.changes(meta.id)) for (const f of c.files) if (!baseline.has(f.path)) baseline.set(f.path, f.before);
		const next = { changedFiles: meta.changedFiles, baseline };
		fileCache.set(meta.id, next);
		return next;
	}

	function relevantSessions(): SessionMeta[] {
		return sessions.all().filter(m => m.changedFiles > 0 && (m.status !== "stopped" || sessions.inWorkspace(m)));
	}

	// ---------- explorer decorations ----------
	const decoEmitter = new vscode.EventEmitter<vscode.Uri[]>();
	/** Path → title of the session shown in the badge tooltip. */
	let decorated = new Map<string, string>();

	function computeDecorated(): Map<string, string> {
		const next = new Map<string, string>();
		if (!decorationsEnabled()) return next;
		for (const m of relevantSessions()) for (const file of filesOf(m).baseline.keys()) if (!next.has(file)) next.set(file, m.title);
		return next;
	}

	function refreshDecorations(): void {
		const next = computeDecorated();
		const changed: vscode.Uri[] = [];
		for (const [file, title] of next) if (decorated.get(file) !== title) changed.push(vscode.Uri.file(file));
		for (const file of decorated.keys()) if (!next.has(file)) changed.push(vscode.Uri.file(file));
		decorated = next;
		if (changed.length > 0) decoEmitter.fire(changed);
	}

	context.subscriptions.push(
		decoEmitter,
		vscode.window.registerFileDecorationProvider({
			onDidChangeFileDecorations: decoEmitter.event,
			provideFileDecoration(uri) {
				if (uri.scheme !== "file") return undefined;
				const title = decorated.get(uri.fsPath);
				if (title === undefined) return undefined;
				return { badge: "π", color: new vscode.ThemeColor("charts.purple"), tooltip: `Changed by omp: ${title}` };
			},
		}),
	);

	// ---------- editor gutter + CodeLens ----------
	const border = (style: string) => ({
		isWholeLine: true,
		borderColor: new vscode.ThemeColor("charts.purple"),
		borderStyle: style,
		borderWidth: "0 0 0 3px",
		overviewRulerColor: new vscode.ThemeColor("charts.purple"),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	const addedType = vscode.window.createTextEditorDecorationType(border("solid"));
	const modifiedType = vscode.window.createTextEditorDecorationType(border("double"));
	const deletedType = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderColor: new vscode.ThemeColor("charts.purple"),
		borderStyle: "dotted",
		borderWidth: "1px 0 0 0",
		overviewRulerColor: new vscode.ThemeColor("charts.purple"),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	context.subscriptions.push(addedType, modifiedType, deletedType);

	interface FileStats {
		session: SessionMeta;
		added: number;
		removed: number;
	}
	/** Per-document diff stats against each touching session's baseline, keyed by document URI. */
	const stats = new Map<string, FileStats[]>();
	const lensEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(lensEmitter);

	function decorateEditor(editor: vscode.TextEditor): void {
		const doc = editor.document;
		// Most relevant first: running before stopped, then most recent.
		const touching = doc.uri.scheme === "file" && decorationsEnabled() ? relevantSessions().filter(m => filesOf(m).baseline.has(doc.uri.fsPath)) : [];
		const current = doc.getText();
		const fileStats: FileStats[] = [];
		const added: vscode.DecorationOptions[] = [];
		const modified: vscode.DecorationOptions[] = [];
		const deleted: vscode.DecorationOptions[] = [];
		touching.forEach((session, index) => {
			const diff = diffTexts(baselineText(session.id, filesOf(session).baseline.get(doc.uri.fsPath) ?? null), current, 1);
			if (diff.added === 0 && diff.removed === 0) return;
			fileStats.push({ session, added: diff.added, removed: diff.removed });
			if (index > 0) return; // gutter shows the most relevant session only
			// Hovers for these lines come from editor-plus.ts (session, prompt, links).
			const at = (n: number): vscode.DecorationOptions => ({ range: doc.lineAt(Math.min(Math.max(0, n - 1), doc.lineCount - 1)).range });
			// Walk each run of consecutive -/+ lines: + lines are "added" (pure insert) or "modified" (replaced
			// something); a run with only - lines marks the line after the last kept one.
			for (const hunk of diff.hunks) {
				let lastNew = hunk.newStart - 1;
				let removedInRun = 0;
				let run: number[] = [];
				const flush = () => {
					if (run.length > 0) for (const n of run) (removedInRun > 0 ? modified : added).push(at(n));
					else if (removedInRun > 0) deleted.push(at(lastNew + 1));
					run = [];
					removedInRun = 0;
				};
				for (const l of hunk.lines) {
					if (l.t === "-") removedInRun++;
					else if (l.t === "+" && l.n !== undefined) run.push(l.n);
					else {
						flush();
						lastNew = l.n ?? lastNew;
					}
				}
				flush();
			}
		});
		editor.setDecorations(addedType, added);
		editor.setDecorations(modifiedType, modified);
		editor.setDecorations(deletedType, deleted);
		const key = doc.uri.toString();
		const before = stats.get(key);
		const same = (before ?? []).length === fileStats.length && fileStats.every((s, i) => before?.[i].session.id === s.session.id && before[i].session.title === s.session.title && before[i].added === s.added && before[i].removed === s.removed);
		if (fileStats.length > 0) stats.set(key, fileStats);
		else stats.delete(key);
		if (!same) lensEmitter.fire();
	}

	function decorateVisible(): void {
		for (const editor of vscode.window.visibleTextEditors) decorateEditor(editor);
		const visible = new Set(vscode.window.visibleTextEditors.map(e => e.document.uri.toString()));
		for (const key of stats.keys()) if (!visible.has(key)) stats.delete(key);
	}

	const pending = new Map<string, NodeJS.Timeout>();
	function scheduleDocument(doc: vscode.TextDocument): void {
		const key = doc.uri.toString();
		if (!vscode.window.visibleTextEditors.some(e => e.document.uri.toString() === key)) return;
		clearTimeout(pending.get(key));
		pending.set(
			key,
			setTimeout(() => {
				pending.delete(key);
				for (const editor of vscode.window.visibleTextEditors) if (editor.document.uri.toString() === key) decorateEditor(editor);
			}, 300),
		);
	}

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			{ scheme: "file" },
			{
				onDidChangeCodeLenses: lensEmitter.event,
				provideCodeLenses(doc) {
					const fileStats = stats.get(doc.uri.toString());
					if (!fileStats || !decorationsEnabled()) return [];
					const top = new vscode.Range(0, 0, 0, 0);
					return fileStats.flatMap(({ session, added, removed }) => [
						new vscode.CodeLens(top, { title: `π omp changed this file · +${added} −${removed}`, tooltip: `"${session.title}" — diff against the content before the session touched this file`, command: "omp.openSessionFileDiff", arguments: [session.id, doc.uri.fsPath] }),
						new vscode.CodeLens(top, { title: "Revert", tooltip: "Restore the content from before the session touched this file", command: "omp.revertFile", arguments: [session.id, doc.uri.fsPath] }),
						new vscode.CodeLens(top, { title: "Open chat", command: "omp.openSession", arguments: [session.id] }),
					]);
				},
			},
		),
		vscode.window.onDidChangeVisibleTextEditors(decorateVisible),
		vscode.workspace.onDidChangeTextDocument(e => {
			if (e.contentChanges.length > 0) scheduleDocument(e.document);
		}),
		vscode.workspace.onDidSaveTextDocument(scheduleDocument),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration("omp.showChangeDecorations")) return;
			refreshDecorations();
			decorateVisible();
		}),
		sessions.onDidChange(() => {
			const live = new Set(sessions.all().map(m => m.id));
			for (const id of fileCache.keys()) if (!live.has(id)) fileCache.delete(id);
			refreshDecorations();
			decorateVisible();
		}),
		{
			dispose: () => {
				for (const t of pending.values()) clearTimeout(t);
				pending.clear();
			},
		},
	);
	refreshDecorations();
	decorateVisible();

	// ---------- revert ----------
	reg("omp.revertFile", async (arg?: unknown, fileArg?: unknown) => {
		let sessionId: string | undefined;
		let file: string | undefined;
		if (typeof arg === "string" && typeof fileArg === "string") {
			sessionId = arg;
			file = fileArg;
		} else if (isFileNode(arg)) {
			sessionId = arg.sessionId;
			file = arg.file;
		}
		if (!sessionId || !file) return;
		const meta = sessions.get(sessionId);
		const firstBefore = sessions
			.changes(sessionId)
			.flatMap(c => c.files)
			.find(f => f.path === file);
		if (!meta || !firstBefore) {
			void vscode.window.showWarningMessage("That session has no recorded changes for this file.");
			return;
		}
		const shown = sessionPath(file, meta.cwd);
		const deletes = firstBefore.before === null;
		const ok = await vscode.window.showWarningMessage(
			`Revert ${shown} to its content before "${meta.title}" changed it?`,
			{ modal: true, detail: deletes ? "The session created this file; reverting deletes it." : "Unsaved and later edits to this file are lost." },
			deletes ? "Delete File" : "Revert",
		);
		if (!ok) return;
		const uri = vscode.Uri.file(file);
		try {
			if (deletes) {
				await vscode.workspace.fs.delete(uri, { useTrash: true });
			} else {
				const hash = firstBefore.before;
				const content = hash && hash !== EMPTY_BLOB ? await vscode.workspace.fs.readFile(vscode.Uri.file(blobPath(sessionId, hash))) : new Uint8Array();
				await vscode.workspace.fs.writeFile(uri, content);
			}
		} catch (err) {
			void vscode.window.showErrorMessage(`Could not revert ${shown}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		void vscode.window.showInformationMessage(deletes ? `Deleted ${shown} (created by "${meta.title}").` : `Reverted ${shown} to its content before "${meta.title}".`);
		decorateVisible();
	});
}
