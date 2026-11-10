// Switchyard Overview: one editor tab that answers "what needs me, what runs, what is next, what is blocked, what
// is held and why". It shows what AO and the planner already know (sessions with their planner state, the plan's
// tasks, holds, limits and budget, orchestrators, pull requests) and every click goes to the thing that already
// exists: the chat, the Tasks view's commands, the scheduler commands, the PR review, the orchestrator's chat,
// the Hermes card. It refreshes on the change events the stores already emit (no timers of its own) and does
// nothing while hidden. The model is src/overview/overview-core.ts's; the page is src/overview/main.ts.
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { prFactsOf } from "../ao/pr";
import { type FromOverview, type OverviewInput, type OverviewOrchestrator, type OverviewSession, type SchedulerAction, buildOverview, overviewSession } from "../overview/overview-core";
import { hermesOrigin } from "../shared/hermes-origin";
import type { OmpApi } from "./api";
import { queueAction } from "./board";
import { orchestratorStatus } from "./orchestrator-core";
import type { PlannerStore } from "./planner-store";
import { projectRoot } from "./sessions";
import { taskNodeOf } from "./task-graph";

/** The scheduler command behind each of the page's scheduler buttons. */
const SCHEDULER_COMMAND: Record<SchedulerAction, string> = {
	togglePause: "switchyard.scheduler.togglePause",
	increase: "switchyard.scheduler.increase",
	decrease: "switchyard.scheduler.decrease",
	setConcurrency: "switchyard.scheduler.setConcurrency",
	setBudget: "switchyard.scheduler.setBudget",
	setUsage: "switchyard.scheduler.setUsage",
	configure: "switchyard.scheduler.configure",
};

const OPEN_COMMAND: Record<Extract<FromOverview, { type: "open" }>["what"], string> = {
	board: "switchyard.board",
	taskGraph: "switchyard.tasks.showGraph",
	tasks: "switchyard.tasks.focus",
	usage: "switchyard.dashboard",
};

function sessionsOf(api: OmpApi): OverviewSession[] {
	return api.sessions
		.all()
		.filter(m => api.sessions.inScope(m) && api.organize.session(m.id).archived !== true)
		.map(m => {
			const model = api.sessions.model(m.id);
			const origin = hermesOrigin(api.organize.session(m.id).tags);
			return overviewSession(m, {
				// AO runs project sessions in worktrees named after the session: name the repository instead.
				project: path.basename(projectRoot(m.cwd).root) || m.cwd,
				...(model?.question && { question: model.question }),
				...(origin?.card && { card: { ...(origin.board && { board: origin.board }), card: origin.card } }),
				prs: (model?.view.prs ?? []).map(prFactsOf),
			});
		});
}

function orchestratorsOf(api: OmpApi): OverviewOrchestrator[] {
	return api.orchestrators.entries.flatMap(({ project, orchestrator: o }) =>
		o
			? [
					{
						projectId: project.id,
						projectName: project.name,
						id: o.id,
						active: o.active,
						status: orchestratorStatus(o),
						displayStatus: o.displayStatus,
						...(o.harness && { harness: o.harness }),
						...(o.model && { model: o.model }),
						updatedAt: o.updatedAt,
						...(o.question && { question: { title: o.question.title, approval: o.question.approval } }),
						counts: o.counts,
					},
				]
			: [],
	);
}

function html(api: OmpApi, webview: vscode.Webview): string {
	const nonce = crypto.randomBytes(16).toString("base64");
	const js = webview.asWebviewUri(vscode.Uri.joinPath(api.context.extensionUri, "out", "overview.js"));
	const css = webview.asWebviewUri(vscode.Uri.joinPath(api.context.extensionUri, "out", "overview.css"));
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Switchyard Overview</title>
</head>
<body>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

export function registerOverview(api: OmpApi, planner: PlannerStore): void {
	const { context } = api;
	let panel: vscode.WebviewPanel | undefined;
	/** What the page last got (without its clock), so an event that changes nothing it shows sends nothing. */
	let last = "";
	/** Something changed while the page was hidden. */
	let stale = false;

	const input = (): OverviewInput => ({ now: Date.now(), sessions: sessionsOf(api), orchestrators: orchestratorsOf(api), plan: planner.plan, ...(planner.error && { plannerError: planner.error }) });

	const refresh = (force = false) => {
		if (!panel) return;
		if (!panel.visible) {
			stale = true;
			return;
		}
		stale = false;
		const model = buildOverview(input());
		const key = JSON.stringify({ ...model, now: 0 });
		if (key === last && !force) return;
		last = key;
		void panel.webview.postMessage({ type: "data", model });
	};

	/** The chat of a planner task: its own session, else its queue's. */
	const chatOfTask = (id: string): string | undefined => {
		const plan = planner.plan;
		const task = plan?.tasks.find(t => t.id === id);
		const lane = task?.lane ? plan?.lanes.find(l => l.id === task.lane) : undefined;
		return [task?.session, lane?.session, lane?.id].find((s): s is string => s !== undefined && api.sessions.get(s) !== undefined);
	};

	const handle = async (msg: FromOverview): Promise<void> => {
		const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args);
		switch (msg.type) {
			case "ready":
				last = "";
				refresh(true);
				break;
			// The answer UI is the chat's (and the orchestrator's chat is an ordinary one): the same command the Orchestrators view's question row runs.
			case "openSession":
				await run(msg.answer ? "switchyard.orchestrator.openSessionChat" : "switchyard.openSession", msg.id);
				break;
			case "openTask": {
				const session = chatOfTask(msg.id);
				if (session) await run("switchyard.openSession", session);
				else await run("switchyard.tasks.focus");
				break;
			}
			case "runTask": {
				const node = taskNodeOf(planner.plan, msg.id);
				if (node) await run("switchyard.tasks.runNow", node);
				break;
			}
			case "requeue":
				await queueAction(api, msg.id, "requeue");
				break;
			case "changes":
				await run("switchyard.reviewChanges", msg.id);
				break;
			case "reviewPr":
				await run("switchyard.pr.review", { session: msg.session, pr: msg.pr });
				break;
			case "openOrchestrator":
				await run("switchyard.orchestrator.openChat", msg.projectId);
				break;
			case "openCard":
				await run("switchyard.hermes.openCard", msg.id);
				break;
			case "clearLimits":
				await run("switchyard.scheduler.clearLimits", msg.provider ?? true);
				break;
			case "scheduler":
				await run(SCHEDULER_COMMAND[msg.action]);
				break;
			case "open":
				await run(OPEN_COMMAND[msg.what]);
				break;
		}
	};

	const open = () => {
		if (panel) {
			panel.reveal();
			refresh(true);
			return;
		}
		const created = vscode.window.createWebviewPanel("switchyard.overview", "Switchyard Overview", vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "out")],
		});
		panel = created;
		created.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "switchyard-color.svg");
		created.webview.html = html(api, created.webview);
		created.webview.onDidReceiveMessage((m: FromOverview) => void handle(m));
		// The orchestrators are read again on AO's events only while someone shows them: the overview does while it is on screen.
		api.orchestrators.setVisible(created.visible, "overview");
		void api.orchestrators.refresh();
		created.onDidChangeViewState(() => {
			api.orchestrators.setVisible(created.visible, "overview");
			if (created.visible && stale) refresh();
		});
		created.onDidDispose(() => {
			api.orchestrators.setVisible(false, "overview");
			panel = undefined;
			last = "";
		});
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("switchyard.overview", open),
		api.sessions.onDidChange(() => refresh()),
		planner.onDidChange(() => refresh()),
		api.orchestrators.onDidChange(() => refresh()),
		api.organize.onDidChange(() => refresh()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("switchyard.sessionScope")) refresh();
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
		{ dispose: () => panel?.dispose() },
	);
}
