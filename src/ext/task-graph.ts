// Task Graph: the plan as a graph in an editor-area webview (src/graph). Shows dependencies (`after`) and
// queue order, live from the planner; node actions reuse the Tasks view's commands, so a click here does
// what the same entry in the tree does. One panel per window.
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { FromGraph, ToGraph } from "../graph/main";
import { planGraph } from "../shared/plan-graph";
import { tasksOf } from "../shared/plan-tree";
import type { OmpApi } from "./api";
import type { TaskNode, TasksProvider } from "./tasks";
import type { TasksDeps } from "./tasks-deps";

/** Tasks view command that implements each graph action. */
const COMMAND: Record<Extract<FromGraph, { type: "action" }>["action"], string> = {
	openChat: "omp.tasks.openChat",
	runNow: "omp.tasks.runNow",
	requeue: "omp.tasks.markPending",
	dependencies: "switchyard.tasks.setDependencies",
	schedule: "omp.tasks.schedule",
};

function html(api: OmpApi, webview: vscode.Webview): string {
	const nonce = crypto.randomBytes(16).toString("base64");
	const js = webview.asWebviewUri(vscode.Uri.joinPath(api.context.extensionUri, "out", "graph.js"));
	const css = webview.asWebviewUri(vscode.Uri.joinPath(api.context.extensionUri, "out", "graph.css"));
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Switchyard: Task Graph</title>
</head>
<body>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

export function registerTaskGraph(api: OmpApi, deps: TasksDeps, provider: TasksProvider): void {
	const { context } = api;
	let panel: vscode.WebviewPanel | undefined;

	const post = (msg: ToGraph) => void panel?.webview.postMessage(msg);
	const refresh = () => {
		if (!panel) return;
		const plan = deps.planner.plan;
		if (!plan) post({ type: "unreachable", reason: deps.planner.error ?? "no answer yet" });
		else post({ type: "graph", graph: planGraph(plan, l => l.title ?? provider.sessionTitle(l.session ?? l.id) ?? l.id) });
	};

	/** The Tasks view node of a task, so the tree's own commands can act on it. */
	const nodeOf = (id: string): TaskNode | undefined => {
		const plan = deps.planner.plan;
		const task = plan?.tasks.find(t => t.id === id);
		return plan && task ? { kind: "task", task, index: tasksOf(plan, task.lane).indexOf(task) } : undefined;
	};

	const open = () => {
		if (panel) {
			panel.reveal();
			refresh();
			return;
		}
		panel = vscode.window.createWebviewPanel("switchyard.taskGraph", "Switchyard: Task Graph", vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "out")],
		});
		panel.webview.html = html(api, panel.webview);
		panel.webview.onDidReceiveMessage((m: FromGraph) => {
			if (m.type === "ready") refresh();
			else if (m.type === "action") {
				const node = nodeOf(m.id);
				const command = COMMAND[m.action];
				if (node && command) void vscode.commands.executeCommand(command, node);
			}
		});
		panel.onDidDispose(() => {
			panel = undefined;
		});
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("switchyard.tasks.showGraph", open),
		deps.planner.onDidChange(refresh),
		{ dispose: deps.aoSessions.onChange(refresh) },
		{ dispose: () => panel?.dispose() },
	);
}
