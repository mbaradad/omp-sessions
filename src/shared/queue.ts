// Normalizes a task queue read from disk or the wire (the legacy queue.json files `omp-sessions migrate` imports)
// into a well-formed one, and the limits the CLI applies to a task it adds. Pure.
import * as crypto from "node:crypto";
import type { QueueTask, QueueTaskOptions, QueueTaskStatus, TaskQueue } from "./protocol";

const STATUSES: Record<QueueTaskStatus, true> = { pending: true, running: true, done: true, failed: true, skipped: true };
/** Longer task titles are cut: long prompts belong in the notes. */
export const MAX_TITLE = 500;
export const MAX_NOTES = 20_000;
const MAX_TASKS = 500;
const MAX_SUBTASKS = 200;
const MAX_RETRIES = 10;
/** A day; longer runs are almost certainly a typo. */
const MAX_TIMEOUT_MINUTES = 24 * 60;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

function emptyQueue(): TaskQueue {
	return { tasks: [], autoRun: false };
}

function newId(): string {
	return crypto.randomBytes(5).toString("hex");
}

function cleanTitle(v: unknown): string {
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
}

function rec(v: unknown): Record<string, unknown> | undefined {
	// Parsed JSON object; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function finite(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Validated task options; undefined when nothing is set (so old/plain tasks stay plain). */
function normalizeOptions(raw: unknown): QueueTaskOptions | undefined {
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
		const interrupted = finite(tr.interrupted);
		if (interrupted !== undefined && interrupted > 0 && status === "pending") task.interrupted = interrupted;
		tasks.push(task);
		if (tasks.length >= MAX_TASKS) break;
	}
	const q: TaskQueue = { tasks, autoRun: r.autoRun === true };
	const startAt = finite(r.startAt);
	if (startAt !== undefined && startAt > 0) q.startAt = startAt;
	return q;
}
