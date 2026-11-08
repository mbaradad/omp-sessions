import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { diffTexts } from "../shared/diff";
import { hermesOrigin } from "../shared/hermes-origin";
import type { OrganizeStore } from "../shared/organize";
import { PLAN_PROMPT_PREFIX } from "../shared/permissions";
import type { FileChange, HostToClient, SessionMeta } from "../shared/protocol";
import { EMPTY_BLOB, blobPath, sessionDir } from "../shared/protocol";
import { type PromptSnippet, expandPlaceholders, matchSnippetCommand } from "../shared/snippets";
import { readTranscriptText } from "../shared/transcript-files";
import type { DiffsByPath, FileAttachment, FromWebview, PanelCommand, SlashCommand, SlimState, ToWebview } from "../shared/webview";
import { expandContextMentions, placeholderValues } from "./chat-context";
import { HostClient } from "./client";
import { Checkpoints } from "./checkpoints";
import { type CommandContext, LOCAL_COMMANDS, handleComposerInput, runSessionAction } from "./commands";
import { setSessionPermissionMode } from "../shared/launch";
import { parseTaskInput } from "./tasks";
import { chatSymbolInfo, openChatSymbol } from "./bridge";
import { type SnapshotProvider, openFile, openTextDiff, openToolDiff } from "./diff";
import { exportMarkdown } from "./export";
import { openLink, openUrlFromOmp } from "./links";
import type { SessionManager } from "./sessions";
import { loadSnippets, promptsDir, snippetCommands } from "./prompt-snippets";
import { slimFrame, slimMessage, slimRunningTool } from "./slim";

const STARRED_MODELS_KEY = "omp.starredModels";

export const VIEW_TYPE = "omp.chat";

/** Where a chat renders: an editor tab or the side bar view. */
export interface ChatSurface {
	readonly webview: vscode.Webview;
	readonly visible: boolean;
	/** Editor column of the chat (undefined in the side bar: files open in the active column). */
	readonly viewColumn: vscode.ViewColumn | undefined;
	title: string;
	reveal(): void;
	readonly onDidDispose: vscode.Event<void>;
	/** Called when the controller is done: editor tabs close, the side bar view stays. */
	release(): void;
	/** Per-session chrome: tab icon (editor tabs) or a header mark (side bar). */
	decorate(d: ChatDecoration | undefined): void;
}

/** Session chrome supplied by a feature module (Organize: the session's color). */
export interface ChatDecoration {
	/** Editor tab icon. */
	icon?: vscode.Uri;
	/** Short prefix of the side bar header (e.g. a colored emoji dot). */
	mark?: string;
}

let chatDecorator: (sessionId: string) => ChatDecoration | undefined = () => undefined;
const decorationEmitter = new vscode.EventEmitter<void>();

/** Installs the decoration source of all chats; call again (same function is fine) when its answers change. */
export function setChatDecorator(fn: (sessionId: string) => ChatDecoration | undefined): void {
	chatDecorator = fn;
	decorationEmitter.fire();
}

export function panelSurface(panel: vscode.WebviewPanel, icon: vscode.Uri): ChatSurface {
	panel.iconPath = icon;
	let shown = icon.toString();
	return {
		get webview() {
			return panel.webview;
		},
		get visible() {
			return panel.visible;
		},
		get viewColumn() {
			return panel.viewColumn;
		},
		get title() {
			return panel.title;
		},
		set title(t: string) {
			panel.title = t;
		},
		reveal: () => panel.reveal(undefined, false),
		onDidDispose: panel.onDidDispose,
		release: () => panel.dispose(),
		decorate: d => {
			const next = d?.icon ?? icon;
			if (next.toString() === shown) return;
			shown = next.toString();
			panel.iconPath = next;
		},
	};
}

export function viewSurface(view: vscode.WebviewView): ChatSurface {
	let base = "";
	let mark = "";
	return {
		get webview() {
			return view.webview;
		},
		get visible() {
			return view.visible;
		},
		viewColumn: undefined,
		get title() {
			return base;
		},
		set title(t: string) {
			base = t;
			view.description = mark + t;
		},
		reveal: () => view.show(false),
		onDidDispose: view.onDidDispose,
		release: () => {},
		decorate: d => {
			const next = d?.mark ? `${d.mark} ` : "";
			if (next === mark) return;
			mark = next;
			view.description = mark + base;
		},
	};
}

/** Files larger than this are not diffed line-by-line in the chat (the editor diff still works). */
const MAX_INLINE_DIFF_BYTES = 2 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function rec(v: unknown): Record<string, unknown> | undefined {
	// JSON objects from omp frames; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Messages recorded in an omp session file (used to show stopped sessions). */
function readTranscript(file: string | undefined): unknown[] {
	if (!file) return [];
	const raw = readTranscriptText(file);
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		if (!line.includes('"type":"message"')) continue;
		try {
			const entry = rec(JSON.parse(line));
			if (entry?.type === "message" && entry.message) out.push(entry.message);
		} catch {
			/* torn line */
		}
	}
	return out;
}

function mergeCommands(server: SlashCommand[], snippets: PromptSnippet[]): SlashCommand[] {
	const names = new Set(server.map(c => c.name));
	return [...server, ...LOCAL_COMMANDS.filter(c => !names.has(c.name)), ...snippetCommands(snippets)];
}

export class ChatPanel implements vscode.Disposable {
	private client: HostClient | undefined;
	private clientSubs: vscode.Disposable[] = [];
	private readonly subs: vscode.Disposable[] = [];
	private webviewReady = false;
	private snapshot: Extract<HostToClient, { t: "snapshot" }> | undefined;
	private state: SlimState | null = null;
	private serverCommands: SlashCommand[] = [];
	/** Prompt snippets offered as `/p:<name>` (settings + the session folder's .omp/prompts). */
	private snippets: PromptSnippet[] = [];
	private changes: FileChange[] = [];
	/** Full edit details (with oldText/newText) by toolCallId, for diffs of history the host did not snapshot. */
	private readonly editTexts = new Map<string, Array<{ path: string; oldText: string; newText: string }>>();
	private readonly diffCache = new Map<string, DiffsByPath>();
	private outbox: ToWebview[] = [];
	/** Notices to show once the host replaces the transcript (fork / new / switch). */
	private readonly afterReset: ToWebview[] = [];
	private flushTimer: NodeJS.Timeout | undefined;
	private disposed = false;
	private lastStatus: SessionMeta["status"] | undefined;
	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	readonly onDidDispose = this.disposeEmitter.event;
	private readonly checkpoints: Checkpoints;

	constructor(
		readonly sessionId: string,
		readonly surface: ChatSurface,
		private readonly sessions: SessionManager,
		private readonly snapshots: SnapshotProvider,
		private readonly extensionUri: vscode.Uri,
		private readonly globalState: vscode.Memento,
		private readonly organize: OrganizeStore,
	) {
		surface.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out"), vscode.Uri.joinPath(extensionUri, "media")] };
		const panel = this;
		this.checkpoints = new Checkpoints({
			sessionId,
			get client() {
				return panel.client;
			},
			get meta() {
				return panel.meta;
			},
			get state() {
				return panel.state;
			},
			get changes() {
				return panel.changes;
			},
			transcript: () => this.transcriptMessages(),
			findUserEntry: text => this.findUserEntry(text),
			insertText: text => this.insertText(text),
			post: msg => this.post(msg),
			postAfterReset: msg => this.afterReset.push(msg),
		});
		surface.webview.html = this.html();
		this.subs.push(
			surface.webview.onDidReceiveMessage((m: FromWebview) => void this.onWebviewMessage(m)),
			surface.onDidDispose(() => this.dispose()),
			sessions.onDidChange(() => this.onSessionsChanged()),
			decorationEmitter.event(() => this.updateTitle()),
			organize.onDidChange(() => this.postOrigin()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration("omp.chat.snippets")) this.reloadSnippets();
				if (e.affectsConfiguration("omp.chat.toolCardsCollapsed")) this.postChatConfig();
			}),
		);
		const cwd = this.meta?.cwd;
		if (cwd) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(promptsDir(cwd)), "*.md"));
			this.subs.push(watcher, watcher.onDidCreate(() => this.reloadSnippets()), watcher.onDidChange(() => this.reloadSnippets()), watcher.onDidDelete(() => this.reloadSnippets()));
		}
		this.updateTitle();
		this.lastStatus = this.meta?.status;
		this.attach();
	}

	private starredModels(): string[] {
		const v = this.globalState.get<unknown>(STARRED_MODELS_KEY);
		return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
	}

	private async postModels(): Promise<void> {
		const client = this.client;
		if (!client) return;
		const [models, levels] = await Promise.all([client.rpc({ type: "get_available_models" }), client.rpc({ type: "get_available_thinking_levels" })]);
		const list = rec(models.data)?.models;
		const lv = rec(levels.data)?.levels;
		this.post({
			type: "models",
			models: (Array.isArray(list) ? list : []).map(x => rec(x) ?? {}).map(x => ({ provider: String(x.provider), id: String(x.id), name: typeof x.name === "string" ? x.name : undefined })),
			levels: Array.isArray(lv) ? lv.map(String) : [],
			starred: this.starredModels(),
		});
	}

	/** omp's realtime voice (`live_start`): the microphone and speaker of the machine omp runs on. */
	private async startVoice(): Promise<void> {
		const client = this.client;
		if (!client?.connected) {
			this.post({ type: "notice", level: "warning", text: "Resume the session first: voice talks to the running omp." });
			return;
		}
		if (vscode.env.remoteName) {
			const ok = await vscode.window.showWarningMessage(
				"Start voice on the remote machine?",
				{ modal: true, detail: `omp runs on the ${vscode.env.remoteName} side, so voice uses that machine's microphone and speaker, which a server usually lacks. Voice works best in a local window.` },
				"Start Anyway",
			);
			if (ok !== "Start Anyway") return;
		}
		const voice = vscode.workspace.getConfiguration("omp").get<string>("voice.name");
		const res = await client.rpc({ type: "live_start", ...(voice ? { voice } : {}) }, 60_000);
		if (res.success) return;
		const error = String(res.error ?? "live_start failed");
		if (/already active/i.test(error)) {
			this.post({ type: "event", ev: { type: "live_phase", phase: "listening" } });
			return;
		}
		const hint = /unknown command|unsupported/i.test(error)
			? "This omp has no realtime voice: update it (omp: Update omp)."
			: /auth|login|credential|token|401|403/i.test(error)
				? "Voice uses OpenAI's realtime model through a ChatGPT login: run /login and pick OpenAI (ChatGPT)."
				: "";
		this.post({ type: "notice", level: "error", text: `Voice could not start: ${error}${hint ? `\n${hint}` : ""}` });
	}

	get meta(): SessionMeta | undefined {
		return this.sessions.get(this.sessionId);
	}

	get isVisible(): boolean {
		return this.surface.visible;
	}

	reveal(): void {
		this.surface.reveal();
	}

	post(msg: ToWebview): void {
		if (!this.webviewReady) return;
		const coalesce = (a: ToWebview, b: ToWebview) =>
			a.type === "event" &&
			b.type === "event" &&
			a.ev.type === b.ev.type &&
			((a.ev.type === "message_update" && a.ev.messageId === b.ev.messageId) || (a.ev.type === "tool_execution_update" && a.ev.toolCallId === b.ev.toolCallId));
		const last = this.outbox[this.outbox.length - 1];
		if (last && coalesce(last, msg)) this.outbox[this.outbox.length - 1] = msg;
		else this.outbox.push(msg);
		this.flushTimer ??= setTimeout(() => this.flush(), 40);
	}

	private flush(): void {
		this.flushTimer = undefined;
		const batch = this.outbox;
		this.outbox = [];
		for (const m of batch) void this.surface.webview.postMessage(m);
	}

	/** (Re)connect to the session host if it is running; otherwise show the recorded transcript. */
	attach(): void {
		for (const d of this.clientSubs) d.dispose();
		this.clientSubs = [];
		this.client?.dispose();
		this.client = undefined;
		this.snapshot = undefined;
		const meta = this.meta;
		if (!meta) return;
		if (meta.status === "stopped") {
			this.sendInit();
			return;
		}
		const client = new HostClient(meta.socket, `vscode:${vscode.env.machineId.slice(0, 8)}`, () => this.meta?.status !== "stopped" && !this.disposed);
		this.client = client;
		this.clientSubs.push(
			client.onMessage(m => this.onHostMessage(m)),
			client.onConnection(connected => this.post({ type: "connection", connected })),
		);
	}

	private onSessionsChanged(): void {
		const meta = this.meta;
		if (!meta) return;
		this.updateTitle();
		// A restarted host can listen elsewhere (Windows pipes get a fresh name per start).
		if ((this.lastStatus === "stopped" && meta.status !== "stopped") || (meta.status !== "stopped" && this.client && this.client.socketPath !== meta.socket)) this.attach();
		else if (meta.status === "stopped" && this.lastStatus !== "stopped" && this.lastStatus !== undefined) {
			this.post({ type: "meta", meta });
		}
		this.lastStatus = meta.status;
	}

	private updateTitle(): void {
		const meta = this.meta;
		if (!meta) return;
		const mark = meta.status === "working" ? "● " : meta.status === "waiting" ? "◆ " : "";
		this.surface.title = `${mark}${meta.title}`;
		this.surface.decorate(chatDecorator(this.sessionId));
	}

	private reloadSnippets(): void {
		this.snippets = loadSnippets(this.meta?.cwd);
		this.post({ type: "commands", commands: mergeCommands(this.serverCommands, this.snippets) });
	}

	private postChatConfig(): void {
		this.post({ type: "chatConfig", toolCardsCollapsed: vscode.workspace.getConfiguration("omp.chat").get<boolean>("toolCardsCollapsed", true) });
	}

	private lastOrigin: string | undefined;
	/** The session's Hermes origin (its tags) for the chat header chip; sent when it changes. */
	private postOrigin(force = false): void {
		const hermes = hermesOrigin(this.organize.session(this.sessionId).tags) ?? null;
		const key = JSON.stringify(hermes);
		if (!force && key === this.lastOrigin) return;
		this.lastOrigin = key;
		this.post({ type: "origin", hermes });
	}

	// ---------- diffs ----------
	private readBlob(hash: string | null): string | undefined {
		if (hash === null || hash === EMPTY_BLOB) return "";
		try {
			const file = blobPath(this.sessionId, hash);
			if (fs.statSync(file).size > MAX_INLINE_DIFF_BYTES) return undefined;
			return fs.readFileSync(file, "utf8");
		} catch {
			return undefined;
		}
	}

	private diffsForChange(change: FileChange): DiffsByPath {
		const cached = this.diffCache.get(change.toolCallId);
		if (cached) return cached;
		const out: DiffsByPath = {};
		for (const f of change.files) {
			const before = this.readBlob(f.before);
			const after = this.readBlob(f.after);
			if (before !== undefined && after !== undefined) out[f.path] = diffTexts(before, after);
		}
		this.diffCache.set(change.toolCallId, out);
		return out;
	}

	private diffsForEditTexts(toolCallId: string): DiffsByPath | undefined {
		const texts = this.editTexts.get(toolCallId);
		if (!texts) return undefined;
		const cached = this.diffCache.get(toolCallId);
		if (cached) return cached;
		const out: DiffsByPath = {};
		for (const t of texts) {
			if (t.oldText.length + t.newText.length < MAX_INLINE_DIFF_BYTES) out[t.path] = diffTexts(t.oldText, t.newText);
		}
		this.diffCache.set(toolCallId, out);
		return out;
	}

	private allDiffs(): Record<string, DiffsByPath> {
		const out: Record<string, DiffsByPath> = {};
		for (const c of this.changes) out[c.toolCallId] = this.diffsForChange(c);
		for (const id of this.editTexts.keys()) if (!out[id]) out[id] = this.diffsForEditTexts(id) ?? {};
		return out;
	}

	private indexEdits(messages: unknown[]): string[] {
		const ids: string[] = [];
		for (const m of messages) {
			const r = rec(m);
			if (r?.role !== "toolResult" || typeof r.toolCallId !== "string") continue;
			const d = rec(r.details);
			if (!d) continue;
			const files: Array<{ path: string; oldText: string; newText: string }> = [];
			const add = (x: Record<string, unknown> | undefined) => {
				if (x && typeof x.path === "string" && typeof x.oldText === "string" && typeof x.newText === "string") files.push({ path: x.path, oldText: x.oldText, newText: x.newText });
			};
			add(d);
			if (Array.isArray(d.perFileResults)) for (const f of d.perFileResults) add(rec(f));
			if (files.length) {
				this.editTexts.set(r.toolCallId, files);
				ids.push(r.toolCallId);
			}
		}
		return ids;
	}

	// ---------- host -> webview ----------
	private onHostMessage(m: HostToClient): void {
		switch (m.t) {
			case "snapshot":
				this.snapshot = m;
				this.state = (m.state as SlimState) ?? null;
				this.serverCommands = (m.commands as SlashCommand[]) ?? [];
				this.changes = [...m.changes];
				this.indexEdits(m.messages);
				this.sendInit();
				return;
			case "event": {
				const ev = m.ev;
				if (ev.type === "message_end") {
					for (const id of this.indexEdits([ev.message])) {
						if (this.changes.some(c => c.toolCallId === id)) continue;
						const diffs = this.diffsForEditTexts(id);
						if (diffs) this.post({ type: "diffs", toolCallId: id, diffs });
					}
				}
				if (ev.type === "available_commands_update") {
					this.serverCommands = Array.isArray(ev.commands) ? (ev.commands as SlashCommand[]) : [];
					this.post({ type: "commands", commands: mergeCommands(this.serverCommands, this.snippets) });
					return;
				}
				if (ev.type === "extension_ui_request" && ev.method === "open_url") {
					const target = typeof ev.launchUrl === "string" ? ev.launchUrl : typeof ev.url === "string" ? ev.url : undefined;
					if (target) void openUrlFromOmp(target);
				}
				const slim = slimFrame(ev);
				if (slim) this.post({ type: "event", ev: slim });
				return;
			}
			case "state":
				this.state = (m.state as SlimState) ?? null;
				this.post({ type: "state", state: this.state });
				return;
			case "meta":
				this.post({ type: "meta", meta: m.meta });
				return;
			case "change":
				this.changes.push(m.change);
				this.post({ type: "change", change: m.change, diffs: this.diffsForChange(m.change) });
				return;
			case "ui_resolved":
				this.post({ type: "uiResolved", id: m.id });
				return;
			case "queue":
				this.post({ type: "queue", queue: m.queue });
				return;
			case "reset":
				this.state = (m.state as SlimState) ?? null;
				this.indexEdits(m.messages);
				this.post({ type: "reset", messages: m.messages.map(x => slimMessage(x)), state: this.state, diffs: this.allDiffs() });
				for (const msg of this.afterReset.splice(0)) this.commandContext.post(msg);
				return;
			case "response":
				return;
		}
	}

	private sendInit(): void {
		if (!this.webviewReady) return;
		const meta = this.meta;
		if (!meta) return;
		const snap = this.snapshot;
		let messages: unknown[];
		if (snap) messages = snap.messages;
		else {
			messages = readTranscript(meta.ompSessionFile);
			this.changes = this.sessions.changes(this.sessionId);
			this.indexEdits(messages);
		}
		this.outbox = [];
		this.snippets = loadSnippets(meta.cwd);
		this.postChatConfig();
		this.post({
			type: "init",
			meta: snap?.meta ?? meta,
			messages: messages.map(x => slimMessage(x)),
			inflight: snap?.inflight ? { messageId: snap.inflight.messageId, message: slimMessage(snap.inflight.message, true) } : null,
			runningTools: (snap?.runningTools ?? []).map(slimRunningTool),
			pendingUi: snap?.pendingUi ?? [],
			state: this.state,
			commands: mergeCommands(this.serverCommands, this.snippets),
			changes: this.changes,
			diffs: this.allDiffs(),
			connected: !!this.client?.connected,
			home: os.homedir(),
			queue: snap?.queue ?? this.sessions.queue(this.sessionId),
		});
		this.post({ type: "checkpoints", redo: this.checkpoints.redoCount });
		this.postOrigin(true);
	}

	/** Send a prompt as if typed in the composer (used by editor integrations). */
	async sendPrompt(text: string): Promise<void> {
		this.reveal();
		await this.onWebviewMessage({ type: "prompt", text });
	}

	insertText(text: string): void {
		this.post({ type: "insertText", text });
	}

	focusComposer(): void {
		this.post({ type: "focusComposer" });
	}

	private resolveCandidate(candidate: string): string | undefined {
		const cwd = this.meta?.cwd ?? os.homedir();
		const expanded = candidate.startsWith("~/") ? path.join(os.homedir(), candidate.slice(2)) : candidate;
		const abs = path.resolve(cwd, expanded);
		return fs.existsSync(abs) ? abs : undefined;
	}

	/** Writes pasted/dropped files next to the session; returns prompt lines describing every attachment. */
	private storeAttachments(files: FileAttachment[]): string[] {
		const dir = path.join(sessionDir(this.sessionId), "attachments");
		fs.mkdirSync(dir, { recursive: true });
		const fmt = (n?: number) => (n === undefined ? "" : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
		return files.map(f => {
			let file = f.path;
			if (!file && f.data !== undefined) {
				const safe = f.name.replace(/[^\w.@+-]+/g, "_").slice(-120) || "attachment";
				file = path.join(dir, `${Date.now().toString(36)}-${safe}`);
				fs.writeFileSync(file, Buffer.from(f.data, "base64"));
			}
			const info = [f.name !== path.basename(file ?? "") ? f.name : "", f.mimeType ?? "", fmt(f.size)].filter(Boolean).join(", ");
			return `${file}${info ? ` (${info})` : ""}`;
		});
	}

	/** omp reads files from disk: save unsaved editors inside the session folder so it sees what the user sees. */
	private async saveDirtyDocuments(): Promise<void> {
		const cwd = this.meta?.cwd;
		if (!cwd || !vscode.workspace.getConfiguration("omp").get<boolean>("saveBeforePrompt", true)) return;
		const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && d.uri.scheme === "file" && !path.relative(cwd, d.uri.fsPath).startsWith(".."));
		await Promise.all(dirty.map(d => d.save()));
	}

	private get commandContext(): CommandContext {
		return {
			client: this.client,
			meta: this.meta,
			state: this.state,
			post: msg => {
				this.post(msg);
				if (msg.type === "notice") this.client?.write({ t: "note", level: msg.level, message: msg.text, markdown: msg.markdown });
			},
			insertText: text => this.insertText(text),
			postAfterReset: msg => this.afterReset.push(msg),
		};
	}

	// ---------- webview -> host ----------
	private async onWebviewMessage(m: FromWebview): Promise<void> {
		const client = this.client;
		switch (m.type) {
			case "ready":
				this.webviewReady = true;
				this.sendInit();
				return;
			case "prompt": {
				const images = m.images ?? [];
				const files = m.files ?? [];
				const queued = /^\/(queue|task)\s+([\s\S]+)$/.exec(m.text.trim());
				if (queued) {
					const [first, ...rest] = queued[2].trim().split("\n");
					const { title, subtasks } = parseTaskInput(first);
					await this.sessions.editQueue(this.sessionId, [{ op: "add", title, subtasks, notes: rest.join("\n").trim() || undefined }]);
					this.commandContext.post({ type: "notice", level: "info", text: `Queued task: ${title}` });
					return;
				}
				if (/^\/tasks\s*$/.test(m.text.trim())) {
					await vscode.commands.executeCommand("omp.tasks.focus");
					return;
				}
				let text = m.text;
				const snippet = matchSnippetCommand(text, this.snippets);
				if (snippet) text = [this.fillSnippet(snippet.snippet.prompt), snippet.rest].filter(Boolean).join("\n\n");
				if (!images.length && !files.length && (await handleComposerInput(text, this.commandContext, name => this.runCommand(name)))) return;
				if (!client?.connected) {
					this.post({ type: "error", message: "Session is not running. Resume it first." });
					return;
				}
				await this.saveDirtyDocuments();
				const expansion = await expandContextMentions(text, this.meta?.cwd);
				for (const u of expansion.unavailable) this.post({ type: "notice", level: "warning", text: `@${u.kind}: ${u.reason}` });
				let message = expansion.text;
				if (files.length) {
					const listed = this.storeAttachments(files);
					message = `${message}${message ? "\n\n" : ""}Attached files (read them with your read tool):\n${listed.map(f => `- ${f}`).join("\n")}`;
				}
				if (!message.trim() && images.length) message = images.length === 1 ? "(see attached image)" : "(see attached images)";
				const busy = !!this.state?.isStreaming;
				this.checkpoints.clearRedo();
				const behavior = vscode.workspace.getConfiguration("omp").get<string>("sendWhileBusy") ?? "steer";
				const res = await client.rpc({
					type: "prompt",
					message,
					...(images.length ? { images: images.map(i => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}),
					...(busy ? { streamingBehavior: behavior } : {}),
				});
				if (!res.success) this.post({ type: "error", message: String(res.error ?? "prompt failed") });
				return;
			}
			case "abort":
				await client?.rpc({ type: "abort" });
				return;
			case "uiResponse":
				client?.write({ t: "ui_response", res: m.res });
				return;
			case "openFile": {
				const abs = this.resolveCandidate(m.path) ?? path.resolve(this.meta?.cwd ?? "", m.path);
				await openFile(abs, m.line, m.column, this.surface.viewColumn);
				return;
			}
			case "openLink":
				await openLink(m.url, this.meta, this.surface.viewColumn);
				return;
			case "openDiff":
				await this.openDiff(m.toolCallId, m.path);
				return;
			case "copy":
				await vscode.env.clipboard.writeText(m.text);
				void vscode.window.setStatusBarMessage("$(copy) Copied", 2000);
				return;
			case "expandSnippet": {
				const snippet = this.snippets.find(s => s.name === m.name);
				if (snippet) this.insertText(this.fillSnippet(snippet.prompt));
				return;
			}
			case "pickFiles": {
				const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach", defaultUri: this.meta ? vscode.Uri.file(this.meta.cwd) : undefined });
				if (!picked?.length) return;
				const images = [];
				const files = [];
				for (const uri of picked) {
					const mimeType = IMAGE_MIME[path.extname(uri.fsPath).toLowerCase()];
					const stat = await vscode.workspace.fs.stat(uri);
					if (mimeType && stat.size < 20 * 1024 * 1024) {
						const bytes = await vscode.workspace.fs.readFile(uri);
						images.push({ data: Buffer.from(bytes).toString("base64"), mimeType, name: path.basename(uri.fsPath) });
					} else files.push({ name: path.basename(uri.fsPath), path: uri.fsPath, size: stat.size });
				}
				this.post({ type: "attachFiles", images, files });
				return;
			}
			case "symbolInfo":
				this.post({ type: "symbolInfo", name: m.name, ...(await chatSymbolInfo(m.name, this.meta?.cwd)) });
				return;
			case "openSymbol":
				await openChatSymbol(m.name, this.meta?.cwd, this.surface.viewColumn);
				return;
			case "resolvePaths": {
				const resolved: Record<string, string> = {};
				for (const c of m.candidates.slice(0, 500)) {
					const abs = this.resolveCandidate(c);
					if (abs) resolved[c] = abs;
				}
				this.post({ type: "pathsResolved", reqId: m.reqId, resolved });
				return;
			}
			case "suggestFiles": {
				const cwd = this.meta?.cwd;
				if (!cwd) return;
				const q = m.query.replace(/[[\]{}*?!]/g, "");
				const found = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(cwd), `**/*${q}*`), "**/{node_modules,.git,dist,out,build,__pycache__,.venv}/**", 40);
				const files = found.map(u => path.relative(cwd, u.fsPath)).sort((a, b) => a.length - b.length);
				this.post({ type: "fileSuggestions", reqId: m.reqId, files });
				return;
			}
			case "getModels":
				await this.postModels();
				return;
			case "setModel": {
				const res = await client?.rpc({ type: "set_model", provider: m.provider, modelId: m.id });
				if (res && !res.success) this.post({ type: "error", message: String(res.error) });
				return;
			}
			case "setThinking": {
				const res = await client?.rpc({ type: "set_thinking_level", level: m.level });
				if (res && !res.success) this.post({ type: "error", message: String(res.error) });
				return;
			}
			case "removeQueued":
				await client?.rpc({ type: "remove_queued_message", message: m.text, queue: m.queue });
				return;
			case "rewindTo":
			case "forkFrom": {
				const entryId = await this.findUserEntry(m.text);
				if (!client || !entryId) {
					this.post({ type: "notice", level: "warning", text: "Could not locate that message on the current branch." });
					return;
				}
				if (m.type === "rewindTo") {
					const res = await client.rpc({ type: "branch", entryId });
					const data = rec(res.data) ?? {};
					if (!res.success) this.post({ type: "error", message: String(res.error) });
					else if (!data.cancelled) this.insertText(String(data.text ?? m.text).replace(PLAN_PROMPT_PREFIX, ""));
				} else {
					const res = await client.rpc({ type: "fork", entryId });
					if (!res.success) this.post({ type: "error", message: String(res.error) });
					else this.afterReset.push({ type: "notice", level: "info", text: "Forked: continuing from that message in a new transcript." });
				}
				return;
			}
			case "revertFile":
				await this.revertFile(m.toolCallId, m.path);
				return;
			case "queueOp":
				await this.sessions.editQueue(this.sessionId, m.ops);
				if (this.meta?.status === "stopped") this.post({ type: "queue", queue: this.sessions.queue(this.sessionId) });
				return;
			case "focusTasks":
				await vscode.commands.executeCommand("omp.tasks.focus");
				return;
			case "command":
				await this.runCommand(m.name);
				return;
			case "setMode":
				if (this.meta && !(await setSessionPermissionMode(this.meta, m.mode))) this.post({ type: "notice", level: "warning", text: "Could not switch the permission mode: the session host is unreachable." });
				return;
			case "restoreCheckpoint":
				await this.checkpoints.restore(m.text);
				return;
			case "starModel": {
				const key = `${m.provider}/${m.id}`;
				const starred = this.starredModels();
				await this.globalState.update(STARRED_MODELS_KEY, starred.includes(key) ? starred.filter(k => k !== key) : [...starred, key]);
				await this.postModels();
				return;
			}
		}
	}

	private async runCommand(name: PanelCommand): Promise<void> {
		if (await runSessionAction(name, this.commandContext)) return;
		const meta = this.meta;
		switch (name) {
			case "undoTurn":
				await this.checkpoints.restore();
				return;
			case "redoTurn":
				await this.checkpoints.redo();
				return;
			case "voiceStart":
				await this.startVoice();
				return;
			case "voiceStop": {
				const res = await this.client?.rpc({ type: "live_stop" });
				if (res && !res.success) this.post({ type: "error", message: String(res.error) });
				return;
			}
			case "voiceMute": {
				const res = await this.client?.rpc({ type: "live_mute" });
				if (res && !res.success) this.post({ type: "error", message: String(res.error) });
				return;
			}
			case "openTui":
				await vscode.commands.executeCommand("omp.continueInTerminal", this.sessionId);
				return;
			case "openHermesCard":
				await vscode.commands.executeCommand("omp.hermes.openCard", this.sessionId);
				return;
			case "showHermesCard":
				await vscode.commands.executeCommand("omp.hermes.showCard", this.sessionId);
				return;
			case "compact": {
				const res = await this.client?.rpc({ type: "compact" }, 15 * 60_000);
				if (res && !res.success) this.post({ type: "error", message: String(res.error) });
				return;
			}
			case "newSession":
				await vscode.commands.executeCommand("omp.newSession", meta?.cwd);
				return;
			case "stopSession":
				await vscode.commands.executeCommand("omp.stopSession", this.sessionId);
				return;
			case "resumeSession":
				await vscode.commands.executeCommand("omp.resumeSession", this.sessionId);
				return;
			case "rename":
				await vscode.commands.executeCommand("omp.renameSession", this.sessionId);
				return;
			case "sessionChanges":
				await vscode.commands.executeCommand("omp.showChanges", this.sessionId);
				return;
			case "reviewChanges":
				await vscode.commands.executeCommand("omp.reviewChanges", this.sessionId);
				return;
			case "openLog":
				await vscode.window.showTextDocument(vscode.Uri.file(path.join(sessionDir(this.sessionId), "host.log")));
				return;
			case "exportMarkdownCopy":
			case "exportMarkdownSave":
				await exportMarkdown(name === "exportMarkdownCopy" ? "copy" : "save", await this.transcriptMessages(), meta, msg => this.post(msg));
				return;
		}
	}

	/** Snippet text with `{{selection}}` / `{{file}}` filled in from the editor the user last used. */
	private fillSnippet(prompt: string): string {
		const { text, missing } = expandPlaceholders(prompt, placeholderValues(this.meta?.cwd));
		if (missing.length) this.post({ type: "notice", level: "warning", text: `Snippet placeholder ${missing.map(k => `{{${k}}}`).join(", ")} left empty: ${missing.includes("selection") ? "nothing is selected" : "no editor is open"}.` });
		return text;
	}

	/** Full transcript of the current branch: from omp when running, else the recorded session file. */
	private async transcriptMessages(): Promise<unknown[]> {
		if (this.client?.connected) {
			const res = await this.client.rpc({ type: "get_messages" });
			const list = rec(res.data)?.messages;
			if (res.success && Array.isArray(list)) return list;
		}
		return this.snapshot?.messages ?? readTranscript(this.meta?.ompSessionFile);
	}

	private async findUserEntry(text: string): Promise<string | undefined> {
		const res = await this.client?.rpc({ type: "get_branch_messages" });
		const msgs = Array.isArray(rec(res?.data)?.messages) ? (rec(res?.data)?.messages as unknown[]).map(x => rec(x) ?? {}) : [];
		const want = text.trim();
		const hit = [...msgs].reverse().find(x => String(x.text ?? "").trim() === want) ?? [...msgs].reverse().find(x => String(x.text ?? "").trim().startsWith(want.slice(0, 200)));
		return hit ? String(hit.entryId) : undefined;
	}

	/** Restores one file to its content right before the given tool call. */
	private async revertFile(toolCallId: string, file: string): Promise<void> {
		const change = this.changes.find(c => c.toolCallId === toolCallId);
		const entry = change?.files.find(f => f.path === file);
		if (!change || !entry) return;
		const name = path.relative(this.meta?.cwd ?? "", file) || file;
		const later = this.changes.some(c => c.timestamp > change.timestamp && c.files.some(f => f.path === file));
		const ok = await vscode.window.showWarningMessage(
			`Revert ${name} to its content before this edit?`,
			{ modal: true, detail: later ? "Later edits to this file in this session will be undone too." : entry.before === null ? "The file did not exist before; it will be deleted." : undefined },
			"Revert",
		);
		if (ok !== "Revert") return;
		const uri = vscode.Uri.file(file);
		if (entry.before === null) await vscode.workspace.fs.delete(uri, { useTrash: true });
		else {
			const content = entry.before === EMPTY_BLOB ? new Uint8Array() : fs.readFileSync(blobPath(this.sessionId, entry.before));
			await vscode.workspace.fs.writeFile(uri, content);
		}
		this.commandContext.post({ type: "notice", level: "info", markdown: true, text: `Reverted \`${name}\` to before that ${change.toolName}.` });
	}

	private async openDiff(toolCallId: string, file?: string): Promise<void> {
		const change = this.changes.find(c => c.toolCallId === toolCallId);
		if (change) {
			const target = file ? (this.resolveCandidate(file) ?? file) : undefined;
			const entry = change.files.find(f => f.path === target) ?? change.files.find(f => file && f.path.endsWith(file)) ?? change.files[0];
			await openToolDiff(this.snapshots, this.sessionId, change, entry.path, this.surface.viewColumn);
			return;
		}
		const texts = this.editTexts.get(toolCallId);
		const t = texts?.find(x => !file || x.path === file || x.path.endsWith(file)) ?? texts?.[0];
		if (t) {
			await openTextDiff(this.snapshots, t.path, t.oldText, t.newText, `${path.basename(t.path)} (omp edit)`, this.surface.viewColumn);
			return;
		}
		if (file) {
			const abs = this.resolveCandidate(file);
			if (abs) await openFile(abs, undefined, undefined, this.surface.viewColumn);
		}
	}

	private html(): string {
		const webview = this.surface.webview;
		const nonce = crypto.randomBytes(16).toString("base64");
		const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "webview.js"));
		const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "webview.css"));
		const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "omp-color.svg"));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>omp</title>
</head>
<body data-logo="${logo}">
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.flushTimer);
		for (const d of this.clientSubs) d.dispose();
		for (const d of this.subs) d.dispose();
		this.client?.dispose();
		this.surface.release();
		this.disposeEmitter.fire();
		this.disposeEmitter.dispose();
	}
}
