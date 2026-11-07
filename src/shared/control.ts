// Session operations behind the omp-vs server and CLI (the CLI runs them in-process when no
// server is up), plus the pure planning the server's scheduler uses. Node-only; no vscode.
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HostConnection, isBusy } from "./host-conn";
import { type HostLauncher, canConnect, launchHost, listMetas, newSessionId, readMeta, sendToHost } from "./launch";
import { type OrgData, OrganizeStore, readOrgFile, schedulingOrder } from "./organize";
import { type QueueOp, type SessionMeta, type TaskQueue, sessionDir } from "./protocol";
import { applyQueueOps, queueSummary, readQueueFile, writeQueueFile } from "./queue";
import { type SlotWaiter, listLeases, listWaiting, readScheduler, writeScheduler } from "./scheduler";
import type { Column, CreateArgs, OrganizeAction, SchedulerStatus, ServerOps, SessionInfo } from "./server-protocol";
import { newSessionLaunch, writeSessionToggles } from "./session-config";

// ---------- pure planning ----------

export function queueFilePath(id: string): string {
	return path.join(sessionDir(id), "queue.json");
}

/**
 * The queue would start a task if the session were running: a pending task, nothing marked
 * running (a host crash leaves that behind; the user decides whether to rerun it), and auto-run
 * on or a scheduled start that is due.
 */
export function hasRunnableWork(q: TaskQueue, now = Date.now()): boolean {
	if (q.tasks.some(t => t.status === "running")) return false;
	if (!q.tasks.some(t => t.status === "pending")) return false;
	return q.autoRun || (q.startAt !== undefined && q.startAt <= now);
}

/** Pending work that will become runnable (auto-run, or a scheduled start at any time). */
export function hasQueuedWork(q: TaskQueue): boolean {
	return q.tasks.some(t => t.status === "pending") && (q.autoRun || q.startAt !== undefined);
}

export function sessionColumn(meta: SessionMeta, waiting: boolean): Column {
	if (meta.status === "stopped") return waiting ? "waiting" : "stopped";
	if (meta.status === "waiting") return "input";
	if (waiting) return "waiting";
	return meta.status === "idle" ? "idle" : "working";
}

/** Keeps every id of `ids` exactly once, in `order`'s ranking (ordering functions may drop/invent ids). */
export function rankIds(ids: readonly string[], order: (ids: string[]) => string[]): string[] {
	const set = new Set(ids);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of [...order([...set]), ...set]) {
		if (!set.has(id) || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

export interface LaunchPlanInput {
	/** Stopped sessions with runnable work that may be launched (eligible, not backing off). */
	candidates: readonly string[];
	/** Running hosts already waiting for a slot: they compete with candidates for free slots. */
	waiters: readonly string[];
	order: (ids: string[]) => string[];
	maxConcurrent: number;
	paused?: boolean;
	/** Live slot leases. */
	running: number;
	/** Hosts launched by the server that have neither taken a slot nor started waiting yet. */
	launching: number;
	/** Cap per scheduling pass (spreads omp start-up load when the limit is unlimited). */
	maxPerPass: number;
}

/**
 * Which candidates to launch now: waiters and candidates are ranked together (priority, manual
 * order), and only candidates ranked within the free slots start, so a launched session takes the
 * next slot instead of waiting behind or ahead of the wrong session.
 */
export function planLaunches(input: LaunchPlanInput): string[] {
	if (input.paused || input.candidates.length === 0) return [];
	const free = input.maxConcurrent === 0 ? Number.POSITIVE_INFINITY : input.maxConcurrent - input.running - input.launching;
	if (free <= 0) return [];
	const candidates = new Set(input.candidates);
	const ranked = rankIds([...input.waiters, ...input.candidates], input.order);
	const out: string[] = [];
	for (let i = 0; i < ranked.length && i < free && out.length < input.maxPerPass; i++) if (candidates.has(ranked[i])) out.push(ranked[i]);
	return out;
}

/** Stopped sessions with runnable queued work, in start order (what the server launches next). */
export function launchQueue(metas: readonly SessionMeta[], queues: ReadonlyMap<string, TaskQueue>, org: OrgData, now = Date.now(), blocked: (id: string) => boolean = () => false): string[] {
	const ids = metas
		.filter(m => {
			const q = queues.get(m.id);
			return m.status === "stopped" && q && hasRunnableWork(q, now) && !org.sessions[m.id]?.archived && !blocked(m.id) && isDirectory(m.cwd);
		})
		.map(m => m.id);
	return schedulingOrder(org, ids);
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves what a user typed to one session: `.` (latest session for the current folder), an
 * exact id, a unique id prefix, or a unique case-insensitive title substring.
 */
export function resolveSession(query: string, metas: readonly SessionMeta[], cwd: string): { id: string } | { error: string } {
	const q = query.trim();
	if (!q) return { error: "no session given" };
	const newestFirst = [...metas].sort((a, b) => (a.status === "stopped" ? 1 : 0) - (b.status === "stopped" ? 1 : 0) || b.updatedAt - a.updatedAt);
	if (q === ".") {
		const here = newestFirst.find(m => isWithin(cwd, m.cwd) || isWithin(m.cwd, cwd));
		return here ? { id: here.id } : { error: `no session for ${cwd}` };
	}
	const exact = metas.find(m => m.id === q);
	if (exact) return { id: exact.id };
	const describe = (ms: SessionMeta[]) =>
		ms
			.slice(0, 6)
			.map(m => `${m.id.slice(0, 8)} ${m.title}`)
			.join(", ");
	const byPrefix = newestFirst.filter(m => m.id.startsWith(q));
	if (byPrefix.length === 1) return { id: byPrefix[0].id };
	if (byPrefix.length > 1) return { error: `"${q}" matches ${byPrefix.length} sessions: ${describe(byPrefix)}` };
	const needle = q.toLowerCase();
	const byTitle = newestFirst.filter(m => m.title.toLowerCase().includes(needle));
	if (byTitle.length === 1) return { id: byTitle[0].id };
	const exactTitle = byTitle.filter(m => m.title.toLowerCase() === needle);
	if (exactTitle.length === 1) return { id: exactTitle[0].id };
	if (byTitle.length > 1) return { error: `"${q}" matches ${byTitle.length} sessions: ${describe(byTitle)}` };
	return { error: `no session matches "${q}"` };
}

/** Title for a session created from a task or prompt: its first line, shortened. */
export function titleFrom(text: string): string {
	const line = text.split("\n")[0].trim();
	return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New session";
}

// ---------- listing ----------

export interface ListContext {
	metas: SessionMeta[];
	queues: Map<string, TaskQueue>;
	org: OrgData;
	waiters: SlotWaiter[];
	/** Stopped sessions waiting to be launched, in start order. */
	launches: string[];
}

export function readListContext(blocked?: (id: string) => boolean, now = Date.now()): ListContext {
	const metas = listMetas();
	const queues = new Map(metas.map(m => [m.id, readQueueFile(queueFilePath(m.id))]));
	const org = readOrgFile();
	return { metas, queues, org, waiters: listWaiting(), launches: launchQueue(metas, queues, org, now, blocked) };
}

export function sessionInfos(ctx: ListContext, all = false): SessionInfo[] {
	const { metas, queues, org, waiters, launches } = ctx;
	const order = schedulingOrder(
		org,
		metas.map(m => m.id),
	);
	const orderIndex = new Map(order.map((id, i) => [id, i]));
	const waiterSince = new Map(waiters.map(w => [w.sessionId, w.since]));
	const launchSet = new Set(launches);
	const waitRank = rankIds([...waiters.map(w => w.sessionId), ...launches], ids => schedulingOrder(org, ids));
	const waitPos = new Map(waitRank.map((id, i) => [id, i + 1]));
	const out: SessionInfo[] = [];
	for (const meta of metas) {
		const e = org.sessions[meta.id];
		if (!all && e?.archived) continue;
		const queue = queues.get(meta.id);
		const summary = queue ? queueSummary(queue) : (meta.queue ?? { pending: 0, running: 0, done: 0, total: 0, autoRun: false });
		const slotWaiting = meta.status !== "stopped" && waiterSince.has(meta.id);
		const launchWaiting = meta.status === "stopped" && launchSet.has(meta.id);
		const position = waitPos.get(meta.id);
		const info: SessionInfo = {
			meta,
			column: sessionColumn(meta, slotWaiting || launchWaiting),
			queue: summary,
			priority: e?.priority ?? "normal",
			order: orderIndex.get(meta.id) ?? order.length,
		};
		if (e?.groupId) {
			const g = org.groups.find(x => x.id === e.groupId);
			if (g) info.group = g.name;
		}
		if (e?.color) info.color = e.color;
		if (e?.archived) info.archived = true;
		if ((slotWaiting || launchWaiting) && position) info.waiting = { position, ...(slotWaiting ? { since: waiterSince.get(meta.id) } : { launch: true }) };
		out.push(info);
	}
	return out.sort((a, b) => (a.meta.status === "stopped" ? 1 : 0) - (b.meta.status === "stopped" ? 1 : 0) || b.meta.updatedAt - a.meta.updatedAt);
}

// ---------- operations ----------

export interface ControlEnv {
	/** How to start hosts; throws when omp cannot be found. */
	launcher(): HostLauncher;
	/** A server launches queued sessions (queue-only `create` then waits for it). */
	serverUp(): boolean;
	/** Name used when connecting to hosts (`omp-vs-server…` doesn't count as a viewer). */
	clientName: string;
	/** Sessions the server is backing off from (crash loops). */
	blocked?(id: string): boolean;
	/** State changed: re-plan / notify subscribers soon. */
	changed?(): void;
}

type Result<K extends keyof ServerOps> = ServerOps[K]["result"];

export class Control {
	constructor(private readonly env: ControlEnv) {}

	private meta(id: string): SessionMeta {
		const meta = readMeta(id);
		if (!meta) throw new Error(`unknown session ${id}`);
		return meta;
	}

	list(args: { all?: boolean }): Result<"list"> {
		return sessionInfos(readListContext(this.env.blocked), args.all);
	}

	scheduler(args: ServerOps["scheduler"]["args"]): Result<"scheduler"> {
		if (args.set) {
			writeScheduler({ ...readScheduler(), ...args.set });
			this.env.changed?.();
		}
		const ctx = readListContext(this.env.blocked);
		const status: SchedulerStatus = {
			...readScheduler(),
			running: listLeases().length,
			waiting: ctx.waiters.length + ctx.launches.length,
			server: this.env.serverUp(),
		};
		return status;
	}

	async create(args: CreateArgs): Promise<Result<"create">> {
		const cwd = path.resolve(args.cwd);
		if (!isDirectory(cwd)) throw new Error(`not a folder: ${cwd}`);
		if (args.prompt && args.task) throw new Error("give either a prompt or a task, not both");
		const launcher = this.env.launcher();
		const defaults = newSessionLaunch(cwd, launcher.extraArgs);
		const ompArgs = [...(args.ompArgs ?? defaults.ompArgs), ...(args.model ? ["--model", args.model] : [])];
		const toggles = args.ompArgs ? undefined : defaults.toggles;
		const org = new OrganizeStore();
		if (args.task) {
			// Queue-only: a stopped session whose queue holds the task; whoever launches it (the
			// server's scheduler, or us right away) resumes it with these arguments.
			const id = newSessionId();
			const now = Date.now();
			fs.mkdirSync(sessionDir(id), { recursive: true, mode: 0o700 });
			fs.writeFileSync(path.join(sessionDir(id), "launch.json"), JSON.stringify({ ompArgs }));
			if (toggles) writeSessionToggles(id, toggles);
			const queue = applyQueueOps({ tasks: [], autoRun: true }, [{ op: "add", title: args.task, subtasks: args.subtasks }], now);
			writeQueueFile(queueFilePath(id), queue);
			const meta: SessionMeta = {
				id,
				cwd,
				title: args.title || titleFrom(args.task),
				status: "stopped",
				pid: 0,
				socket: "",
				createdAt: now,
				updatedAt: now,
				changedFiles: 0,
				queue: queueSummary(queue),
				exitReason: "queued",
			};
			writeMetaFile(id, meta);
			if (args.priority) org.setPriority([id], args.priority);
			if (this.env.serverUp()) {
				this.env.changed?.();
				return { id, started: false };
			}
			launchHost(launcher, { cwd, id });
			return { id, started: true };
		}
		const id = launchHost(launcher, { cwd, title: args.title, ompArgs, toggles });
		if (args.priority) org.setPriority([id], args.priority);
		this.env.changed?.();
		if (args.prompt) {
			if (!(await waitForHost(id))) throw new Error(`session ${id} did not start (see omp-vs tail ${id.slice(0, 8)})`);
			await this.prompt({ id, text: args.prompt });
		}
		return { id, started: true };
	}

	resume(args: { id: string }): Result<"resume"> {
		const meta = this.meta(args.id);
		if (meta.status !== "stopped") return { started: false };
		if (!isDirectory(meta.cwd)) throw new Error(`the session's folder no longer exists: ${meta.cwd}`);
		launchHost(this.env.launcher(), { cwd: meta.cwd, id: meta.id });
		this.env.changed?.();
		return { started: true };
	}

	async stop(args: { id: string }): Promise<Result<"stop">> {
		const meta = this.meta(args.id);
		if (meta.status === "stopped") return { stopped: false };
		await sendToHost(meta, { t: "stop" });
		// The host aborts omp, then SIGTERMs (6 s) / SIGKILLs (10 s) it before exiting.
		if (!(await waitForStatus(meta.id, m => m.status === "stopped", 12_000))) {
			try {
				process.kill(meta.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
			await waitForStatus(meta.id, m => m.status === "stopped", 3000);
		}
		this.env.changed?.();
		return { stopped: true };
	}

	async remove(args: { id: string }): Promise<Result<"remove">> {
		const meta = this.meta(args.id);
		if (meta.status !== "stopped") await this.stop(args);
		fs.rmSync(sessionDir(meta.id), { recursive: true, force: true });
		const org = new OrganizeStore();
		if (org.data.sessions[meta.id]) org.cleanup(id => id !== meta.id);
		this.env.changed?.();
		return {};
	}

	/** Sends a prompt; a stopped session is resumed first. Busy omp gets it as steer/follow-up. */
	async prompt(args: ServerOps["prompt"]["args"]): Promise<Result<"prompt">> {
		let meta = this.meta(args.id);
		if (meta.status === "stopped") {
			this.resume({ id: meta.id });
			if (!(await waitForHost(meta.id))) throw new Error(`session ${meta.id} did not start`);
			meta = this.meta(meta.id);
		}
		const { conn, snapshot } = await HostConnection.open(meta.socket, this.env.clientName);
		try {
			const busy = isBusy(snapshot.meta, snapshot.state);
			const res = await conn.rpc({ type: "prompt", message: args.text, ...(busy ? { streamingBehavior: args.mode ?? "steer" } : {}) });
			if (!res.success) throw new Error(String(res.error ?? "omp rejected the prompt"));
			return { sent: true };
		} finally {
			conn.close();
		}
	}

	async abort(args: { id: string }): Promise<Result<"abort">> {
		const meta = this.meta(args.id);
		if (meta.status === "stopped") return { sent: false };
		const { conn } = await HostConnection.open(meta.socket, this.env.clientName);
		try {
			const res = await conn.rpc({ type: "abort" }, 10_000);
			return { sent: res.success === true };
		} finally {
			conn.close();
		}
	}

	getQueue(args: { id: string }): Result<"getQueue"> {
		this.meta(args.id);
		return readQueueFile(queueFilePath(args.id));
	}

	/** Edits the queue through the host when it runs (so it dispatches), else on disk. */
	async queue(args: { id: string; ops: QueueOp[] }): Promise<Result<"queue">> {
		const meta = this.meta(args.id);
		const file = queueFilePath(meta.id);
		if (meta.status !== "stopped" && (await sendToHost(meta, { t: "queue", ops: args.ops }))) {
			// The host applies and saves asynchronously; give it a moment so the answer is current.
			const before = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
			for (let i = 0; i < 20 && (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0) === before; i++) await sleep(50);
			this.env.changed?.();
			return readQueueFile(file);
		}
		const next = applyQueueOps(readQueueFile(file), args.ops);
		writeQueueFile(file, next);
		const onDisk = readMeta(meta.id);
		if (onDisk) writeMetaFile(meta.id, { ...onDisk, queue: queueSummary(next), updatedAt: Date.now() });
		this.env.changed?.();
		return next;
	}

	organize(args: { id: string } & OrganizeAction): Result<"organize"> {
		const metas = listMetas();
		const meta = this.meta(args.id);
		const created = new Map(metas.map(m => [m.id, m.createdAt]));
		const store = new OrganizeStore(undefined, id => created.get(id));
		const before = JSON.stringify(store.session(meta.id));
		const ids = [meta.id];
		const siblings = () => store.groupSiblings(meta.id, [...created.keys()]);
		switch (args.action) {
			case "priority":
				store.setPriority(ids, args.priority);
				break;
			case "up":
				store.move(meta.id, -1, siblings());
				break;
			case "down":
				store.move(meta.id, 1, siblings());
				break;
			case "top":
				store.moveToTop(ids, siblings());
				break;
			case "bottom": {
				const list = siblings();
				store.place(ids, list, list.length - 1);
				break;
			}
			case "color":
				store.setColor(ids, args.color ?? undefined);
				break;
			case "group": {
				if (args.name === null) {
					store.setGroup(ids, undefined);
					break;
				}
				const name = args.name.trim();
				if (!name) throw new Error("group name is empty");
				const group = store.data.groups.find(g => g.name.toLowerCase() === name.toLowerCase()) ?? store.createGroup({ name });
				store.setGroup(ids, group.id);
				break;
			}
			case "archive":
				store.setArchived(ids, args.value);
				break;
		}
		const changed = JSON.stringify(store.session(meta.id)) !== before;
		if (changed) this.env.changed?.();
		return { changed };
	}
}

// ---------- disk + host helpers ----------

/** Atomic meta.json write (only for stopped sessions: a running host owns its meta). */
export function writeMetaFile(id: string, meta: SessionMeta): void {
	const file = path.join(sessionDir(id), "meta.json");
	const tmp = `${file}.ctl.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(meta, null, 1));
	fs.renameSync(tmp, file);
}

export async function waitForStatus(id: string, ok: (m: SessionMeta) => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const m = readMeta(id);
		if (m && ok(m)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(150);
	}
}

/** Waits until a just-launched host accepts connections; false when it gave up or timed out. */
export async function waitForHost(id: string, timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	// The stopped meta from before the launch; a different stopped meta means the new host gave up.
	const before = readMeta(id);
	const stale = before?.status === "stopped" ? `${before.pid}:${before.updatedAt}` : undefined;
	while (Date.now() < deadline) {
		const meta = readMeta(id);
		if (meta?.status === "stopped" && `${meta.pid}:${meta.updatedAt}` !== stale) return false;
		if (meta && meta.status !== "stopped" && (await canConnect(meta.socket))) return true;
		await sleep(150);
	}
	return false;
}
