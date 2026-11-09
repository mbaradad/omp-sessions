import * as path from "node:path";
import * as vscode from "vscode";
import { SYNC_LABEL } from "../kanban/board";
import { hermesOrigin, isHermesTag, originLabel } from "../shared/hermes-origin";
import { type OrganizeStore, effectiveColor, groupPath } from "../shared/organize";
import { type ViewNode, buildView, isGroupMode, isSortMode, siblingIds } from "../shared/organize-view";
import type { SessionMeta } from "../shared/protocol";
import { agentState } from "../shared/session-report";
import { orgThemeColor } from "./organize";
import { type SessionManager, projectRoot } from "./sessions";
import { headOf } from "./worktree-git";

/** Layout nodes (projects, custom groups, sections, sessions; see shared/organize-view) plus changed files (AO per-turn diffs: lines added/deleted). */
export type Node = ViewNode | { kind: "file"; sessionId: string; cwd: string; file: string; op: string; additions: number; deletions: number };

/** Container nodes (everything with children computed by the layout). */
export type ContainerNode = Exclude<Node, { kind: "session" } | { kind: "file" }>;

const DND_MIME = "application/vnd.code.tree.switchyard.sessions.organize";
const NO_QUEUE: NonNullable<SessionMeta["queue"]> = { pending: 0, running: 0, done: 0, total: 0, autoRun: false };

export function isNode(v: unknown): v is Node {
	return !!v && typeof v === "object" && "kind" in v && typeof v.kind === "string";
}

function relTime(ts: number): string {
	const s = Math.max(0, (Date.now() - ts) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

const STATUS_ICON: Record<SessionMeta["status"], vscode.ThemeIcon> = {
	starting: new vscode.ThemeIcon("loading~spin"),
	working: new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue")),
	waiting: new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.yellow")),
	idle: new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green")),
	stopped: new vscode.ThemeIcon("circle-outline"),
};

const STATUS_LABEL: Record<SessionMeta["status"], string> = {
	starting: "starting",
	working: "working",
	waiting: "needs input",
	idle: "idle",
	stopped: "stopped",
};

/** "3 · 1 working · 1 needs input" for a container. */
function groupSummary(sessions: readonly SessionMeta[]): string {
	const working = sessions.filter(m => m.status === "working" || m.status === "starting").length;
	const waiting = sessions.filter(m => m.status === "waiting").length;
	return [`${sessions.length}`, working ? `${working} working` : "", waiting ? `${waiting} needs input` : ""].filter(Boolean).join(" · ");
}

/** Session state shapes for colored session icons (the color is the user's label, the shape the status). */
const STATUS_SHAPE: Record<SessionMeta["status"], string> = {
	starting: "loading~spin",
	working: "loading~spin",
	waiting: "bell-dot",
	idle: "circle-filled",
	stopped: "circle-outline",
};

const SECTION_ICON: Record<string, vscode.ThemeIcon> = {
	pinned: new vscode.ThemeIcon("pinned"),
	archived: new vscode.ThemeIcon("archive"),
	ungrouped: new vscode.ThemeIcon("inbox"),
	other: new vscode.ThemeIcon("folder-library"),
	"status:waiting": new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.yellow")),
	"status:working": new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue")),
	"status:idle": new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green")),
	"status:stopped": new vscode.ThemeIcon("circle-outline"),
};

export class SessionTree implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
	private readonly emitter = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	readonly dragMimeTypes = [DND_MIME];
	readonly dropMimeTypes = [DND_MIME];
	/** Text filter of the view (organize.ts). */
	filter = "";
	/** Whether archived sessions are listed (organize.ts). */
	showArchived = false;
	/** Whether stopped sessions are hidden; unread ones stay until looked at (organize.ts). */
	hideFinished = false;
	/** Whether sessions marked completed are hidden (organize.ts). */
	hideCompleted = false;
	/** Stopped sessions the last render hid because of `hideFinished`. */
	hiddenFinished = 0;
	/** Root nodes the last render produced. */
	rootCount = 0;
	/** Called after each root render, e.g. to refresh the view description (organize.ts). */
	onRender: (() => void) | undefined;
	/** Handles drops of sessions/groups (organize.ts). */
	onDrop: ((target: Node | undefined, dragged: Node[]) => Promise<void> | void) | undefined;
	/** Root nodes of the last render. */
	private layout: ViewNode[] = [];

	constructor(
		private readonly sessions: SessionManager,
		/** Sessions with news the user has not looked at (finished or asking while unattended). */
		private readonly isUnread: (id: string) => boolean,
		readonly organize: OrganizeStore,
	) {
		sessions.onDidChange(() => this.emitter.fire(undefined));
		organize.onDidChange(() => this.emitter.fire(undefined));
	}

	refresh(): void {
		this.emitter.fire(undefined);
	}

	/** Ids of the sessions directly inside the container `key`, in display order (organize.ts drop/move). */
	sessionIdsIn(key: string): string[] {
		return siblingIds(this.layout, key);
	}

	getTreeItem(node: Node): vscode.TreeItem {
		if (node.kind === "project") {
			const active = node.sessions.filter(m => m.status !== "stopped");
			const waiting = node.sessions.filter(m => m.status === "waiting").length;
			const working = node.sessions.filter(m => m.status === "working" || m.status === "starting").length;
			const item = new vscode.TreeItem(path.basename(node.root) || node.root, this.collapsible(node, node.inWorkspace || active.length > 0));
			item.id = this.containerId(node);
			item.iconPath = new vscode.ThemeIcon(node.isRepo ? "repo" : "folder", waiting ? new vscode.ThemeColor("charts.yellow") : working ? new vscode.ThemeColor("charts.blue") : undefined);
			const parts = [working ? `${working} working` : "", waiting ? `${waiting} needs input` : "", `${node.sessions.length} session${node.sessions.length === 1 ? "" : "s"}`].filter(Boolean);
			item.description = parts.join(" · ");
			item.tooltip = `${node.root}${node.inWorkspace ? "\n(in this workspace)" : ""}`;
			item.contextValue = "project";
			item.resourceUri = vscode.Uri.file(node.root);
			return item;
		}
		if (node.kind === "orgGroup") {
			const g = node.group;
			const item = new vscode.TreeItem(g.name, this.collapsible(node, true));
			item.id = this.containerId(node);
			item.iconPath = new vscode.ThemeIcon(g.icon ?? "folder", orgThemeColor(g.color));
			item.description = groupSummary(node.sessions);
			item.tooltip = `${groupPath(this.organize.data, g.id)}\n${node.sessions.length} session(s)${g.color ? ` · ${g.color}` : ""}\nDrop sessions or groups here to move them into this group.`;
			item.contextValue = "orgGroup";
			return item;
		}
		if (node.kind === "section") {
			const defaultOpen = node.section === "pinned" || node.section === "ungrouped" || (node.section === "status" && node.status !== "stopped");
			const item = new vscode.TreeItem(node.label, this.collapsible(node, defaultOpen));
			item.id = this.containerId(node);
			item.iconPath = SECTION_ICON[node.key] ?? SECTION_ICON[node.section];
			item.description = node.section === "status" ? `${node.sessions.length}` : groupSummary(node.sessions);
			item.contextValue = `section.${node.section}`;
			return item;
		}
		if (node.kind === "file") {
			const item = new vscode.TreeItem(vscode.Uri.file(node.file), vscode.TreeItemCollapsibleState.None);
			const dir = path.relative(node.cwd, path.dirname(node.file));
			item.description = `${dir.startsWith("..") ? path.dirname(node.file) : dir || "."} · ${node.op}${node.additions || node.deletions ? ` +${node.additions} −${node.deletions}` : ""}`;
			item.tooltip = `${node.file}\nClick to diff against the content before the session touched it.`;
			item.command = { command: "switchyard.openSessionFileDiff", title: "Open diff", arguments: [node.sessionId, node.file] };
			item.contextValue = "file";
			return item;
		}
		const m = node.meta;
		const inWs = this.sessions.inWorkspace(m);
		const unread = this.isUnread(m.id);
		const label: vscode.TreeItemLabel = { label: m.title, highlights: unread ? [[0, m.title.length]] : undefined };
		const item = new vscode.TreeItem(label, m.changedFiles > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		item.id = `session:${m.id}`;
		item.iconPath = m.status === "stopped" && m.exitCode && m.exitCode !== 0 ? new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red")) : STATUS_ICON[m.status];
		const worktree = projectRoot(m.cwd).worktree;
		const branch = worktree && headOf(worktree.gitDir);
		const where = worktree ? `⎇ ${branch ?? path.basename(worktree.root)}` : node.project ? path.relative(node.project, m.cwd) : inWs ? "" : path.basename(m.cwd);
		item.description = [unread ? "● new" : "", STATUS_LABEL[m.status], where, relTime(m.updatedAt)].filter(Boolean).join(" · ");
		const tip = new vscode.MarkdownString(undefined, true);
		tip.appendMarkdown(`**${m.title.replace(/[*_`[\]]/g, "\\$&")}**\n\n`);
		tip.appendMarkdown(`$(folder) \`${m.cwd}\`  \n$(pulse) ${STATUS_LABEL[m.status]}${m.exitReason && m.status === "stopped" ? ` (${m.exitReason})` : ""}  \n`);
		if (worktree) tip.appendMarkdown(`$(git-branch) worktree on \`${branch ?? "?"}\`  \n`);
		if (m.model) tip.appendMarkdown(`$(hubot) ${m.model}  \n`);
		if (m.changedFiles) tip.appendMarkdown(`$(diff) ${m.changedFiles} file(s) changed  \n`);
		if (m.cost) tip.appendMarkdown(`$(credit-card) $${m.cost.toFixed(2)}  \n`);
		if (m.authProblem && m.status !== "stopped") tip.appendMarkdown(`$(warning) omp can't use a model: ${m.authProblem.replace(/[*_`[\]]/g, "\\$&")} — run **Switchyard: Log In to a Model Provider**  \n`);
		if (m.exitReason) tip.appendMarkdown(`$(info) ${m.exitReason.replace(/[*_`[\]]/g, "\\$&")}  \n`);
		if (m.queue?.waitReason) tip.appendMarkdown(`$(clock) ${m.queue.state ?? "waiting"}: ${m.queue.waitReason.replace(/[*_`[\]]/g, "\\$&")}  \n`);
		if (m.queue?.sync) {
			const from = m.queue.sync.parents.map(id => this.sessions.get(id)?.title ?? id.slice(0, 8)).join(", ");
			const files = m.queue.sync.files?.length ? ` in ${m.queue.sync.files.slice(0, 5).join(", ")}${m.queue.sync.files.length > 5 ? ", …" : ""}` : "";
			tip.appendMarkdown(`$(git-merge) ${SYNC_LABEL[m.queue.sync.state]}${from ? ` — from ${from.replace(/[*_`[\]]/g, "\\$&")}` : ""}${files.replace(/[*_`[\]]/g, "\\$&")}  \n`);
		}
		if (m.queue?.after?.length) {
			const names = m.queue.after.map(id => `“${(this.sessions.get(id)?.title ?? `${id.slice(0, 8)} (deleted)`).replace(/[*_`[\]]/g, "\\$&")}”`);
			tip.appendMarkdown(`$(type-hierarchy) Queued tasks wait for ${names.join(", ")} to finish  \n`);
		}
		if (m.lastText) tip.appendCodeblock(m.lastText, "markdown");
		item.tooltip = tip;
		item.contextValue = `${m.status === "stopped" ? "session.stopped" : "session.running"}${worktree ? ".worktree" : ""}`;
		item.command = { command: "switchyard.openSession", title: "Open", arguments: [m.id] };
		this.organizeItem(item, node);
		return item;
	}

	/** Collapse state: remembered per container (organize.json); everything opens while filtering. */
	private collapsible(node: ContainerNode, openByDefault: boolean): vscode.TreeItemCollapsibleState {
		if (this.filter) return vscode.TreeItemCollapsibleState.Expanded;
		const collapsed = this.organize.data.collapsed[node.key] ?? !openByDefault;
		return collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
	}

	/** Item id of a container; a different id while filtering so VS Code applies the expanded state. */
	private containerId(node: ContainerNode): string {
		const id = node.kind === "project" ? node.key : `org:${node.key}`;
		return this.filter ? `filtered:${id}` : id;
	}

	/** Colors, priority decoration, tags and context flags of a session item. */
	private organizeItem(item: vscode.TreeItem, node: Extract<Node, { kind: "session" }>): void {
		const m = node.meta;
		const data = this.organize.data;
		const e = data.sessions[m.id];
		const color = effectiveColor(data, m.id);
		const failed = m.status === "stopped" && !!m.exitCode;
		if (color && !failed) item.iconPath = new vscode.ThemeIcon(STATUS_SHAPE[m.status], orgThemeColor(color));
		// Completed shows while nothing happens in the session (activity icons win).
		const completed = m.queue?.completed === true;
		if (completed && (m.status === "idle" || m.status === "stopped") && !failed) item.iconPath = new vscode.ThemeIcon("pass-filled", orgThemeColor(color) ?? new vscode.ThemeColor("charts.green"));
		if (completed) item.description = ["✓ completed", item.description].filter(Boolean).join(" · ");
		const origin = hermesOrigin(e?.tags);
		const plainTags = origin ? (e?.tags ?? []).filter(t => !isHermesTag(t, origin)) : (e?.tags ?? []);
		if (origin || plainTags.length) item.description = [item.description, origin ? originLabel(origin) : "", plainTags.map(t => `#${t}`).join(" ")].filter(Boolean).join(" · ");
		// Priority badge and label color come from the organize FileDecorationProvider.
		item.resourceUri = vscode.Uri.from({ scheme: "omp-org", path: `/session/${m.id}` });
		if (item.tooltip instanceof vscode.MarkdownString) {
			const lines = [
				e?.priority ? `$(flame) priority: ${e.priority}` : "",
				e?.groupId ? `$(folder) group: ${groupPath(data, e.groupId)}` : "",
				e?.lane ? `$(project) lane: ${this.organize.lanes().find(l => l.id === e.lane)?.name ?? e.lane}` : "",
				origin ? `$(comment-discussion) ${origin.card ? `from Hermes kanban card \`${origin.card}\`${origin.board ? ` on board \`${origin.board}\`` : ""} — right-click: Open Hermes Card` : "started from a Hermes chat"}` : "",
				plainTags.length ? `$(tag) ${plainTags.map(t => `#${t}`).join(" ")}` : "",
				color ? `$(symbol-color) ${color}${e?.color ? "" : " (from group)"}` : "",
				e?.pinned ? "$(pinned) pinned" : "",
				e?.archived ? "$(archive) archived" : "",
				completed ? `$(pass) completed${m.queue?.completedAt ? ` ${new Date(m.queue.completedAt).toLocaleString()}` : ""}` : "",
			].filter(Boolean);
			if (lines.length) item.tooltip.appendMarkdown(`\n\n${lines.join("  \n")}`);
		}
		item.contextValue = `${item.contextValue ?? "session"}${e?.pinned ? ".pinned" : ""}${e?.archived ? ".archived" : ""}${completed ? ".completed" : ""}${e?.groupId ? ".grouped" : ""}${origin?.card ? ".hermesCard" : ""}`;
	}

	/** Session ids shown next to `node` in its container (display order). */
	siblingsOf(node: Extract<Node, { kind: "session" }>): string[] {
		return siblingIds(this.layout, node.parent);
	}

	/** The rendered node of a session (first match), e.g. for keyboard commands. */
	findSession(id: string): Extract<Node, { kind: "session" }> | undefined {
		const walk = (nodes: readonly ViewNode[]): Extract<Node, { kind: "session" }> | undefined => {
			for (const n of nodes) {
				if (n.kind === "session") {
					if (n.meta.id === id) return n;
				} else {
					const hit = walk(n.children);
					if (hit) return hit;
				}
			}
			return undefined;
		};
		return walk(this.layout);
	}

	handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
		const movable = source.filter(n => n.kind === "session" || n.kind === "orgGroup");
		if (movable.length) data.set(DND_MIME, new vscode.DataTransferItem(movable));
	}

	async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
		const raw = data.get(DND_MIME)?.value;
		const dragged = Array.isArray(raw) ? raw.filter(isNode) : [];
		if (dragged.length) await this.onDrop?.(target, dragged);
	}

	getParent(node: Node): Node | undefined {
		if (node.kind === "file") return this.findSession(node.sessionId);
		const key = node.kind === "session" ? node.parent : node.key;
		const walk = (nodes: readonly ViewNode[], parent: Node | undefined): Node | undefined | null => {
			for (const n of nodes) {
				if (n.kind === "session") {
					if (node.kind === "session" && n.meta.id === node.meta.id) return parent;
					continue;
				}
				if (node.kind !== "session" && n.key === key) return parent;
				const hit = walk(n.children, n);
				if (hit !== null) return hit;
			}
			return null;
		};
		return walk(this.layout, undefined) ?? undefined;
	}

	getChildren(node?: Node): Node[] | Promise<Node[]> {
		if (!node) {
			const cfg = vscode.workspace.getConfiguration("switchyard");
			const noWorkspace = (vscode.workspace.workspaceFolders ?? []).length === 0;
			const groupBy = cfg.get<string>("groupBy");
			const sortBy = cfg.get<string>("sortBy");
			let hidden = 0;
			this.layout = buildView({
				sessions: this.sessions.all(),
				data: this.organize.data,
				groupBy: isGroupMode(groupBy) ? groupBy : "project",
				sortBy: isSortMode(sortBy) ? sortBy : "auto",
				filter: this.filter,
				showArchived: this.showArchived,
				hideCompleted: this.hideCompleted,
				visible: m => {
					if (!this.sessions.inScope(m)) return false;
					// Finished = nothing ahead: scheduled, queued and interrupted sessions stay (their meta.queue is kept current).
					if (this.hideFinished && agentState({ meta: m, queue: m.queue ?? NO_QUEUE }) === "stopped" && !this.isUnread(m.id)) {
						hidden++;
						return false;
					}
					return true;
				},
				inWorkspace: m => this.sessions.inWorkspace(m),
				project: m => projectRoot(m.cwd),
				noWorkspace,
			});
			this.hiddenFinished = hidden;
			this.rootCount = this.layout.length;
			this.onRender?.();
			return this.layout;
		}
		if (node.kind !== "session" && node.kind !== "file") return node.children;
		if (node.kind === "session") return this.fileNodes(node.meta);
		return [];
	}

	/** The files a session changed in its worktree (AO `workspace/files`); none when AO can't say (e.g. a released workspace). */
	private async fileNodes({ id, cwd }: SessionMeta): Promise<Node[]> {
		const files = await this.sessions.workspaceFiles(id).catch(() => []);
		return files.map(f => ({ kind: "file", sessionId: id, cwd, file: path.resolve(cwd, f.path), op: f.status === "added" ? "create" : f.status === "deleted" ? "delete" : f.status === "renamed" ? "rename" : "update", additions: f.additions, deletions: f.deletions }));
	}
}
