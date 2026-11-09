// Per-task options (model/thinking/fresh context/retries/timeout), scheduled starts (a queue's or
// one task's), dependencies, priorities and duplicate/retry: the UI for what the planner stores and
// honours (PLANNER-API.md). The Tasks view re-renders when the planner pushes the new plan.
import * as vscode from "vscode";
import type { PermissionMode, PlanOp, Priority, TaskOptions } from "../planner/types";
import { PERMISSION_MODES, PRIORITIES, THINKING_LEVELS } from "../planner/types";
import { afterUndoOps, armedLanes, checkTaskOption, continuesSession, isUndoable, undoneWith } from "../shared/plan-tree";
import { formatStartTime, parseStartTime } from "../shared/task-text";
import type { OmpApi } from "./api";
import { type TaskNode, type TasksProvider, editOrWarn, isNode } from "./tasks";
import type { TasksDeps } from "./tasks-deps";

async function choose(items: Array<{ label: string; detail?: string; id: string }>): Promise<string | undefined> {
	const pick = await vscode.window.showQuickPick(
		items.map(i => ({ label: i.label, detail: i.detail, id: i.id })),
		{ ignoreFocusOut: true },
	);
	return pick?.id;
}

const MODE_HELP: Record<PermissionMode, string> = {
	ask: "asks before edits and shell commands",
	edits: "edits freely, asks before shell commands",
	plan: "plans only: edit tools are blocked",
	auto: "no questions",
};

const TIME_HELP = "HH:MM (today or tomorrow), YYYY-MM-DD HH:MM, +30m / +2h, tomorrow 9:00";

export function registerTaskExtras(api: OmpApi, deps: TasksDeps, provider: TasksProvider): void {
	const { context } = api;
	const reg = (id: string, fn: (...args: unknown[]) => unknown): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	};
	const edit = (ops: PlanOp[]) => editOrWarn(deps, ops);

	reg("omp.tasks.editOptions", async (arg?: unknown) => {
		if (!isNode(arg) || arg.kind !== "task") return;
		const task = arg.task;
		const o: TaskOptions = { ...(task.options ?? {}) };
		const current = (v: string | number | boolean | undefined) => (v === undefined ? "" : String(v));
		const items = [
			{ id: "model", label: `Model for this task${o.model ? ` — ${o.model}` : ""}`, detail: "type a `provider/modelId`; the session's own model is not changed for later prompts" },
			{ id: "clearModel", label: "Clear model" },
			{ id: "thinking", label: `Thinking level${o.thinking ? ` — ${o.thinking}` : ""}`, detail: `${THINKING_LEVELS.join(" / ")}` },
			{ id: "clearThinking", label: "Clear thinking level" },
			{ id: "fresh", label: o.freshContext ? "Fresh context: ON" : "Fresh context: OFF", detail: "run the task in a new session (clean context)" },
			{ id: "mode", label: `Permission mode${o.mode ? ` — ${o.mode}` : ""}`, detail: `ask / edits / plan / auto (default auto): for a session this task STARTS; ignored when the task continues a session${continuesSession(deps.planner.plan, task, o.freshContext) ? ". Right now it would continue its queue's session, so the mode is ignored (unless that session ends or fresh context is on)" : ""}` },
			{ id: "retries", label: `Automatic retries${o.retries ? ` — ${o.retries}` : ""}`, detail: "1–10, with backoff; 0 = none" },
			{ id: "timeout", label: `Time limit${o.timeoutMinutes ? ` — ${o.timeoutMinutes} min` : ""}`, detail: "minutes; 0 = none" },
			{ id: "clearAll", label: "Clear all options" },
		];
		const choice = await choose(items);
		if (!choice) return;
		if (choice === "mode") {
			const picked = await choose([
				...PERMISSION_MODES.map(m => ({ id: m, label: m === o.mode ? `${m} (current)` : m, detail: MODE_HELP[m] })),
				{ id: "clearMode", label: "Clear (use the default, auto)" },
			]);
			if (!picked) return;
			if (picked === "clearMode") delete o.mode;
			else o.mode = picked as PermissionMode;
		} else if (choice === "model" || choice === "thinking" || choice === "retries" || choice === "timeout") {
			const value = await vscode.window.showInputBox({
				title: `“${task.title}”`,
				prompt: { model: "provider/modelId (e.g. anthropic/claude-opus-4-6)", thinking: `one of: ${THINKING_LEVELS.join(", ")}`, retries: "number 1–10", timeout: "minutes" }[choice],
				value: current(choice === "model" ? o.model : choice === "thinking" ? o.thinking : choice === "retries" ? o.retries : o.timeoutMinutes),
				ignoreFocusOut: true,
				validateInput: v => checkTaskOption(choice, v),
			});
			if (value === undefined) return;
			const v = value.trim();
			if (choice === "model") {
				if (v) o.model = v;
				else delete o.model;
			} else if (choice === "thinking") {
				if (v) o.thinking = v;
				else delete o.thinking;
			} else if (choice === "retries") {
				if (v) o.retries = Number(v);
				else delete o.retries;
			} else if (v) o.timeoutMinutes = Number(v);
			else delete o.timeoutMinutes;
		} else if (choice === "clearModel") delete o.model;
		else if (choice === "clearThinking") delete o.thinking;
		else if (choice === "fresh") o.freshContext = !o.freshContext;
		else if (choice === "clearAll") {
			delete o.model;
			delete o.thinking;
			delete o.freshContext;
			delete o.retries;
			delete o.timeoutMinutes;
			delete o.mode;
		}
		await edit([{ op: "update", id: task.id, options: Object.keys(o).length ? o : null }]);
	});

	reg("omp.tasks.duplicate", async (arg?: unknown) => {
		if (isNode(arg) && arg.kind === "task") await edit([{ op: "duplicate", id: arg.task.id }]);
	});

	reg("omp.tasks.retryFailed", async (arg?: unknown) => {
		if (!isNode(arg)) return;
		if (arg.kind === "lane") await edit([{ op: "lane.retryFailed", id: arg.lane.id }]);
		else if (arg.kind === "task") await edit([{ op: "requeue", id: arg.task.id }]);
	});

	// A queue's start time (lane node) or one task's "not before" time (task node).
	reg("omp.tasks.schedule", async (arg?: unknown) => {
		if (!isNode(arg) || (arg.kind !== "lane" && arg.kind !== "task")) return;
		const node: TaskNode = arg;
		const at = node.kind === "lane" ? node.lane.startAt : node.task.startAt;
		const name = node.kind === "lane" ? (node.lane.title ?? provider.sessionTitle(node.lane.session ?? node.lane.id) ?? "Task queue") : node.task.title;
		const set = (time: number | null): PlanOp => (node.kind === "lane" ? { op: "lane.startAt", id: node.lane.id, at: time } : { op: "update", id: node.task.id, startAt: time });
		if (at) {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: node.kind === "lane" ? `Start now (cancel ${new Date(at).toLocaleString()})` : `No start time (was ${new Date(at).toLocaleString()})`, id: "cancel" },
					{ label: "Change the time…", id: "change" },
				],
				{ title: name, ignoreFocusOut: true },
			);
			if (!pick) return;
			if (pick.id === "cancel") {
				await edit(node.kind === "lane" ? [set(null), { op: "lane.resume", id: node.lane.id }] : [set(null)]);
				return;
			}
		}
		const input = await vscode.window.showInputBox({
			title: node.kind === "lane" ? `Start the queue “${name}” at` : `Start “${name}” not before`,
			prompt: TIME_HELP,
			ignoreFocusOut: true,
			validateInput: v => (v.trim() && parseStartTime(v) === undefined ? `Couldn't read that time. Use ${TIME_HELP}.` : undefined),
		});
		const time = input === undefined ? undefined : parseStartTime(input);
		if (time === undefined) return;
		if (await edit([set(time)])) void vscode.window.setStatusBarMessage(`omp: “${name}” starts ${formatStartTime(time)}`, 5000);
	});

	reg("switchyard.tasks.setDependencies", async (arg?: unknown) => {
		if (!isNode(arg) || arg.kind !== "task") return;
		const plan = deps.planner.plan;
		if (!plan) return;
		const task = arg.task;
		const current = new Set(task.after ?? []);
		const candidates = plan.tasks.filter(t => t.id !== task.id);
		const picks = await vscode.window.showQuickPick(
			candidates.map(t => ({ label: t.title, description: [t.state, t.lane ? (plan.lanes.find(l => l.id === t.lane)?.title ?? provider.sessionTitle(t.lane)) : "separate"].filter(Boolean).join(" · "), picked: current.has(t.id), id: t.id })),
			{ title: `“${task.title}” starts after…`, canPickMany: true, ignoreFocusOut: true, matchOnDescription: true },
		);
		if (picks) await edit([{ op: "after", id: task.id, ids: picks.map(p => p.id) }]);
	});

	reg("switchyard.tasks.setPriority", async (arg?: unknown) => {
		if (!isNode(arg) || (arg.kind !== "lane" && arg.kind !== "task")) return;
		const current = (arg.kind === "lane" ? arg.lane.priority : arg.task.priority) ?? "normal";
		const pick = await vscode.window.showQuickPick(
			PRIORITIES.map(p => ({ label: p, description: p === current ? "current" : undefined })),
			{ title: "Priority: which waiting work starts first when slots are limited", ignoreFocusOut: true },
		);
		if (!pick) return;
		const priority: Priority | null = pick.label === "normal" ? null : (pick.label as Priority);
		await edit([arg.kind === "lane" ? { op: "lane.update", id: arg.lane.id, priority } : { op: "update", id: arg.task.id, priority }]);
	});

	// Undo a task's work (files and conversation) with the checkpoints of its AO session. The undo itself, its
	// confirmation and the interruption of a running turn are the `switchyard.undo` command's (checkpoints slice);
	// here: which turn, and the plan afterwards (the task and every later one of that session are pending again).
	reg("switchyard.tasks.undo", async (arg?: unknown) => {
		if (!isNode(arg) || arg.kind !== "task") return;
		const plan = deps.planner.plan;
		const task = plan?.tasks.find(t => t.id === arg.task.id);
		if (!plan || !task || !isUndoable(task) || !task.session) {
			void vscode.window.showInformationMessage(task?.undone ? "This task is already undone." : "This task has no recorded run to undo.");
			return;
		}
		// Hold the queues of everything the undo takes with it first: while the confirmation is open, and while omp
		// is interrupted and rewinds, the planner must not dispatch the next task into this session.
		const undone = undoneWith(plan, task);
		const held = armedLanes(plan, undone, task.session);
		const release = () => (held.length ? edit(held.map((id): PlanOp => ({ op: "lane.resume", id }))) : Promise.resolve(true));
		if (held.length && !(await edit(held.map((id): PlanOp => ({ op: "lane.pause", id }))))) return;
		let result: { ok?: boolean; message?: string } | undefined;
		try {
			result = (await vscode.commands.executeCommand("switchyard.undo", task.session, task.turn)) as typeof result;
		} catch (err) {
			void vscode.window.showWarningMessage(`Switchyard: could not undo “${task.title}”: ${err instanceof Error ? err.message : String(err)}`);
			await release();
			return;
		}
		if (!result?.ok) {
			await release(); // cancelled, nothing to undo, or refused: that command said why; the queues go on as before
			return;
		}
		if (await edit(afterUndoOps(undone))) {
			void vscode.window.showInformationMessage(`Switchyard: undid ${undone.length === 1 ? `“${task.title}”` : `${undone.length} tasks (“${task.title}” and the later ones in that session)`}. They are pending again and held; run them when you want.`);
		}
	});
}
