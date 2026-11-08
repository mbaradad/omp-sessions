// Global concurrency limit for queued tasks across all session hosts (independent processes,
// running with or without VS Code). Node-only; no vscode import.
//
// Layout under stateRoot() (~/.omp/vscode, OMP_VSCODE_HOME overrides):
//   scheduler.json                 { maxConcurrent: number (0 = unlimited), paused?: boolean }
//   slots/<sessionId>.json         lease { pid, since, taskId, …stamp } held while a queued task runs
//   slots/waiting/<sessionId>.json { pid, since, …stamp } a host with a runnable queued task but no slot
//   slots/.lock                    short global mutex (O_EXCL create) around check+acquire
// Leases and waiting entries whose process is gone are stale: ignored and removed by the next caller.
// The stamp (process-lock.ts) keeps a reused pid (after a reboot) from holding a slot forever.
// Only queued tasks are gated; prompts typed in a chat always go straight to omp.
import * as fs from "node:fs";
import * as path from "node:path";
import { processStamp, stampAlive } from "./process-lock";
import { stateRoot } from "./protocol";

export interface SchedulerConfig {
	/** Queued tasks allowed to run at once across all sessions; 0 = unlimited. */
	maxConcurrent: number;
	/** No new queued task starts anywhere while set; running ones finish. */
	paused?: boolean;
	/** The omp-sessions daemon stops sessions it launched once their queue is done (absent = true). */
	stopWhenQueueDone?: boolean;
}

export interface SlotLease {
	sessionId: string;
	pid: number;
	since: number;
	taskId: string;
}

export interface SlotWaiter {
	sessionId: string;
	pid: number;
	since: number;
}

export type AcquireResult = { acquired: true } | { acquired: false; position: number; since: number } | { acquired: false; busy: true };

const LOCK_STALE_MS = 5000;
export const MAX_CONCURRENT = 64;

export function schedulerPath(): string {
	return path.join(stateRoot(), "scheduler.json");
}

export function slotsDir(): string {
	return path.join(stateRoot(), "slots");
}

function waitingDir(): string {
	return path.join(slotsDir(), "waiting");
}

function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function normalizeScheduler(raw: unknown): SchedulerConfig {
	const r = rec(raw);
	const n = typeof r?.maxConcurrent === "number" && Number.isFinite(r.maxConcurrent) ? Math.trunc(r.maxConcurrent) : 0;
	const out: SchedulerConfig = { maxConcurrent: Math.max(0, Math.min(MAX_CONCURRENT, n)) };
	if (r?.paused === true) out.paused = true;
	if (typeof r?.stopWhenQueueDone === "boolean") out.stopWhenQueueDone = r.stopWhenQueueDone;
	return out;
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** Atomic JSON write (temp file + rename). */
function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
	fs.renameSync(tmp, file);
}

export function readScheduler(): SchedulerConfig {
	return normalizeScheduler(readJson(schedulerPath()));
}

export function writeScheduler(cfg: SchedulerConfig): void {
	writeJson(schedulerPath(), normalizeScheduler(cfg));
}

function unlink(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {
		/* already gone */
	}
}

/** Entries of `dir` whose process still runs; files of dead processes are removed. */
function liveEntries(dir: string): Array<{ sessionId: string; pid: number; since: number; raw: Record<string, unknown> }> {
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: Array<{ sessionId: string; pid: number; since: number; raw: Record<string, unknown> }> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		const r = rec(readJson(file));
		const pid = typeof r?.pid === "number" ? r.pid : 0;
		if (!r || !stampAlive(r)) {
			// Writes are atomic (temp + rename), so unreadable or dead-pid entries are garbage.
			unlink(file);
			continue;
		}
		out.push({ sessionId: name.slice(0, -5), pid, since: typeof r.since === "number" ? r.since : 0, raw: r });
	}
	return out;
}

/** Running queued tasks (live leases), oldest first. */
export function listLeases(): SlotLease[] {
	return liveEntries(slotsDir())
		.map(e => ({ sessionId: e.sessionId, pid: e.pid, since: e.since, taskId: typeof e.raw.taskId === "string" ? e.raw.taskId : "" }))
		.sort((a, b) => a.since - b.since);
}

/** Hosts waiting for a slot, oldest first (before any user ordering). */
export function listWaiting(): SlotWaiter[] {
	return liveEntries(waitingDir())
		.map(e => ({ sessionId: e.sessionId, pid: e.pid, since: e.since }))
		.sort((a, b) => a.since - b.since || a.sessionId.localeCompare(b.sessionId));
}

/** Short global mutex; undefined when another process holds it (caller retries shortly). */
function tryLock(): (() => void) | undefined {
	const file = path.join(slotsDir(), ".lock");
	fs.mkdirSync(waitingDir(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(file, "wx");
			fs.writeSync(fd, String(process.pid));
			fs.closeSync(fd);
			return () => unlink(file);
		} catch (err) {
			if (rec(err)?.code !== "EEXIST") throw err;
			try {
				// A holder that crashed mid-section leaves the lock behind; it's only ever held for ms.
				if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) unlink(file);
				else return undefined;
			} catch {
				/* vanished between open and stat: retry */
			}
		}
	}
	return undefined;
}

/**
 * Tries to take a slot for the next queued task of `sessionId`. Waiters are ranked by `order`
 * (given ids sorted by waiting-since, returns them in start order); the first `free` of them may
 * start. Not acquired → the caller is (still) registered as waiting, with its 1-based position.
 */
export function tryAcquireSlot(sessionId: string, taskId: string, order: (ids: string[]) => string[] = ids => ids, pid = process.pid): AcquireResult {
	const release = tryLock();
	if (!release) return { acquired: false, busy: true };
	try {
		const cfg = readScheduler();
		const leases = listLeases();
		const leaseFile = path.join(slotsDir(), `${sessionId}.json`);
		const waitFile = path.join(waitingDir(), `${sessionId}.json`);
		if (leases.some(l => l.sessionId === sessionId && l.pid === pid)) {
			writeJson(leaseFile, { ...processStamp(pid), since: Date.now(), taskId });
			unlink(waitFile);
			return { acquired: true };
		}
		let waiting = listWaiting();
		let self = waiting.find(w => w.sessionId === sessionId);
		if (!self || self.pid !== pid) {
			self = { sessionId, pid, since: self?.since ?? Date.now() };
			writeJson(waitFile, { ...processStamp(pid), since: self.since });
			waiting = [...waiting.filter(w => w.sessionId !== sessionId), self].sort((a, b) => a.since - b.since || a.sessionId.localeCompare(b.sessionId));
		}
		const ids = waiting.map(w => w.sessionId);
		const ordered = order(ids);
		// Ordering functions may drop or invent ids; keep every waiter exactly once.
		const ranked = [...ordered.filter((id, i) => ids.includes(id) && ordered.indexOf(id) === i), ...ids.filter(id => !ordered.includes(id))];
		const position = ranked.indexOf(sessionId) + 1;
		const free = cfg.paused ? 0 : cfg.maxConcurrent === 0 ? Number.POSITIVE_INFINITY : cfg.maxConcurrent - leases.length;
		if (position > free) return { acquired: false, position, since: self.since };
		writeJson(leaseFile, { ...processStamp(pid), since: Date.now(), taskId });
		unlink(waitFile);
		return { acquired: true };
	} finally {
		release();
	}
}

/** Drops this host's lease (task ended) — only if it is ours. */
export function releaseSlot(sessionId: string, pid = process.pid): void {
	const file = path.join(slotsDir(), `${sessionId}.json`);
	if (rec(readJson(file))?.pid === pid) unlink(file);
}

/** Stops waiting (queue paused/emptied, host exiting) — only if the entry is ours. */
export function leaveWaiting(sessionId: string, pid = process.pid): void {
	const file = path.join(waitingDir(), `${sessionId}.json`);
	if (rec(readJson(file))?.pid === pid) unlink(file);
}
