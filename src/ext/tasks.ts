// Tasks view: per-session task queues (tasks → subtasks) that the detached host feeds to omp
// one by one, plus omp's own todo plan. Native TreeView: drag & drop to sort (also across
// sessions), checkboxes to complete, inline run/pause. Being a regular view, it can be moved to
// the panel or the secondary side bar.
import * as vscode from "vscode";
import { sendToHost } from "../shared/launch";
import type { QueueOp, QueueSubtask, QueueTask, SessionMeta } from "../shared/protocol";
import { describeOptions, formatDuration, formatStartTime } from "../shared/task-text";
import type { OmpApi } from "./api";
import type { SessionManager } from "./sessions";
import { registerTaskExtras } from "./task-extras";

type PlanPhase = NonNullable<SessionMeta["plan"]>[number];

export type TaskNode =
	| { kind: "session"; meta: SessionMeta }
	| { kind: "task"; sessionId: string; task: QueueTask; index: number }
	| { kind: "subtask"; sessionId: string; taskId: string; sub: QueueSubtask; index: number }
	| { kind: "plan"; sessionId: string; phases: PlanPhase[] }
	| { kind: "planItem"; sessionId: string; phaseIndex: number; itemIndex: number; item: PlanPhase["tasks"][number]; phaseName: string };

const MIME = "application/vnd.code.tree.omp.tasks";

const TASK_ICON: Record<QueueTask["status"], vscode.ThemeIcon> = {
	pending: new vscode.ThemeIcon("circle-large-outline"),
	running: new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.purple")),
	done: new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green")),
	failed: new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red")),
	skipped: new vscode.ThemeIcon("circle-slash"),
};

const PLAN_GLYPH: Record<string, string> = { completed: "✔", in_progress: "◐", pending: "○", abandoned: "✕", blocked: "⛔" };

export function isNode(v: unknown): v is TaskNode {
	return !!v && typeof v === "object" && "kind" in v && typeof v.kind === "string";
}

function fmtAgo(ts?: number): string {
	if (!ts) return "";
	const s = Math.max(0, (Date.now() - ts) / 1000);
	return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

/** "Title :: sub one; sub two" quick syntax for adding a task with subtasks. */
export function parseTaskInput(text: string): { title: string; subtasks: string[] } {
	const [title, rest] = text.split(/\s*::\s*/, 2);
	return { title: title.trim(), subtasks: (rest ?? "").split(/\s*;\s*/).map(s => s.trim()).filter(Boolean) };
}

export class TasksProvider implements vscode.TreeDataProvider<TaskNode>, vscode.TreeDragAndDropController<TaskNode> {
	private readonly emitter = new vscode.EventEmitter<TaskNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	readonly dragMimeTypes = [MIME];
	readonly dropMimeTypes = [MIME];

	constructor(private readonly sessions: SessionManager) {
		sessions.onDidChange(() => this.emitter.fire(undefined));
	}

	refresh(): void {
		this.emitter.fire(undefined);
	}

	private roots(): SessionMeta[] {
		return this.sessions
			.all()
			.filter(m => this.sessions.inWorkspace(m) || (m.queue?.pending ?? 0) > 0 || m.status !== "stopped")
			.filter(m => m.status !== "stopped" || (m.queue?.total ?? 0) > 0 || this.sessions.inWorkspace(m));
	}

	getChildren(node?: TaskNode): TaskNode[] {
		if (!node) return this.roots().map(meta => ({ kind: "session", meta }));
		if (node.kind === "session") {
			const q = this.sessions.queue(node.meta.id);
			const out: TaskNode[] = q.tasks.map((task, index) => ({ kind: "task", sessionId: node.meta.id, task, index }));
			if (node.meta.plan?.some(p => p.tasks.length)) out.push({ kind: "plan", sessionId: node.meta.id, phases: node.meta.plan });
			return out;
		}
		if (node.kind === "task") return node.task.subtasks.map((sub, index) => ({ kind: "subtask", sessionId: node.sessionId, taskId: node.task.id, sub, index }));
		if (node.kind === "plan") {
			return node.phases.flatMap((phase, phaseIndex) =>
				phase.tasks.map((item, itemIndex) => ({ kind: "planItem" as const, sessionId: node.sessionId, phaseIndex, itemIndex, item, phaseName: phase.name })),
			);
		}
		return [];
	}

	getTreeItem(node: TaskNode): vscode.TreeItem {
		switch (node.kind) {
			case "session": {
				const m = node.meta;
				const q = m.queue;
				const hasKids = (q?.total ?? 0) > 0 || !!m.plan?.some(p => p.tasks.length);
				const item = new vscode.TreeItem(m.title, hasKids ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
				item.id = `tasks:session:${m.id}`;
				item.iconPath = m.status === "stopped" ? new vscode.ThemeIcon("circle-outline") : m.status === "working" ? new vscode.ThemeIcon("loading~spin") : new vscode.ThemeIcon("comment-discussion");
				const parts = [
					q?.running ? "running" : "",
					q?.waiting ? `⏳ waiting for a slot (#${q.waiting.position})` : "",
					q?.pending ? `${q.pending} pending` : "",
					q?.total ? `${q.done}/${q.total} done` : "no tasks",
					q?.autoRun ? "▶ auto-run" : q?.startAt ? `⏰ starts ${formatStartTime(q.startAt)}` : q?.pending ? "⏸ paused" : "",
					m.status === "stopped" ? "stopped" : "",
				];
				item.description = parts.filter(Boolean).join(" · ");
				const when = q?.autoRun ? " (auto-run on)" : q?.startAt ? ` starting ${new Date(q.startAt).toLocaleString()}` : " when you start the queue";
				const waiting = q?.waiting ? `\n\nWaiting for a free slot (position ${q.waiting.position}): the global limit of concurrently running queued tasks is reached.` : "";
				item.tooltip = `${m.title}\n${m.cwd}\n\nTasks run one after another in the background${when}.${waiting}`;
				item.contextValue = q?.autoRun ? "tasks.session.auto" : "tasks.session.paused";
				return item;
			}
			case "task": {
				const t = node.task;
				const subsDone = t.subtasks.filter(s => s.done).length;
				const item = new vscode.TreeItem(t.title, t.subtasks.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
				item.id = `tasks:task:${node.sessionId}:${t.id}`;
				item.iconPath = TASK_ICON[t.status];
				item.checkboxState = t.status === "done" ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
				const results = t.status === "done" || t.status === "failed" ? [t.durationMs ? formatDuration(t.durationMs) : "", t.cost ? `$${t.cost.toFixed(t.cost < 0.01 ? 4 : 2)}` : ""] : [];
				const retrying = t.status === "pending" && t.attempts ? `↻ retry ${t.attempts}/${t.options?.retries ?? t.attempts}` : "";
				item.description = [
					t.status === "pending" ? "" : t.status,
					retrying,
					t.subtasks.length ? `${subsDone}/${t.subtasks.length}` : "",
					t.status === "done" || t.status === "failed" ? fmtAgo(t.finishedAt) : t.status === "running" ? fmtAgo(t.startedAt) : "",
					...results,
					...describeOptions(t.options),
				]
					.filter(Boolean)
					.join(" · ");
				const tip = new vscode.MarkdownString(undefined, true);
				tip.appendMarkdown(`**${t.title.replace(/[*_`[\]]/g, "\\$&")}**  \n$(pulse) ${t.status}`);
				if (results.some(Boolean)) tip.appendMarkdown(`  \n$(watch) ${results.filter(Boolean).join(" · ")}${t.attempts ? ` · ${t.attempts} attempt(s)` : ""}`);
				const opts = t.options;
				if (opts) {
					const lines = [
						opts.model ? `model \`${opts.model}\` (restored afterwards)` : "",
						opts.thinking ? `thinking \`${opts.thinking}\` (restored afterwards)` : "",
						opts.freshContext ? "fresh context: starts a new omp session (earlier conversation is not visible to it)" : "",
						opts.retries ? `up to ${opts.retries} automatic retr${opts.retries === 1 ? "y" : "ies"} on failure` : "",
						opts.timeoutMinutes ? `stopped after ${opts.timeoutMinutes} min` : "",
					].filter(Boolean);
					tip.appendMarkdown(`\n\n$(settings-gear) ${lines.join("  \n")}`);
				}
				if (t.notes) tip.appendMarkdown(`\n\n${t.notes}`);
				if (t.summary) {
					tip.appendMarkdown("\n\n---\n");
					tip.appendCodeblock(t.summary.slice(0, 1500), "markdown");
				}
				item.tooltip = tip;
				item.contextValue = `tasks.task.${t.status}`;
				return item;
			}
			case "subtask": {
				const item = new vscode.TreeItem(node.sub.title, vscode.TreeItemCollapsibleState.None);
				item.id = `tasks:sub:${node.sessionId}:${node.taskId}:${node.sub.id}`;
				item.checkboxState = node.sub.done ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
				item.contextValue = "tasks.subtask";
				return item;
			}
			case "plan": {
				const all = node.phases.flatMap(p => p.tasks);
				const done = all.filter(t => t.status === "completed" || t.status === "abandoned").length;
				const item = new vscode.TreeItem("omp's plan", vscode.TreeItemCollapsibleState.Collapsed);
				item.id = `tasks:plan:${node.sessionId}`;
				item.iconPath = new vscode.ThemeIcon("checklist");
				item.description = `${done}/${all.length}`;
				item.tooltip = "omp's own todo list for the current work (edit to steer it).";
				item.contextValue = "tasks.plan";
				return item;
			}
			case "planItem": {
				const item = new vscode.TreeItem(node.item.content, vscode.TreeItemCollapsibleState.None);
				item.id = `tasks:planItem:${node.sessionId}:${node.phaseIndex}:${node.itemIndex}`;
				item.checkboxState = node.item.status === "completed" ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
				item.description = `${PLAN_GLYPH[node.item.status] ?? ""} ${node.phaseName}${node.item.blocker ? ` · blocked: ${node.item.blocker}` : ""}`.trim();
				item.contextValue = "tasks.planItem";
				return item;
			}
		}
	}

	getParent(node: TaskNode): TaskNode | undefined {
		if (node.kind === "session") return undefined;
		const meta = this.sessions.get(node.sessionId);
		if (!meta) return undefined;
		if (node.kind === "subtask") {
			const q = this.sessions.queue(node.sessionId);
			const index = q.tasks.findIndex(t => t.id === node.taskId);
			return index >= 0 ? { kind: "task", sessionId: node.sessionId, task: q.tasks[index], index } : undefined;
		}
		if (node.kind === "planItem") return { kind: "plan", sessionId: node.sessionId, phases: meta.plan ?? [] };
		return { kind: "session", meta };
	}

	// ---------- drag & drop ----------
	handleDrag(source: readonly TaskNode[], data: vscode.DataTransfer): void {
		const movable = source.filter(n => n.kind === "task" || n.kind === "subtask");
		if (movable.length) data.set(MIME, new vscode.DataTransferItem(movable));
	}

	async handleDrop(target: TaskNode | undefined, data: vscode.DataTransfer): Promise<void> {
		const raw = data.get(MIME)?.value;
		const dragged = Array.isArray(raw) ? raw.filter(isNode) : [];
		if (!target || !dragged.length) return;
		const tasks = dragged.filter((n): n is Extract<TaskNode, { kind: "task" }> => n.kind === "task");
		const subs = dragged.filter((n): n is Extract<TaskNode, { kind: "subtask" }> => n.kind === "subtask");
		if (tasks.length) {
			const targetSession = target.kind === "session" ? target.meta.id : target.sessionId;
			let index = target.kind === "task" ? target.index : target.kind === "subtask" ? Number.POSITIVE_INFINITY : this.sessions.queue(targetSession).tasks.length;
			for (const t of tasks) {
				if (t.sessionId === targetSession) {
					await this.sessions.editQueue(targetSession, [{ op: "move", id: t.task.id, index }]);
				} else {
					// Moving across sessions: re-create in the target queue, then drop the original.
					if (t.task.status === "running") continue;
					await this.sessions.editQueue(targetSession, [{ op: "add", title: t.task.title, notes: t.task.notes, subtasks: t.task.subtasks.map(s => ({ title: s.title, done: s.done })), options: t.task.options, index }]);
					await this.sessions.editQueue(t.sessionId, [{ op: "remove", id: t.task.id }]);
				}
				if (Number.isFinite(index)) index++;
			}
		}
		for (const s of subs) {
			if (target.kind === "subtask" && target.taskId === s.taskId && target.sessionId === s.sessionId) {
				await this.sessions.editQueue(s.sessionId, [{ op: "moveSubtask", id: s.taskId, subtaskId: s.sub.id, index: target.index }]);
			} else if (target.kind === "task") {
				const ops: QueueOp[] = [{ op: "addSubtask", id: target.task.id, title: s.sub.title }];
				if (target.task.id !== s.taskId || target.sessionId !== s.sessionId) {
					await this.sessions.editQueue(target.sessionId, ops);
					await this.sessions.editQueue(s.sessionId, [{ op: "removeSubtask", id: s.taskId, subtaskId: s.sub.id }]);
				} else {
					await this.sessions.editQueue(s.sessionId, [{ op: "moveSubtask", id: s.taskId, subtaskId: s.sub.id, index: Number.MAX_SAFE_INTEGER }]);
				}
			}
		}
		this.refresh();
	}
}

/** Registers the Tasks view and its commands. */
export function registerTasks(api: OmpApi): TasksProvider {
	const { context, sessions, pickSession } = api;
	const provider = new TasksProvider(sessions);
	const view = vscode.window.createTreeView("omp.tasks", { treeDataProvider: provider, dragAndDropController: provider, canSelectMany: true, showCollapseAll: true });
	context.subscriptions.push(view);
	registerTaskExtras(api, view);

	const updateBadge = () => {
		const pending = sessions
			.all()
			.filter(m => sessions.inWorkspace(m))
			.reduce((n, m) => n + (m.queue?.pending ?? 0) + (m.queue?.running ?? 0), 0);
		view.badge = pending ? { value: pending, tooltip: `${pending} queued task(s)` } : undefined;
	};
	sessions.onDidChange(updateBadge);
	updateBadge();

	const ensureRunning = async (id: string) => {
		if (sessions.get(id)?.status === "stopped") await vscode.commands.executeCommand("omp.resumeSession", id);
	};

	const sessionFor = async (arg: unknown): Promise<string | undefined> => {
		if (typeof arg === "string") return arg;
		if (isNode(arg)) return arg.kind === "session" ? arg.meta.id : arg.sessionId;
		const running = sessions.all().filter(m => m.status !== "stopped" && sessions.inWorkspace(m));
		if (running.length === 1) return running[0].id;
		return pickSession("Add the task to which session?", m => sessions.inWorkspace(m));
	};

	const selected = (arg: unknown, args: unknown): TaskNode[] => {
		const many = Array.isArray(args) ? args.filter(isNode) : [];
		if (many.length) return many;
		return isNode(arg) ? [arg] : [...view.selection];
	};

	const reg = (name: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));

	reg("omp.tasks.add", async (arg?: unknown) => {
		const id = await sessionFor(arg);
		if (!id) {
			void vscode.window.showInformationMessage("Start an omp session first, then add tasks to its queue.");
			return;
		}
		const text = await vscode.window.showInputBox({
			title: "New task",
			prompt: "What should omp do? Add subtasks after '::', separated by ';' (e.g. Add login page :: form; validation; tests)",
			ignoreFocusOut: true,
		});
		if (!text?.trim()) return;
		const { title, subtasks } = parseTaskInput(text);
		await sessions.editQueue(id, [{ op: "add", title, subtasks }]);
	});

	reg("omp.tasks.addSubtask", async (arg?: unknown) => {
		if (!isNode(arg) || arg.kind !== "task") return;
		const title = await vscode.window.showInputBox({ title: `Subtask of "${arg.task.title}"`, ignoreFocusOut: true });
		if (title?.trim()) await sessions.editQueue(arg.sessionId, [{ op: "addSubtask", id: arg.task.id, title }]);
	});

	reg("omp.tasks.edit", async (arg?: unknown) => {
		if (!isNode(arg)) return;
		if (arg.kind === "task") {
			const title = await vscode.window.showInputBox({ title: "Task", value: arg.task.title, ignoreFocusOut: true });
			if (title?.trim()) await sessions.editQueue(arg.sessionId, [{ op: "update", id: arg.task.id, title }]);
		} else if (arg.kind === "subtask") {
			const title = await vscode.window.showInputBox({ title: "Subtask", value: arg.sub.title, ignoreFocusOut: true });
			if (title?.trim()) await sessions.editQueue(arg.sessionId, [{ op: "updateSubtask", id: arg.taskId, subtaskId: arg.sub.id, title }]);
		}
	});

	reg("omp.tasks.editNotes", async (arg?: unknown) => {
		if (!isNode(arg) || arg.kind !== "task") return;
		const notes = await vscode.window.showInputBox({ title: `Details for "${arg.task.title}"`, prompt: "Extra context omp gets with the task (acceptance criteria, files, constraints)", value: arg.task.notes ?? "", ignoreFocusOut: true });
		if (notes !== undefined) await sessions.editQueue(arg.sessionId, [{ op: "update", id: arg.task.id, notes }]);
	});

	reg("omp.tasks.delete", async (arg?: unknown, args?: unknown) => {
		const nodes = selected(arg, args);
		const taskNodes = nodes.filter(n => n.kind === "task");
		if (taskNodes.length > 1) {
			const ok = await vscode.window.showWarningMessage(`Delete ${taskNodes.length} tasks?`, { modal: true }, "Delete");
			if (ok !== "Delete") return;
		}
		for (const n of nodes) {
			if (n.kind === "task") await sessions.editQueue(n.sessionId, [{ op: "remove", id: n.task.id }]);
			else if (n.kind === "subtask") await sessions.editQueue(n.sessionId, [{ op: "removeSubtask", id: n.taskId, subtaskId: n.sub.id }]);
		}
	});

	reg("omp.tasks.runNow", async (arg?: unknown) => {
		if (!isNode(arg) || arg.kind !== "task") return;
		await sessions.editQueue(arg.sessionId, [{ op: "run", id: arg.task.id }]);
		await ensureRunning(arg.sessionId);
	});

	reg("omp.tasks.start", async (arg?: unknown) => {
		const id = await sessionFor(arg);
		if (!id) return;
		await sessions.editQueue(id, [{ op: "autoRun", value: true }]);
		await ensureRunning(id);
	});

	reg("omp.tasks.pause", async (arg?: unknown) => {
		const id = await sessionFor(arg);
		if (id) await sessions.editQueue(id, [{ op: "autoRun", value: false }]);
	});

	const setStatus = (status: QueueTask["status"]) => async (arg?: unknown, args?: unknown) => {
		for (const n of selected(arg, args)) if (n.kind === "task" && n.task.status !== "running") await sessions.editQueue(n.sessionId, [{ op: "update", id: n.task.id, status }]);
	};
	reg("omp.tasks.markDone", setStatus("done"));
	reg("omp.tasks.markPending", setStatus("pending"));
	reg("omp.tasks.skip", setStatus("skipped"));

	const move = (delta: number) => async (arg?: unknown) => {
		if (!isNode(arg)) return;
		if (arg.kind === "task") await sessions.editQueue(arg.sessionId, [{ op: "move", id: arg.task.id, index: Math.max(0, arg.index + delta) }]);
		else if (arg.kind === "subtask") await sessions.editQueue(arg.sessionId, [{ op: "moveSubtask", id: arg.taskId, subtaskId: arg.sub.id, index: Math.max(0, arg.index + delta) }]);
	};
	reg("omp.tasks.moveUp", move(-1));
	reg("omp.tasks.moveDown", move(1));

	reg("omp.tasks.clearDone", async (arg?: unknown) => {
		const id = await sessionFor(arg);
		if (id) await sessions.editQueue(id, [{ op: "clearDone" }]);
	});

	reg("omp.tasks.openChat", (arg?: unknown) => {
		if (isNode(arg)) void vscode.commands.executeCommand("omp.openSession", arg.kind === "session" ? arg.meta.id : arg.sessionId);
	});

	context.subscriptions.push(
		view.onDidChangeCheckboxState(async e => {
			const planEdits = new Map<string, PlanPhase[]>();
			for (const [node, state] of e.items) {
				const checked = state === vscode.TreeItemCheckboxState.Checked;
				if (node.kind === "task") {
					if (node.task.status !== "running") await sessions.editQueue(node.sessionId, [{ op: "update", id: node.task.id, status: checked ? "done" : "pending" }]);
				} else if (node.kind === "subtask") {
					await sessions.editQueue(node.sessionId, [{ op: "updateSubtask", id: node.taskId, subtaskId: node.sub.id, done: checked }]);
				} else if (node.kind === "planItem") {
					const meta = sessions.get(node.sessionId);
					if (!meta?.plan) continue;
					const phases = planEdits.get(node.sessionId) ?? meta.plan.map(p => ({ ...p, tasks: p.tasks.map(t => ({ ...t })) }));
					const item = phases[node.phaseIndex]?.tasks[node.itemIndex];
					if (item) item.status = checked ? "completed" : "pending";
					planEdits.set(node.sessionId, phases);
				}
			}
			for (const [id, phases] of planEdits) {
				const meta = sessions.get(id);
				if (meta && meta.status !== "stopped") await sendToHost(meta, { t: "rpc", cmd: { type: "set_todos", phases } });
			}
		}),
	);

	return provider;
}
