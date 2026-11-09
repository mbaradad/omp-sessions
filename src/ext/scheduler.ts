// Global concurrency for queued tasks, now held by the planner (PLANNER-API.md `scheduler`): the limit,
// a pause switch, and a status bar counter "2/3 running · 5 waiting". The planner enforces them with
// VS Code closed; this only shows them and sends changes.
import * as vscode from "vscode";
import { holdLines, parseBudget } from "../shared/plan-tree";
import type { PlannerConfig } from "../planner/types";
import type { OmpApi } from "./api";
import type { PlannerStore } from "./planner-store";

/** The planner's own cap (src/planner/engine.ts MAX_CONCURRENT). */
const MAX_CONCURRENT = 64;

export interface SchedulerSnapshot {
	maxConcurrent: number;
	paused: boolean;
	/** Planner tasks running now. */
	running: number;
	/** Ready tasks waiting for a slot. */
	waiting: number;
	/** Ready tasks held by a provider limit, a spend cap or a retry backoff. */
	held: number;
}

let source: PlannerStore | undefined;

/** The planner's last word on the limit and the counts (all zero while it is unreachable). */
export function schedulerSnapshot(): SchedulerSnapshot {
	const s = source?.plan?.status;
	return { maxConcurrent: s?.maxConcurrent ?? 0, paused: s?.paused === true, running: s?.running ?? 0, waiting: s?.waiting ?? 0, held: s?.held ?? 0 };
}

/** "2/3 running · 5 waiting"; empty when there's nothing to say (no limit, nothing running). */
export function describeScheduler(s: SchedulerSnapshot): string {
	if (!s.maxConcurrent && !s.running && !s.waiting && !s.held && !s.paused) return "";
	const parts = [s.maxConcurrent ? `${s.running}/${s.maxConcurrent} running` : `${s.running} running`, s.waiting ? `${s.waiting} waiting` : "", s.held ? `${s.held} held` : "", s.paused ? "paused" : ""];
	return parts.filter(Boolean).join(" · ");
}

/** Calls `listener` whenever the limit, the pause switch, or the running/waiting counts change. */
export function watchScheduler(listener: (s: SchedulerSnapshot) => void): vscode.Disposable {
	let last = "";
	const check = () => {
		const snap = schedulerSnapshot();
		const key = JSON.stringify(snap);
		if (key === last) return;
		last = key;
		listener(snap);
	};
	check();
	return source ? source.onDidChange(check) : new vscode.Disposable(() => undefined);
}

function parseLimit(text: string): number | undefined {
	const t = text.trim().toLowerCase();
	if (t === "" || t === "unlimited" || t === "∞") return 0;
	if (!/^\d+$/.test(t)) return undefined;
	const n = Number(t);
	return n <= MAX_CONCURRENT ? n : undefined;
}

export function registerScheduler(api: OmpApi, planner: PlannerStore): void {
	const { context } = api;
	source = planner;
	const status = vscode.window.createStatusBarItem("omp.scheduler", vscode.StatusBarAlignment.Left, 49);
	status.name = "omp: queued task slots";
	status.command = "omp.scheduler.setConcurrency";
	context.subscriptions.push(status);

	const render = (s: SchedulerSnapshot) => {
		const text = describeScheduler(s);
		if (!text) {
			status.hide();
			return;
		}
		status.text = `${s.paused ? "$(debug-pause)" : "$(layers)"} ${text}`;
		const holds = source?.plan ? holdLines(source.plan.status) : [];
		status.tooltip = `Planner tasks across all sessions: ${text}.\nLimit: ${s.maxConcurrent || "unlimited"}. Click to change.\nPrompts typed in a chat are never held back.${holds.length ? `\n\n${holds.join("\n")}` : ""}`;
		status.show();
	};
	context.subscriptions.push(watchScheduler(render));

	const set = async (change: Partial<Pick<PlannerConfig, "maxConcurrent" | "paused" | "budget">>): Promise<boolean> => {
		try {
			await planner.scheduler(change);
			return true;
		} catch (err) {
			void vscode.window.showWarningMessage(`Switchyard planner: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("omp.scheduler.setConcurrency", async (arg?: unknown) => {
			if (typeof arg === "number" && Number.isFinite(arg)) {
				await set({ maxConcurrent: Math.max(0, Math.min(MAX_CONCURRENT, Math.trunc(arg))) });
				return;
			}
			const text = await vscode.window.showInputBox({
				title: "Concurrently running tasks",
				prompt: "How many planner tasks may run at the same time (all sessions). 0 or empty = unlimited. The rest wait by priority, then queue order.",
				value: String(schedulerSnapshot().maxConcurrent),
				validateInput: v => (parseLimit(v) === undefined ? `A number from 0 to ${MAX_CONCURRENT}` : undefined),
				ignoreFocusOut: true,
			});
			const n = text === undefined ? undefined : parseLimit(text);
			if (n !== undefined) await set({ maxConcurrent: n });
		}),
		vscode.commands.registerCommand("omp.scheduler.increase", () => set({ maxConcurrent: Math.min(MAX_CONCURRENT, schedulerSnapshot().maxConcurrent + 1) })),
		vscode.commands.registerCommand("omp.scheduler.decrease", async () => {
			// Going below 1 would mean "unlimited" (0): stop at 1.
			const n = schedulerSnapshot().maxConcurrent;
			if (n > 1) await set({ maxConcurrent: n - 1 });
		}),
		vscode.commands.registerCommand("omp.scheduler.togglePause", async () => {
			const paused = schedulerSnapshot().paused;
			if (await set({ paused: !paused })) void vscode.window.showInformationMessage(paused ? "Queued tasks may start again." : "No new queued task will start (running ones finish). Run the command again to resume.");
		}),
		vscode.commands.registerCommand("switchyard.scheduler.setBudget", async () => {
			const current = source?.plan?.status.budget ?? {};
			const value = Object.entries(current).map(([w, usd]) => `${w} ${usd}`).join(" ");
			const text = await vscode.window.showInputBox({
				title: "Spend budget for planner tasks (USD)",
				prompt: 'No new task starts while the spend of planner tasks in a rolling hour/day/week reaches its cap. E.g. "day 20" or "hour 2 day 20 week 100"; empty removes it.',
				value,
				validateInput: v => {
					const parsed = parseBudget(v);
					return "error" in parsed ? parsed.error : undefined;
				},
				ignoreFocusOut: true,
			});
			if (text === undefined) return;
			const parsed = parseBudget(text);
			if ("caps" in parsed) await set({ budget: parsed.caps });
		}),
	);
}
