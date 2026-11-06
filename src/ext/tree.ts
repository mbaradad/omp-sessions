import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionMeta } from "../shared/protocol";
import { type SessionManager, projectRoot } from "./sessions";

export type Node =
	| { kind: "project"; root: string; isRepo: boolean; sessions: SessionMeta[]; inWorkspace: boolean }
	| { kind: "session"; meta: SessionMeta; project?: string }
	| { kind: "group"; label: string; sessions: SessionMeta[] }
	| { kind: "file"; sessionId: string; cwd: string; file: string; op: string; count: number };

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

export class SessionTree implements vscode.TreeDataProvider<Node> {
	private readonly emitter = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(
		private readonly sessions: SessionManager,
		/** Sessions with news the user has not looked at (finished or asking while unattended). */
		private readonly isUnread: (id: string) => boolean = () => false,
	) {
		sessions.onDidChange(() => this.emitter.fire(undefined));
	}

	refresh(): void {
		this.emitter.fire(undefined);
	}

	getTreeItem(node: Node): vscode.TreeItem {
		if (node.kind === "project") {
			const active = node.sessions.filter(m => m.status !== "stopped");
			const waiting = node.sessions.filter(m => m.status === "waiting").length;
			const working = node.sessions.filter(m => m.status === "working" || m.status === "starting").length;
			const expanded = node.inWorkspace || active.length > 0;
			const item = new vscode.TreeItem(path.basename(node.root) || node.root, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
			item.id = `project:${node.root}`;
			item.iconPath = new vscode.ThemeIcon(node.isRepo ? "repo" : "folder", waiting ? new vscode.ThemeColor("charts.yellow") : working ? new vscode.ThemeColor("charts.blue") : undefined);
			const parts = [working ? `${working} working` : "", waiting ? `${waiting} needs input` : "", `${node.sessions.length} session${node.sessions.length === 1 ? "" : "s"}`].filter(Boolean);
			item.description = parts.join(" · ");
			item.tooltip = `${node.root}${node.inWorkspace ? "\n(in this workspace)" : ""}`;
			item.contextValue = "project";
			item.resourceUri = vscode.Uri.file(node.root);
			return item;
		}
		if (node.kind === "group") {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon("folder-library");
			item.description = `${node.sessions.length}`;
			item.contextValue = "group";
			return item;
		}
		if (node.kind === "file") {
			const item = new vscode.TreeItem(vscode.Uri.file(node.file), vscode.TreeItemCollapsibleState.None);
			const dir = path.relative(node.cwd, path.dirname(node.file));
			item.description = `${dir.startsWith("..") ? path.dirname(node.file) : dir || "."} · ${node.op}${node.count > 1 ? ` ×${node.count}` : ""}`;
			item.tooltip = `${node.file}\nClick to diff against the content before the session touched it.`;
			item.command = { command: "omp.openSessionFileDiff", title: "Open diff", arguments: [node.sessionId, node.file] };
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
		const where = node.project ? path.relative(node.project, m.cwd) : inWs ? "" : path.basename(m.cwd);
		item.description = [unread ? "● new" : "", STATUS_LABEL[m.status], where, relTime(m.updatedAt)].filter(Boolean).join(" · ");
		const tip = new vscode.MarkdownString(undefined, true);
		tip.appendMarkdown(`**${m.title.replace(/[*_`[\]]/g, "\\$&")}**\n\n`);
		tip.appendMarkdown(`$(folder) \`${m.cwd}\`  \n$(pulse) ${STATUS_LABEL[m.status]}${m.exitReason && m.status === "stopped" ? ` (${m.exitReason})` : ""}  \n`);
		if (m.model) tip.appendMarkdown(`$(hubot) ${m.model}  \n`);
		if (m.changedFiles) tip.appendMarkdown(`$(diff) ${m.changedFiles} file(s) changed  \n`);
		if (m.cost) tip.appendMarkdown(`$(credit-card) $${m.cost.toFixed(2)}  \n`);
		if (m.lastText) tip.appendCodeblock(m.lastText, "markdown");
		item.tooltip = tip;
		item.contextValue = m.status === "stopped" ? "session.stopped" : "session.running";
		item.command = { command: "omp.openSession", title: "Open", arguments: [m.id] };
		return item;
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			const all = this.sessions.all();
			const cfg = vscode.workspace.getConfiguration("omp");
			const showAll = cfg.get<boolean>("showAllSessions") ?? false;
			const noWorkspace = (vscode.workspace.workspaceFolders ?? []).length === 0;
			if ((cfg.get<string>("groupBy") ?? "project") === "project") {
				const byRoot = new Map<string, SessionMeta[]>();
				for (const m of all) {
					const inWs = this.sessions.inWorkspace(m);
					if (!inWs && !showAll && !noWorkspace && m.status === "stopped") continue;
					const root = projectRoot(m.cwd);
					byRoot.set(root.root, [...(byRoot.get(root.root) ?? []), m]);
				}
				const projects = [...byRoot].map(([root, sessions]) => ({
					kind: "project" as const,
					root,
					isRepo: projectRoot(sessions[0].cwd).isRepo,
					sessions,
					inWorkspace: sessions.some(m => this.sessions.inWorkspace(m)),
				}));
				const recent = (p: (typeof projects)[number]) => Math.max(...p.sessions.map(m => m.updatedAt));
				projects.sort((a, b) => Number(b.inWorkspace) - Number(a.inWorkspace) || recent(b) - recent(a));
				return projects;
			}
			const local = all.filter(m => this.sessions.inWorkspace(m));
			const other = all.filter(m => !this.sessions.inWorkspace(m));
			const nodes: Node[] = local.map(meta => ({ kind: "session", meta }));
			if (other.length && (showAll || noWorkspace)) {
				if (noWorkspace) nodes.push(...other.map(meta => ({ kind: "session" as const, meta })));
				else nodes.push({ kind: "group", label: "Other folders", sessions: other });
			} else if (other.some(m => m.status !== "stopped")) {
				nodes.push({ kind: "group", label: "Running in other folders", sessions: other.filter(m => m.status !== "stopped") });
			}
			return nodes;
		}
		if (node.kind === "project") return node.sessions.map(meta => ({ kind: "session", meta, project: node.root }));
		if (node.kind === "group") return node.sessions.map(meta => ({ kind: "session", meta }));
		if (node.kind === "session") {
			const byFile = new Map<string, { op: string; count: number }>();
			for (const c of this.sessions.changes(node.meta.id)) {
				for (const f of c.files) {
					const prev = byFile.get(f.path);
					if (!prev) byFile.set(f.path, { op: f.op, count: 1 });
					else {
						prev.count++;
						if (f.op === "delete") prev.op = prev.op === "create" ? "created+deleted" : "delete";
					}
				}
			}
			return [...byFile].map(([file, v]) => ({ kind: "file", sessionId: node.meta.id, cwd: node.meta.cwd, file, op: v.op, count: v.count }));
		}
		return [];
	}
}
