import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { type ClientToHost, type FileChange, type HostToClient, type SessionMeta, type TaskQueue, sessionDir, sessionsRoot } from "../../../src/shared/protocol";

export function env(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not set; run via test/e2e-desktop/run.mjs`);
	return v;
}

/** Polls `fn` until it returns a truthy value; fails with `what` and the last value on timeout. */
export async function waitFor<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 20_000): Promise<NonNullable<T>> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (last) return last as NonNullable<T>;
		} catch (err) {
			lastErr = err;
		}
		await sleep(100);
	}
	throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last=${JSON.stringify(last)}${lastErr ? ` err=${String(lastErr)}` : ""}`);
}

export function readMeta(id: string): SessionMeta | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(sessionDir(id), "meta.json"), "utf8")) as SessionMeta;
	} catch {
		return undefined;
	}
}

export function readChanges(id: string): FileChange[] {
	let raw = "";
	try {
		raw = fs.readFileSync(path.join(sessionDir(id), "changes.jsonl"), "utf8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l) as FileChange);
}

/** The raw queue.json (undefined when absent/unparsable). */
export function readQueue(id: string): TaskQueue | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(sessionDir(id), "queue.json"), "utf8")) as TaskQueue;
	} catch {
		return undefined;
	}
}

/** Live (non-zombie) session host processes for `id`: `<host.js> --id <id> …` command lines. */
export function hostPids(id: string): number[] {
	const out: number[] = [];
	for (const line of ps(["-A", "-o", "pid=,stat=,command="]).split("\n")) {
		const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!m || m[2].startsWith("Z")) continue;
		const argv = m[3].split(" ");
		const i = argv.indexOf("--id");
		if (i > 0 && argv[i + 1] === id && argv.some(a => a.endsWith(`${path.sep}host.js`))) out.push(Number(m[1]));
	}
	return out;
}

export function sessionIds(): string[] {
	try {
		return fs.readdirSync(sessionsRoot());
	} catch {
		return [];
	}
}

export interface ProcStat {
	state: string;
	ppid: number;
	pgrp: number;
	/** Leads its own session (setsid). */
	sessionLeader: boolean;
}

/** `ps` (procps on Linux, BSD ps on macOS, which has no /proc); "" when it fails. */
function ps(args: string[]): string {
	const r = spawnSync("ps", ["-ww", ...args], { encoding: "utf8" });
	return r.status === 0 ? r.stdout : "";
}

/** State, parent, process group and session leadership of `pid`; undefined when it is gone. */
export function procStat(pid: number): ProcStat | undefined {
	const f = ps(["-o", "stat=,ppid=,pgid=", "-p", String(pid)]).trim().split(/\s+/);
	if (f.length < 3) return undefined;
	// STAT's "s" flag marks a session leader in both procps and BSD ps (macOS prints 0 for `sess`).
	return { state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]), sessionLeader: f[0].includes("s") };
}

/** Alive and not a zombie. */
export function pidAlive(pid: number | undefined): boolean {
	if (typeof pid !== "number") return false;
	const st = procStat(pid);
	return !!st && !st.state.startsWith("Z");
}

/** pid's ancestors up to init, nearest first. */
export function ancestors(pid: number): number[] {
	const out: number[] = [];
	let cur = procStat(pid)?.ppid;
	while (cur && cur > 0 && out.length < 64) {
		out.push(cur);
		cur = procStat(cur)?.ppid;
	}
	return out;
}

/** Minimal JSONL client for a session host's Unix socket. */
export class HostClient {
	private readonly backlog: HostToClient[] = [];
	private readonly waiters: { pred: (m: HostToClient) => boolean; resolve: (m: HostToClient) => void }[] = [];
	readonly received: HostToClient[] = [];

	private constructor(private readonly sock: net.Socket) {
		const rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
		// readline re-emits socket errors; without a listener they become uncaught in the extension host.
		rl.on("error", () => {});
		sock.on("error", () => {});
		rl.on("line", line => {
			if (!line.trim()) return;
			const msg = JSON.parse(line) as HostToClient;
			this.received.push(msg);
			const i = this.waiters.findIndex(w => w.pred(msg));
			if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
			else this.backlog.push(msg);
		});
	}

	static async connect(socket: string, name: string): Promise<{ client: HostClient; snapshot: Extract<HostToClient, { t: "snapshot" }> }> {
		const sock = net.createConnection(socket);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		sock.once("connect", () => resolve());
		sock.once("error", reject);
		await promise;
		const client = new HostClient(sock);
		client.send({ t: "hello", client: name });
		const snapshot = await client.next("snapshot", m => m.t === "snapshot", 10_000);
		return { client, snapshot: snapshot as Extract<HostToClient, { t: "snapshot" }> };
	}

	send(msg: ClientToHost): void {
		this.sock.write(`${JSON.stringify(msg)}\n`);
	}

	/** Next message matching `pred` (including ones already received but not consumed). */
	next(what: string, pred: (m: HostToClient) => boolean, timeoutMs = 20_000): Promise<HostToClient> {
		const i = this.backlog.findIndex(pred);
		if (i >= 0) return Promise.resolve(this.backlog.splice(i, 1)[0]);
		const { promise, resolve, reject } = Promise.withResolvers<HostToClient>();
		const waiter = { pred, resolve };
		this.waiters.push(waiter);
		setTimeout(() => {
			const j = this.waiters.indexOf(waiter);
			if (j < 0) return;
			this.waiters.splice(j, 1);
			reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
		}, timeoutMs);
		return promise;
	}

	close(): void {
		this.sock.end();
	}
}
