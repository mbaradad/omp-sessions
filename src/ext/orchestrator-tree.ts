// The Orchestrators view: one node per AO project with an orchestrator (and this window's project always), with
// what it asks, last said, the workers it coordinates (with their PRs) and its settings. The data is
// OrchestratorStore's (src/ao/orchestrator.ts, refreshed on AO's change events); clicks open the chat panel, the
// existing answer UI, or the setting's editor.
import * as vscode from "vscode";
import { isOmpHarness } from "../ao/harness";
import type { OrchestratorInfo, OrchestratorWorker } from "../ao/orchestrator";
import { prSummaryLine } from "../shared/pr-review";
import type { OrchestratorStore } from "./orchestrator";
import { type ProjectEntry, orchestratorDescription, orchestratorStatus, replyLine, settingRows, workerDescription, workersSummary } from "./orchestrator-core";
import { STATUS_LABEL, statusOf } from "./session-view";
import { type SessionManager, projectRoot } from "./sessions";
import { STATUS_ICON, relTime } from "./tree";

/** Every node carries its project; the ones that stand for a session carry its id (the Sessions view's commands read it). */
export type OrchestratorNode =
	| { kind: "orchProject"; projectId: string; sessionId?: string; entry: ProjectEntry }
	| { kind: "orchNone"; projectId: string }
	| { kind: "orchQuestion"; projectId: string; sessionId: string; orchestrator: OrchestratorInfo }
	| { kind: "orchReply"; projectId: string; sessionId: string; reply: string }
	| { kind: "orchWorkers"; projectId: string; orchestrator: OrchestratorInfo }
	| { kind: "orchWorker"; projectId: string; sessionId: string; worker: OrchestratorWorker }
	| { kind: "orchSettings"; projectId: string; entry: ProjectEntry }
	| { kind: "orchSetting"; projectId: string; key: string; label: string; value: string }
	| { kind: "orchMessage"; projectId: ""; text: string };

const escape = (s: string): string => s.replace(/[*_`[\]]/g, "\\$&");

export class OrchestratorTree implements vscode.TreeDataProvider<OrchestratorNode> {
	private readonly emitter = new vscode.EventEmitter<OrchestratorNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(
		private readonly store: OrchestratorStore,
		private readonly sessions: SessionManager,
		/** Whether the chat has news the user has not looked at. */
		private readonly isUnread: (id: string) => boolean,
	) {
		store.onDidChange(() => this.refresh());
	}

	refresh(): void {
		this.emitter.fire(undefined);
	}

	getTreeItem(node: OrchestratorNode): vscode.TreeItem {
		switch (node.kind) {
			case "orchProject":
				return this.projectItem(node.entry);
			case "orchNone": {
				const item = new vscode.TreeItem("No orchestrator yet", vscode.TreeItemCollapsibleState.None);
				item.id = `orch:${node.projectId}:none`;
				item.description = "Give it a task";
				item.iconPath = new vscode.ThemeIcon("add");
				item.tooltip = "AO starts this project's orchestrator when it gets its first task: it splits the task into worker sessions, steers them and has their pull requests reviewed.";
				item.command = { command: "switchyard.orchestrator.submit", title: "Give Orchestrator a Task", arguments: [node.projectId] };
				item.contextValue = "orchestrator.none.hint";
				return item;
			}
			case "orchQuestion": {
				const q = node.orchestrator.question;
				const item = new vscode.TreeItem(`? ${q?.title ?? "Needs input"}`, vscode.TreeItemCollapsibleState.None);
				item.id = `orch:${node.projectId}:question`;
				item.description = q?.approval ? "approval needed" : "waiting for your answer";
				item.iconPath = STATUS_ICON.waiting;
				item.tooltip = [q?.title, q?.message].filter(Boolean).join("\n\n");
				item.command = { command: "switchyard.orchestrator.openSessionChat", title: "Answer", arguments: [node.sessionId] };
				item.contextValue = "orchestrator.question";
				return item;
			}
			case "orchReply": {
				const item = new vscode.TreeItem("Last reply", vscode.TreeItemCollapsibleState.None);
				item.id = `orch:${node.projectId}:reply`;
				item.description = replyLine(node.reply);
				item.iconPath = new vscode.ThemeIcon("comment");
				item.tooltip = node.reply;
				item.command = { command: "switchyard.orchestrator.openSessionChat", title: "Open Chat", arguments: [node.sessionId] };
				item.contextValue = "orchestrator.reply";
				return item;
			}
			case "orchWorkers": {
				const item = new vscode.TreeItem("Workers", node.orchestrator.workers.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
				item.id = `orch:${node.projectId}:workers`;
				item.description = node.orchestrator.workers.length ? workersSummary(node.orchestrator.counts) : "none yet";
				item.iconPath = new vscode.ThemeIcon("organization");
				item.tooltip = "The project's worker sessions (AO does not say which ones this orchestrator started).";
				item.contextValue = "orchestrator.workers";
				return item;
			}
			case "orchWorker":
				return this.workerItem(node);
			case "orchSettings": {
				const item = new vscode.TreeItem("Settings", vscode.TreeItemCollapsibleState.Collapsed);
				item.id = `orch:${node.projectId}:settings`;
				item.description = `${settingRows(node.entry.config).filter(r => r.set).length} set`;
				item.iconPath = new vscode.ThemeIcon("settings-gear");
				item.tooltip = "What the project's orchestrator and its workers start with. A running orchestrator keeps what it started with: Restart Orchestrator applies changes.";
				item.contextValue = "orchestrator.settings";
				return item;
			}
			case "orchSetting": {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
				item.id = `orch:${node.projectId}:setting:${node.key}`;
				item.description = node.value;
				item.tooltip = `${node.label}: ${node.value}\nClick to change it.`;
				item.command = { command: "switchyard.orchestrator.editSetting", title: "Change", arguments: [node.projectId, node.key] };
				item.contextValue = "orchestrator.setting";
				return item;
			}
			case "orchMessage": {
				const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon("warning");
				return item;
			}
		}
	}

	private projectItem({ project, orchestrator: o, inWorkspace }: ProjectEntry): vscode.TreeItem {
		const open = inWorkspace || o?.active === true;
		const item = new vscode.TreeItem(project.name, open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
		item.id = `orch:${project.id}`;
		const unread = !!o && this.isUnread(o.id);
		if (!o) {
			item.iconPath = new vscode.ThemeIcon("repo");
			item.description = "no orchestrator";
			item.contextValue = "orchestrator.none";
		} else {
			const status = orchestratorStatus(o);
			item.iconPath = STATUS_ICON[status];
			item.description = [unread ? "● new" : "", orchestratorDescription(o), relTime(o.updatedAt)].filter(Boolean).join(" · ");
			item.contextValue = o.active ? "orchestrator.running" : "orchestrator.stopped";
		}
		const tip = new vscode.MarkdownString(undefined, true);
		tip.appendMarkdown(`**${escape(project.name)}**${inWorkspace ? " (this workspace)" : ""}\n\n$(folder) \`${project.path}\`  \n`);
		if (o) {
			tip.appendMarkdown(`$(pulse) orchestrator ${STATUS_LABEL[orchestratorStatus(o)]}${o.displayStatus ? ` — ${escape(o.displayStatus)}` : ""}  \n`);
			if (o.harness) tip.appendMarkdown(`$(robot) ${isOmpHarness(o.harness) ? "omp" : escape(o.harness)}${o.model ? ` · ${escape(o.model)}` : ""}  \n`);
			if (o.branch) tip.appendMarkdown(`$(git-branch) \`${o.branch}\`  \n`);
		}
		item.tooltip = tip;
		return item;
	}

	private workerItem(node: Extract<OrchestratorNode, { kind: "orchWorker" }>): vscode.TreeItem {
		const w = node.worker;
		const status = statusOf(w.state);
		const item = new vscode.TreeItem(w.title, vscode.TreeItemCollapsibleState.None);
		item.id = `orch:${node.projectId}:worker:${w.id}`;
		item.iconPath = STATUS_ICON[status];
		item.description = workerDescription(w);
		const cwd = this.sessions.get(w.id)?.cwd;
		const worktree = cwd ? projectRoot(cwd).worktree : undefined;
		const tip = new vscode.MarkdownString(undefined, true);
		tip.appendMarkdown(`**${escape(w.title)}**\n\n$(pulse) ${STATUS_LABEL[status]}${w.displayStatus ? ` — ${escape(w.displayStatus)}` : ""}  \n`);
		if (w.branch) tip.appendMarkdown(`$(git-branch) \`${w.branch}\`  \n`);
		if (w.harness && !isOmpHarness(w.harness)) tip.appendMarkdown(`$(robot) ${escape(w.harness)}  \n`);
		for (const pr of w.prs) tip.appendMarkdown(`$(git-pull-request) [${prSummaryLine(pr)}](${pr.url})  \n`);
		item.tooltip = tip;
		item.command = { command: "switchyard.orchestrator.openSessionChat", title: "Open", arguments: [w.id] };
		// The Sessions view's actions apply to a worker the same way (they read `sessionId`).
		item.contextValue = `orchestrator.worker.${status === "stopped" ? "stopped" : "running"}${worktree ? ".worktree" : ""}`;
		return item;
	}

	getChildren(node?: OrchestratorNode): OrchestratorNode[] {
		if (!node) {
			if (!this.store.loaded) return [];
			if (this.store.error && !this.store.entries.length) return [{ kind: "orchMessage", projectId: "", text: `Could not read AO: ${this.store.error}` }];
			return this.store.entries.map(entry => ({ kind: "orchProject", projectId: entry.project.id, ...(entry.orchestrator && { sessionId: entry.orchestrator.id }), entry }));
		}
		switch (node.kind) {
			case "orchProject": {
				const { entry } = node;
				const o = entry.orchestrator;
				if (!o) return [{ kind: "orchNone", projectId: node.projectId }, { kind: "orchSettings", projectId: node.projectId, entry }];
				return [
					...(o.question ? [{ kind: "orchQuestion", projectId: node.projectId, sessionId: o.id, orchestrator: o } satisfies OrchestratorNode] : []),
					...(o.reply ? [{ kind: "orchReply", projectId: node.projectId, sessionId: o.id, reply: o.reply } satisfies OrchestratorNode] : []),
					{ kind: "orchWorkers", projectId: node.projectId, orchestrator: o },
					{ kind: "orchSettings", projectId: node.projectId, entry },
				];
			}
			case "orchWorkers":
				return node.orchestrator.workers.map(worker => ({ kind: "orchWorker", projectId: node.projectId, sessionId: worker.id, worker }));
			case "orchSettings":
				return settingRows(node.entry.config).map(row => ({ kind: "orchSetting", projectId: node.projectId, key: row.key, label: row.label, value: row.value }));
			default:
				return [];
		}
	}
}
