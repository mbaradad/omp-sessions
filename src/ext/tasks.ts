// Tasks view: the planner's queues (lanes → tasks → subtasks; PLANNER-API.md), the free tasks, and
// omp's own todo plan of each AO session. The planner runs everything with VS Code closed; this view
// only shows its plan and sends edits. Native TreeView: drag & drop to sort (also across lanes),
// checkboxes to complete, inline run/pause. Being a regular view, it can be moved to the panel or
// the secondary side bar.
import * as vscode from "vscode";
import type { LaneView, PlanOp, PlanView, Subtask, TaskStatus, TaskView } from "../planner/types";
import type { TodoItem, TodoPhase } from "../shared/omp-todos";
import { laneSummary, orderedLanes, syncAttention, syncConflicts, syncText, taskStateText, tasksOf } from "../shared/plan-tree";
import { describeOptions, formatDuration } from "../shared/task-text";
import type { OmpApi } from "./api";
import { registerTaskExtras } from "./task-extras";
import { registerTaskGraph } from "./task-graph";
import type { TasksDeps } from "./tasks-deps";

export type TaskNode =
	| { kind: "lane"; lane: LaneView }
	/** Tasks in no lane: each runs in its own AO session, in parallel. */
	| { kind: "free" }
	/** An AO session that has an omp plan but no queue. */
	| { kind: "session"; sessionId: string }
	| { kind: "task"; task: TaskView; index: number }
	| { kind: "subtask"; taskId: string; sub: Subtask; index: number }
	| { kind: "plan"; sessionId: string }
	| { kind: "planItem"; sessionId: string; phaseIndex: number; itemIndex: number; item: TodoItem; phaseName: string };

const MIME = "application/vnd.code.tree.omp.tasks";

const TASK_ICON: Record<TaskStatus, vscode.ThemeIcon> = {
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

/** The lane a node belongs to (undefined: free tasks, or not a queue node). */
function laneOf(node: TaskNode, deps: TasksDeps): string | undefined {
	if (node.kind === "lane") return node.lane.id;
	if (node.kind === "task") return node.task.lane;
	if (node.kind === "session") return node.sessionId;
	if (node.kind === "subtask") return deps.planner.plan?.tasks.find(t => t.id === node.taskId)?.lane;
	return undefined;
}

export class TasksProvider implements vscode.TreeDataProvider<TaskNode>, vscode.TreeDragAndDropController<TaskNode> {
	private readonly emitter = new vscode.EventEmitter<TaskNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	readonly dragMimeTypes = [MIME];
	readonly dropMimeTypes = [MIME];

	constructor(private readonly deps: TasksDeps) {}

	refresh(): void {
		this.emitter.fire(undefined);
	}

	sessionTitle(id: string | undefined): string | undefined {
		return id ? this.deps.aoSessions.get(id)?.title : undefined;
	}

	/** omp's plan for an AO session, when it has one with tasks. */
	private phases(sessionId: string | undefined): TodoPhase[] | undefined {
		const phases = sessionId ? this.deps.plans.get(sessionId) : undefined;
		return phases?.some(p => p.tasks.length) ? phases : undefined;
	}

	getChildren(node?: TaskNode): TaskNode[] {
		const plan = this.deps.planner.plan;
		if (!node) {
			const lanes = plan ? orderedLanes(plan) : [];
			const roots: TaskNode[] = lanes.map(lane => ({ kind: "lane", lane }));
			if (plan && tasksOf(plan, undefined).length) roots.push({ kind: "free" });
			// Live sessions whose omp keeps a plan but that have no queue.
			const queued = new Set(lanes.flatMap(l => [l.id, l.session]));
			for (const s of this.deps.aoSessions.all()) {
				if (queued.has(s.id) || s.state === "stopped" || !this.phases(s.id)) continue;
				roots.push({ kind: "session", sessionId: s.id });
			}
			return roots;
		}
		switch (node.kind) {
			case "lane":
			case "free": {
				const tasks: TaskNode[] = plan ? tasksOf(plan, node.kind === "lane" ? node.lane.id : undefined).map((task, index) => ({ kind: "task", task, index })) : [];
				const session = node.kind === "lane" ? node.lane.session : undefined;
				if (this.phases(session)) tasks.push({ kind: "plan", sessionId: session as string });
				return tasks;
			}
			case "session":
				return [{ kind: "plan", sessionId: node.sessionId }];
			case "task":
				return node.task.subtasks.map((sub, index) => ({ kind: "subtask", taskId: node.task.id, sub, index }));
			case "plan":
				return (this.phases(node.sessionId) ?? []).flatMap((phase, phaseIndex) =>
					phase.tasks.map((item, itemIndex) => ({ kind: "planItem" as const, sessionId: node.sessionId, phaseIndex, itemIndex, item, phaseName: phase.name })),
				);
			default:
				return [];
		}
	}

	getTreeItem(node: TaskNode): vscode.TreeItem {
		switch (node.kind) {
			case "lane": {
				const l = node.lane;
				const title = l.title ?? this.sessionTitle(l.session ?? l.id) ?? l.id;
				const item = new vscode.TreeItem(title, l.total || this.phases(l.session) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
				item.id = `tasks:lane:${l.id}`;
				const state = l.session ? this.deps.aoSessions.get(l.session)?.state : undefined;
				item.iconPath = state === "working" ? new vscode.ThemeIcon("loading~spin") : state && state !== "stopped" ? new vscode.ThemeIcon("comment-discussion") : new vscode.ThemeIcon("list-ordered");
				item.description = laneSummary(l);
				const when = l.autoRun ? " (auto-run on)" : l.startAt ? ` starting ${new Date(l.startAt).toLocaleString()}` : " when you start the queue";
				item.tooltip = `${title}\n\nTasks run one after another${l.session ? " in this session" : ""}${when}, with VS Code closed too.`;
				// Same context values as the old per-session queues, so menus keep working.
				item.contextValue = l.autoRun ? "tasks.session.auto" : "tasks.session.paused";
				return item;
			}
			case "free": {
				const item = new vscode.TreeItem("Separate tasks", vscode.TreeItemCollapsibleState.Expanded);
				item.id = "tasks:free";
				item.iconPath = new vscode.ThemeIcon("split-horizontal");
				item.tooltip = "Tasks in no queue: each runs in its own new session, in parallel within the concurrency limit.";
				item.contextValue = "tasks.free";
				return item;
			}
			case "session": {
				const item = new vscode.TreeItem(this.sessionTitle(node.sessionId) ?? node.sessionId, vscode.TreeItemCollapsibleState.Expanded);
				item.id = `tasks:session:${node.sessionId}`;
				item.iconPath = new vscode.ThemeIcon("comment-discussion");
				item.description = "no queued tasks";
				item.contextValue = "tasks.ompSession";
				return item;
			}
			case "task":
				return this.taskItem(node.task);
			case "subtask": {
				const item = new vscode.TreeItem(node.sub.title, vscode.TreeItemCollapsibleState.None);
				item.id = `tasks:sub:${node.taskId}:${node.sub.id}`;
				item.checkboxState = node.sub.done ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
				item.contextValue = "tasks.subtask";
				return item;
			}
			case "plan": {
				const all = (this.phases(node.sessionId) ?? []).flatMap(p => p.tasks);
				const done = all.filter(t => t.status === "completed" || t.status === "abandoned").length;
				const item = new vscode.TreeItem("omp's plan", vscode.TreeItemCollapsibleState.Collapsed);
				item.id = `tasks:plan:${node.sessionId}`;
				item.iconPath = new vscode.ThemeIcon("checklist");
				item.description = `${done}/${all.length}`;
				item.tooltip = "omp's own todo list for the current work. Ticking an item sends omp `/todo import` (applied after the running turn, if any).";
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

	private taskItem(t: TaskView): vscode.TreeItem {
		const subsDone = t.subtasks.filter(s => s.done).length;
		const item = new vscode.TreeItem(t.title, t.subtasks.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		item.id = `tasks:task:${t.id}`;
		const attention = syncAttention(t);
		item.iconPath =
			t.undone
				? new vscode.ThemeIcon("discard", new vscode.ThemeColor("charts.orange"))
				: attention === "conflict"
				? new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.red"))
				: attention === "upstream-changed" || attention === "resolving"
					? new vscode.ThemeIcon("git-merge", new vscode.ThemeColor("charts.orange"))
					: TASK_ICON[t.status];
		item.checkboxState = t.status === "done" && !t.undone ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
		const results = t.status === "done" || t.status === "failed" ? [t.durationMs ? formatDuration(t.durationMs) : "", t.cost ? `$${t.cost.toFixed(t.cost < 0.01 ? 4 : 2)}` : ""] : [];
		const retrying = t.status === "pending" && t.attempts ? `↻ retry ${t.attempts}/${t.options?.retries ?? t.attempts}` : "";
		const titleOf = (id: string) => this.deps.planner.plan?.tasks.find(x => x.id === id)?.title;
		item.description = [
			t.state === "waiting" && !t.position ? "" : taskStateText(t, titleOf),
			t.undone ? "↶ undone: its work is gone" : "",
			syncText(syncAttention(t)),
			t.priority && t.priority !== "normal" ? t.priority : "",
			retrying,
			t.subtasks.length ? `${subsDone}/${t.subtasks.length}` : "",
			t.status === "done" || t.status === "failed" ? fmtAgo(t.finishedAt) : t.status === "running" ? fmtAgo(t.startedAt) : "",
			...results,
			...describeOptions(t.options),
			t.options?.mode && t.options.mode !== "auto" ? `🔒 ${t.options.mode}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		const tip = new vscode.MarkdownString(undefined, true);
		tip.appendMarkdown(`**${t.title.replace(/[*_`[\]]/g, "\\$&")}**  \n$(pulse) ${t.state}`);
		if (t.waitReason) tip.appendMarkdown(` — ${t.waitReason}`);
		if (results.some(Boolean)) tip.appendMarkdown(`  \n$(watch) ${results.filter(Boolean).join(" · ")}${t.attempts ? ` · ${t.attempts} attempt(s)` : ""}`);
		if (t.after?.length) tip.appendMarkdown(`  \n$(git-merge) after ${t.after.map(id => titleOf(id) ?? id).join(", ")}`);
		const opts = t.options;
		if (opts) {
			const lines = [
				opts.model ? `model \`${opts.model}\`` : "",
				opts.thinking ? `thinking \`${opts.thinking}\`` : "",
				opts.freshContext ? "fresh context: runs in a new session (earlier conversation is not visible to it)" : "",
				opts.retries ? `up to ${opts.retries} automatic retr${opts.retries === 1 ? "y" : "ies"} on failure` : "",
				opts.timeoutMinutes ? `stopped after ${opts.timeoutMinutes} min` : "",
				opts.mode ? `permission mode \`${opts.mode}\` (when the task starts a new session)` : "",
			].filter(Boolean);
			if (lines.length) tip.appendMarkdown(`\n\n$(settings-gear) ${lines.join("  \n")}`);
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

	getParent(node: TaskNode): TaskNode | undefined {
		const plan = this.deps.planner.plan;
		switch (node.kind) {
			case "task": {
				const lane = plan?.lanes.find(l => l.id === node.task.lane);
				return lane ? { kind: "lane", lane } : { kind: "free" };
			}
			case "subtask": {
				const task = plan?.tasks.find(t => t.id === node.taskId);
				return task ? { kind: "task", task, index: tasksOf(plan as NonNullable<typeof plan>, task.lane).indexOf(task) } : undefined;
			}
			case "plan": {
				const lane = plan?.lanes.find(l => l.session === node.sessionId || l.id === node.sessionId);
				return lane ? { kind: "lane", lane } : { kind: "session", sessionId: node.sessionId };
			}
			case "planItem":
				return { kind: "plan", sessionId: node.sessionId };
			default:
				return undefined;
		}
	}

	// ---------- drag & drop ----------
	handleDrag(source: readonly TaskNode[], data: vscode.DataTransfer): void {
		const movable = source.filter(n => n.kind === "task" || n.kind === "subtask");
		if (movable.length) data.set(MIME, new vscode.DataTransferItem(movable));
	}

	async handleDrop(target: TaskNode | undefined, data: vscode.DataTransfer): Promise<void> {
		const raw = data.get(MIME)?.value;
		const dragged = Array.isArray(raw) ? raw.filter(isNode) : [];
		const plan = this.deps.planner.plan;
		if (!target || !dragged.length || !plan) return;
		const ops: PlanOp[] = [];
		const targetLane = laneOf(target, this.deps);
		let index = target.kind === "task" ? target.index : Number.MAX_SAFE_INTEGER;
		for (const n of dragged) {
			if (n.kind !== "task") continue;
			// Another lane: the planner moves it (keeping its id, so dependencies stay intact).
			if (n.task.lane !== targetLane) {
				if (n.task.status === "running") continue;
				ops.push({ op: "update", id: n.task.id, lane: targetLane ?? null });
			}
			ops.push({ op: "move", id: n.task.id, index });
			if (index !== Number.MAX_SAFE_INTEGER) index++;
		}
		for (const n of dragged) {
			if (n.kind !== "subtask") continue;
			if (target.kind === "subtask" && target.taskId === n.taskId) ops.push({ op: "moveSubtask", id: n.taskId, subtaskId: n.sub.id, index: target.index });
			else if (target.kind === "task" && target.task.id === n.taskId) ops.push({ op: "moveSubtask", id: n.taskId, subtaskId: n.sub.id, index: Number.MAX_SAFE_INTEGER });
			else if (target.kind === "task") ops.push({ op: "addSubtask", id: target.task.id, title: n.sub.title }, { op: "removeSubtask", id: n.taskId, subtaskId: n.sub.id });
		}
		await editOrWarn(this.deps, ops);
	}
}

/** Sends edits to the planner; a refused batch (stale, running task, cycle…) shows the planner's reason. */
export async function editOrWarn(deps: TasksDeps, ops: PlanOp[]): Promise<boolean> {
	if (!ops.length) return true;
	try {
		await deps.planner.edit(ops);
		return true;
	} catch (err) {
		void vscode.window.showWarningMessage(`Switchyard planner: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

/** Registers the Tasks view and its commands. */
export function registerTasks(api: OmpApi, deps: TasksDeps): TasksProvider {
	const { context } = api;
	const provider = new TasksProvider(deps);
	const view = vscode.window.createTreeView("omp.tasks", { treeDataProvider: provider, dragAndDropController: provider, canSelectMany: true, showCollapseAll: true });
	context.subscriptions.push(view);
	registerTaskExtras(api, deps, provider);
	registerTaskGraph(api, deps, provider, ops => editOrWarn(deps, ops));

	// A merge of a parent's changes that conflicted is needs-input: say so once, when it arises (not for ones already there at start-up; the tree keeps showing them).
	const seenConflicts = new Set<string>();
	let primed = false;
	const announceConflicts = (plan: PlanView) => {
		const fresh = syncConflicts(plan).filter(c => !seenConflicts.has(c.key));
		for (const c of fresh) seenConflicts.add(c.key);
		if (!primed) return;
		for (const c of fresh) {
			const parent = plan.tasks.find(t => t.id === c.parentId)?.title ?? c.parentId;
			const files = c.files.length ? ` (${c.files.slice(0, 3).join(", ")}${c.files.length > 3 ? ` and ${c.files.length - 3} more` : ""})` : "";
			void vscode.window.showWarningMessage(`Switchyard: merging “${parent}” into “${c.task.title}” conflicted${files}. It needs a person.`, "Open chat", "Show Task Graph").then(pick => {
				if (pick === "Open chat") void vscode.commands.executeCommand("omp.tasks.openChat", { kind: "task", task: c.task, index: 0 } satisfies TaskNode);
				else if (pick === "Show Task Graph") void vscode.commands.executeCommand("switchyard.tasks.showGraph");
			});
		}
	};
	const update = () => {
		provider.refresh();
		const plan = deps.planner.plan;
		const open = plan ? plan.tasks.filter(t => t.status === "pending" || t.status === "running").length : 0;
		const conflicts = plan ? syncConflicts(plan).length : 0;
		view.badge = open || conflicts ? { value: open + conflicts, tooltip: `${open} queued task(s)${conflicts ? `, ${conflicts} merge conflict(s) need a person` : ""}` } : undefined;
		view.message = plan ? undefined : `The planner is not reachable${deps.planner.error ? ` (${deps.planner.error})` : ""}. Retrying…`;
		if (plan) {
			announceConflicts(plan);
			primed = true;
		}
	};
	context.subscriptions.push(deps.planner.onDidChange(update), deps.plans.onDidChange(() => provider.refresh()));
	const stopWatching = deps.aoSessions.onChange(() => provider.refresh());
	context.subscriptions.push({ dispose: stopWatching });
	update();

	/** The lane to add to: the node's, the only queue, or the person's pick (a queue, a session, or a separate task). */
	const laneFor = async (arg: unknown): Promise<{ lane?: string; cwd?: string } | undefined> => {
		if (isNode(arg)) {
			if (arg.kind === "free") return { cwd: await api.pickFolder() };
			return { lane: laneOf(arg, deps) };
		}
		const plan = deps.planner.plan;
		const lanes = plan ? orderedLanes(plan) : [];
		const laneIds = new Set(lanes.flatMap(l => [l.id, l.session]));
		const sessions = deps.aoSessions.all().filter(s => s.state !== "stopped" && !laneIds.has(s.id));
		type Pick = vscode.QuickPickItem & { lane?: string; separate?: boolean };
		const items: Pick[] = [
			...lanes.map(l => ({ label: `$(list-ordered) ${l.title ?? provider.sessionTitle(l.session ?? l.id) ?? l.id}`, description: laneSummary(l), lane: l.id })),
			...sessions.map(s => ({ label: `$(comment-discussion) ${s.title}`, description: "start a queue in this session", lane: s.id })),
			{ label: "$(split-horizontal) Separate task", description: "runs in its own new session", separate: true },
		];
		const pick = await vscode.window.showQuickPick(items, { title: "Add the task to…", ignoreFocusOut: true });
		if (!pick) return undefined;
		if (pick.separate) {
			const cwd = await api.pickFolder();
			return cwd ? { cwd } : undefined;
		}
		return { lane: pick.lane };
	};

	const selected = (arg: unknown, args: unknown): TaskNode[] => {
		const many = Array.isArray(args) ? args.filter(isNode) : [];
		if (many.length) return many;
		return isNode(arg) ? [arg] : [...view.selection];
	};
	const laneArg = (arg: unknown): string | undefined => {
		if (isNode(arg)) return laneOf(arg, deps);
		const lanes = deps.planner.plan?.lanes ?? [];
		return lanes.length === 1 ? lanes[0].id : undefined;
	};
	const edit = (ops: PlanOp[]) => editOrWarn(deps, ops);
	const reg = (name: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));

	reg("omp.tasks.add", async (arg?: unknown) => {
		const where = await laneFor(arg);
		if (!where || (!where.lane && !where.cwd)) return;
		const text = await vscode.window.showInputBox({
			title: "New task",
			prompt: "What should omp do? Add subtasks after '::', separated by ';' (e.g. Add login page :: form; validation; tests)",
			ignoreFocusOut: true,
		});
		if (!text?.trim()) return;
		const { title, subtasks } = parseTaskInput(text);
		// A queue named after an AO session that has none is created by the planner, paused (it waits for Start ▶,
		// as queues always did); a task in no queue runs when ready.
		await edit([{ op: "add", task: { title, subtasks, lane: where.lane, options: where.cwd ? { cwd: where.cwd } : undefined } }]);
	});

	reg("omp.tasks.addSubtask", async (arg?: unknown) => {
		if (!isNode(arg) || arg.kind !== "task") return;
		const title = await vscode.window.showInputBox({ title: `Subtask of "${arg.task.title}"`, ignoreFocusOut: true });
		if (title?.trim()) await edit([{ op: "addSubtask", id: arg.task.id, title }]);
	});

	reg("omp.tasks.edit", async (arg?: unknown) => {
		if (!isNode(arg)) return;
		if (arg.kind === "task") {
			const title = await vscode.window.showInputBox({ title: "Task", value: arg.task.title, ignoreFocusOut: true });
			if (title?.trim()) await edit([{ op: "update", id: arg.task.id, title }]);
		} else if (arg.kind === "subtask") {
			const title = await vscode.window.showInputBox({ title: "Subtask", value: arg.sub.title, ignoreFocusOut: true });
			if (title?.trim()) await edit([{ op: "updateSubtask", id: arg.taskId, subtaskId: arg.sub.id, title }]);
		}
	});

	reg("omp.tasks.editNotes", async (arg?: unknown) => {
		if (!isNode(arg) || arg.kind !== "task") return;
		const notes = await vscode.window.showInputBox({ title: `Details for "${arg.task.title}"`, prompt: "Extra context omp gets with the task (acceptance criteria, files, constraints)", value: arg.task.notes ?? "", ignoreFocusOut: true });
		if (notes !== undefined) await edit([{ op: "update", id: arg.task.id, notes }]);
	});

	reg("omp.tasks.delete", async (arg?: unknown, args?: unknown) => {
		const nodes = selected(arg, args);
		const taskNodes = nodes.filter(n => n.kind === "task");
		if (taskNodes.length > 1) {
			const ok = await vscode.window.showWarningMessage(`Delete ${taskNodes.length} tasks?`, { modal: true }, "Delete");
			if (ok !== "Delete") return;
		}
		await edit(
			nodes.flatMap((n): PlanOp[] => (n.kind === "task" ? [{ op: "remove", id: n.task.id }] : n.kind === "subtask" ? [{ op: "removeSubtask", id: n.taskId, subtaskId: n.sub.id }] : [])),
		);
	});

	reg("omp.tasks.runNow", async (arg?: unknown) => {
		if (isNode(arg) && arg.kind === "task") await edit([{ op: "run", id: arg.task.id }]);
	});

	reg("omp.tasks.start", async (arg?: unknown) => {
		const lane = laneArg(arg);
		if (lane) await edit([{ op: "lane.resume", id: lane }]);
	});

	reg("omp.tasks.pause", async (arg?: unknown) => {
		const lane = laneArg(arg);
		if (lane) await edit([{ op: "lane.pause", id: lane }]);
	});

	const setStatus = (to: "done" | "requeue" | "skip") => async (arg?: unknown, args?: unknown) => {
		await edit(selected(arg, args).flatMap((n): PlanOp[] => (n.kind === "task" && n.task.status !== "running" ? [{ op: to, id: n.task.id }] : [])));
	};
	reg("omp.tasks.markDone", setStatus("done"));
	reg("omp.tasks.markPending", setStatus("requeue"));
	reg("omp.tasks.skip", setStatus("skip"));

	const move = (delta: number) => async (arg?: unknown) => {
		if (!isNode(arg)) return;
		if (arg.kind === "task") await edit([{ op: "move", id: arg.task.id, index: Math.max(0, arg.index + delta) }]);
		else if (arg.kind === "subtask") await edit([{ op: "moveSubtask", id: arg.taskId, subtaskId: arg.sub.id, index: Math.max(0, arg.index + delta) }]);
	};
	reg("omp.tasks.moveUp", move(-1));
	reg("omp.tasks.moveDown", move(1));

	reg("omp.tasks.clearDone", async (arg?: unknown) => {
		if (isNode(arg) && arg.kind === "free") {
			const plan = deps.planner.plan;
			await edit((plan ? tasksOf(plan, undefined) : []).filter(t => t.status === "done" || t.status === "skipped").map(t => ({ op: "remove", id: t.id })));
			return;
		}
		const lane = laneArg(arg);
		if (lane) await edit([{ op: "lane.clearDone", id: lane }]);
	});

	// Graph propagation (planner `rerun` / `sync`): the same actions as in the Task Graph, from the tree.
	reg("switchyard.tasks.rerun", async (arg?: unknown) => {
		if (isNode(arg) && arg.kind === "task") await edit([{ op: "rerun", id: arg.task.id }]);
	});
	reg("switchyard.tasks.sync", async (arg?: unknown) => {
		if (isNode(arg) && arg.kind === "task") await edit([{ op: "sync", id: arg.task.id }]);
	});

	// The "completed" marker of a queue (the old per-session completed mark, now the planner's `lane.complete`).
	reg("switchyard.tasks.completeLane", async (arg?: unknown) => {
		const id = laneArg(arg);
		const lane = id ? deps.planner.plan?.lanes.find(l => l.id === id) : undefined;
		if (lane) await edit([{ op: "lane.complete", id: lane.id, completed: !lane.completed }]);
	});

	reg("omp.tasks.openChat", (arg?: unknown) => {
		if (!isNode(arg)) return;
		const plan = deps.planner.plan;
		const session =
			arg.kind === "task" ? (arg.task.session ?? plan?.lanes.find(l => l.id === arg.task.lane)?.session) : arg.kind === "lane" ? (arg.lane.session ?? arg.lane.id) : arg.kind === "session" || arg.kind === "plan" || arg.kind === "planItem" ? arg.sessionId : undefined;
		if (session && deps.aoSessions.get(session)) void vscode.commands.executeCommand("omp.openSession", session);
		else void vscode.window.showInformationMessage("This task has not run yet, so it has no chat.");
	});

	context.subscriptions.push(
		view.onDidChangeCheckboxState(async e => {
			const ops: PlanOp[] = [];
			const planEdits = new Map<string, TodoPhase[]>();
			for (const [node, state] of e.items) {
				const checked = state === vscode.TreeItemCheckboxState.Checked;
				if (node.kind === "task") {
					if (node.task.status !== "running") ops.push({ op: checked ? "done" : "requeue", id: node.task.id });
				} else if (node.kind === "subtask") {
					ops.push({ op: "updateSubtask", id: node.taskId, subtaskId: node.sub.id, done: checked });
				} else if (node.kind === "planItem") {
					const current = deps.plans.get(node.sessionId);
					if (!current) continue;
					const phases = planEdits.get(node.sessionId) ?? current.map(p => ({ ...p, tasks: p.tasks.map(t => ({ ...t })) }));
					const item = phases[node.phaseIndex]?.tasks[node.itemIndex];
					if (item) item.status = checked ? "completed" : "pending";
					planEdits.set(node.sessionId, phases);
				}
			}
			await edit(ops);
			for (const [id, phases] of planEdits) {
				try {
					await deps.plans.set(await deps.ao(), id, phases);
				} catch (err) {
					void vscode.window.showWarningMessage(`omp: could not update omp's plan: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}),
	);

	return provider;
}
