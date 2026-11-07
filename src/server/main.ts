// omp-vs server: a per-user daemon (one per state root) that
//  - answers the CLI / extension over `serverSocketPath()` (see server-protocol.ts),
//  - launches stopped sessions whose queue has runnable work when a concurrency slot is free
//    (priority + manual order; also recovers queued work after a reboot),
//  - stops sessions it launched once their queue is done and nobody is looking at them,
//  - backs off from sessions that keep dying right after launch.
// Sessions never depend on it: hosts run on their own and gate tasks through the slot files.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as readline from "node:readline";
import { Control, hasRunnableWork, planLaunches, readListContext, sessionInfos } from "../shared/control";
import { HostConnection } from "../shared/host-conn";
import { type HostLauncher, findOmp, launchHost, pidAlive, readHostVersion, readLauncherSettings } from "../shared/launch";
import { schedulingOrder } from "../shared/organize";
import { sessionsRoot, stateRoot } from "../shared/protocol";
import { listLeases, readScheduler, schedulerPath, slotsDir } from "../shared/scheduler";
import { type OpName, type ServerEvent, type ServerOps, type ServerRequest, type ServerResponse, serverLogPath, serverPidPath, serverSocketPath } from "../shared/server-protocol";

const HOST_SCRIPT = path.join(__dirname, "host.js");
const VERSION = readHostVersion(HOST_SCRIPT);
const STARTED_AT = Date.now();
const IS_WINDOWS = process.platform === "win32";

/** Scheduling pass interval; file watchers trigger passes sooner. */
const TICK_MS = 2000;
/** A launched host that neither took a slot nor started waiting by then is no longer "launching". */
const LAUNCH_TIMEOUT_MS = 60_000;
/** A launched session that stops again within this window (work still queued) counts as a failed launch. */
const QUICK_EXIT_MS = 3 * 60_000;
/** Done + idle this long before a scheduler-launched session is stopped. */
const DONE_GRACE_MS = Number(process.env.OMP_VS_DONE_GRACE_MS) || 60_000;
/** No auto-stop while a person interacted with the session this recently. */
const USER_GRACE_MS = 10 * 60_000;
const MAX_LAUNCHES_PER_PASS = 4;
const MAX_LOG_BYTES = 1024 * 1024;

// ---------- logging ----------

function openLog(): void {
	try {
		fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
		if (fs.statSync(serverLogPath()).size > MAX_LOG_BYTES) fs.renameSync(serverLogPath(), `${serverLogPath()}.1`);
	} catch {
		/* no log yet */
	}
}

function log(...parts: unknown[]): void {
	const line = `[${new Date().toISOString()}] ${parts.map(p => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
	try {
		fs.appendFileSync(serverLogPath(), line);
	} catch {
		/* state dir gone */
	}
	if (process.env.OMP_VS_SERVER_STDERR) process.stderr.write(line);
}

// ---------- single instance ----------

/** Takes the pid file; false when another live server owns it. */
function claimPidFile(): boolean {
	const file = serverPidPath();
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
			return true;
		} catch (err) {
			if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") throw err;
		}
		const owner = Number(fs.readFileSync(file, "utf8").trim());
		if (owner && owner !== process.pid && pidAlive(owner)) return false;
		fs.rmSync(file, { force: true });
	}
	return false;
}

function releasePidFile(): void {
	try {
		if (Number(fs.readFileSync(serverPidPath(), "utf8").trim()) === process.pid) fs.rmSync(serverPidPath(), { force: true });
	} catch {
		/* gone */
	}
}

// ---------- launching ----------

function launcher(): HostLauncher {
	const settings = readLauncherSettings();
	const omp = findOmp(settings.ompPath);
	if (!omp) throw new Error("could not find the omp executable (install omp, or set omp.path in VS Code)");
	return {
		hostScript: HOST_SCRIPT,
		omp,
		hostVersion: VERSION,
		extraArgs: settings.extraArgs ?? [],
		nodePath: process.execPath,
		onError: err => log("host spawn failed", err.message),
	};
}

interface Backoff {
	failures: number;
	until: number;
}

const launching = new Map<string, number>();
/** Launch time of sessions the server started recently (quick-exit detection). */
const recentLaunches = new Map<string, number>();
const backoff = new Map<string, Backoff>();
const doneSince = new Map<string, number>();
const stopping = new Set<string>();
let launcherError: { message: string; at: number } | undefined;

function blocked(id: string): boolean {
	return (backoff.get(id)?.until ?? 0) > Date.now();
}

function launchFailed(id: string, why: string): void {
	const prev = backoff.get(id);
	const failures = (prev?.failures ?? 0) + 1;
	const delay = Math.min(30 * 60_000, 60_000 * 2 ** (failures - 1));
	backoff.set(id, { failures, until: Date.now() + delay });
	log("launch failed", id, why, `retry in ${Math.round(delay / 60_000)} min`);
}

const control = new Control({
	launcher,
	serverUp: () => true,
	clientName: "omp-vs-server",
	blocked,
	changed: () => scheduleTick(50),
});

// ---------- scheduling pass ----------

let tickTimer: NodeJS.Timeout | undefined;
let ticking = false;
let lastList = "";

let tickDue = 0;

/** Runs a pass within `delay` ms; an already scheduled earlier pass is kept (events can't starve it). */
function scheduleTick(delay = 300): void {
	const due = Date.now() + delay;
	if (tickTimer && tickDue <= due) return;
	if (tickTimer) clearTimeout(tickTimer);
	tickDue = due;
	tickTimer = setTimeout(() => {
		tickTimer = undefined;
		void tick();
	}, delay);
}

async function tick(): Promise<void> {
	if (ticking) {
		scheduleTick(200);
		return;
	}
	ticking = true;
	try {
		pass();
	} catch (err) {
		log("scheduling pass failed", String(err));
	} finally {
		ticking = false;
		publishSessions();
		scheduleTick(TICK_MS);
	}
}

function pass(): void {
	const now = Date.now();
	const ctx = readListContext(blocked, now);
	const metas = new Map(ctx.metas.map(m => [m.id, m]));
	const leases = listLeases();
	const leased = new Set(leases.map(l => l.sessionId));
	const waiting = new Set(ctx.waiters.map(w => w.sessionId));

	// Settle launches: the host took a slot / started waiting / ran a task, gave up, or timed out.
	for (const [id, at] of launching) {
		const meta = metas.get(id);
		const queue = ctx.queues.get(id);
		if (!meta) launching.delete(id);
		else if (meta.status !== "stopped" && (leased.has(id) || waiting.has(id) || (queue && !hasRunnableWork(queue, now)))) launching.delete(id);
		else if (meta.status === "stopped" && meta.updatedAt > at && meta.pid !== 0) launching.delete(id);
		else if (now - at > LAUNCH_TIMEOUT_MS) {
			launching.delete(id);
			if (meta.status === "stopped") launchFailed(id, "the host did not start");
		}
	}
	for (const [id, at] of recentLaunches) {
		const meta = metas.get(id);
		const queue = ctx.queues.get(id);
		if (!meta || now - at > QUICK_EXIT_MS) recentLaunches.delete(id);
		else if (leased.has(id) || !queue || queue.tasks.some(t => t.status === "running") || !hasRunnableWork(queue, now)) {
			// A task got going (or the work is gone): the session works; forget earlier failures.
			recentLaunches.delete(id);
			backoff.delete(id);
		} else if (meta.status === "stopped" && meta.updatedAt > at && !launching.has(id)) {
			recentLaunches.delete(id);
			launchFailed(id, meta.authProblem ? `omp cannot use a model: ${meta.authProblem}` : (meta.exitReason ?? "stopped right after launch"));
		}
	}

	const cfg = readScheduler();
	const plan = planLaunches({
		candidates: ctx.launches.filter(id => !launching.has(id)),
		waiters: ctx.waiters.map(w => w.sessionId),
		order: ids => schedulingOrder(ctx.org, ids),
		maxConcurrent: cfg.maxConcurrent,
		paused: cfg.paused,
		running: leases.length,
		launching: launching.size,
		maxPerPass: MAX_LAUNCHES_PER_PASS,
	});
	if (plan.length && !(launcherError && now - launcherError.at < 60_000)) {
		let l: HostLauncher | undefined;
		try {
			l = launcher();
			launcherError = undefined;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (launcherError?.message !== message) log(message);
			launcherError = { message, at: now };
		}
		for (const id of l ? plan : []) {
			const meta = metas.get(id);
			if (!meta || !l) continue;
			try {
				launchHost(l, { cwd: meta.cwd, id, launchedBy: "scheduler" });
				launching.set(id, now);
				recentLaunches.set(id, now);
				log("launched", id, JSON.stringify(meta.title));
			} catch (err) {
				launchFailed(id, String(err));
			}
		}
	}

	// Stop sessions the scheduler launched once their queue is done and nobody uses them.
	if (cfg.stopWhenQueueDone === false) {
		doneSince.clear();
		return;
	}
	for (const meta of ctx.metas) {
		const queue = ctx.queues.get(meta.id);
		const done =
			meta.launchedBy === "scheduler" &&
			meta.status === "idle" &&
			!meta.viewers &&
			!launching.has(meta.id) &&
			!leased.has(meta.id) &&
			!waiting.has(meta.id) &&
			!!queue &&
			!queue.tasks.some(t => t.status === "running") &&
			!hasRunnableWork(queue, now) &&
			now - (meta.userActiveAt ?? 0) > USER_GRACE_MS;
		if (!done) {
			doneSince.delete(meta.id);
			continue;
		}
		const since = doneSince.get(meta.id) ?? now;
		doneSince.set(meta.id, since);
		if (now - since < DONE_GRACE_MS || stopping.has(meta.id)) continue;
		stopping.add(meta.id);
		log("queue done, stopping", meta.id, JSON.stringify(meta.title));
		void control
			.stop({ id: meta.id })
			.catch(err => log("stop failed", meta.id, String(err)))
			.finally(() => {
				stopping.delete(meta.id);
				doneSince.delete(meta.id);
			});
	}
}

// ---------- clients ----------

interface Client {
	sock: net.Socket;
	/** subscribe-sessions request ids. */
	sessionSubs: Set<number>;
	/** subscribe-events request id → host connection. */
	eventSubs: Map<number, HostConnection>;
}

const clients = new Set<Client>();

function sendLine(c: Client, msg: ServerResponse | ServerEvent): void {
	if (!c.sock.destroyed) c.sock.write(`${JSON.stringify(msg)}\n`);
}

function publishSessions(force?: Client): void {
	const subs = [...clients].filter(c => c.sessionSubs.size > 0);
	if (subs.length === 0) return;
	const sessions = sessionInfos(readListContext(blocked), true);
	const json = JSON.stringify(sessions);
	if (json === lastList && !force) return;
	lastList = json;
	for (const c of force ? [force] : subs) for (const id of c.sessionSubs) sendLine(c, { id, event: "sessions", sessions });
}

type Handler<K extends OpName> = (args: ServerOps[K]["args"]) => ServerOps[K]["result"] | Promise<ServerOps[K]["result"]>;

const handlers: { [K in OpName]: Handler<K> } = {
	ping: () => ({ pid: process.pid, version: VERSION, root: stateRoot(), startedAt: STARTED_AT }),
	list: args => control.list(args),
	create: args => control.create(args),
	stop: args => control.stop(args),
	resume: args => {
		backoff.delete(args.id);
		return control.resume(args);
	},
	remove: args => control.remove(args),
	prompt: args => control.prompt(args),
	abort: args => control.abort(args),
	getQueue: args => control.getQueue(args),
	queue: args => {
		backoff.delete(args.id);
		return control.queue(args);
	},
	organize: args => control.organize(args),
	scheduler: args => control.scheduler(args),
	shutdown: () => {
		setTimeout(() => shutdown("shutdown request"), 50);
		return {};
	},
};

function isOp(op: string): op is OpName {
	return Object.hasOwn(handlers, op);
}

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function onRequest(c: Client, req: ServerRequest): Promise<void> {
	const { id, op } = req;
	try {
		if (op === "subscribe") {
			const args = rec(req.args);
			if (args.topic === "sessions") {
				c.sessionSubs.add(id);
				sendLine(c, { id, ok: true, result: {} });
				publishSessions(c);
				return;
			}
			if (args.topic === "events" && typeof args.id === "string") {
				const meta = control.list({ all: true }).find(s => s.meta.id === args.id)?.meta;
				if (!meta || meta.status === "stopped") throw new Error(`session ${String(args.id)} is not running`);
				const { conn, snapshot } = await HostConnection.open(meta.socket, "omp-vs-proxy");
				c.eventSubs.set(id, conn);
				sendLine(c, { id, ok: true, result: {} });
				sendLine(c, { id, event: "host", msg: snapshot });
				conn.onMessage(msg => sendLine(c, { id, event: "host", msg }));
				conn.onClose(() => {
					c.eventSubs.delete(id);
					sendLine(c, { id, event: "end", reason: "session host closed" });
				});
				return;
			}
			throw new Error("unknown subscription");
		}
		if (!isOp(op)) throw new Error(`unknown operation ${String(op)}`);
		const handler: (args: unknown) => unknown = handlers[op] as (args: unknown) => unknown;
		const result = await handler(rec(req.args));
		sendLine(c, { id, ok: true, result });
	} catch (err) {
		sendLine(c, { id, ok: false, error: err instanceof Error ? err.message : String(err) });
	}
}

const server = net.createServer(sock => {
	const c: Client = { sock, sessionSubs: new Set(), eventSubs: new Map() };
	clients.add(c);
	const rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
	rl.on("error", () => {});
	rl.on("line", line => {
		if (!line.trim()) return;
		let req: ServerRequest;
		try {
			req = JSON.parse(line) as ServerRequest;
		} catch {
			return;
		}
		if (typeof req.id !== "number" || typeof req.op !== "string") return;
		void onRequest(c, req);
	});
	const drop = () => {
		if (!clients.delete(c)) return;
		for (const conn of c.eventSubs.values()) conn.close();
	};
	sock.on("close", drop);
	sock.on("error", drop);
});

// ---------- watching ----------

const watchers: fs.FSWatcher[] = [];

function watch(target: string, recursive: boolean): void {
	try {
		fs.mkdirSync(target, { recursive: true, mode: 0o700 });
		const w = fs.watch(target, { recursive, persistent: false }, () => scheduleTick());
		w.on("error", () => {});
		watchers.push(w);
	} catch {
		/* polling (TICK_MS) covers it */
	}
}

// ---------- lifecycle ----------

let finished = false;

function shutdown(reason: string): void {
	if (finished) return;
	finished = true;
	log("server stopping:", reason);
	clearTimeout(tickTimer);
	for (const w of watchers) w.close();
	for (const c of clients) {
		for (const conn of c.eventSubs.values()) conn.close();
		c.sock.destroy();
	}
	server.close();
	if (!IS_WINDOWS) fs.rmSync(serverSocketPath(), { force: true });
	releasePidFile();
	process.exit(0);
}

function main(): void {
	openLog();
	if (!claimPidFile()) {
		log("another server is running; exiting", process.pid);
		process.exit(0);
	}
	const socket = serverSocketPath();
	if (!IS_WINDOWS) {
		fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
		fs.rmSync(socket, { force: true });
	}
	server.on("error", err => {
		log("socket error", String(err));
		releasePidFile();
		process.exit(1);
	});
	server.listen(socket, () => {
		if (!IS_WINDOWS) fs.chmodSync(socket, 0o600);
		log("server started", { pid: process.pid, version: VERSION, root: stateRoot(), node: process.version });
		watch(sessionsRoot(), true);
		watch(slotsDir(), true);
		watch(path.dirname(schedulerPath()), false);
		scheduleTick(0);
	});
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGHUP", () => shutdown("SIGHUP"));
	process.on("uncaughtException", err => log("uncaught", err.stack ?? String(err)));
	process.on("unhandledRejection", err => log("unhandled rejection", String(err)));
}

main();
