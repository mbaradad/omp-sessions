import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type AoClient, type AoConversation, type AoEventSubscription, type AoSchemas, type AoStreamStatus, AoError, unwrap } from "../ao/client";
import { hermesOrigin } from "../shared/hermes-origin";
import { appendContext } from "../shared/mentions";
import type { OrganizeStore } from "../shared/organize";
import { type PermissionMode, PERMISSION_MODE_INFO, permissionModeOf } from "../shared/permissions";
import type { FileChange, QueueOp, SessionMeta, TaskQueue } from "../shared/protocol";
import { type PromptSnippet, expandPlaceholders, matchSnippetCommand } from "../shared/snippets";
import type { DiffsByPath, FileAttachment, FromWebview, PanelCommand, SlashCommand, SlimState, ToWebview } from "../shared/webview";
import { expandContextMentions, placeholderValues } from "./chat-context";
import { askSideQuestion, sideRecords } from "./chat-btw";
import { ChatFeed, OPEN_LINK, replyFor } from "./chat-feed";
import { interruptKeepingQueue, sendResuming } from "./chat-send";
import { type CommandContext, LOCAL_COMMANDS, handleComposerInput, runSessionAction } from "./commands";
import { parseTaskInput } from "./tasks";
import { chatSymbolInfo, openChatSymbol } from "./bridge";
import { type SnapshotProvider, openFile, openTextDiff } from "./diff";
import { exportMarkdown } from "./export";
import { openLink, openUrlFromOmp } from "./links";
import { type SessionManager, resolveOmpPath } from "./sessions";
import { loadSnippets, promptsDir, snippetCommands } from "./prompt-snippets";
import { slimFrame, slimMessage } from "./slim";
import { readNativeSession, switchyardHome } from "../ao/native";

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

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
/** Messages per history page (AO's maximum). */
const HISTORY_PAGE = 500;
/** History pages read when a chat opens; older turns stay in AO. */
const MAX_HISTORY_PAGES = 20;
/** Coalesce a burst of change events (AO writes streamed text every 50 ms) into one fetch. */
const SYNC_DEBOUNCE_MS = 60;
/** Shell output kept per `!command` for the next prompt's context. */
const MAX_SHELL_CONTEXT = 20_000;
/** AO's chat view lease lasts 30 s: renew well inside it. */
const LEASE_RENEW_MS = 15_000;

type ConfigOption = AoSchemas["ConversationConfigOptionResponse"];

function mergeCommands(server: SlashCommand[], snippets: PromptSnippet[]): SlashCommand[] {
	const names = new Set(server.map(c => c.name));
	return [...server, ...LOCAL_COMMANDS.filter(c => !names.has(c.name)), ...snippetCommands(snippets)];
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

let ompDefaultMode: Promise<PermissionMode | undefined> | undefined;
/** omp's own `tools.approvalMode`: AO launches omp with no approval flag in its `default` mode, so this is what that mode means. */
function ompDefaultPermissionMode(): Promise<PermissionMode | undefined> {
	if (ompDefaultMode) return ompDefaultMode;
	const { promise, resolve } = Promise.withResolvers<PermissionMode | undefined>();
	ompDefaultMode = promise;
	const omp = resolveOmpPath();
	if (!omp) resolve(undefined);
	else
		execFile(omp, ["config", "get", "tools.approvalMode", "--json"], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
			if (err) return resolve(undefined);
			let parsed: unknown;
			try {
				parsed = JSON.parse(stdout);
			} catch {
				/* not JSON: omp too old for --json */
			}
			const value = parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : undefined;
			// omp's built-in default is yolo.
			resolve(permissionModeOf(value) ?? "auto");
		});
	return promise;
}

/**
 * Where the chat's task strip, `/queue` and Alt+Enter go when the planner holds the queues: a lane whose
 * id is an AO session id continues that session (PLANNER-API.md). The extension adapts its planner
 * store to this with ext-tasks' `SessionQueues` (`get` reads the live plan and never calls the planner; `PlannerStore.queue(id, [])`
 * is NOT a read: it creates an empty paused lane for a session that has none).
 */
export interface ChatQueueSource {
	get(sessionId: string): Promise<TaskQueue | null>;
	edit(sessionId: string, ops: QueueOp[]): Promise<TaskQueue | null>;
	/** The plan changed: the chat re-reads its queue and the usage windows. */
	onDidChange: vscode.Event<unknown>;
	/** The provider usage windows the planner last read (`omp usage`; PlanView.status.usageWindows), for the footer's usage pill. */
	usage?(): ReadonlyArray<{ provider: string; window: string; usedPercent: number; resetsAt?: number }>;
}

/** The window's one AO change stream: events and its status (open/reset/gap/retrying/closed), so a chat opens no stream of its own. */
export interface ChatEventSource {
	onEvent: vscode.Event<{ sessionId?: string; type: string }>;
	onStatus: vscode.Event<AoStreamStatus>;
	/** The latest status, for a chat opened after it was announced. */
	readonly status: AoStreamStatus | undefined;
}

/** The part of the checkpoints extension's client the chat uses (`Checkpoints` in `src/ext/checkpoints.ts` on `ao/checkpoints`). Edits are keyed by omp's tool call ids. */
export interface ChatCheckpoints {
	undo(sessionId: string, target?: { turnId: string } | { text: string }): Promise<{ prompt?: string } | undefined>;
	redo(sessionId: string): Promise<unknown>;
	redoCount(sessionId: string): number;
	changes(sessionId: string): FileChange[];
	toolDiffs(sessionId: string, change: FileChange): DiffsByPath;
	blob(sessionId: string, hash: string | null): Uint8Array | undefined;
	/** AO turns to leave out: `undone` (omp rewound them) and `command` (/undo, /redo). */
	turnStatuses(sessionId: string, conversation: AoConversation): ReadonlyMap<string, string>;
	onDidChange: vscode.Event<{ sessionId: string; added: FileChange[] }>;
}

/**
 * The session's permission-mode file, which the Switchyard omp extension's gate reads on every tool call
 * (`readMode` in `src/shared/session-mode.ts` on `ao/checkpoints`). Switch with `setSessionMode(ao, id, mode)`
 * from `session-mode-ops.ts`, never by writing the file: it also sets omp's plan option and declines stale gate questions.
 */
export interface ChatModeGate {
	read(sessionId: string): PermissionMode | undefined;
	/** Resolves once the switch is done (the gate's waiting question, if any, is settled). */
	set(sessionId: string, mode: PermissionMode): Promise<unknown>;
}

export class ChatPanel implements vscode.Disposable {
	private ao: AoClient | undefined;
	private stream: AoEventSubscription | undefined;
	private streamOpen = false;
	/** The stream has been open once: a later `open` is a reconnect. */
	private sawOpen = false;
	private readonly subs: vscode.Disposable[] = [];
	private webviewReady = false;
	private readonly feed = new ChatFeed();
	/** The feed holds the full history the webview was initialized with. */
	private loaded = false;
	private syncTimer: NodeJS.Timeout | undefined;
	private syncing = false;
	private syncPending = false;
	private wantFull = false;
	private options: ConfigOption[] = [];
	private defaultMode: PermissionMode | undefined;
	private state: SlimState | null = null;
	private postedState = "";
	private serverCommands: SlashCommand[] = [];
	/** Prompt snippets offered as `/p:<name>` (settings + the session folder's .omp/prompts). */
	private snippets: PromptSnippet[] = [];
	/** `!command` output waiting to go into the next prompt's context. */
	private shellContext: string[] = [];
	private shell: ChildProcess | undefined;
	/** Tool cards whose inline diff comes from the checkpoints extension. */
	private readonly checkpointCards = new Set<string>();
	/** Identifies this chat's keep-awake lease on the AO chat. */
	private readonly viewId = crypto.randomUUID();
	private outbox: ToWebview[] = [];
	private flushTimer: NodeJS.Timeout | undefined;
	private leaseTimer: NodeJS.Timeout | undefined;
	private disposed = false;
	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	readonly onDidDispose = this.disposeEmitter.event;

	constructor(
		readonly sessionId: string,
		readonly surface: ChatSurface,
		private readonly sessions: SessionManager,
		private readonly snapshots: SnapshotProvider,
		private readonly extensionUri: vscode.Uri,
		private readonly globalState: vscode.Memento,
		private readonly organize: OrganizeStore,
		/** The extension's AO client (src/ao); rejects while no daemon answers. */
		private readonly connect: () => Promise<AoClient>,
		/** The planner's queue for this chat's session; absent: `sessions.queue/editQueue`. */
		private readonly tasks?: ChatQueueSource,
		/** Checkpoints (omp extension: undo/redo with files, recorded edits); absent: those buttons say so. */
		private readonly checkpoints?: ChatCheckpoints,
		/** The session's permission-mode file (Switchyard omp extension gate); absent: AO-native modes. */
		private readonly modes?: ChatModeGate,
		/** The window's shared AO change stream (`AoConnection` on `ao/ext-views`); absent: this chat opens its own. */
		private readonly events?: ChatEventSource,
	) {
		surface.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out"), vscode.Uri.joinPath(extensionUri, "media")] };
		surface.webview.html = this.html();
		this.subs.push(
			surface.webview.onDidReceiveMessage((m: FromWebview) => void this.onWebviewMessage(m).catch(err => this.post({ type: "error", message: errorText(err) }))),
			surface.onDidDispose(() => this.dispose()),
			sessions.onDidChange(() => this.onSessionsChanged()),
			decorationEmitter.event(() => this.updateTitle()),
			organize.onDidChange(() => this.postOrigin()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration("omp.chat.snippets")) this.reloadSnippets();
				if (e.affectsConfiguration("omp.chat.toolCardsCollapsed")) this.postChatConfig();
			}),
			{ dispose: () => this.stream?.close() },
			...(tasks ? [tasks.onDidChange(() => (void this.postQueue(), this.postState()))] : []),
			...(checkpoints ? [checkpoints.onDidChange(e => e.sessionId === sessionId && this.onCheckpoints(e.added))] : []),
		);
		const cwd = this.meta?.cwd;
		if (cwd) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(promptsDir(cwd)), "*.md"));
			this.subs.push(watcher, watcher.onDidCreate(() => this.reloadSnippets()), watcher.onDidChange(() => this.reloadSnippets()), watcher.onDidDelete(() => this.reloadSnippets()));
		}
		this.updateTitle();
		this.attach();
	}

	private starredModels(): string[] {
		const v = this.globalState.get<unknown>(STARRED_MODELS_KEY);
		return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
	}

	/** The session as the views know it, with the permission mode this chat reads from AO. */
	get meta(): SessionMeta | undefined {
		const meta = this.sessions.get(this.sessionId);
		const mode = this.mode;
		return meta && mode ? { ...meta, permissionMode: mode } : meta;
	}

	/** omp's permission mode: plan is omp's `mode` option; the others follow the approval mode AO launched omp with. */
	private get mode(): PermissionMode | undefined {
		const conv = this.feed.conversation;
		const gated = this.modes?.read(this.sessionId);
		if (gated) return gated;
		if (!conv) return undefined;
		if (this.option("mode")?.currentValue === "plan") return "plan";
		switch (conv.settings.approvalMode) {
			case "accept-edits":
			case "auto":
				return "edits";
			case "bypass-permissions":
				return "auto";
			default:
				return this.defaultMode;
		}
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

	/** Feed output, shrunk for the (possibly remote) webview channel. */
	private postFeed(msg: ToWebview): void {
		// An edit the checkpoints extension recorded is diffed from its snapshots (what Review and Revert use); AO's text diff is the fallback.
		if (msg.type === "diffs" && this.checkpointCards.has(msg.toolCallId)) return;
		if (msg.type !== "event") return this.post(msg);
		const ev = slimFrame(msg.ev);
		if (ev) this.post({ type: "event", ev });
	}

	// ---------- AO connection ----------

	/** Connects to AO and follows this session's change events; every change refetches the conversation's tail. */
	private attach(): void {
		void this.connect().then(
			ao => {
				if (this.disposed) return;
				this.ao = ao;
				const shared = this.events;
				if (shared) {
					// The window's one change stream: this chat only listens.
					this.subs.push(shared.onEvent(ev => this.onChange(ev)), shared.onStatus(s => this.onStreamStatus(s)));
					if (shared.status) this.onStreamStatus(shared.status, true);
				} else {
					this.stream = ao.events({ after: "latest", onEvent: ev => this.onChange(ev), onStatus: s => this.onStreamStatus(s) });
				}
				this.lease(this.surface.visible);
				this.leaseTimer = setInterval(() => this.lease(this.surface.visible), LEASE_RENEW_MS);
				this.schedule(true);
			},
			err => this.post({ type: "error", message: `AO daemon unreachable: ${errorText(err)}` }),
		);
	}

	private onChange(ev: { sessionId?: string; type: string }): void {
		if (ev.sessionId === this.sessionId && ev.type === "session_updated") this.schedule();
	}

	/** `initial`: the status the stream already had when this chat started listening (not a reconnect). */
	private onStreamStatus(s: AoStreamStatus, initial = false): void {
		const open = s.state === "open";
		if (open !== this.streamOpen) {
			this.streamOpen = open;
			this.post({ type: "connection", connected: open && this.loaded });
		}
		if (s.state === "open") {
			// A reconnect replays what it missed after Last-Event-ID; a replaced or pruned log can't, so read everything again.
			if (this.sawOpen && !initial && (s.reset || !s.resumed)) this.schedule(true);
			this.sawOpen = true;
		} else if (s.state === "gap") this.schedule(true);
	}

	private async client(): Promise<AoClient> {
		this.ao ??= await this.connect();
		return this.ao;
	}

	/** AO hibernates idle chats nobody watches; a visible chat holds a view lease (30 s in AO), renewed while it stays open. */
	private lease(active: boolean): void {
		void this.ao?.chatView(this.sessionId, this.viewId, active).catch(() => undefined);
	}

	private schedule(full = false): void {
		if (full) this.wantFull = true;
		if (this.syncTimer || this.disposed) return;
		this.syncTimer = setTimeout(
			() => {
				this.syncTimer = undefined;
				void this.sync();
			},
			full ? 0 : SYNC_DEBOUNCE_MS,
		);
	}

	/** One fetch at a time; events that arrive meanwhile run one more. */
	private async sync(): Promise<void> {
		if (this.syncing) {
			this.syncPending = true;
			return;
		}
		this.syncing = true;
		try {
			do {
				this.syncPending = false;
				const full = this.wantFull || !this.loaded;
				this.wantFull = false;
				if (!this.webviewReady) return;
				if (full) await this.reload();
				else await this.tail();
			} while (this.syncPending && !this.disposed);
		} catch (err) {
			// A chat still connecting answers 409; the next change event retries.
			if (!(err instanceof AoError && err.status === 409)) this.post({ type: "error", message: `Could not read the conversation from AO: ${errorText(err)}` });
		} finally {
			this.syncing = false;
		}
	}

	/** Reads the whole history (newest page first, then older pages) and re-initializes the webview. */
	private async reload(): Promise<void> {
		const ao = await this.client();
		const conv = await ao.getConversation(this.sessionId, { limit: HISTORY_PAGE });
		let oldest = conv.oldestSequence;
		let more = conv.hasMoreBefore;
		const merged: AoConversation = { ...conv, turns: [...conv.turns], messages: [...conv.messages], activities: [...conv.activities] };
		for (let page = 1; more && oldest && page < MAX_HISTORY_PAGES; page++) {
			const older = await ao.getConversation(this.sessionId, { beforeSequence: oldest, limit: HISTORY_PAGE });
			const known = new Set(merged.turns.map(t => t.id));
			merged.turns.push(...older.turns.filter(t => !known.has(t.id)));
			merged.messages.push(...older.messages);
			merged.activities.push(...older.activities);
			oldest = older.oldestSequence;
			more = older.hasMoreBefore;
		}
		if (this.disposed) return;
		if (this.checkpoints) this.feed.setTurnStatus(this.checkpoints.turnStatuses(this.sessionId, merged));
		const snap = this.feed.reset(merged);
		const view = this.checkpointView();
		this.loaded = true;
		await this.refreshOptions(ao);
		this.serverCommands = await this.skills(ao);
		this.snippets = loadSnippets(this.meta?.cwd);
		const meta = this.meta;
		if (!meta || this.disposed) return;
		this.outbox = [];
		this.postChatConfig();
		this.state = this.buildState();
		this.postedState = JSON.stringify([this.state, this.mode]);
		this.post({
			type: "init",
			meta,
			messages: snap.messages.map(m => slimMessage(m)),
			inflight: null,
			runningTools: [],
			pendingUi: snap.pendingUi,
			state: this.state,
			commands: mergeCommands(this.serverCommands, this.snippets),
			changes: view.changes,
			diffs: { ...snap.diffs, ...view.diffs },
			connected: this.streamOpen,
			home: os.homedir(),
			queue: await this.queueView(),
		});
		for (const m of snap.live) this.postFeed(m);
		this.post({ type: "checkpoints", redo: this.checkpoints?.redoCount(this.sessionId) ?? 0 });
		// Earlier side questions (/btw) live in AO as side chats: draw their cards again.
		void sideRecords(ao, this.sessionId).then(records => {
			for (const record of records) this.post({ type: "event", ev: { type: "btw_record", record } });
		}, () => undefined);
		this.postOrigin(true);
	}

	/** Reads what changed since the oldest row that may still change and forwards it. */
	private async tail(): Promise<void> {
		const ao = await this.client();
		const floor = this.feed.floor();
		const page = await ao.getConversation(this.sessionId, { ...(floor > 0 && { afterSequence: floor }), limit: HISTORY_PAGE });
		if (this.disposed) return;
		const wasBusy = this.feed.isBusy();
		for (const m of this.feed.apply(page)) this.postFeed(m);
		// The model can change inside a turn (omp's /model); config options have no change event.
		if (wasBusy && !this.feed.isBusy()) {
			await this.refreshOptions(ao);
			const skills = await this.skills(ao);
			if (JSON.stringify(skills) !== JSON.stringify(this.serverCommands)) {
				this.serverCommands = skills;
				this.post({ type: "commands", commands: mergeCommands(this.serverCommands, this.snippets) });
			}
		}
		// omp undid or redid a prompt (or ran /undo, /redo): the turns to hide changed, so show the new conversation.
		const cp = this.checkpoints;
		const full = this.feed.full();
		const statusChanged = !!cp && !!full && this.feed.setTurnStatus(cp.turnStatuses(this.sessionId, full));
		// A replayed copy of a turn already on screen (GAPS G33) turned up: rebuild without it.
		if (this.feed.takeStale() || statusChanged) this.schedule(true);
		this.postState();
	}

	private async refreshOptions(ao: AoClient): Promise<void> {
		try {
			this.options = (await ao.configOptions(this.sessionId)).options;
		} catch {
			// Not connected yet: the footer shows no model until the next turn ends.
		}
		this.defaultMode = await ompDefaultPermissionMode();
	}

	/** omp's slash commands, as AO lists them (skills). */
	private async skills(ao: AoClient): Promise<SlashCommand[]> {
		try {
			const skills = await ao.skills(this.sessionId);
			return skills.map(s => ({ name: s.name, ...(s.description && { description: s.description }), ...(s.inputHint && { input: { hint: s.inputHint } }) }));
		} catch {
			return this.serverCommands;
		}
	}

	private option(id: string): ConfigOption | undefined {
		return this.options.find(o => o.id === id);
	}

	/** omp's model option: id `model`, else whatever option AO files under the model category. */
	private modelOption(): ConfigOption | undefined {
		return this.option("model") ?? this.options.find(o => o.category === "model");
	}

	private thinkingOption(): ConfigOption | undefined {
		return this.option("thinking") ?? this.options.find(o => o.category === "thought_level");
	}

	private buildState(): SlimState {
		const state = this.feed.state();
		const model = this.modelOption();
		const value = model?.currentValue ?? this.feed.conversation?.settings.model;
		if (value) state.model = { ...splitModel(value), name: model?.choices?.find(c => c.value === value)?.name };
		const thinking = this.thinkingOption()?.currentValue;
		if (thinking) state.thinkingLevel = thinking;
		// How much of the model's provider quota is used comes from the planner (omp's own `usage`): AO sets a limit only when a prompt itself fails, and omp's limits end as completed turns (G35).
		const windows = this.tasks?.usage?.() ?? [];
		const mine = state.model?.provider ? windows.filter(w => w.provider === state.model?.provider) : windows;
		if (mine.length) state.usageWindows = mine.map(w => ({ window: w.window, usedPercent: w.usedPercent, ...(w.resetsAt && { resetsAtSec: Math.round(w.resetsAt / 1000) }) }));
		return state;
	}

	private postState(): void {
		this.state = this.buildState();
		// The mode chip lives in meta; plan mode changes only it.
		const json = JSON.stringify([this.state, this.mode]);
		if (json === this.postedState) return;
		this.postedState = json;
		this.post({ type: "state", state: this.state });
		const meta = this.meta;
		if (meta) this.post({ type: "meta", meta });
	}

	/** The session's task queue in the old `TaskQueue` shape: the planner's lane when `tasks` is set, else the session manager's. */
	private async queueView(): Promise<TaskQueue | null> {
		if (!this.tasks) return this.sessions.queue(this.sessionId);
		try {
			return await this.tasks.get(this.sessionId);
		} catch {
			return null; // planner unreachable: no strip
		}
	}

	private async postQueue(): Promise<void> {
		const queue = await this.queueView();
		if (queue) this.post({ type: "queue", queue });
	}

	/** Applies queue ops; false (with a notice carrying the planner's reason) when the edit was refused. */
	private async editQueue(ops: QueueOp[]): Promise<boolean> {
		try {
			if (!this.tasks) {
				await this.sessions.editQueue(this.sessionId, ops);
				if (this.meta?.status === "stopped") await this.postQueue();
				return true;
			}
			const queue = await this.tasks.edit(this.sessionId, ops);
			if (queue) this.post({ type: "queue", queue });
			return true;
		} catch (err) {
			this.post({ type: "notice", level: "warning", text: `Queue change refused: ${errorText(err)}` });
			return false;
		}
	}

	/**
	 * `/tui`: hands the session to omp's own terminal UI. AO stops the agent (the conversation stays), omp
	 * resumes the same omp session in a terminal, and closing the terminal gives the session back to AO.
	 * The omp session id is what the Switchyard omp extension recorded (GAPS G9); `AO_SESSION_ID` keeps its
	 * checkpoints and mode gate on in the terminal.
	 */
	private async openTui(): Promise<void> {
		const native = readNativeSession(this.sessionId);
		const omp = resolveOmpPath();
		const warn = (text: string) => this.post({ type: "notice", level: "warning", text });
		if (!native?.ompSessionId) return warn("omp's session id is not known yet: the Switchyard omp extension records it when the session starts. Send a message first, or check that the extension is installed.");
		if (!omp) return warn("Could not find the `omp` executable.");
		if (this.feed.isBusy()) return warn("omp is working: interrupt it (Esc), or wait for it to finish, before continuing in the terminal.");
		const ao = await this.client();
		await ao.exitAgent(this.sessionId);
		this.post({ type: "notice", level: "info", text: "Continuing in omp's terminal UI. The session returns to the background when you close that terminal." });
		const terminal = vscode.window.createTerminal({
			name: `omp · ${this.meta?.title ?? this.sessionId}`,
			cwd: native.cwd ?? this.meta?.cwd,
			shellPath: omp,
			shellArgs: ["--resume", native.ompSessionId],
			env: { AO_SESSION_ID: this.sessionId },
			location: { viewColumn: vscode.ViewColumn.Beside },
		});
		terminal.show();
		const closed = vscode.window.onDidCloseTerminal(t => {
			if (t !== terminal) return;
			closed.dispose();
			ao.resumeAgent(this.sessionId).then(
				() => this.schedule(true),
				err => this.post({ type: "notice", level: "error", text: `Could not give the session back to AO: ${errorText(err)}. Use Resume session.` }),
			);
		});
		this.subs.push(closed);
	}

	/** `/btw`: asks in a forked side chat; the webview draws the card as it fills. */
	private async askSide(typed: string): Promise<void> {
		const question = typed || (await vscode.window.showInputBox({ prompt: "Side question (answered without interrupting the agent)" })) || "";
		if (!question.trim()) return;
		try {
			await askSideQuestion(await this.client(), this.sessionId, question.trim(), record => this.post({ type: "event", ev: { type: "btw_record", record } }));
		} catch (err) {
			this.post({ type: "notice", level: "error", text: `Side question failed: ${errorText(err)}` });
		}
	}

	// ---------- checkpoints (omp extension) ----------

	private unavailable(what: string): void {
		this.post({ type: "notice", level: "warning", text: `${what} needs the Switchyard checkpoints extension, which is not loaded in this window.` });
	}

	/** The recorded edits of this session, keyed by the chat's tool card ids (AO activity ids) instead of omp's tool call ids. */
	private checkpointView(): { changes: FileChange[]; diffs: Record<string, DiffsByPath> } {
		const out: { changes: FileChange[]; diffs: Record<string, DiffsByPath> } = { changes: [], diffs: {} };
		const cp = this.checkpoints;
		if (!cp) return out;
		for (const c of cp.changes(this.sessionId)) {
			const card = this.feed.activityIdOf(c.toolCallId);
			if (!card) continue;
			out.changes.push({ ...c, toolCallId: card });
			const diffs = cp.toolDiffs(this.sessionId, c);
			// A change whose snapshots are too large to diff has no diffs: AO's stay.
			if (Object.keys(diffs).length) {
				out.diffs[card] = diffs;
				this.checkpointCards.add(card);
			}
		}
		return out;
	}

	/** New edits were recorded, or an undo/redo changed the state: show them, and re-read the conversation (hidden turns changed). */
	private onCheckpoints(added: FileChange[]): void {
		const cp = this.checkpoints;
		if (!cp) return;
		for (const c of added) {
			const card = this.feed.activityIdOf(c.toolCallId);
			if (!card) continue;
			const diffs = cp.toolDiffs(this.sessionId, c);
			if (Object.keys(diffs).length) this.checkpointCards.add(card);
			this.post({ type: "change", change: { ...c, toolCallId: card }, diffs });
		}
		this.post({ type: "checkpoints", redo: cp.redoCount(this.sessionId) });
		this.schedule();
	}

	/** Undoes the last prompt (or the one named): omp rewinds the conversation and restores the files; the prompt text returns to the composer. */
	private async undo(target?: { turnId: string } | { text: string }): Promise<void> {
		if (!this.checkpoints) return this.unavailable("Undo");
		const done = await this.checkpoints.undo(this.sessionId, target);
		if (done?.prompt) this.insertText(done.prompt);
	}

	/** Restores one file to its content right before the given tool call. */
	private async revertFile(cardId: string, file: string): Promise<void> {
		const cp = this.checkpoints;
		if (!cp) return this.unavailable("Revert");
		const ompId = this.feed.toolCallIdOf(cardId);
		const changes = cp.changes(this.sessionId);
		const change = changes.find(c => c.toolCallId === ompId);
		const entry = change?.files.find(f => f.path === file);
		if (!change || !entry) return;
		const name = path.relative(this.meta?.cwd ?? "", file) || file;
		const later = changes.some(c => c.timestamp > change.timestamp && c.files.some(f => f.path === file));
		const ok = await vscode.window.showWarningMessage(
			`Revert ${name} to its content before this edit?`,
			{ modal: true, detail: later ? "Later edits to this file in this session will be undone too." : entry.before === null ? "The file did not exist before; it will be deleted." : undefined },
			"Revert",
		);
		if (ok !== "Revert") return;
		const uri = vscode.Uri.file(file);
		if (entry.before === null) await vscode.workspace.fs.delete(uri, { useTrash: true });
		else {
			const content = cp.blob(this.sessionId, entry.before);
			if (!content) {
				this.post({ type: "notice", level: "warning", text: `The snapshot of ${name} before that edit is gone; nothing reverted.` });
				return;
			}
			await vscode.workspace.fs.writeFile(uri, content);
		}
		this.post({ type: "notice", level: "info", markdown: true, text: `Reverted \`${name}\` to before that ${change.toolName}.` });
	}

	private async postModels(): Promise<void> {
		await this.refreshOptions(await this.client());
		this.post({
			type: "models",
			models: (this.modelOption()?.choices ?? []).map(c => ({ ...splitModel(c.value), name: c.name })),
			levels: (this.thinkingOption()?.choices ?? []).map(c => c.value),
			starred: this.starredModels(),
		});
		this.postState();
	}

	/** Sets one of omp's config options (model, thinking, mode); AO answers with the whole new list. */
	private async setOption(id: string, value: string): Promise<void> {
		const ao = await this.client();
		this.options = (await ao.setConfigOption(this.sessionId, id, { value })).options;
		this.postState();
	}

	/**
	 * Permission modes are live through the Switchyard omp extension (MAPPING Q4/D11): its gate reads the
	 * session's mode file on every tool call, so a switch applies at once, mid-turn, with no client open.
	 * A session without a mode file (started from AO's own UI) runs in AO's mode; the chat can't change it.
	 */
	private async setMode(mode: PermissionMode): Promise<void> {
		if (this.modes && this.modes.read(this.sessionId) !== undefined) {
			await this.modes.set(this.sessionId, mode);
			this.postState();
			this.schedule();
			return;
		}
		this.post({ type: "notice", level: "warning", text: "This session was not started by Switchyard, so its permission mode is AO's and cannot be switched here. Sessions started from Switchyard switch modes live." });
	}

	// ---------- session chrome ----------

	private onSessionsChanged(): void {
		const meta = this.meta;
		if (!meta) return;
		this.updateTitle();
		this.post({ type: "meta", meta });
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
		const cwd = this.meta?.cwd;
		const expanded = candidate.startsWith("~/") ? path.join(os.homedir(), candidate.slice(2)) : candidate;
		// Without a workspace only absolute paths resolve.
		if (!cwd && !path.isAbsolute(expanded)) return undefined;
		const abs = path.resolve(cwd ?? "", expanded);
		return fs.existsSync(abs) ? abs : undefined;
	}

	/** Writes pasted/dropped files into Switchyard's state dir; returns prompt lines describing every attachment. */
	private storeAttachments(files: FileAttachment[]): string[] {
		const dir = path.join(switchyardHome(), "sessions", this.sessionId, "attachments");
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

	/**
	 * `!command`: omp runs `!` only in its terminal UI (over ACP it is an ordinary prompt), so the chat runs
	 * it in the session folder and, like omp, hands the output to the model with the next prompt.
	 */
	private async runShell(command: string, keep: boolean): Promise<void> {
		if (this.shell) {
			this.post({ type: "notice", level: "warning", text: "A shell command is still running (Esc stops it)." });
			return;
		}
		// AO has no workspace for this session (terminated, worktree released): there is no folder to run in.
		const cwd = this.meta?.cwd;
		if (!cwd) {
			this.post({ type: "notice", level: "warning", text: "This session has no workspace folder any more, so there is nowhere to run the command." });
			return;
		}
		const win = process.platform === "win32";
		const child = spawn(win ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh", win ? ["/d", "/s", "/c", command] : ["-c", command], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		this.shell = child;
		let output = "";
		const add = (b: Buffer) => {
			output += b.toString("utf8");
		};
		child.stdout?.on("data", add);
		child.stderr?.on("data", add);
		const { promise, resolve } = Promise.withResolvers<{ code: number | undefined; cancelled: boolean }>();
		child.on("error", err => {
			output += String(err);
			resolve({ code: 127, cancelled: false });
		});
		child.on("close", (c, signal) => resolve({ code: c ?? undefined, cancelled: signal !== null }));
		const { code, cancelled } = await promise;
		this.shell = undefined;
		this.post({ type: "bashResult", command, output, exitCode: code, cancelled });
		if (keep && !cancelled) {
			const text = output.length > MAX_SHELL_CONTEXT ? `… [${output.length - MAX_SHELL_CONTEXT} chars cut]\n${output.slice(-MAX_SHELL_CONTEXT)}` : output;
			this.shellContext.push(`**!${command}** · ran in \`${cwd}\`${code ? ` (exit ${code})` : ""}\n\`\`\`text\n${text.trimEnd()}\n\`\`\``);
		}
	}

	private get commandContext(): CommandContext {
		return {
			sessionId: this.sessionId,
			meta: this.meta,
			feed: this.feed,
			mode: this.mode,
			ao: () => this.client(),
			post: msg => this.post(msg),
			insertText: text => this.insertText(text),
			setMode: mode => this.setMode(mode),
			askSide: question => this.askSide(question),
			runShell: (command, keep) => this.runShell(command, keep),
		};
	}

	/** Sends a prompt: a new turn when omp is idle; while it works, steers the turn or queues behind it (`omp.sendWhileBusy`). */
	private async send(message: string, images: Array<{ data: string; mimeType: string }>): Promise<void> {
		const ao = await this.client();
		const attachments = images.map(i => ({ data: i.data, mimeType: i.mimeType }));
		const steer = this.feed.isBusy() && (vscode.workspace.getConfiguration("omp").get<string>("sendWhileBusy") ?? "steer") === "steer";
		// The same id on a retry after a restart: AO answers a duplicate instead of sending twice. The wrappers add AO's upload-deadline header for images.
		const body = { text: message, clientMessageId: crypto.randomUUID(), ...(attachments.length && { attachments }) };
		await sendResuming(
			ao,
			this.sessionId,
			async () => void (await (steer ? ao.steerOrSend(this.sessionId, body) : ao.sendMessage(this.sessionId, body))),
			() => this.post({ type: "notice", level: "info", text: "omp was not running: restarting it on this conversation…" }),
		);
		this.schedule();
	}

	// ---------- webview -> AO ----------
	private async onWebviewMessage(m: FromWebview): Promise<void> {
		switch (m.type) {
			case "ready":
				this.webviewReady = true;
				this.schedule(true);
				return;
			case "prompt": {
				const images = m.images ?? [];
				const files = m.files ?? [];
				const queued = /^\/(queue|task)\s+([\s\S]+)$/.exec(m.text.trim());
				if (queued) {
					const [first, ...rest] = queued[2].trim().split("\n");
					const { title, subtasks } = parseTaskInput(first);
					if (await this.editQueue([{ op: "add", title, subtasks, notes: rest.join("\n").trim() || undefined }])) this.post({ type: "notice", level: "info", text: `Queued task: ${title}` });
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
				if (this.meta?.status === "stopped") {
					this.post({ type: "error", message: "Session is stopped. Resume it first." });
					return;
				}
				await this.saveDirtyDocuments();
				const expansion = await expandContextMentions(text, this.meta?.cwd);
				for (const u of expansion.unavailable) this.post({ type: "notice", level: "warning", text: `@${u.kind}: ${u.reason}` });
				let message = appendContext(expansion.text, "shell commands run from the chat", this.shellContext);
				if (files.length) {
					const listed = this.storeAttachments(files);
					message = `${message}${message ? "\n\n" : ""}Attached files (read them with your read tool):\n${listed.map(f => `- ${f}`).join("\n")}`;
				}
				if (!message.trim() && images.length) message = images.length === 1 ? "(see attached image)" : "(see attached images)";
				await this.send(message, images);
				this.shellContext = [];
				return;
			}
			case "abort":
				if (this.shell) {
					this.shell.kill();
					return;
				}
			{
				const again = await interruptKeepingQueue(await this.client(), this.sessionId);
				if (again) this.post({ type: "notice", level: "info", text: `Interrupted. AO drops the messages queued behind a turn, so your ${again} queued message${again === 1 ? " was" : "s were"} sent again.` });
				this.schedule();
				return;
			}
			case "uiResponse": {
				const req = this.feed.request(m.res.id);
				if (req?.question.url && m.res.value === OPEN_LINK) {
					await openUrlFromOmp(req.question.url);
					this.post({ type: "event", ev: { ...req.ui } });
					return;
				}
				const reply = req && replyFor(req, m.res);
				if (!req || !reply) return;
				const ao = await this.client();
				try {
					if (reply.kind === "approval") await ao.resolveApproval(this.sessionId, req.question.id, reply.decisionId);
					else await ao.resolveInput(this.sessionId, req.question.id, { action: reply.action, ...(reply.content && { content: reply.content }) });
				} catch (err) {
					// Answered elsewhere (another client, AO's timeout): the next refetch drops the dialog.
					if (!(err instanceof AoError && err.code === "CHAT_REQUEST_NOT_PENDING")) throw err;
				}
				this.schedule();
				return;
			}
			case "openFile": {
				const abs = this.resolveCandidate(m.path) ?? (this.meta?.cwd || path.isAbsolute(m.path) ? path.resolve(this.meta?.cwd ?? "", m.path) : undefined);
				if (!abs) return;
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
				const cwd = this.meta?.cwd;
				const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach", defaultUri: cwd ? vscode.Uri.file(cwd) : undefined });
				if (!picked?.length) return;
				const images = [];
				const files = [];
				for (const uri of picked) {
					const mimeType = IMAGE_MIME[path.extname(uri.fsPath).toLowerCase()];
					const stat = await vscode.workspace.fs.stat(uri);
					// AO takes up to 10 MiB per image.
					if (mimeType && stat.size < 10 * 1024 * 1024) {
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
			case "setModel":
				await this.setOption(this.modelOption()?.id ?? "model", m.provider ? `${m.provider}/${m.id}` : m.id);
				return;
			case "setThinking":
				await this.setOption(this.thinkingOption()?.id ?? "thinking", m.level);
				return;
			case "removeQueued": {
				const item = this.feed.queued().find(q => q.text === m.text);
				if (item) await (await this.client()).cancelQueuedTurn(this.sessionId, item.turnId);
				this.schedule();
				return;
			}
			case "queueOp":
				await this.editQueue(m.ops);
				return;
			case "focusTasks":
				await vscode.commands.executeCommand("omp.tasks.focus");
				return;
			case "command":
				await this.runCommand(m.name);
				return;
			case "setMode":
				await this.setMode(m.mode);
				return;
			case "starModel": {
				const key = `${m.provider}/${m.id}`;
				const starred = this.starredModels();
				await this.globalState.update(STARRED_MODELS_KEY, starred.includes(key) ? starred.filter(k => k !== key) : [...starred, key]);
				await this.postModels();
				return;
			}
			case "restoreCheckpoint":
			case "rewindTo":
				// Both rewind to before that prompt (files and conversation) and put its text back in the composer.
				await this.undo(m.turnId ? { turnId: m.turnId } : { text: m.text });
				return;
			case "revertFile":
				await this.revertFile(m.toolCallId, m.path);
				return;
		}
	}

	private async runCommand(name: PanelCommand): Promise<void> {
		if (await runSessionAction(name, this.commandContext)) return;
		const meta = this.meta;
		switch (name) {
			case "compact": {
				const ao = await this.client();
				this.post({ type: "event", ev: { type: "auto_compaction_start" } });
				await ao.compact(this.sessionId);
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
			case "undoTurn":
				await this.undo();
				return;
			case "openTui":
				await this.openTui();
				return;
			case "redoTurn":
				if (!this.checkpoints) return this.unavailable("Redo");
				await this.checkpoints.redo(this.sessionId);
				return;
			case "openHermesCard":
				await vscode.commands.executeCommand("omp.hermes.openCard", this.sessionId);
				return;
			case "showHermesCard":
				await vscode.commands.executeCommand("omp.hermes.showCard", this.sessionId);
				return;
			case "exportMarkdownCopy":
			case "exportMarkdownSave":
				await exportMarkdown(name === "exportMarkdownCopy" ? "copy" : "save", this.feed.transcript(), meta, msg => this.post(msg));
				return;
		}
	}

	/** Snippet text with `{{selection}}` / `{{file}}` filled in from the editor the user last used. */
	private fillSnippet(prompt: string): string {
		const { text, missing } = expandPlaceholders(prompt, placeholderValues(this.meta?.cwd));
		if (missing.length) this.post({ type: "notice", level: "warning", text: `Snippet placeholder ${missing.map(k => `{{${k}}}`).join(", ")} left empty: ${missing.includes("selection") ? "nothing is selected" : "no editor is open"}.` });
		return text;
	}

	/** The edit's before/after in VS Code's diff editor, from the texts AO recorded for the tool call. */
	private async openDiff(toolCallId: string, file?: string): Promise<void> {
		const texts = this.feed.fileTexts(toolCallId);
		const t = texts.find(x => !file || x.path === file || x.path.endsWith(file)) ?? texts[0];
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
		clearTimeout(this.syncTimer);
		clearInterval(this.leaseTimer);
		this.lease(false);
		this.shell?.kill();
		for (const d of this.subs) d.dispose();
		this.surface.release();
		this.disposeEmitter.fire();
		this.disposeEmitter.dispose();
	}
}

/** `provider/id` (omp's model option values) → the picker's parts. */
function splitModel(value: string): { provider: string; id: string } {
	const slash = value.indexOf("/");
	return slash > 0 ? { provider: value.slice(0, slash), id: value.slice(slash + 1) } : { provider: "", id: value };
}
