// Task queue model shared by the session host (which runs it) and the extension (which edits
// queues of stopped sessions directly on disk). Pure apart from the small file helpers.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { QueueOp, QueueTask, QueueTaskOptions, QueueTaskStatus, SessionMeta, TaskQueue } from "./protocol";

const STATUSES: Record<QueueTaskStatus, true> = { pending: true, running: true, done: true, failed: true, skipped: true };
const MAX_TITLE = 500;
const MAX_NOTES = 20_000;
const MAX_TASKS = 500;
const MAX_SUBTASKS = 200;
export const MAX_RETRIES = 10;
/** A day; longer runs are almost certainly a typo. */
export const MAX_TIMEOUT_MINUTES = 24 * 60;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function emptyQueue(): TaskQueue {
	return { tasks: [], autoRun: false };
}

function newId(): string {
	return crypto.randomBytes(5).toString("hex");
}

function cleanTitle(v: unknown): string {
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
}

function clampIndex(index: unknown, length: number): number {
	const n = typeof index === "number" && Number.isFinite(index) ? Math.trunc(index) : length;
	return Math.max(0, Math.min(length, n));
}

function rec(v: unknown): Record<string, unknown> | undefined {
	// Parsed JSON object; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function finite(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Validated task options; undefined when nothing is set (so old/plain tasks stay plain). */
export function normalizeOptions(raw: unknown): QueueTaskOptions | undefined {
	const r = rec(raw);
	if (!r) return undefined;
	const out: QueueTaskOptions = {};
	const model = typeof r.model === "string" ? r.model.trim() : "";
	// `provider/modelId`; ids may contain further slashes (openrouter/anthropic/…).
	if (/^[^/\s]+\/\S+$/.test(model)) out.model = model;
	if (typeof r.thinking === "string" && THINKING_LEVELS.includes(r.thinking)) out.thinking = r.thinking;
	if (r.freshContext === true) out.freshContext = true;
	const retries = finite(r.retries);
	if (retries !== undefined && retries >= 1) out.retries = Math.min(MAX_RETRIES, Math.trunc(retries));
	const timeout = finite(r.timeoutMinutes);
	if (timeout !== undefined && timeout > 0) out.timeoutMinutes = Math.min(MAX_TIMEOUT_MINUTES, timeout);
	return Object.keys(out).length ? out : undefined;
}

/** Clears the outcome of a previous run so the task can run again from scratch. */
function resetRun(t: QueueTask): void {
	t.startedAt = undefined;
	t.finishedAt = undefined;
	t.summary = undefined;
	delete t.attempts;
	delete t.durationMs;
	delete t.cost;
}

function subtaskInput(v: unknown): { title: string; done: boolean } | undefined {
	const r = rec(v);
	const title = cleanTitle(r ? r.title : v);
	return title ? { title, done: r?.done === true } : undefined;
}

/** Validates/normalizes anything read from disk or the wire into a well-formed queue. */
export function normalizeQueue(raw: unknown): TaskQueue {
	const r = rec(raw);
	if (!r) return emptyQueue();
	const seen = new Set<string>();
	const tasks: QueueTask[] = [];
	for (const t of Array.isArray(r.tasks) ? r.tasks : []) {
		const tr = rec(t);
		const title = cleanTitle(tr?.title);
		if (!tr || !title) continue;
		let id = typeof tr.id === "string" && tr.id ? tr.id : newId();
		if (seen.has(id)) id = newId();
		seen.add(id);
		const status = typeof tr.status === "string" && tr.status in STATUSES ? (tr.status as QueueTaskStatus) : "pending";
		const subSeen = new Set<string>();
		const subtasks = (Array.isArray(tr.subtasks) ? tr.subtasks : [])
			.map(s => rec(s))
			.filter((s): s is Record<string, unknown> => !!s && !!cleanTitle(s.title))
			.slice(0, MAX_SUBTASKS)
			.map(s => {
				let sid = typeof s.id === "string" && s.id ? s.id : newId();
				if (subSeen.has(sid)) sid = newId();
				subSeen.add(sid);
				return { id: sid, title: cleanTitle(s.title), done: s.done === true };
			});
		const task: QueueTask = {
			id,
			title,
			notes: typeof tr.notes === "string" && tr.notes.trim() ? tr.notes.slice(0, MAX_NOTES) : undefined,
			subtasks,
			status,
			createdAt: typeof tr.createdAt === "number" ? tr.createdAt : Date.now(),
			startedAt: typeof tr.startedAt === "number" ? tr.startedAt : undefined,
			finishedAt: typeof tr.finishedAt === "number" ? tr.finishedAt : undefined,
			summary: typeof tr.summary === "string" ? tr.summary.slice(0, 4000) : undefined,
		};
		// Newer fields only when present, so files from older versions round-trip unchanged.
		const options = normalizeOptions(tr.options);
		if (options) task.options = options;
		const attempts = finite(tr.attempts);
		if (attempts !== undefined && attempts > 0) task.attempts = Math.trunc(attempts);
		const duration = finite(tr.durationMs);
		if (duration !== undefined && duration >= 0) task.durationMs = duration;
		const cost = finite(tr.cost);
		if (cost !== undefined && cost >= 0) task.cost = cost;
		tasks.push(task);
		if (tasks.length >= MAX_TASKS) break;
	}
	const q: TaskQueue = { tasks, autoRun: r.autoRun === true };
	const startAt = finite(r.startAt);
	if (startAt !== undefined && startAt > 0) q.startAt = startAt;
	return q;
}

/** Applies edits; invalid ops (unknown ids, empty titles) are ignored rather than throwing. */
export function applyQueueOps(queue: TaskQueue, ops: QueueOp[], now = Date.now()): TaskQueue {
	const q: TaskQueue = { ...queue, tasks: queue.tasks.map(t => ({ ...t, subtasks: t.subtasks.map(s => ({ ...s })) })) };
	const find = (id: unknown) => q.tasks.findIndex(t => t.id === id);
	for (const op of Array.isArray(ops) ? ops : []) {
		const o = rec(op);
		if (!o) continue;
		switch (o.op) {
			case "add": {
				const title = cleanTitle(o.title);
				if (!title || q.tasks.length >= MAX_TASKS) break;
				const subtasks = (Array.isArray(o.subtasks) ? o.subtasks : [])
					.map(subtaskInput)
					.filter((s): s is { title: string; done: boolean } => !!s)
					.slice(0, MAX_SUBTASKS)
					.map(s => ({ id: newId(), ...s }));
				const notes = typeof o.notes === "string" && o.notes.trim() ? o.notes.slice(0, MAX_NOTES) : undefined;
				const task: QueueTask = { id: newId(), title, notes, subtasks, status: "pending", createdAt: now };
				const options = normalizeOptions(o.options);
				if (options) task.options = options;
				if (o.done === true) Object.assign(task, { status: "done", finishedAt: now });
				q.tasks.splice(clampIndex(o.index, q.tasks.length), 0, task);
				break;
			}
			case "update": {
				const t = q.tasks[find(o.id)];
				if (!t) break;
				const title = cleanTitle(o.title);
				if (title) t.title = title;
				if (typeof o.notes === "string") t.notes = o.notes.trim() ? o.notes.slice(0, MAX_NOTES) : undefined;
				// The host owns a running task's outcome; clients can't flip it mid-run.
				if (typeof o.status === "string" && o.status in STATUSES && o.status !== "running" && t.status !== "running") {
					t.status = o.status as QueueTaskStatus;
					if (t.status === "done" || t.status === "skipped") {
						t.finishedAt = now;
						if (t.status === "done") for (const s of t.subtasks) s.done = true;
					}
					if (t.status === "pending") resetRun(t);
				}
				break;
			}
			case "remove": {
				const i = find(o.id);
				if (i >= 0 && q.tasks[i].status !== "running") q.tasks.splice(i, 1);
				break;
			}
			case "move": {
				const i = find(o.id);
				if (i < 0) break;
				const [t] = q.tasks.splice(i, 1);
				q.tasks.splice(clampIndex(o.index, q.tasks.length), 0, t);
				break;
			}
			case "addSubtask": {
				const t = q.tasks[find(o.id)];
				const title = cleanTitle(o.title);
				if (t && title && t.subtasks.length < MAX_SUBTASKS) t.subtasks.push({ id: newId(), title, done: false });
				break;
			}
			case "updateSubtask": {
				const s = q.tasks[find(o.id)]?.subtasks.find(x => x.id === o.subtaskId);
				if (!s) break;
				const title = cleanTitle(o.title);
				if (title) s.title = title;
				if (typeof o.done === "boolean") s.done = o.done;
				break;
			}
			case "removeSubtask": {
				const t = q.tasks[find(o.id)];
				if (t) t.subtasks = t.subtasks.filter(s => s.id !== o.subtaskId);
				break;
			}
			case "moveSubtask": {
				const t = q.tasks[find(o.id)];
				const i = t ? t.subtasks.findIndex(s => s.id === o.subtaskId) : -1;
				if (!t || i < 0) break;
				const [s] = t.subtasks.splice(i, 1);
				t.subtasks.splice(clampIndex(o.index, t.subtasks.length), 0, s);
				break;
			}
			case "autoRun":
				q.autoRun = o.value === true;
				delete q.startAt;
				break;
			case "clearDone":
				q.tasks = q.tasks.filter(t => t.status !== "done" && t.status !== "skipped");
				break;
			case "run": {
				// Promote the task to the front of the pending work and arm the runner.
				const i = typeof o.id === "string" ? find(o.id) : q.tasks.findIndex(t => t.status === "pending");
				if (i >= 0 && q.tasks[i].status !== "running") {
					const [t] = q.tasks.splice(i, 1);
					t.status = "pending";
					resetRun(t);
					const firstOpen = q.tasks.findIndex(x => x.status === "pending" || x.status === "running");
					q.tasks.splice(firstOpen < 0 ? q.tasks.length : firstOpen, 0, t);
				}
				q.autoRun = true;
				delete q.startAt;
				break;
			}
			case "setOptions": {
				const t = q.tasks[find(o.id)];
				if (!t) break;
				const options = normalizeOptions(o.options);
				if (options) t.options = options;
				else delete t.options;
				break;
			}
			case "duplicate": {
				const i = find(o.id);
				if (i < 0 || q.tasks.length >= MAX_TASKS) break;
				const src = q.tasks[i];
				const copy: QueueTask = { id: newId(), title: src.title, notes: src.notes, subtasks: src.subtasks.map(s => ({ id: newId(), title: s.title, done: false })), status: "pending", createdAt: now };
				if (src.options) copy.options = { ...src.options };
				q.tasks.splice(i + 1, 0, copy);
				break;
			}
			case "retryFailed":
				for (const t of q.tasks) {
					if (t.status !== "failed") continue;
					t.status = "pending";
					resetRun(t);
				}
				break;
			case "schedule": {
				// A scheduled start means "not now": the runner waits for the time.
				const at = finite(o.at);
				if (at !== undefined && at > 0) {
					q.startAt = at;
					q.autoRun = false;
				} else if (o.at === null) delete q.startAt;
				break;
			}
		}
	}
	return q;
}

export function queueSummary(q: TaskQueue): NonNullable<SessionMeta["queue"]> {
	const out: NonNullable<SessionMeta["queue"]> = {
		pending: q.tasks.filter(t => t.status === "pending").length,
		running: q.tasks.filter(t => t.status === "running").length,
		done: q.tasks.filter(t => t.status === "done").length,
		total: q.tasks.length,
		autoRun: q.autoRun,
	};
	if (q.startAt) out.startAt = q.startAt;
	return out;
}

/** Wait before auto-retry number `attempt` (1-based): base, 2×, 4×… capped at 5 minutes. */
export function retryDelay(attempt: number, baseMs = 10_000): number {
	return Math.min(5 * 60_000, baseMs * 2 ** Math.max(0, attempt - 1));
}

export function nextPending(q: TaskQueue): QueueTask | undefined {
	return q.tasks.find(t => t.status === "pending");
}

/** The prompt omp receives for a queued task. */
export function taskPrompt(task: QueueTask, position: { index: number; total: number }): string {
	const lines = [`[Task ${position.index}/${position.total} from the queue] ${task.title}`];
	if (task.notes) lines.push("", task.notes);
	if (task.subtasks.length) {
		lines.push("", "Subtasks:");
		for (const s of task.subtasks) lines.push(`- [${s.done ? "x" : " "}] ${s.title}`);
	}
	lines.push("", "Work through this task completely (track the subtasks with your todo tool), verify the result, and finish with a short summary of what you did.");
	return lines.join("\n");
}

export function readQueueFile(file: string): TaskQueue {
	try {
		return normalizeQueue(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return emptyQueue();
	}
}

/** Atomic write so a crash never leaves a torn queue file. */
export function writeQueueFile(file: string, q: TaskQueue): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(q, null, 1));
	fs.renameSync(tmp, file);
}
