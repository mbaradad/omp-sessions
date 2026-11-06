// Host-side task queue runner: feeds pending tasks to omp one at a time, applies per-task
// options (model / thinking level / fresh context / timeout / retries), records results, starts
// the queue at its scheduled time, and takes a global concurrency slot (src/shared/scheduler.ts)
// for every queued task. Owns queue.json; main.ts wires omp frames into it.
import * as fs from "node:fs";
import * as path from "node:path";
import { readOrgFile, schedulingOrder } from "../shared/organize";
import { type OmpFrame, type QueueOp, type QueueTask, type SessionMeta, type TaskQueue, stateRoot } from "../shared/protocol";
import { applyQueueOps, nextPending, queueSummary, readQueueFile, retryDelay, taskPrompt, writeQueueFile } from "../shared/queue";
import { type AcquireResult, leaveWaiting, releaseSlot, slotsDir, tryAcquireSlot } from "../shared/scheduler";

export interface QueueRunnerHost {
	log(...parts: unknown[]): void;
	sendOmp(cmd: Record<string, unknown>): void;
	request(cmd: Record<string, unknown>): Promise<OmpFrame>;
	/** omp is ready and idle, no dialog is open, and the host isn't shutting down. */
	idle(): boolean;
	/** Marks the agent busy/idle on the runner's behalf (session status, dispatch gating). */
	setBusy(busy: boolean): void;
	/** omp switched to a new session underneath (new_session): re-mirror the transcript. */
	sessionReset(): Promise<void>;
	/** Persistent notice in the session timeline. */
	notice(level: "info" | "warning" | "error", message: string): void;
	/** The queue (already written to disk) or its summary changed: broadcast and publish meta. */
	changed(queue: TaskQueue, summary: NonNullable<SessionMeta["queue"]>): void;
}

interface ActiveTask {
	id: string;
	promptId: string;
	started: number;
	/** The prompt went out (false while switching model/session). */
	prompted: boolean;
	result?: "completed" | "aborted" | "error";
	error?: string;
	timedOut?: boolean;
	timeout?: NodeJS.Timeout;
	finishing?: boolean;
	cost: number;
	lastText?: string;
	restore: { model?: { provider: string; modelId: string }; thinking?: string };
}

/** setTimeout's ceiling (~24.8 days); longer waits re-arm. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function textOf(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(b => (rec(b)?.type === "text" && typeof rec(b)?.text === "string" ? String(rec(b)?.text) : "")).join("\n");
}

function splitModel(label: string): { provider: string; modelId: string } {
	const i = label.indexOf("/");
	return { provider: label.slice(0, i), modelId: label.slice(i + 1) };
}

export class QueueRunner {
	queue: TaskQueue;
	private active: ActiveTask | null = null;
	private dispatchTimer: NodeJS.Timeout | undefined;
	private startTimer: NodeJS.Timeout | undefined;
	/** Auto-retry backoff: nothing is dispatched before this time. */
	private holdUntil = 0;
	/** Set while the next task waits for a global concurrency slot. */
	private waiting: { position: number; since: number } | undefined;
	private watchers: fs.FSWatcher[] | undefined;

	constructor(
		private readonly sessionId: string,
		private readonly file: string,
		private readonly host: QueueRunnerHost,
		private readonly retryBaseMs = Number(process.env.OMP_VSCODE_RETRY_BASE_MS) || 10_000,
	) {
		this.queue = readQueueFile(file);
		// A task left "running" by a crashed/restarted host goes back to pending; don't auto-run it
		// again unattended, the user decides.
		if (this.queue.tasks.some(t => t.status === "running")) {
			for (const t of this.queue.tasks) if (t.status === "running") Object.assign(t, { status: "pending", summary: "Interrupted: the session host restarted." });
			this.queue.autoRun = false;
		}
		// Next tick: the host's broadcast plumbing isn't initialized while it constructs the runner.
		setImmediate(() => this.armStart());
		// Synchronous on purpose: "exit" handlers can't await. Dead pids make leftovers stale anyway.
		process.on("exit", () => {
			releaseSlot(sessionId);
			leaveWaiting(sessionId);
		});
	}

	summary(): NonNullable<SessionMeta["queue"]> {
		const s = queueSummary(this.queue);
		if (this.waiting) s.waiting = this.waiting;
		return s;
	}

	/** Prompt id of the task currently driving omp. */
	get activePromptId(): string | undefined {
		return this.active?.prompted ? this.active.promptId : undefined;
	}

	apply(ops: QueueOp[]): void {
		this.queue = applyQueueOps(this.queue, ops);
		this.save();
		this.armStart();
		this.schedule();
	}

	/** Feeds the next pending task to omp when the queue is armed and the session is idle. */
	schedule(delay = 400): void {
		clearTimeout(this.dispatchTimer);
		this.dispatchTimer = setTimeout(() => this.dispatchNext(), delay);
	}

	/** The queued prompt was rejected before reaching the agent. Returns true when it was ours. */
	onResponse(frame: OmpFrame): boolean {
		const a = this.active;
		if (!a?.prompted || frame.id !== a.promptId || frame.success) return false;
		a.result = "error";
		a.error = typeof frame.error === "string" ? frame.error : undefined;
		this.host.setBusy(false);
		void this.finish();
		return true;
	}

	/** Assistant message_end while a task runs: cost and the final summary text. */
	onAssistantMessage(message: Record<string, unknown>): void {
		const a = this.active;
		if (!a?.prompted) return;
		const cost = rec(rec(message.usage)?.cost)?.total;
		if (typeof cost === "number" && Number.isFinite(cost)) a.cost += cost;
		const text = textOf(message).trim();
		if (text) a.lastText = text.slice(0, 4000);
	}

	onPromptResult(frame: OmpFrame): void {
		const a = this.active;
		if (!a?.prompted || frame.id !== a.promptId) return;
		a.result = frame.status === "completed" ? "completed" : frame.status === "aborted" ? "aborted" : "error";
		const message = rec(frame.error)?.message;
		a.error = typeof message === "string" ? message : undefined;
		if (frame.sessionSettled || a.result !== "completed") void this.finish();
	}

	onSettled(): void {
		void this.finish();
	}

	private save(): void {
		try {
			writeQueueFile(this.file, this.queue);
		} catch (err) {
			this.host.log("queue save failed", String(err));
		}
		this.host.changed(this.queue, this.summary());
	}

	private setWaiting(next: { position: number; since: number } | undefined): void {
		if (next?.position === this.waiting?.position && next?.since === this.waiting?.since) return;
		this.waiting = next;
		if (!next) leaveWaiting(this.sessionId);
		this.host.changed(this.queue, this.summary());
	}

	/** Re-evaluate promptly when a slot frees up, the limit changes, or the user reorders sessions. */
	private watchSlots(): void {
		if (this.watchers) return;
		this.watchers = [];
		const poke = () => {
			if (this.waiting) this.schedule(100);
		};
		const targets: Array<[string, (name: string | null) => boolean]> = [
			[slotsDir(), () => true],
			[path.join(slotsDir(), "waiting"), () => true],
			[stateRoot(), name => name === "scheduler.json" || name === "organize.json"],
		];
		for (const [dir, wanted] of targets) {
			try {
				const w = fs.watch(dir, (_event, name) => {
					if (wanted(name === null ? null : String(name))) poke();
				});
				w.on("error", () => w.close());
				this.watchers.push(w);
			} catch {
				/* the 2 s poll still covers it */
			}
		}
	}

	/** Queued-task start order of waiting sessions: the user's board order (Organize), else waiting time. */
	private order(ids: string[]): string[] {
		try {
			return schedulingOrder(readOrgFile(), ids);
		} catch (err) {
			this.host.log("organize order failed", String(err));
			return ids;
		}
	}

	/** (Re)arms the scheduled start; fires right away when the time already passed (host was down). */
	private armStart(): void {
		clearTimeout(this.startTimer);
		const at = this.queue.startAt;
		if (!at) return;
		const wait = at - Date.now();
		if (wait > 0) {
			this.startTimer = setTimeout(() => this.armStart(), Math.min(wait, MAX_TIMER_MS));
			return;
		}
		this.host.log("queue scheduled start", new Date(at).toISOString());
		this.queue.autoRun = true;
		delete this.queue.startAt;
		this.save();
		this.schedule(0);
	}

	private dispatchNext(): void {
		if (this.active) return;
		const task = this.queue.autoRun ? nextPending(this.queue) : undefined;
		if (!task) {
			this.setWaiting(undefined);
			return;
		}
		if (!this.host.idle()) return;
		const wait = this.holdUntil - Date.now();
		if (wait > 0) {
			this.schedule(wait);
			return;
		}
		let slot: AcquireResult;
		try {
			slot = tryAcquireSlot(this.sessionId, task.id, ids => this.order(ids));
		} catch (err) {
			// A broken state dir must not wedge the queue: run ungated.
			this.host.log("slot acquire failed", String(err));
			slot = { acquired: true };
		}
		if (!slot.acquired) {
			if ("position" in slot) {
				this.setWaiting({ position: slot.position, since: slot.since });
				this.watchSlots();
			}
			// Another host holds the mutex for a moment, or we wait: poll as a fallback to the watchers.
			this.schedule("busy" in slot ? 150 : 2000);
			return;
		}
		this.setWaiting(undefined);
		void this.run(task);
	}

	private async run(task: QueueTask): Promise<void> {
		const index = this.queue.tasks.indexOf(task) + 1;
		if (!task.attempts) {
			// A fresh run (not an auto-retry): results of earlier runs don't add up.
			delete task.durationMs;
			delete task.cost;
		}
		task.status = "running";
		task.startedAt = Date.now();
		task.finishedAt = undefined;
		task.summary = undefined;
		const a: ActiveTask = { id: task.id, promptId: `q:${task.id}:${Date.now().toString(36)}`, started: Date.now(), prompted: false, cost: 0, restore: {} };
		this.active = a;
		this.host.setBusy(true);
		this.host.log("queue dispatch", task.id, task.title, task.options ?? {});
		this.save();
		const opts = task.options ?? {};
		try {
			if (opts.freshContext) {
				const res = await this.host.request({ type: "new_session" });
				if (!res.success) throw new Error(`new session: ${String(res.error)}`);
				if (rec(res.data)?.cancelled === true) throw new Error("new session was cancelled");
				await this.host.sessionReset();
				this.host.notice("info", `Queued task "${task.title}" started in a new omp session (fresh context).`);
			}
			if (opts.model || opts.thinking) {
				const st = await this.host.request({ type: "get_state" });
				const state = rec(st.data);
				const model = rec(state?.model);
				const current = typeof model?.provider === "string" && typeof model.id === "string" ? { provider: model.provider, modelId: model.id } : undefined;
				if (opts.model && (!current || `${current.provider}/${current.modelId}` !== opts.model)) {
					const res = await this.host.request({ type: "set_model", ...splitModel(opts.model) });
					if (!res.success) throw new Error(`model ${opts.model}: ${String(res.error)}`);
					a.restore.model = current;
				}
				const thinking = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : undefined;
				if (opts.thinking && thinking !== opts.thinking) {
					const res = await this.host.request({ type: "set_thinking_level", level: opts.thinking });
					if (!res.success) throw new Error(`thinking level ${opts.thinking}: ${String(res.error)}`);
					a.restore.thinking = thinking;
				}
			}
		} catch (err) {
			a.result = "error";
			a.error = `Could not prepare the task (${err instanceof Error ? err.message : String(err)}).`;
			this.host.setBusy(false);
			await this.finish();
			return;
		}
		a.prompted = true;
		if (opts.timeoutMinutes) {
			a.timeout = setTimeout(
				() => {
					if (this.active !== a || a.result) return;
					a.timedOut = true;
					this.host.log("queue task timed out", a.id);
					this.host.sendOmp({ type: "abort" });
				},
				Math.min(opts.timeoutMinutes * 60_000, MAX_TIMER_MS),
			);
		}
		this.host.sendOmp({ type: "prompt", id: a.promptId, message: taskPrompt(task, { index, total: this.queue.tasks.length }) });
	}

	private async finish(): Promise<void> {
		const a = this.active;
		if (!a?.result || a.finishing) return;
		a.finishing = true;
		clearTimeout(a.timeout);
		// Put the session back the way the user had it.
		if (a.restore.model) {
			const res = await this.host.request({ type: "set_model", ...a.restore.model });
			if (!res.success) this.host.log("model restore failed", res.error);
		}
		if (a.restore.thinking) {
			const res = await this.host.request({ type: "set_thinking_level", level: a.restore.thinking });
			if (!res.success) this.host.log("thinking restore failed", res.error);
		}
		this.active = null;
		releaseSlot(this.sessionId);
		const task = this.queue.tasks.find(t => t.id === a.id);
		let delay = 800;
		if (task) {
			const now = Date.now();
			task.finishedAt = now;
			task.durationMs = (task.durationMs ?? 0) + (now - a.started);
			if (a.cost > 0) task.cost = (task.cost ?? 0) + a.cost;
			if (a.result === "completed") {
				task.status = "done";
				for (const s of task.subtasks) s.done = true;
				task.summary = a.lastText;
			} else if (a.result === "aborted" && !a.timedOut) {
				// The user interrupted: keep the task, stop the runner until they resume it.
				task.status = "pending";
				task.startedAt = undefined;
				task.finishedAt = undefined;
				task.summary = "Interrupted.";
				this.queue.autoRun = false;
			} else {
				const minutes = task.options?.timeoutMinutes ?? 0;
				const reason = a.timedOut ? `Timed out after ${minutes} min.` : (a.error ?? "The model request failed.");
				if (a.timedOut) this.host.notice("warning", `Queued task "${task.title}" timed out after ${minutes} min and was stopped.`);
				const attempts = (task.attempts ?? 0) + 1;
				const allowed = task.options?.retries ?? 0;
				task.attempts = attempts;
				if (attempts <= allowed) {
					delay = retryDelay(attempts, this.retryBaseMs);
					this.holdUntil = now + delay;
					task.status = "pending";
					task.startedAt = undefined;
					task.finishedAt = undefined;
					task.summary = `Attempt ${attempts} of ${allowed + 1} failed: ${reason} Retrying in ${Math.round(delay / 1000)}s.`;
				} else {
					task.status = "failed";
					task.summary = allowed ? `${reason} (gave up after ${attempts} attempts)` : reason;
					this.queue.autoRun = false;
				}
			}
		}
		this.save();
		this.schedule(delay);
	}
}
