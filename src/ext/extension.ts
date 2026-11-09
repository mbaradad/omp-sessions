import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { OrganizeStore, organizeFile } from "../shared/organize";
import type { SessionMeta } from "../shared/protocol";
import type { OmpApi } from "./api";
import { registerAgentSkill } from "./agent-skill";
import { type PermissionMode, readMode } from "../shared/session-mode";
import { setSessionMode } from "../shared/session-mode-ops";
import { Checkpoints } from "./checkpoints";
import { registerBoard } from "./board";
import { registerBridge } from "./bridge";
import { registerChatContext } from "./chat-context";
import { registerDashboard } from "./dashboard";
import { SNAPSHOT_SCHEME, SnapshotProvider } from "./diff";
import { registerDoctor } from "./doctor";
import { registerEditorPlus } from "./editor-plus";
import { registerHermesPlugin } from "./hermes";
import { registerEditorIntegration } from "./integration";
import { askLaunchOptions, chooseDefaultMode, chooseDefaultModel } from "./launch-options";
import { ChatPanel, VIEW_TYPE, panelSurface, viewSurface } from "./panel";
import { registerOmpExtensions } from "./omp-extension";
import { plain } from "./plain";
import { AoConnection } from "./ao-connection";
import { inCheckout } from "./checkout";
import { type NewSessionOptions, SessionManager, projectRoot } from "./sessions";
import { registerDependencies } from "./dependencies";
import { registerPermissions } from "./permissions";
import { registerOrganize } from "./organize";
import { registerScheduler } from "./scheduler";
import { registerRemote } from "./remote";
import { registerServer } from "./server";
import { registerTasks } from "./tasks";
import { type Node, SessionTree } from "./tree";
import { addChatSoundSink, registerSounds } from "./sounds";
import { registerToolbox } from "./toolbox";
import { registerVscodeOpen } from "./vscode-open";
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

/** Returns the feature API (the e2e suite reads the views' state through it). */
export function activate(context: vscode.ExtensionContext): OmpApi {
	const ao = new AoConnection();
	const sessions = new SessionManager(ao, String(context.extension.packageJSON.version ?? "unknown"));
	const snapshots = new SnapshotProvider();
	// Checkpoints send `/undo` and `/redo` through AO; the AO connection connects on first use.
	const checkpoints = new Checkpoints(() => ao.client());
	// The permission-mode gate (Switchyard omp extension): a switch rewrites the session's mode file.
	const modes = { read: readMode, set: (id: string, mode: PermissionMode) => ao.client().then(client => setSessionMode(client, id, mode)) };
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
	context.subscriptions.push(ao, sessions, checkpoints, treeView, vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshots));

	// ---------- panels ----------
	const chatIcon = vscode.Uri.joinPath(context.extensionUri, "media", "omp-color.svg");
	function adopt(id: string, webviewPanel: vscode.WebviewPanel): ChatPanel {
		const panel = new ChatPanel(id, panelSurface(webviewPanel, chatIcon), sessions, snapshots, context.extensionUri, context.globalState, organize, () => ao.client(), undefined, checkpoints, modes);
		panels.set(id, panel);
		addChatSoundSink(panel);
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
			const chat = new ChatPanel(id, viewSurface(sideView), sessions, snapshots, context.extensionUri, context.globalState, organize, () => ao.client(), undefined, checkpoints, modes);
			chat.onDidDispose(() => {
				if (sideChat === chat) sideChat = undefined;
				if (lastActive === chat) lastActive = undefined;
			});
			sideChat = chat;
			addChatSoundSink(chat);
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

	async function launchAndOpen(opts: NewSessionOptions): Promise<ChatPanel | undefined> {
		let id: string;
		try {
			id = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: opts.id ? "omp: resuming the session" : "omp: starting a session in AO" }, () => sessions.launch(opts));
		} catch (err) {
			void vscode.window.showErrorMessage(plain(`omp session did not start: ${err instanceof Error ? err.message : String(err)}`), "Show AO Log").then(a => {
				if (a) ao.log.show();
			});
			return undefined;
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
		// A session runs in AO's worktree of its project: it belongs where its project's checkout is.
		const related = (m: SessionMeta | undefined): m is SessionMeta => !!m && (!cwdHint || within(cwdHint, m.cwd) || within(m.cwd, cwdHint) || within(cwdHint, projectRoot(m.cwd).root) || within(projectRoot(m.cwd).root, cwdHint));
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
	/** Runs a session action on AO; a failure becomes an error message (with the AO log one click away). */
	const act = async (what: string, fn: () => Promise<void>): Promise<boolean> => {
		try {
			await fn();
			return true;
		} catch (err) {
			void vscode.window.showErrorMessage(plain(`Could not ${what}: ${err instanceof Error ? err.message : String(err)}`), "Show AO Log").then(a => a && ao.log.show());
			return false;
		}
	};

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
	reg("omp.setDefaultModel", () => chooseDefaultModel(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()));
	reg("omp.setDefaultMode", () => chooseDefaultMode());

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
			const ok = await vscode.window.showWarningMessage(`"${meta.title}" is working. Stop it?`, { modal: true, detail: "The omp agent exits; the session and its transcript stay and can be resumed." }, "Stop");
			if (ok !== "Stop") return;
		}
		await act(`stop "${meta.title}"`, () => sessions.stop(meta.id));
	});

	reg("omp.resumeSession", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Resume which session?", m => m.status === "stopped"));
		const meta = id ? sessions.get(id) : undefined;
		if (!meta) return;
		if (meta.status !== "stopped") {
			openPanel(meta.id);
			return;
		}
		if (await act(`resume "${meta.title}"`, () => sessions.resume(meta.id))) openPanel(meta.id);
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
			`Remove "${meta.title}"?`,
			{ modal: true, detail: "Deletes the session from AO, with its worktree when it has no uncommitted changes. The omp transcript stays in ~/.omp/agent/sessions." },
			"Remove",
		);
		if (ok !== "Remove") return;
		panels.get(meta.id)?.dispose();
		await act(`remove "${meta.title}"`, () => sessions.remove(meta.id));
	});

	reg("omp.renameSession", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Rename which session?"));
		const meta = id ? sessions.get(id) : undefined;
		if (!meta) return;
		const title = (await vscode.window.showInputBox({ prompt: "Session title", value: meta.title }))?.trim();
		if (!title || title === meta.title) return;
		await act("rename the session", () => sessions.rename(meta.id, title));
	});

	/** A session's display name: from the Sessions list, else AO's; the id when neither answers. */
	const titleOf = async (id: string) =>
		sessions.get(id)?.title ??
		(await ao.client()
			.then(ao => ao.getSession(id))
			.then(
				view => view.displayName || id,
				() => id,
			));

	reg("omp.showChanges", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Show changes of which session?"));
		if (!id) return;
		const files = [...checkpoints.baselines(id).keys()];
		if (files.length === 0) {
			void vscode.window.showInformationMessage("This session has not changed any files yet.");
			return;
		}
		const cwd = sessions.get(id)?.cwd ?? checkpoints.state(id)?.cwd ?? "";
		const pick = await vscode.window.showQuickPick(
			files.map(f => ({ label: path.basename(f), description: path.relative(cwd, path.dirname(f)) || ".", file: f, iconPath: vscode.ThemeIcon.File, resourceUri: vscode.Uri.file(f) })),
			{ placeHolder: `${files.length} file(s) changed by "${await titleOf(id)}"` },
		);
		if (pick) await checkpoints.openFileDiff(id, pick.file, snapshots, panels.get(id)?.surface.viewColumn);
	});

	reg("omp.openSessionFileDiff", async (sessionId: unknown, file: unknown) => {
		if (typeof sessionId !== "string" || typeof file !== "string") return;
		await checkpoints.openFileDiff(sessionId, file, snapshots, panels.get(sessionId)?.surface.viewColumn);
	});

	reg("omp.reviewChanges", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Review changes of which session?"));
		if (id) await checkpoints.review(id, `omp: ${await titleOf(id)}`, snapshots);
	});

	// `switchyard.undo(sessionId, turnId?)`: the session's last prompt, or the one AO turn `turnId` sent and
	// everything after it. Resolves with omp's CheckpointResult (undefined: cancelled, nothing to undo, or failed).
	reg("switchyard.undo", async (arg?: unknown, turnId?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Undo the last prompt of which session?"));
		if (!id) return undefined;
		const done = await checkpoints.undo(id, typeof turnId === "string" ? { turnId } : undefined);
		if (done?.prompt) panels.get(id)?.insertText(done.prompt);
		return done;
	});

	// `switchyard.redo(sessionId)`: resolves with omp's CheckpointResult, or undefined.
	reg("switchyard.redo", async (arg?: unknown) => {
		const id = idFrom(arg) ?? (await pickSession("Redo in which session?"));
		return id ? checkpoints.redo(id) : undefined;
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
			if (e.affectsConfiguration("omp.groupBy") || e.affectsConfiguration("omp.sortBy") || e.affectsConfiguration("omp.sessionScope")) tree.refresh();
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
		const root = repoRoot(arg);
		await panel.sendPrompt(root ? inCheckout(prompt, root) : prompt);
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

	const api: OmpApi = {
		context,
		ao,
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
	const server = registerServer(api);
	registerScheduler(api);
	registerOrganize(api);
	registerWorktrees(api);
	registerDependencies(api);
	registerDoctor(api);
	registerEditorPlus(api);
	registerToolbox(api);
	registerDashboard(api);
	registerSounds(api);
	registerChatContext(api);
	registerBoard(api);
	registerBridge(api);
	registerPermissions(api);
	registerAgentSkill(api);
	registerOmpExtensions(api);
	registerHermesPlugin(api);
	registerVscodeOpen(api);
	registerRemote(api, server);

	// ---------- status bar ----------
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	status.command = "omp.openSession";
	context.subscriptions.push(status);
	const COMMAND_CENTER_HINT = `\n\nAll omp commands: omp: Command Center (${process.platform === "darwin" ? "⌘⌥P" : "Ctrl+Alt+P"})`;
	const updateStatus = () => {
		const local = sessions.all().filter(m => m.status !== "stopped" && sessions.inScope(m));
		const working = local.filter(m => m.status === "working" || m.status === "starting").length;
		const waiting = local.filter(m => m.status === "waiting").length;
		const idle = local.length - working - waiting;
		if (!ao.connected) {
			status.text = "$(hubot) omp $(debug-disconnect)";
			status.tooltip = `The AO daemon isn't reachable${ao.mayStart() ? "" : " (omp.server.autoStart is off)"}. Click to start it.${COMMAND_CENTER_HINT}`;
			status.command = "omp.server.start";
		} else if (local.length === 0) {
			status.text = "$(hubot) omp";
			status.tooltip = `No omp sessions running${sessions.scope() === "all" ? "" : " for this workspace"}. Click to open one.${COMMAND_CENTER_HINT}`;
			status.command = "omp.focus";
		} else {
			const parts = [working ? `$(loading~spin) ${working}` : "", waiting ? `$(bell-dot) ${waiting}` : "", idle ? `$(pass) ${idle}` : ""].filter(Boolean);
			status.text = `$(hubot) omp ${parts.join(" ")}`;
			status.tooltip = local.map(m => `${m.status.padEnd(8)} ${m.title}`).join("\n") + COMMAND_CENTER_HINT;
			status.command = "omp.openSession";
		}
		status.backgroundColor = waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
		status.show();
		const unseen = sessions.all().filter(m => unread.has(m.id) && sessions.inScope(m)).length;
		const attention = waiting + unseen;
		treeView.badge = attention ? { value: attention, tooltip: [waiting ? `${waiting} need input` : "", unseen ? `${unseen} with new results` : ""].filter(Boolean).join(", ") } : undefined;
	};
	sessions.onDidChange(updateStatus);
	updateStatus();
	context.subscriptions.push(
		ao.onDidConnect(updateStatus),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("omp.sessionScope")) updateStatus();
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			updateStatus();
			tree.refresh();
		}),
	);
	void migrateShowAllSessions(context);

	// ---------- notifications ----------
	context.subscriptions.push(
		sessions.onDidTransition(({ meta, from }) => {
			const panel = panels.get(meta.id);
			const attended = !!panel?.isVisible && vscode.window.state.focused;
			if (!attended && (meta.status === "waiting" || (meta.status === "idle" && from === "working"))) setUnread(meta.id, true);
			if (!vscode.workspace.getConfiguration("omp").get<boolean>("notifications", true)) return;
			if (!sessions.notifies(meta)) return;
			if (attended) return;
			let message: string | undefined;
			if (meta.status === "waiting") message = `omp needs your input: ${meta.title}`;
			else if (meta.status === "idle" && from === "working") message = `omp finished: ${meta.title}`;
			else if (meta.status === "stopped" && from !== "stopped" && meta.exitCode && meta.exitCode !== 0) message = `omp session exited (${meta.exitReason}): ${meta.title}`;
			if (!message) return;
			void vscode.window.showInformationMessage(plain(message), "Open").then(a => {
				if (a) openPanel(meta.id);
			});
		}),
	);
	return api;
}

/**
 * 0.5's `omp.showAllSessions: true` (user or workspace settings) becomes `omp.sessionScope: "all"` there, once
 * per target; the old key is then removed where VS Code still lets the extension write it.
 */
async function migrateShowAllSessions(context: vscode.ExtensionContext): Promise<void> {
	const cfg = vscode.workspace.getConfiguration("omp");
	const old = cfg.inspect<boolean>("showAllSessions");
	const scope = cfg.inspect<string>("sessionScope");
	const targets = [
		{ target: vscode.ConfigurationTarget.Global, state: context.globalState, oldValue: old?.globalValue, newValue: scope?.globalValue },
		{ target: vscode.ConfigurationTarget.Workspace, state: context.workspaceState, oldValue: old?.workspaceValue, newValue: scope?.workspaceValue },
	];
	for (const t of targets) {
		if (t.oldValue === undefined || t.state.get<boolean>("omp.migrated.showAllSessions")) continue;
		try {
			if (t.oldValue === true && t.newValue === undefined) await cfg.update("sessionScope", "all", t.target);
			await t.state.update("omp.migrated.showAllSessions", true);
			await cfg.update("showAllSessions", undefined, t.target);
		} catch {
			/* an unregistered key may not be writable: it is ignored from now on */
		}
	}
}

export function deactivate(): void {
	for (const p of panels.values()) p.dispose();
	panels.clear();
}
