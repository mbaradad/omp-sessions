import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { type LaunchOptions, sendToHost } from "../shared/launch";
import { OrganizeStore, organizeFile } from "../shared/organize";
import { type SessionMeta, sessionDir } from "../shared/protocol";
import type { OmpApi } from "./api";
import { registerAgentSkill } from "./agent-skill";
import { registerBoard } from "./board";
import { registerBridge } from "./bridge";
import { registerChatContext } from "./chat-context";
import { registerDashboard } from "./dashboard";
import { SNAPSHOT_SCHEME, SnapshotProvider, openSessionDiff } from "./diff";
import { registerDoctor } from "./doctor";
import { registerEditorPlus } from "./editor-plus";
import { registerHermesPlugin } from "./hermes";
import { registerEditorIntegration } from "./integration";
import { askLaunchOptions } from "./launch-options";
import { ChatPanel, VIEW_TYPE, panelSurface, viewSurface } from "./panel";
import { OmpMissingError, SessionManager, listOmpHistory } from "./sessions";
import { registerPermissions } from "./permissions";
import { registerOrganize } from "./organize";
import { registerScheduler } from "./scheduler";
import { registerRemote } from "./remote";
import { registerServer } from "./server";
import { registerSessionConfig } from "./session-config";
import { registerTasks } from "./tasks";
import { type Node, SessionTree } from "./tree";
import { registerToolbox } from "./toolbox";
import { registerWorktrees } from "./worktree";

const panels = new Map<string, ChatPanel>();
let lastActive: ChatPanel | undefined;

function idFrom(arg: unknown): string | undefined {
	if (typeof arg === "string") return arg;
	if (arg && typeof arg === "object" && "kind" in arg) {
		const node = arg as Node;
		if (node.kind === "session") return node.meta.id;
		if (node.kind === "file") return node.sessionId;
	}
	return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
	const hostScript = vscode.Uri.joinPath(context.extensionUri, "out", "host.js").fsPath;
	const sessions = new SessionManager(hostScript);
	const snapshots = new SnapshotProvider();
	// Sessions that finished or asked something while their chat was not in view.
	const unread = new Set<string>(context.globalState.get<string[]>("omp.unread") ?? []);
	const setUnread = (id: string, value: boolean) => {
		if (unread.has(id) === value) return;
		if (value) unread.add(id);
		else unread.delete(id);
		void context.globalState.update("omp.unread", [...unread]);
		tree.refresh();
		updateStatus();
	};
	// User organization (groups, colors, pins, priorities); shared with other windows through the file.
	const organize = new OrganizeStore(organizeFile(), id => sessions.get(id)?.createdAt);
	const organizeWatch = organize.watch();
	context.subscriptions.push({ dispose: () => organizeWatch.dispose() });
	const tree = new SessionTree(sessions, id => unread.has(id), organize);
	const treeView = vscode.window.createTreeView("omp.sessions", { treeDataProvider: tree, dragAndDropController: tree, canSelectMany: true, showCollapseAll: true });
	context.subscriptions.push(sessions, treeView, vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshots));

	// ---------- panels ----------
	const chatIcon = vscode.Uri.joinPath(context.extensionUri, "media", "omp-color.svg");
	function adopt(id: string, webviewPanel: vscode.WebviewPanel): ChatPanel {
		const panel = new ChatPanel(id, panelSurface(webviewPanel, chatIcon), sessions, snapshots, context.extensionUri, context.globalState, organize);
		panels.set(id, panel);
		lastActive = panel;
		webviewPanel.onDidChangeViewState(e => {
			if (e.webviewPanel.active) lastActive = panel;
			if (e.webviewPanel.visible) setUnread(id, false);
		});
		setUnread(id, false);
		panel.onDidDispose(() => {
			if (panels.get(id) === panel) panels.delete(id);
			if (lastActive === panel) lastActive = undefined;
		});
		return panel;
	}

	// ---------- side bar chat (a view, so it can live in the side bar, panel or secondary side bar) ----------
	let sideView: vscode.WebviewView | undefined;
	let sideChat: ChatPanel | undefined;
	let pendingSide: string | undefined;
	const sidePlaceholder = (view: vscode.WebviewView) => {
		view.webview.options = { enableCommandUris: true };
		view.description = undefined;
		view.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);padding:16px;line-height:1.6">
<p>Open an omp session here: pick one in the Sessions view and choose <b>Open in Side Bar</b>, or set <code>omp.chatLocation</code> to <code>sidebar</code>.</p>
<p><a href="command:omp.openInSidebar">Choose a session…</a> · <a href="command:omp.newSession">New session</a></p></body></html>`;
	};
	function showInSidebar(id: string): ChatPanel | undefined {
		pendingSide = id;
		void context.workspaceState.update("omp.sidebarSession", id);
		if (!sideView) {
			void vscode.commands.executeCommand("omp.chatView.focus");
			return undefined;
		}
		if (sideChat?.sessionId !== id) {
			sideChat?.dispose();
			const chat = new ChatPanel(id, viewSurface(sideView), sessions, snapshots, context.extensionUri, context.globalState, organize);
			chat.onDidDispose(() => {
				if (sideChat === chat) sideChat = undefined;
				if (lastActive === chat) lastActive = undefined;
			});
			sideChat = chat;
		}
		setUnread(id, false);
		lastActive = sideChat;
		sideView.show(false);
		return sideChat;
	}
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			"omp.chatView",
			{
				resolveWebviewView(view) {
					sideView = view;
					view.onDidDispose(() => {
						sideChat?.dispose();
						sideChat = undefined;
						sideView = undefined;
					});
					view.onDidChangeVisibility(() => {
						if (view.visible && sideChat) {
							lastActive = sideChat;
							setUnread(sideChat.sessionId, false);
						}
					});
					const id = pendingSide ?? context.workspaceState.get<string>("omp.sidebarSession");
					if (id && sessions.get(id)) showInSidebar(id);
					else sidePlaceholder(view);
				},
			},
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
	);

	function openPanel(id: string, where?: "editor" | "sidebar"): ChatPanel | undefined {
		const meta = sessions.get(id);
		if (!meta) {
			void vscode.window.showWarningMessage("That omp session no longer exists.");
			return undefined;
		}
		if ((where ?? vscode.workspace.getConfiguration("omp").get<string>("chatLocation")) === "sidebar") return showInSidebar(id);
		const existing = panels.get(id);
		if (existing) {
			existing.reveal();
			return existing;
		}
		const column = vscode.workspace.getConfiguration("omp").get<string>("panelLocation") === "active" ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
		const webviewPanel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			meta.title,
			{ viewColumn: column, preserveFocus: false },
			// The chat's own find bar (Ctrl/Cmd+F) also searches earlier, not yet rendered messages.
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		return adopt(id, webviewPanel);
	}

	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: unknown) {
				const id = state && typeof state === "object" && "sessionId" in state && typeof state.sessionId === "string" ? state.sessionId : undefined;
				if (!id || !sessions.get(id) || panels.has(id)) {
					webviewPanel.dispose();
					return;
				}
				adopt(id, webviewPanel);
			},
		}),
	);

	// ---------- helpers ----------
	async function pickFolder(arg?: unknown): Promise<string | undefined> {
		if (typeof arg === "string" && arg) return arg;
		if (arg && typeof arg === "object" && "kind" in arg && (arg as Node).kind === "project") return (arg as Extract<Node, { kind: "project" }>).root;
		if (arg instanceof vscode.Uri) {
			const stat = await vscode.workspace.fs.stat(arg);
			return stat.type & vscode.FileType.Directory ? arg.fsPath : path.dirname(arg.fsPath);
		}
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === "file");
		if (folders.length === 1) return folders[0].uri.fsPath;
		if (folders.length > 1) {
			const activeFile = vscode.window.activeTextEditor?.document.uri;
			const preferred = activeFile ? vscode.workspace.getWorkspaceFolder(activeFile) : undefined;
			const pick = await vscode.window.showQuickPick(
				folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f, picked: f === preferred })),
				{ placeHolder: "Folder for the omp session" },
			);
			return pick?.folder.uri.fsPath;
		}
		const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Start omp here" });
		return chosen?.[0]?.fsPath;
	}

	async function launchAndOpen(opts: LaunchOptions): Promise<ChatPanel | undefined> {
		let id: string;
		try {
			id = sessions.launch(opts);
		} catch (err) {
			// A missing omp gets the doctor's install/set-path notification instead.
			if (!(err instanceof OmpMissingError)) void vscode.window.showErrorMessage(String((err as Error).message ?? err));
			return undefined;
		}
		const ok = await sessions.waitForSocket(id);
		sessions.refresh();
		if (!ok) {
			const reason = sessions.get(id)?.exitReason;
			void vscode.window.showErrorMessage(`omp session did not start${reason ? `: ${reason}` : ""}.`, "Open log").then(a => {
				if (a) void vscode.window.showTextDocument(vscode.Uri.file(path.join(sessionDir(id), "host.log")));
			});
		}
		return openPanel(id);
	}

	async function pickSession(placeHolder: string, filter: (m: SessionMeta) => boolean = () => true): Promise<string | undefined> {
		const items = sessions
			.all()
			.filter(filter)
			.map(m => ({
				label: `${m.status === "working" ? "$(loading~spin)" : m.status === "waiting" ? "$(bell-dot)" : m.status === "stopped" ? "$(circle-outline)" : "$(pass-filled)"} ${m.title}`,
				description: `${m.status} · ${path.basename(m.cwd)}`,
				detail: m.cwd,
				id: m.id,
			}));
		if (items.length === 0) return undefined;
		return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true }))?.id;
	}

	/** Chat panel that editor integrations send to: the active chat when it belongs to `cwdHint`, else a related open chat, else ask. */
	async function targetPanel(cwdHint?: string): Promise<ChatPanel | undefined> {
		const within = (child: string, parent: string) => {
			const rel = path.relative(parent, child);
			return !rel.startsWith("..") && !path.isAbsolute(rel);
		};
		const related = (m: SessionMeta | undefined): m is SessionMeta => !!m && (!cwdHint || within(cwdHint, m.cwd) || within(m.cwd, cwdHint));
		if (lastActive && related(lastActive.meta)) return lastActive;
		const open = [...panels.values()].find(p => related(p.meta) && p.meta.status !== "stopped");
		if (open) return open;
		const candidates = sessions.all().filter(m => m.status !== "stopped" && sessions.inWorkspace(m) && related(m));
		if (candidates.length === 0 && lastActive) return lastActive;
		const id = candidates.length === 1 ? candidates[0].id : await pickSession("Send to which omp session?", m => m.status !== "stopped" && sessions.inWorkspace(m) && (candidates.length === 0 || related(m)));
		return id ? openPanel(id) : undefined;
	}

	// ---------- commands ----------
	const reg = (name: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));

	reg("omp.newSession", async (arg?: unknown) => {
		const cwd = await pickFolder(arg);
		if (cwd) await launchAndOpen({ cwd });
	});

	reg("omp.newSessionWithOptions", async (arg?: unknown) => {
		const cwd = await pickFolder(arg);
		if (!cwd) return;
		const opts = await askLaunchOptions(cwd);
		if (opts) await launchAndOpen({ cwd, ...opts });
	});

	reg("omp.openSession", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Open omp session"));
		if (id) openPanel(id)?.focusComposer();
	});

	reg("omp.openInSidebar", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Open which session in the side bar?"));
		if (id) showInSidebar(id)?.focusComposer();
	});

	reg("omp.openInEditor", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Open which session in an editor tab?"));
		if (id) openPanel(id, "editor")?.focusComposer();
	});

	reg("omp.focus", async () => {
		if (lastActive) {
			lastActive.reveal();
			lastActive.focusComposer();
			return;
		}
		const running = sessions.all().find(m => m.status !== "stopped" && sessions.inWorkspace(m));
		if (running) openPanel(running.id)?.focusComposer();
		else await vscode.commands.executeCommand("omp.newSession");
	});

	reg("omp.stopSession", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Stop which session?", m => m.status !== "stopped"));
		const meta = id ? sessions.get(id) : undefined;
		if (!meta || meta.status === "stopped") return;
		if (meta.status === "working") {
			const ok = await vscode.window.showWarningMessage(`"${meta.title}" is working. Stop it?`, { modal: true, detail: "The omp process exits; the transcript is kept and can be resumed." }, "Stop");
			if (ok !== "Stop") return;
		}
		if (!(await sendToHost(meta, { t: "stop" }))) {
			try {
				process.kill(meta.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
		}
	});

	reg("omp.resumeSession", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Resume which session?", m => m.status === "stopped"));
		const meta = id ? sessions.get(id) : undefined;
		if (!meta) return;
		if (meta.status !== "stopped") {
			openPanel(meta.id);
			return;
		}
		await launchAndOpen({ cwd: meta.cwd, id: meta.id });
	});

	reg("omp.deleteSession", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Delete which stopped session?", m => m.status === "stopped"));
		const meta = id ? sessions.get(id) : undefined;
		if (!meta) return;
		if (meta.status !== "stopped") {
			void vscode.window.showWarningMessage("Stop the session before deleting it.");
			return;
		}
		const ok = await vscode.window.showWarningMessage(
			`Remove "${meta.title}" from the list?`,
			{ modal: true, detail: "Deletes the VS Code session record and file snapshots. The omp transcript stays in ~/.omp/agent/sessions." },
			"Remove",
		);
		if (ok !== "Remove") return;
		panels.get(meta.id)?.dispose();
		sessions.remove(meta.id);
	});

	reg("omp.renameSession", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Rename which session?"));
		const meta = id ? sessions.get(id) : undefined;
		if (!meta) return;
		const title = (await vscode.window.showInputBox({ prompt: "Session title", value: meta.title }))?.trim();
		if (!title || title === meta.title) return;
		if (meta.status !== "stopped") await sendToHost(meta, { t: "rename", title });
		else {
			const file = path.join(path.dirname(meta.socket), "meta.json");
			fs.writeFileSync(file, JSON.stringify({ ...meta, title, updatedAt: Date.now() }, null, 1));
			sessions.refresh();
		}
	});

	reg("omp.showChanges", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Show changes of which session?"));
		const meta = id ? sessions.get(id) : undefined;
		if (!meta) return;
		const changes = sessions.changes(meta.id);
		const files = [...new Set(changes.flatMap(c => c.files.map(f => f.path)))];
		if (files.length === 0) {
			void vscode.window.showInformationMessage("This session has not changed any files yet.");
			return;
		}
		const pick = await vscode.window.showQuickPick(
			files.map(f => ({ label: path.basename(f), description: path.relative(meta.cwd, path.dirname(f)) || ".", file: f, iconPath: vscode.ThemeIcon.File, resourceUri: vscode.Uri.file(f) })),
			{ placeHolder: `${files.length} file(s) changed by "${meta.title}"` },
		);
		if (pick) await openSessionDiff(snapshots, meta.id, changes, pick.file, panels.get(meta.id)?.surface.viewColumn);
	});

	reg("omp.openSessionFileDiff", async (sessionId: unknown, file: unknown) => {
		if (typeof sessionId !== "string" || typeof file !== "string") return;
		await openSessionDiff(snapshots, sessionId, sessions.changes(sessionId), file, panels.get(sessionId)?.surface.viewColumn);
	});

	reg("omp.reviewChanges", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Review changes of which session?"));
		const meta = id ? sessions.get(id) : undefined;
		if (!meta) return;
		const firstBefore = new Map<string, string | null>();
		for (const c of sessions.changes(meta.id)) for (const f of c.files) if (!firstBefore.has(f.path)) firstBefore.set(f.path, f.before);
		if (firstBefore.size === 0) {
			void vscode.window.showInformationMessage("This session has not changed any files yet.");
			return;
		}
		const resources = [...firstBefore].map(([file, before]) => {
			const left = snapshots.blobUri(file, meta.id, before, "session start");
			const right = fs.existsSync(file) ? vscode.Uri.file(file) : snapshots.blobUri(file, meta.id, null, "deleted");
			return [vscode.Uri.file(file), left, right];
		});
		await vscode.commands.executeCommand("vscode.changes", `omp: ${meta.title} — ${resources.length} file${resources.length === 1 ? "" : "s"} changed`, resources);
	});

	reg("omp.resumeFromHistory", async (arg?: unknown) => {
		const cwd = await pickFolder(arg);
		if (!cwd) return;
		const history = listOmpHistory(cwd);
		if (history.length === 0) {
			void vscode.window.showInformationMessage(`No omp transcripts recorded for ${cwd}.`);
			return;
		}
		const pick = await vscode.window.showQuickPick(
			history.slice(0, 200).map(h => ({ label: h.title, description: new Date(h.mtime).toLocaleString(), detail: path.basename(h.file), entry: h })),
			{ placeHolder: "Resume an omp transcript in the background", matchOnDetail: true },
		);
		if (pick) await launchAndOpen({ cwd, resumeFile: pick.entry.file, title: pick.entry.title.slice(0, 80) });
	});

	reg("omp.sendSelection", async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const doc = editor.document;
		const sel = editor.selection;
		const target = await targetPanel(doc.uri.scheme === "file" ? vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath : undefined);
		if (!target) {
			void vscode.window.showInformationMessage("Open or start an omp session first.");
			return;
		}
		const cwd = target.meta?.cwd ?? "";
		const rel = doc.uri.scheme === "file" ? path.relative(cwd, doc.uri.fsPath) : doc.uri.toString();
		const shown = rel.startsWith("..") ? doc.uri.fsPath : rel;
		let text: string;
		if (sel.isEmpty) text = `@${shown} `;
		else {
			const a = sel.start.line + 1;
			const b = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
			text = `${shown}:${a}${b !== a ? `-${b}` : ""}\n\`\`\`${doc.languageId}\n${doc.getText(sel)}\n\`\`\`\n`;
		}
		target.reveal();
		target.insertText(text);
	});

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("omp.groupBy") || e.affectsConfiguration("omp.sortBy") || e.affectsConfiguration("omp.showAllSessions")) tree.refresh();
		}),
	);

	// ---------- Source Control: hand git chores to the session working in that repository ----------
	const repoRoot = (arg: unknown): string | undefined => {
		const root = arg && typeof arg === "object" && "rootUri" in arg && arg.rootUri instanceof vscode.Uri ? arg.rootUri : undefined;
		return root?.fsPath ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === "file")?.uri.fsPath;
	};
	const scmPrompt = (prompt: string) => async (arg?: unknown) => {
		const panel = await targetPanel(repoRoot(arg));
		if (!panel) {
			void vscode.window.showInformationMessage("Start an omp session for this repository first.");
			return;
		}
		await panel.sendPrompt(prompt);
	};
	reg(
		"omp.scm.commit",
		scmPrompt(
			"Look at the git changes in this repository (`git status`, `git diff`, `git diff --staged`). Group them into sensible commits if they are unrelated; for each, stage the files and commit with a concise, conventional commit message explaining why. Don't push. Report the commits you made.",
		),
	);
	reg("omp.scm.review", scmPrompt("Review the uncommitted changes in this repository (`git diff` and `git diff --staged`) like a senior reviewer: correctness bugs, edge cases, security, missing tests. Report findings with file:line references, most severe first. Don't change files."));
	reg("omp.scm.pr", scmPrompt("Write a pull request title and description for the work on the current branch compared to its upstream/main (`git log` and `git diff` against the merge base): summary, motivation, notable changes, testing done, risks. Don't push or open anything."));

	reg("omp.refresh", () => {
		sessions.refresh();
		tree.refresh();
	});

	reg("omp.showLog", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Show log of which session?"));
		const meta = id ? sessions.get(id) : undefined;
		if (meta) await vscode.window.showTextDocument(vscode.Uri.file(path.join(sessionDir(meta.id), "host.log")));
	});

	const api: OmpApi = {
		context,
		sessions,
		snapshots,
		openPanel,
		launchAndOpen,
		pickSession,
		pickFolder,
		targetPanel,
		idFrom,
		refreshTree: () => tree.refresh(),
		closePanel: id => panels.get(id)?.dispose(),
		isUnread: id => unread.has(id),
		organize,
		sessionTree: tree,
		sessionsView: treeView,
	};
	registerEditorIntegration(context, { sessions, snapshots, targetPanel });
	registerTasks(api);
	// Feature modules: one `register*(api)` line each.
	registerScheduler(api);
	registerOrganize(api);
	registerWorktrees(api);
	registerDoctor(api);
	registerEditorPlus(api);
	registerToolbox(api);
	registerDashboard(api);
	registerChatContext(api);
	registerBoard(api);
	registerBridge(api);
	registerSessionConfig(api);
	registerPermissions(api);
	registerAgentSkill(api);
	registerHermesPlugin(api);
	registerRemote(api, registerServer(api));

	// ---------- status bar ----------
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	status.command = "omp.openSession";
	context.subscriptions.push(status);
	const COMMAND_CENTER_HINT = `\n\nAll omp commands: omp: Command Center (${process.platform === "darwin" ? "⌘⌥P" : "Ctrl+Alt+P"})`;
	const updateStatus = () => {
		const local = sessions.all().filter(m => m.status !== "stopped" && sessions.inWorkspace(m));
		const working = local.filter(m => m.status === "working" || m.status === "starting").length;
		const waiting = local.filter(m => m.status === "waiting").length;
		const idle = local.length - working - waiting;
		if (local.length === 0) {
			status.text = "$(hubot) omp";
			status.tooltip = `No omp sessions running for this workspace. Click to open one.${COMMAND_CENTER_HINT}`;
			status.command = "omp.focus";
		} else {
			const parts = [working ? `$(loading~spin) ${working}` : "", waiting ? `$(bell-dot) ${waiting}` : "", idle ? `$(pass) ${idle}` : ""].filter(Boolean);
			status.text = `$(hubot) omp ${parts.join(" ")}`;
			status.tooltip = local.map(m => `${m.status.padEnd(8)} ${m.title}`).join("\n") + COMMAND_CENTER_HINT;
			status.command = "omp.openSession";
		}
		status.backgroundColor = waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
		status.show();
		const unseen = sessions.all().filter(m => unread.has(m.id) && sessions.inWorkspace(m)).length;
		const attention = waiting + unseen;
		treeView.badge = attention ? { value: attention, tooltip: [waiting ? `${waiting} need input` : "", unseen ? `${unseen} with new results` : ""].filter(Boolean).join(", ") } : undefined;
	};
	sessions.onDidChange(updateStatus);
	updateStatus();

	// ---------- notifications ----------
	context.subscriptions.push(
		sessions.onDidTransition(({ meta, from }) => {
			const panel = panels.get(meta.id);
			const attended = !!panel?.isVisible && vscode.window.state.focused;
			if (!attended && (meta.status === "waiting" || (meta.status === "idle" && from === "working"))) setUnread(meta.id, true);
			if (!vscode.workspace.getConfiguration("omp").get<boolean>("notifications", true)) return;
			if (!sessions.inWorkspace(meta)) return;
			if (attended) return;
			let message: string | undefined;
			if (meta.status === "waiting") message = `omp needs your input: ${meta.title}`;
			else if (meta.status === "idle" && from === "working") message = `omp finished: ${meta.title}`;
			else if (meta.status === "stopped" && from !== "stopped" && meta.exitCode && meta.exitCode !== 0) message = `omp session exited (${meta.exitReason}): ${meta.title}`;
			if (!message) return;
			void vscode.window.showInformationMessage(message, "Open").then(a => {
				if (a) openPanel(meta.id);
			});
		}),
	);
}

export function deactivate(): void {
	for (const p of panels.values()) p.dispose();
	panels.clear();
}
