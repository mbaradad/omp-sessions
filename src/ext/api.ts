import type * as vscode from "vscode";
import type { OrganizeStore } from "../shared/organize";
import type { SoundPlayedMessage } from "../shared/completion-sound";
import type { SessionMeta } from "../shared/protocol";
import type { AoConnection } from "./ao-connection";
import type { SnapshotProvider } from "./diff";
import type { OrchestratorStore } from "./orchestrator";
import type { ChatPanel } from "./panel";
import type { NewSessionOptions, SessionManager } from "./sessions";
import type { Node, SessionTree } from "./tree";

/** What feature modules (`register*(context, api)`) get from extension.ts. */
export interface OmpApi {
	readonly context: vscode.ExtensionContext;
	/** The AO daemon connection (the only way to AO's API; `client()` connects or starts it). */
	readonly ao: AoConnection;
	readonly sessions: SessionManager;
	readonly snapshots: SnapshotProvider;
	/** Open (or reveal) a session's chat; `where` overrides `switchyard.chatLocation`. */
	openPanel(id: string, where?: "editor" | "sidebar"): ChatPanel | undefined;
	/** Start a session in AO (or resume `opts.id`), open its chat. Shows errors itself. */
	launchAndOpen(opts: NewSessionOptions): Promise<ChatPanel | undefined>;
	/** The harness a new session in `cwd` runs (SessionManager.chooseHarness: asks when several are logged in to AO and nobody chose); undefined when cancelled or it failed (shown). */
	chooseHarness(cwd: string): Promise<string | undefined>;
	/** Quick pick over sessions; undefined if cancelled or none match. */
	pickSession(placeHolder: string, filter?: (m: SessionMeta) => boolean): Promise<string | undefined>;
	/** Folder for a new session from a command argument (Uri, project node, path) or by asking. */
	pickFolder(arg?: unknown): Promise<string | undefined>;
	/** The chat that editor actions should send to (active/related chat, else asks). */
	targetPanel(cwdHint?: string): Promise<ChatPanel | undefined>;
	/** Session id from a command argument (id string, session node, file node). */
	idFrom(arg: unknown): string | undefined;
	/** Refresh the Sessions view. */
	refreshTree(): void;
	/** Close a session's chat if one is open (e.g. before removing the session). */
	closePanel(id: string): void;
	/** Whether a session has new activity the user has not seen (tree badge and board cards). */
	isUnread(id: string): boolean;
	/** User organization of sessions (organize.json): groups, colors, priorities, pins, lanes, order. */
	readonly organize: OrganizeStore;
	/** Sessions view data provider and view (selection, description, reveal). */
	readonly sessionTree: SessionTree;
	/** The AO projects' orchestrators with their workers and PRs (the Orchestrators view's data; refreshes on AO's change events). */
	readonly orchestrators: OrchestratorStore;
	readonly sessionsView: vscode.TreeView<Node>;
	/** A Switchyard webview reports it played a session cue (src/ext/sounds.ts); for tests and diagnostics. */
	readonly onDidPlaySound: vscode.Event<SoundPlayedMessage>;
}
