import type * as vscode from "vscode";
import type { LaunchOptions } from "../shared/launch";
import type { OrganizeStore } from "../shared/organize";
import type { SessionMeta } from "../shared/protocol";
import type { SnapshotProvider } from "./diff";
import type { ChatPanel } from "./panel";
import type { SessionManager } from "./sessions";
import type { Node, SessionTree } from "./tree";

/** What feature modules (`register*(context, api)`) get from extension.ts. */
export interface OmpApi {
	readonly context: vscode.ExtensionContext;
	readonly sessions: SessionManager;
	readonly snapshots: SnapshotProvider;
	/** Open (or reveal) a session's chat; `where` overrides `omp.chatLocation`. */
	openPanel(id: string, where?: "editor" | "sidebar"): ChatPanel | undefined;
	/** Start a session, wait until it listens, open its chat. Shows errors itself. */
	launchAndOpen(opts: LaunchOptions): Promise<ChatPanel | undefined>;
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
	readonly sessionsView: vscode.TreeView<Node>;
}
