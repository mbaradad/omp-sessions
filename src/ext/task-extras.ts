// Per-task options (model/thinking/fresh context/retries/timeout), scheduled queue starts and
// duplicate/retry — the UI for what queue.json already carries and the host already honours.
// The Tasks view re-renders on its own when session data changes, so no view refresh is needed.
import * as vscode from "vscode";
import { THINKING_LEVELS } from "../shared/queue";
import type { QueueTask, QueueTaskOptions } from "../shared/protocol";
import type { OmpApi } from "./api";
import { isNode, type TaskNode } from "./tasks";

async function choose(items: Array<{ label: string; detail?: string; id: string }>): Promise<string | undefined> {
	const pick = await vscode.window.showQuickPick(
		items.map(i => ({ label: i.label, detail: i.detail, id: i.id })),
		{ ignoreFocusOut: true },
	);
	return pick?.id;
}

function parseSchedule(input: string): number | undefined {
	const t = input.trim();
	if (!t) return undefined;
	const rel = /^\+?(\d+)\s*([mhd])$/i.exec(t);
	if (rel) {
		const n = Number(rel[1]);
		const unit = rel[2].toLowerCase() === "h" ? 3600 : rel[2].toLowerCase() === "d" ? 86400 : 60;
		return Date.now() + n * unit * 1000;
	}
	const dmy = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(t);
	if (dmy) {
		const d = new Date(Number(dmy[1]), Number(dmy[2]) - 1, Number(dmy[3]), Number(dmy[4]), Number(dmy[5]));
		if (!Number.isNaN(d.getTime())) return d.getTime();
	}
	const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
	if (hm) {
		const d = new Date();
		d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
		if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
		return d.getTime();
	}
	return undefined;
}

export function registerTaskExtras(api: OmpApi, _view: vscode.TreeView<TaskNode>): void {
	const { context, sessions } = api;
	const reg = (id: string, fn: (...args: unknown[]) => unknown): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	};

	reg("omp.tasks.editOptions", async (arg?: unknown) => {
		if (!isNode(arg) || arg.kind !== "task") return;
		const task: QueueTask = arg.task;
		const o: QueueTaskOptions = { ...(task.options ?? {}) };
		const current = (v: string | number | boolean | undefined) => (v === undefined ? "" : String(v));
		const items = [
			{ id: "model", label: `Model for this task${o.model ? ` — ${o.model}` : ""}`, detail: "type a `provider/modelId`; the previous model is restored afterwards" },
			{ id: "clearModel", label: "Clear model" },
			{ id: "thinking", label: `Thinking level${o.thinking ? ` — ${o.thinking}` : ""}`, detail: `${THINKING_LEVELS.join(" / ")}` },
			{ id: "clearThinking", label: "Clear thinking level" },
			{ id: "fresh", label: o.freshContext ? "Fresh context: ON" : "Fresh context: OFF", detail: "start the task in a new omp session (clean context)" },
			{ id: "retries", label: `Automatic retries${o.retries ? ` — ${o.retries}` : ""}`, detail: "1–5, with backoff; 0 = none" },
			{ id: "timeout", label: `Time limit${o.timeoutMinutes ? ` — ${o.timeoutMinutes} min` : ""}`, detail: "minutes; 0 = none" },
			{ id: "clearAll", label: "Clear all options" },
		];
		const choice = await choose(items);
		if (!choice) return;
		if (choice === "model" || choice === "thinking" || choice === "retries" || choice === "timeout") {
			const value = await vscode.window.showInputBox({
				title: `“${task.title}”`,
				prompt: { model: "provider/modelId (e.g. anthropic/claude-opus-4-6)", thinking: "one of: " + THINKING_LEVELS.join(", "), retries: "number 1–5", timeout: "minutes" }[choice],
				value: current(choice === "model" ? o.model : choice === "thinking" ? o.thinking : choice === "retries" ? o.retries : o.timeoutMinutes),
				ignoreFocusOut: true,
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
				if (v) {
					const n = Number(v);
					if (!Number.isFinite(n) || n < 1) void vscode.window.showWarningMessage("Retries must be a whole number from 1–5.");
					else o.retries = Math.trunc(n);
				} else delete o.retries;
			} else {
				if (v) {
					const n = Number(v);
					if (!Number.isFinite(n) || n <= 0) void vscode.window.showWarningMessage("The limit must be a positive number of minutes.");
					else o.timeoutMinutes = n;
				} else delete o.timeoutMinutes;
			}
		} else if (choice === "clearModel") delete o.model;
		else if (choice === "clearThinking") delete o.thinking;
		else if (choice === "fresh") o.freshContext = !o.freshContext;
		else if (choice === "clearAll") {
			delete o.model;
			delete o.thinking;
			delete o.freshContext;
			delete o.retries;
			delete o.timeoutMinutes;
		}
		await sessions.editQueue(arg.sessionId, [{ op: "setOptions", id: task.id, options: o }]);
	});

	reg("omp.tasks.duplicate", async (arg?: unknown) => {
		if (!isNode(arg) || arg.kind !== "task") return;
		await sessions.editQueue(arg.sessionId, [{ op: "duplicate", id: arg.task.id }]);
	});

	reg("omp.tasks.retryFailed", async (arg?: unknown) => {
		if (!isNode(arg)) return;
		const node: TaskNode = arg;
		const id = node.kind === "session" ? node.meta.id : node.sessionId;
		await sessions.editQueue(id, [{ op: "retryFailed" }]);
	});

	reg("omp.tasks.schedule", async (arg?: unknown) => {
		if (!isNode(arg)) return;
		const node: TaskNode = arg;
		const meta = node.kind === "session" ? node.meta : undefined;
		const id = node.kind === "session" ? node.meta.id : node.sessionId;
		const at = meta?.queue?.startAt;
		const cancel = at ? await vscode.window.showQuickPick(
			[{ label: `Start now (cancel ${new Date(at).toLocaleString()})`, id: "cancel" }, { label: `Change scheduled time…`, id: "change" }],
			{ title: meta?.title ?? "Task queue", ignoreFocusOut: true },
		) : { id: "change" };
		if (!cancel || cancel.id === "cancel") {
			if (cancel?.id === "cancel") await sessions.editQueue(id, [{ op: "schedule", at: null }]);
			return;
		}
		const input = await vscode.window.showInputBox({
			title: meta ? `Start the queue for “${meta.title}” at` : "Start the task queue at",
			prompt: "HH:MM (today or tomorrow), YYYY-MM-DD HH:MM, or +30m / +2h",
			ignoreFocusOut: true,
		});
		if (input === undefined) return;
		const time = parseSchedule(input);
		if (time === undefined) {
			void vscode.window.showWarningMessage("Couldn't read that time. Use HH:MM, YYYY-MM-DD HH:MM, or +30m / +2h.");
			return;
		}
		await sessions.editQueue(id, [{ op: "schedule", at: time }]);
	});
}
