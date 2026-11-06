// Global concurrency for queued tasks (see src/shared/scheduler.ts): the limit setting, a pause
// switch, and a status bar counter "2/3 running · 5 waiting". The limit lives in scheduler.json
// so hosts honour it with VS Code closed.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { stateRoot } from "../shared/protocol";
import { MAX_CONCURRENT, listLeases, listWaiting, readScheduler, slotsDir, writeScheduler } from "../shared/scheduler";
import type { OmpApi } from "./api";

export interface SchedulerSnapshot {
	maxConcurrent: number;
	paused: boolean;
	/** Queued tasks currently holding a slot (all sessions on this machine). */
	running: number;
	/** Sessions whose next queued task waits for a slot. */
	waiting: number;
}

export function schedulerSnapshot(): SchedulerSnapshot {
	const cfg = readScheduler();
	return { maxConcurrent: cfg.maxConcurrent, paused: cfg.paused === true, running: listLeases().length, waiting: listWaiting().length };
}

/** "2/3 running · 5 waiting"; empty when there's nothing to say (no limit, nothing running). */
export function describeScheduler(s: SchedulerSnapshot): string {
	if (!s.maxConcurrent && !s.running && !s.waiting && !s.paused) return "";
	const parts = [s.maxConcurrent ? `${s.running}/${s.maxConcurrent} running` : `${s.running} running`, s.waiting ? `${s.waiting} waiting` : "", s.paused ? "paused" : ""];
	return parts.filter(Boolean).join(" · ");
}

/**
 * Calls `listener` whenever the limit, the pause switch, or the running/waiting counts change
 * (fs.watch on scheduler.json and the slot dirs, with a 2 s poll as fallback).
 */
export function watchScheduler(listener: (s: SchedulerSnapshot) => void): vscode.Disposable {
	let last = "";
	let timer: NodeJS.Timeout | undefined;
	const check = () => {
		timer = undefined;
		let snap: SchedulerSnapshot;
		try {
			snap = schedulerSnapshot();
		} catch {
			return;
		}
		const key = JSON.stringify(snap);
		if (key === last) return;
		last = key;
		listener(snap);
	};
	const poke = () => {
		timer ??= setTimeout(check, 100);
	};
	const watchers: fs.FSWatcher[] = [];
	try {
		fs.mkdirSync(path.join(slotsDir(), "waiting"), { recursive: true, mode: 0o700 });
	} catch {
		/* polling still works once something creates it */
	}
	for (const [dir, wanted] of [
		[stateRoot(), (name: string) => name === "scheduler.json"],
		[slotsDir(), () => true],
		[path.join(slotsDir(), "waiting"), () => true],
	] as const) {
		try {
			const w = fs.watch(dir, (_e, name) => {
				if (name === null || wanted(String(name))) poke();
			});
			w.on("error", () => w.close());
			watchers.push(w);
		} catch {
			/* covered by the poll */
		}
	}
	const poll = setInterval(check, 2000);
	check();
	return new vscode.Disposable(() => {
		clearInterval(poll);
		clearTimeout(timer);
		for (const w of watchers) w.close();
	});
}

function parseLimit(text: string): number | undefined {
	const t = text.trim().toLowerCase();
	if (t === "" || t === "unlimited" || t === "∞") return 0;
	if (!/^\d+$/.test(t)) return undefined;
	const n = Number(t);
	return n <= MAX_CONCURRENT ? n : undefined;
}

export function registerScheduler(api: OmpApi): void {
	const { context } = api;
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
		status.tooltip = `Queued tasks across all omp sessions: ${text}.\nLimit: ${s.maxConcurrent || "unlimited"}. Click to change.\nPrompts typed in a chat are never held back.`;
		status.show();
	};
	context.subscriptions.push(watchScheduler(render));

	const setLimit = (n: number) => {
		writeScheduler({ ...readScheduler(), maxConcurrent: n });
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("omp.scheduler.setConcurrency", async (arg?: unknown) => {
			if (typeof arg === "number" && Number.isFinite(arg)) {
				setLimit(Math.max(0, Math.min(MAX_CONCURRENT, Math.trunc(arg))));
				return;
			}
			const cfg = readScheduler();
			const text = await vscode.window.showInputBox({
				title: "Concurrently running queued tasks",
				prompt: "How many sessions may run a queued task at the same time (all sessions on this machine). 0 or empty = unlimited. The rest wait in board order.",
				value: String(cfg.maxConcurrent),
				validateInput: v => (parseLimit(v) === undefined ? `A number from 0 to ${MAX_CONCURRENT}` : undefined),
				ignoreFocusOut: true,
			});
			const n = text === undefined ? undefined : parseLimit(text);
			if (n !== undefined) setLimit(n);
		}),
		vscode.commands.registerCommand("omp.scheduler.increase", () => setLimit(Math.min(MAX_CONCURRENT, readScheduler().maxConcurrent + 1))),
		vscode.commands.registerCommand("omp.scheduler.decrease", () => {
			// Going below 1 would mean "unlimited" (0): stop at 1.
			const n = readScheduler().maxConcurrent;
			if (n > 1) setLimit(n - 1);
		}),
		vscode.commands.registerCommand("omp.scheduler.togglePause", () => {
			const cfg = readScheduler();
			writeScheduler({ ...cfg, paused: !cfg.paused });
			void vscode.window.showInformationMessage(cfg.paused ? "Queued tasks may start again." : "No new queued task will start (running ones finish). Run the command again to resume.");
		}),
	);
}
