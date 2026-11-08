// Process identities that survive pid reuse, and exclusive lock files built on them (the server's
// pid file, a session host's lock, concurrency-slot leases). A bare pid isn't enough: after a reboot
// (or on a busy machine) another process gets the same pid and `kill(pid, 0)` says "alive" forever.
// A stamp adds the boot (Linux/macOS boot id, else boot time) and, where cheap (/proc), the process
// start time. Node-only; no vscode import.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

/** Who holds a lock or lease: pid plus what tells this process apart from a later one with the same pid. */
export interface ProcessStamp {
	pid: number;
	/** Boot time (epoch ms, rounded to seconds). */
	bootAt: number;
	/** Boot id (Linux, macOS): exact, unlike bootAt. */
	bootId?: string;
	/** Process start time in clock ticks since boot (Linux). */
	start?: string;
}

/**
 * Boot times derived from uptime move when the wall clock is stepped; within this they count as
 * the same boot (a boot shorter than this followed by pid reuse goes unnoticed where there's no boot id).
 */
const BOOT_TOLERANCE_MS = 10 * 60_000;
/** A lock file that is still unreadable (being written) after this long is garbage. */
const TORN_STALE_MS = 5000;

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err instanceof Error && "code" in err && err.code === "EPERM";
	}
}

function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function bootTime(): number {
	return Math.round((Date.now() - os.uptime() * 1000) / 1000) * 1000;
}

let bootIdCache: string | null | undefined;
/** Linux: /proc boot_id; macOS: kern.bootsessionuuid (one sysctl per process); elsewhere none. */
function bootId(): string | undefined {
	if (bootIdCache === undefined) {
		bootIdCache = null;
		try {
			if (process.platform === "linux") bootIdCache = readText("/proc/sys/kernel/random/boot_id")?.trim() || null;
			else if (process.platform === "darwin") bootIdCache = execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
		} catch {
			/* no boot id: boot time only */
		}
	}
	return bootIdCache ?? undefined;
}

/** Start time of `pid` (Linux /proc: field 22 of stat, after the parenthesized command name). */
function processStart(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	const stat = readText(`/proc/${pid}/stat`);
	if (!stat) return undefined;
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

export function processStamp(pid = process.pid): ProcessStamp {
	const stamp: ProcessStamp = { pid, bootAt: bootTime() };
	const id = bootId();
	if (id) stamp.bootId = id;
	const start = processStart(pid);
	if (start) stamp.start = start;
	return stamp;
}

/**
 * Whether the process a stamp (or a plain `{ pid }` record from older versions) describes still
 * runs: its pid is alive, in the same boot, and (where known) started at the same time.
 */
export function stampAlive(raw: unknown): boolean {
	const r = rec(raw);
	const pid = typeof r?.pid === "number" ? r.pid : 0;
	if (!pidAlive(pid)) return false;
	const id = bootId();
	if (typeof r?.bootId === "string" && id) {
		if (r.bootId !== id) return false;
	} else if (typeof r?.bootAt === "number" && Math.abs(r.bootAt - bootTime()) > BOOT_TOLERANCE_MS) return false;
	if (typeof r?.start === "string") {
		const start = processStart(pid);
		if (start !== undefined && start !== r.start) return false;
	}
	return true;
}

/** True when `at` (epoch ms) lies before this boot: whatever wrote it then has died since. */
export function beforeBoot(at: number): boolean {
	return at < bootTime() - BOOT_TOLERANCE_MS;
}

/** The parsed lock file (a bare pid from older versions reads as `{ pid }`); undefined when absent or unreadable. */
export function lockOwner(file: string): Record<string, unknown> | undefined {
	const text = readText(file)?.trim();
	if (text === undefined) return undefined;
	if (/^\d+$/.test(text)) return { pid: Number(text) };
	try {
		return rec(JSON.parse(text));
	} catch {
		return undefined;
	}
}

function isOurs(owner: Record<string, unknown> | undefined): boolean {
	return owner?.pid === process.pid && stampAlive(owner);
}

function unlink(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {
		/* already gone */
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Exclusive create of `file` holding `content`; false when it already exists. */
function createExclusive(file: string, content: string): boolean {
	let fd: number;
	try {
		fd = fs.openSync(file, "wx", 0o600);
	} catch (err) {
		if (rec(err)?.code === "EEXIST") return false;
		throw err;
	}
	try {
		fs.writeSync(fd, content);
	} finally {
		fs.closeSync(fd);
	}
	return true;
}

/** Stale: an owner that is gone (or that `stale` gives up on), or a file left torn by a crashed writer. */
function isStale(file: string, stale?: (owner: Record<string, unknown>) => boolean): boolean {
	const owner = lockOwner(file);
	if (owner) return !stampAlive(owner) || (stale?.(owner) ?? false);
	try {
		return Date.now() - fs.statSync(file).mtimeMs > TORN_STALE_MS;
	} catch {
		return false;
	}
}

/**
 * Takes `file` for this process (`{ ...processStamp(), ...extra }`). A lock whose owner is gone,
 * or that `stale(owner)` declares abandoned, is broken; breaking is serialized by `<file>.break`
 * and rechecked under it, so two processes that both found a stale lock can't both end up holding
 * it. True when we hold the lock (also when we already did).
 */
export function claimLock(file: string, extra: Record<string, unknown> = {}, stale?: (owner: Record<string, unknown>) => boolean): boolean {
	const content = JSON.stringify({ ...extra, ...processStamp() });
	for (let attempt = 0; attempt < 20; attempt++) {
		if (createExclusive(file, content)) return true;
		if (isOurs(lockOwner(file))) return true;
		if (!isStale(file, stale)) return false;
		const breakFile = `${file}.break`;
		if (!createExclusive(breakFile, String(process.pid))) {
			// Another claimant is breaking it right now (a crashed breaker's file goes stale in seconds).
			try {
				if (Date.now() - fs.statSync(breakFile).mtimeMs > TORN_STALE_MS) unlink(breakFile);
			} catch {
				/* released meanwhile */
			}
			sleepSync(25);
			continue;
		}
		try {
			if (isStale(file, stale)) unlink(file);
		} finally {
			unlink(breakFile);
		}
	}
	return false;
}

/** Removes `file` if this process holds it. */
export function releaseLock(file: string): void {
	if (lockOwner(file)?.pid === process.pid) unlink(file);
}

/** Whether `file` names this process (e.g. the server re-checking it still owns its pid file). */
export function holdsLock(file: string): boolean {
	return isOurs(lockOwner(file));
}
