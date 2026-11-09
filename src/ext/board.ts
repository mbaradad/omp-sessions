// Sessions board (kanban) host: one shared editor panel that relays session data
// (sessions + organize + scheduler) to the webview and user actions back to the
// extension commands and the organize store. Pure board logic lives in ../kanban/board.ts.
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { effectiveColor, effectiveRank } from "../shared/organize";
import { type BoardData, type BoardCard, type FromBoard, type ToBoard, queueActions } from "../kanban/board";
import type { QueueOp } from "../shared/protocol";
import type { OmpApi } from "./api";
import { finishedAt, scheduledStart } from "../shared/session-sort";
import { askStartTime } from "./task-extras";
import { plain } from "./plain";
import { projectRoot } from "./sessions";
import { schedulerSnapshot, watchScheduler } from "./scheduler";
import { addSoundSink } from "./sounds";

let panel: vscode.WebviewPanel | undefined;

function post(msg: ToBoard): void {
	void panel?.webview.postMessage(msg);
}

function refresh(api: OmpApi): void {
	if (!panel) return;
	const s = schedulerSnapshot();
	post({ type: "data", data: buildData(api), scheduler: { running: s.running, max: s.maxConcurrent, waiting: s.waiting, paused: s.paused } });
}

function buildData(api: OmpApi): BoardData {
	const store = api.organize;
	const cards: BoardCard[] = api.sessions.all().filter(m => api.sessions.inScope(m)).map(m => {
		const e = store.session(m.id);
		return {
			id: m.id,
			title: m.title,
			cwd: m.cwd,
			// AO runs project sessions in worktrees named after the session: name the repository instead.
			project: path.basename(projectRoot(m.cwd).root) || m.cwd,
			status: m.status,
			lastText: m.lastText,
			cost: m.cost,
			queue: m.queue,
			sync: m.queue?.sync,
			waiting: m.queue?.waiting,
			createdAt: m.createdAt,
			updatedAt: m.updatedAt,
			unread: api.isUnread(m.id),
			priority: e.priority ?? "normal",
			rank: effectiveRank(e, m.createdAt),
			color: effectiveColor(store.data, m.id),
			pinned: e.pinned === true,
			archived: e.archived === true,
			tags: e.tags ?? [],
			lane: e.lane,
			group: e.groupId,
			startAt: scheduledStart(m.queue),
			completed: m.queue?.completed === true,
			completedAt: m.queue?.completedAt,
			finishedAt: finishedAt(m.status, m.updatedAt),
			...(m.queue?.after && { after: m.queue.after }),
			...(m.queue?.blockedBy && { blockedBy: m.queue.blockedBy }),
		};
	});
	return { cards, lanes: store.lanes(), groups: store.data.groups };
}

/** Board "apply": one store write for all lane/group/priority/rank patches of a move. */
function apply(api: OmpApi, updates: FromBoard): void {
	if (updates.type !== "apply") return;
	for (const u of updates.updates) {
		if (u.patch.priority !== undefined) void api.sessions.setPriority([u.id], u.patch.priority).catch(err => api.ao.log.warn(`planner priority: ${String(err)}`));
	}
	api.organize.update(d => {
		for (const u of updates.updates) {
			const e = d.sessions[u.id] ?? {};
			const p = u.patch;
			if (p.lane !== undefined) {
				if (p.lane) e.lane = p.lane;
				else delete e.lane;
			}
			if (p.group !== undefined) {
				if (p.group) e.groupId = p.group;
				else delete e.groupId;
			}
			if (p.priority !== undefined) {
				if (p.priority !== "normal") e.priority = p.priority;
				else delete e.priority;
			}
			if (p.rank !== undefined) e.rank = p.rank;
			d.sessions[u.id] = e;
		}
	});
}

/**
 * Run now (the planner's `run`: the queue's first pending task goes ahead and a scheduled start is dropped) or
 * Requeue (`lane.requeue`: failed tasks back to pending, else a paused or interrupted queue restarts, else the
 * last finished task runs again; a scheduled start is kept). Requeue falls back to run for a queue that only
 * has pending work, so a card dropped on Queued always starts what it can. The planner resumes a stopped
 * session itself when it dispatches.
 */
async function queueAction(api: OmpApi, id: string, action: "run" | "requeue"): Promise<void> {
	const meta = api.sessions.get(id);
	const q = api.sessions.queue(id);
	const can = queueActions({ queue: meta?.queue, startAt: scheduledStart(meta?.queue) });
	const ops: QueueOp[] = action === "requeue" && can.requeue ? [{ op: "requeue" }] : q.tasks.some(t => t.status === "pending") ? [{ op: "run" }] : [];
	if (ops.length === 0) {
		void vscode.window.showInformationMessage(`“${meta?.title ?? id}” has nothing to ${action === "requeue" ? "requeue" : "run"}.`);
		return;
	}
	try {
		await api.sessions.editQueue(id, ops);
	} catch (err) {
		void vscode.window.showWarningMessage(`Could not ${action === "requeue" ? "requeue" : "run"} “${meta?.title ?? id}”: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function handle(api: OmpApi, msg: FromBoard): Promise<void> {
	const store = api.organize;
	switch (msg.type) {
		case "ready":
			refresh(api);
			break;
		case "open":
			api.openPanel(msg.id);
			break;
		case "setDeps":
			await vscode.commands.executeCommand("switchyard.setDependencies", msg.id);
			break;
		case "stop":
			for (const id of msg.ids) await vscode.commands.executeCommand("switchyard.stopSession", id);
			break;
		case "resume":
			for (const id of msg.ids) await vscode.commands.executeCommand("switchyard.resumeSession", id);
			break;
		case "runNow":
			for (const id of msg.ids) await queueAction(api, id, "run");
			break;
		case "requeue":
			for (const id of msg.ids) await queueAction(api, id, "requeue");
			break;
		case "schedule": {
			// The board's menu offers the presets and Unschedule; "Other time…" arrives without `at`.
			const first = api.sessions.get(msg.ids[0] ?? "");
			if (!first) break;
			const at = msg.at !== undefined ? msg.at : await askStartTime(msg.ids.length > 1 ? `Start ${msg.ids.length} queues at` : `Start the queue “${first.title}” at`);
			if (at === undefined) break;
			for (const id of msg.ids) {
				try {
					await api.sessions.editQueue(id, [{ op: "schedule", at }]);
				} catch (err) {
					void vscode.window.showWarningMessage(`Could not ${at === null ? "unschedule" : "schedule"} “${api.sessions.get(id)?.title ?? id}”: ${err instanceof Error ? err.message : String(err)}`);
					break;
				}
			}
			break;
		}
		case "rerunWithParent":
			for (const id of msg.ids) {
				try {
					const n = await api.sessions.rerunWithParentChanges(id);
					if (n === 0) void vscode.window.showInformationMessage(`“${api.sessions.get(id)?.title ?? id}” has no parent changes to re-run with.`);
				} catch (err) {
					void vscode.window.showWarningMessage(`Could not re-run with parent changes: ${err instanceof Error ? err.message : String(err)}`);
					break;
				}
			}
			break;
		case "apply":
			apply(api, msg);
			break;
		case "setPriority":
			store.setPriority(msg.ids, msg.priority);
			void api.sessions.setPriority(msg.ids, msg.priority).catch(err => api.ao.log.warn(`planner priority: ${String(err)}`));
			break;
		case "setColor":
			store.setColor(msg.ids, msg.color ?? undefined);
			break;
		case "setArchived":
			store.setArchived(msg.ids, msg.archived);
			break;
		case "setCompleted":
			await api.sessions.setCompleted(msg.ids, msg.completed).catch(err => vscode.window.showWarningMessage(plain(`Could not ${msg.completed ? "mark completed" : "reopen"}: ${err instanceof Error ? err.message : String(err)}`)));
			break;
		case "addLane":
			store.createLane(msg.name);
			break;
		case "renameLane":
			store.updateLane(msg.id, { name: msg.name });
			break;
		case "moveLane": {
			const ids = store.lanes().map(l => l.id);
			const i = ids.indexOf(msg.id);
			const j = i + msg.delta;
			if (i < 0 || j < 0 || j >= ids.length) break;
			ids.splice(i, 1);
			ids.splice(j, 0, msg.id);
			store.reorderLanes(ids);
			break;
		}
		case "deleteLane":
			store.deleteLane(msg.id);
			break;
		case "concurrency":
			await vscode.commands.executeCommand("switchyard.scheduler.setConcurrency", msg.max);
			break;
		case "newSession": {
			const cwd = await api.pickFolder();
			if (cwd) await api.launchAndOpen({ cwd });
			break;
		}
		case "maximize":
			panel?.reveal(panel.viewColumn === vscode.ViewColumn.Beside ? vscode.ViewColumn.One : vscode.ViewColumn.Beside);
			break;
	}
}

function openBoard(api: OmpApi): void {
	if (panel) {
		panel.reveal();
		refresh(api);
		return;
	}
	panel = vscode.window.createWebviewPanel(
		"switchyard.board",
		"Switchyard",
		vscode.ViewColumn.Beside,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(api.context.extensionUri, "out")],
		},
	);
	const board = panel;
	board.webview.html = html(api, board.webview);
	board.webview.onDidReceiveMessage(m => void handle(api, m as FromBoard));
	const sound = addSoundSink({
		get visible() {
			return board.visible;
		},
		post: msg => board.webview.postMessage(msg),
	});
	board.onDidDispose(() => {
		sound.dispose();
		panel = undefined;
	});
	refresh(api);
}

function html(api: OmpApi, webview: vscode.Webview): string {
	const nonce = crypto.randomBytes(16).toString("base64");
	const js = webview.asWebviewUri(vscode.Uri.joinPath(api.context.extensionUri, "out", "kanban.js"));
	const css = webview.asWebviewUri(vscode.Uri.joinPath(api.context.extensionUri, "out", "kanban.css"));
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Switchyard</title>
</head>
<body>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

export function registerBoard(api: OmpApi): void {
	const { context } = api;
	context.subscriptions.push(
		vscode.commands.registerCommand("switchyard.board", () => openBoard(api)),
		api.sessions.onDidChange(() => refresh(api)),
		api.organize.onDidChange(() => refresh(api)),
		watchScheduler(() => refresh(api)),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("switchyard.sessionScope")) refresh(api);
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => refresh(api)),
	);
}
