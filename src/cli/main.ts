// omp-vs: the omp Sessions CLI. Lists, starts, chats with and organizes the same background
// sessions the VS Code extension shows, through the omp-vs server (started on demand) or, when
// it can't run, directly in-process.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Control, resolveSession, waitForHost } from "../shared/control";
import { HostConnection } from "../shared/host-conn";
import { type HostLauncher, findOmp, listMetas, readHostVersion, readLauncherSettings, readMeta } from "../shared/launch";
import { ORG_COLORS, PRIORITIES, isOrgColor, isPriority } from "../shared/organize";
import { type QueueOp, type QueueTask, type SessionMeta, type TaskQueue, stateRoot } from "../shared/protocol";
import { ServerClient, compareVersions, ensureServer, readServerLog, stopServer } from "../shared/server-client";
import { COLUMNS, type OpName, type ServerOps, type SessionInfo, serverLogPath, serverSocketPath } from "../shared/server-protocol";
import { type Args, UsageError, flag, parseArgs, parseWhen, value } from "./args";
import { attach } from "./attach";
import { renderMessage } from "./render";
import { PRIORITY_MARK, STATUS_COLOR, ago, c, confirm, errorLine, oneLine, pad, priorityLabel, setColor, shortId, termWidth, truncate } from "./term";

const HOST_SCRIPT = path.join(__dirname, "host.js");
const SERVER_SCRIPT = path.join(__dirname, "server.js");
const VERSION = readHostVersion(HOST_SCRIPT);

// ---------- backend: server or in-process ----------

type Call = <K extends OpName>(op: K, args: ServerOps[K]["args"]) => Promise<ServerOps[K]["result"]>;

interface Backend {
	call: Call;
	/** The server is up (queued work gets launched; otherwise only running hosts run tasks). */
	server: boolean;
	close(): void;
}

function launcher(): HostLauncher {
	const settings = readLauncherSettings();
	const omp = findOmp(settings.ompPath);
	if (!omp) throw new Error("could not find the omp executable (install omp, or set omp.path in VS Code)");
	return { hostScript: HOST_SCRIPT, omp, hostVersion: VERSION, extraArgs: settings.extraArgs ?? [], nodePath: process.execPath };
}

function localBackend(): Backend {
	const control = new Control({ launcher, serverUp: () => false, clientName: "omp-vs-server/cli" });
	const ops: { [K in OpName]: (args: ServerOps[K]["args"]) => ServerOps[K]["result"] | Promise<ServerOps[K]["result"]> } = {
		ping: () => ({ pid: process.pid, version: VERSION, root: stateRoot(), startedAt: Date.now() }),
		list: a => control.list(a),
		create: a => control.create(a),
		stop: a => control.stop(a),
		resume: a => control.resume(a),
		remove: a => control.remove(a),
		prompt: a => control.prompt(a),
		abort: a => control.abort(a),
		getQueue: a => control.getQueue(a),
		queue: a => control.queue(a),
		organize: a => control.organize(a),
		scheduler: a => control.scheduler(a),
		shutdown: () => ({}),
	};
	return {
		call: async (op, args) => ops[op](args),
		server: false,
		close: () => {},
	};
}

function serverBackend(client: ServerClient): Backend {
	return { call: (op, args) => client.request(op, args), server: true, close: () => client.close() };
}

let backendPromise: Promise<Backend> | undefined;

/** The server when it runs (started on demand, upgraded when older than this CLI), else in-process. */
function backend(): Promise<Backend> {
	backendPromise ??= (async () => {
		if (process.env.OMP_VS_NO_SERVER) return localBackend();
		const canStart = fs.existsSync(SERVER_SCRIPT);
		let client = canStart ? await ensureServer(SERVER_SCRIPT) : await ServerClient.connect();
		if (client && canStart) {
			try {
				const info = await client.request("ping", {}, 3000);
				if (compareVersions(info.version, VERSION) < 0) {
					client.close();
					await stopServer();
					client = await ensureServer(SERVER_SCRIPT);
				}
			} catch {
				/* keep the connection we have */
			}
		}
		if (client) return serverBackend(client);
		process.stderr.write(c.dim(`omp-vs: the server did not start (see ${serverLogPath()}); running without it\n`));
		return localBackend();
	})();
	return backendPromise;
}

// ---------- session lookup ----------

function findSession(query: string | undefined): SessionMeta {
	if (!query) throw new UsageError("which session? (id, id prefix, title words, or . for this folder)");
	const metas = listMetas();
	const hit = resolveSession(query, metas, process.cwd());
	if ("error" in hit) throw new Error(hit.error);
	const meta = metas.find(m => m.id === hit.id);
	if (!meta) throw new Error(`no session matches "${query}"`);
	return meta;
}

/** A running session: stopped ones are resumed (and waited for) first. */
async function running(meta: SessionMeta): Promise<SessionMeta> {
	if (meta.status !== "stopped") return meta;
	process.stderr.write(c.dim(`resuming ${shortId(meta.id)} ${meta.title}…\n`));
	await (await backend()).call("resume", { id: meta.id });
	if (!(await waitForHost(meta.id))) throw new Error(`session ${shortId(meta.id)} did not start (omp-vs tail ${shortId(meta.id)})`);
	return readMeta(meta.id) ?? meta;
}

// ---------- formatting ----------

function statusText(info: SessionInfo): string {
	const m = info.meta;
	if (info.waiting) return c.blue(info.waiting.launch ? `queued #${info.waiting.position}` : `waiting #${info.waiting.position}`);
	if (m.authProblem) return c.red("no model");
	return (STATUS_COLOR[m.status] ?? c.dim)(m.status === "waiting" ? "input" : m.status);
}

function queueText(q: SessionInfo["queue"]): string {
	if (!q.total) return "";
	const s = `${q.done}/${q.total}`;
	if (q.running) return c.yellow(`▶ ${s}`);
	if (q.pending && q.autoRun) return c.blue(`… ${s}`);
	if (q.pending && q.startAt) return c.blue(`⏲ ${s}`);
	return c.dim(s);
}

function costText(cost: number | undefined): string {
	if (!cost || cost < 0.005) return "";
	return `$${cost < 10 ? cost.toFixed(2) : cost.toFixed(0)}`;
}

function printTable(infos: SessionInfo[]): void {
	const width = termWidth();
	const fixed = 9 + 11 + 3 + 9 + 16 + 8 + 7;
	const titleWidth = Math.max(16, width - fixed);
	process.stdout.write(c.dim(`${pad("ID", 9)}${pad("STATUS", 11)}${pad("", 3)}${pad("TITLE", titleWidth)}${pad("QUEUE", 9)}${pad("PROJECT", 16)}${pad("ACTIVE", 8)}COST\n`));
	for (const info of infos) {
		const m = info.meta;
		const prio = info.priority === "urgent" ? c.red(PRIORITY_MARK.urgent) : info.priority === "high" ? c.yellow(PRIORITY_MARK.high) : c.dim(PRIORITY_MARK[info.priority] ?? "  ");
		const title = truncate(oneLine(m.title), titleWidth - 1);
		const group = info.group ? c.dim(` [${info.group}]`) : "";
		process.stdout.write(
			`${pad(c.dim(shortId(m.id)), 9)}${pad(statusText(info), 11)}${pad(prio, 3)}${pad(`${m.status === "stopped" ? c.dim(title) : title}${group}`, titleWidth)}${pad(queueText(info.queue), 9)}${pad(c.dim(truncate(path.basename(m.cwd), 15)), 16)}${pad(c.dim(ago(m.updatedAt)), 8)}${c.dim(costText(m.cost))}\n`,
		);
	}
}

// ---------- commands ----------

async function cmdList(args: Args): Promise<void> {
	const all = flag(args, "all");
	const b = await backend();
	const infos = await b.call("list", { all });
	// Finished (stopped) sessions are hidden unless --all; queued ones about to start stay.
	const shown = all ? infos : infos.filter(i => i.meta.status !== "stopped" || i.waiting?.launch);
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
		return;
	}
	if (shown.length === 0) process.stdout.write(c.dim(all ? "No sessions.\n" : "No running sessions.\n"));
	else printTable(shown);
	const hidden = infos.length - shown.length;
	if (hidden > 0) process.stdout.write(c.dim(`${hidden} finished session${hidden === 1 ? "" : "s"} hidden · omp-vs ls --all\n`));
	if (shown.some(i => i.waiting)) {
		const s = await b.call("scheduler", {});
		const limit = s.maxConcurrent ? `limit ${s.maxConcurrent}` : "no limit";
		process.stdout.write(c.dim(`${s.running} queued task${s.running === 1 ? "" : "s"} running, ${s.waiting} waiting (${limit}${s.paused ? ", paused" : ""})${s.server ? "" : " · server not running: queued sessions won't start"}\n`));
	}
}

async function cmdBoard(args: Args): Promise<void> {
	const all = flag(args, "all");
	const infos = await (await backend()).call("list", { all: false });
	const width = termWidth();
	for (const col of COLUMNS) {
		if (col.id === "stopped" && !all) continue;
		const cards = infos.filter(i => i.column === col.id).sort((a, b) => a.order - b.order);
		if (col.id === "waiting") cards.sort((a, b) => (a.waiting?.position ?? 0) - (b.waiting?.position ?? 0));
		process.stdout.write(`${c.bold(col.label)} ${c.dim(`(${cards.length})`)}\n`);
		for (const info of cards) {
			const tags = [info.priority !== "normal" ? priorityLabel(info.priority) : "", queueText(info.queue), info.group ? c.dim(`[${info.group}]`) : ""].filter(Boolean).join(" ");
			const title = truncate(oneLine(info.meta.title), Math.max(16, width - 14 - 30));
			process.stdout.write(`  ${c.dim(shortId(info.meta.id))}  ${title}${tags ? `  ${tags}` : ""}\n`);
		}
		if (cards.length === 0) process.stdout.write(c.dim("  —\n"));
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return Buffer.concat(chunks).toString("utf8").trim();
}

async function cmdNew(args: Args): Promise<number> {
	const priority = value(args, "priority");
	if (priority !== undefined && !isPriority(priority)) throw new UsageError(`--priority must be one of ${PRIORITIES.join(", ")}`);
	let prompt = value(args, "prompt");
	if (prompt === "-") prompt = await readStdin();
	const task = value(args, "task");
	const cwd = path.resolve(args._[0] ?? process.cwd());
	const b = await backend();
	const res = await b.call("create", {
		cwd,
		title: value(args, "title"),
		model: value(args, "model"),
		prompt,
		task,
		subtasks: args.multi.get("sub"),
		priority: priority !== undefined && isPriority(priority) ? priority : undefined,
	});
	const meta = readMeta(res.id);
	const label = `${shortId(res.id)} ${meta?.title ?? ""}`.trim();
	if (task) {
		process.stdout.write(res.started ? `${c.green("started")} ${label}\n` : `${c.blue("queued")} ${label} ${c.dim("(starts when a slot is free)")}\n`);
		return 0;
	}
	process.stdout.write(`${c.green("started")} ${label}\n`);
	const wantAttach = flag(args, "attach") || (!prompt && !flag(args, "detach") && process.stdin.isTTY && process.stdout.isTTY);
	if (!wantAttach) return 0;
	if (!(await waitForHost(res.id))) throw new Error(`session ${shortId(res.id)} did not start (omp-vs tail ${shortId(res.id)})`);
	const live = readMeta(res.id);
	return live ? attach(live, { history: 20, readOnly: false }) : 1;
}

async function cmdSend(args: Args): Promise<number> {
	const meta = findSession(args._[0]);
	let text = args._.slice(1).join(" ");
	if (text === "-" || (!text && !process.stdin.isTTY)) text = await readStdin();
	if (!text) throw new UsageError("nothing to send");
	if (flag(args, "wait")) return attach(await running(meta), { history: 0, readOnly: true, prompt: text });
	await (await backend()).call("prompt", { id: meta.id, text, mode: flag(args, "follow-up") ? "followUp" : "steer" });
	process.stdout.write(`${c.green("sent")} ${shortId(meta.id)} ${meta.title}\n`);
	return 0;
}

async function cmdAttach(args: Args): Promise<number> {
	const meta = await running(findSession(args._[0] ?? "."));
	const lines = Number(value(args, "lines") ?? 20);
	return attach(meta, { history: Number.isFinite(lines) ? lines : 20, readOnly: !process.stdin.isTTY });
}

/** Transcript entries of a stopped session's omp session file. */
function transcriptMessages(file: string | undefined): unknown[] {
	if (!file) return [];
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line.includes('"message"')) continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (entry && typeof entry === "object" && "message" in entry && entry.message && typeof entry.message === "object") out.push(entry.message);
		} catch {
			/* torn line */
		}
	}
	return out;
}

async function cmdTail(args: Args): Promise<number> {
	const meta = findSession(args._[0] ?? ".");
	const n = Number(value(args, "lines") ?? 10);
	const lines = Number.isFinite(n) && n > 0 ? n : 10;
	if (meta.status !== "stopped" && flag(args, "follow")) return attach(meta, { history: lines, readOnly: true });
	let messages: unknown[];
	if (meta.status !== "stopped") {
		const { conn, snapshot } = await HostConnection.open(meta.socket, "omp-vs-tail");
		conn.close();
		messages = snapshot.messages;
	} else messages = transcriptMessages(meta.ompSessionFile);
	const width = termWidth();
	for (const m of messages.slice(-lines)) for (const l of renderMessage(m, width)) process.stdout.write(`${l}\n`);
	if (meta.status === "stopped") {
		process.stdout.write(c.dim(`session stopped${meta.exitReason ? `: ${meta.exitReason}` : ""} (${ago(meta.updatedAt)} ago)\n`));
		if (flag(args, "follow")) process.stdout.write(c.dim(`omp-vs resume ${shortId(meta.id)} to continue it\n`));
	}
	return 0;
}

async function cmdStop(args: Args): Promise<void> {
	if (args._.length === 0) throw new UsageError("which session?");
	const b = await backend();
	for (const q of args._) {
		const meta = findSession(q);
		const res = await b.call("stop", { id: meta.id });
		process.stdout.write(`${res.stopped ? c.green("stopped") : c.dim("already stopped")} ${shortId(meta.id)} ${meta.title}\n`);
	}
}

async function cmdResume(args: Args): Promise<void> {
	if (args._.length === 0) throw new UsageError("which session?");
	const b = await backend();
	for (const q of args._) {
		const meta = findSession(q);
		const res = await b.call("resume", { id: meta.id });
		process.stdout.write(`${res.started ? c.green("resumed") : c.dim("already running")} ${shortId(meta.id)} ${meta.title}\n`);
	}
}

async function cmdRemove(args: Args): Promise<number> {
	if (args._.length === 0) throw new UsageError("which session?");
	const metas = args._.map(findSession);
	const names = metas.map(m => `${shortId(m.id)} ${m.title}${m.status !== "stopped" ? c.yellow(" (running)") : ""}`).join("\n  ");
	if (!(await confirm(`Remove ${metas.length === 1 ? "this session" : `${metas.length} sessions`} and their history?\n  ${names}\n`, flag(args, "yes")))) {
		process.stderr.write(c.dim(process.stdin.isTTY ? "cancelled\n" : "not removing without --yes\n"));
		return 1;
	}
	const b = await backend();
	for (const m of metas) {
		await b.call("remove", { id: m.id });
		process.stdout.write(`${c.green("removed")} ${shortId(m.id)} ${m.title}\n`);
	}
	return 0;
}

async function cmdAbort(args: Args): Promise<void> {
	const meta = findSession(args._[0] ?? ".");
	const res = await (await backend()).call("abort", { id: meta.id });
	process.stdout.write(res.sent ? `${c.yellow("aborted")} ${shortId(meta.id)} ${meta.title}\n` : c.dim("not running\n"));
}

const TASK_MARK: Record<QueueTask["status"], string> = { pending: "·", running: "▶", done: "✓", failed: "✗", skipped: "−" };

function printQueue(meta: SessionMeta, q: TaskQueue): void {
	const state = q.tasks.some(t => t.status === "running")
		? c.yellow("running")
		: q.autoRun
			? c.blue("auto-run on")
			: q.startAt
				? c.blue(`starts ${new Date(q.startAt).toLocaleString()}`)
				: c.dim("paused");
	process.stdout.write(`${c.bold(meta.title)} ${c.dim(shortId(meta.id))} · ${state}\n`);
	if (q.tasks.length === 0) process.stdout.write(c.dim("  no tasks · omp-vs queue <session> add <task>\n"));
	const width = termWidth();
	q.tasks.forEach((t, i) => {
		const color = t.status === "done" ? c.green : t.status === "failed" ? c.red : t.status === "running" ? c.yellow : t.status === "skipped" ? c.dim : (s: string) => s;
		const subs = t.subtasks.length ? c.dim(` (${t.subtasks.filter(s => s.done).length}/${t.subtasks.length})`) : "";
		process.stdout.write(`  ${c.dim(String(i + 1).padStart(2))} ${color(TASK_MARK[t.status])} ${truncate(oneLine(t.title), width - 14)}${subs}\n`);
		if (t.status === "failed" && t.summary) process.stdout.write(`       ${c.red(truncate(oneLine(t.summary), width - 8))}\n`);
	});
}

function taskRef(q: TaskQueue, ref: string | undefined): QueueTask {
	if (!ref) throw new UsageError("which task? (number or id)");
	const n = Number(ref);
	const t = Number.isInteger(n) && n >= 1 ? q.tasks[n - 1] : q.tasks.find(x => x.id.startsWith(ref));
	if (!t) throw new Error(`no task ${ref}`);
	return t;
}

async function cmdQueue(args: Args): Promise<void> {
	const meta = findSession(args._[0] ?? ".");
	const b = await backend();
	const sub = args._[1] ?? "ls";
	const rest = args._.slice(2);
	const q = await b.call("getQueue", { id: meta.id });
	let ops: QueueOp[];
	switch (sub) {
		case "ls":
		case "list":
			printQueue(meta, q);
			return;
		case "add": {
			const title = rest.join(" ") || (process.stdin.isTTY ? "" : await readStdin());
			if (!title) throw new UsageError("queue add <task title>");
			ops = [{ op: "add", title, subtasks: args.multi.get("sub"), ...(flag(args, "top") ? { index: 0 } : {}) }];
			if (flag(args, "run")) ops.push({ op: "autoRun", value: true });
			break;
		}
		case "run":
			ops = [{ op: "run", ...(rest[0] ? { id: taskRef(q, rest[0]).id } : {}) }];
			break;
		case "pause":
			ops = [{ op: "autoRun", value: false }];
			break;
		case "start":
		case "resume":
			ops = [{ op: "autoRun", value: true }];
			break;
		case "clear":
			ops = [{ op: "clearDone" }];
			break;
		case "retry":
			ops = rest[0] ? [{ op: "update", id: taskRef(q, rest[0]).id, status: "pending" }] : [{ op: "retryFailed" }];
			break;
		case "rm":
		case "remove":
			ops = [{ op: "remove", id: taskRef(q, rest[0]).id }];
			break;
		case "done":
			ops = [{ op: "update", id: taskRef(q, rest[0]).id, status: "done" }];
			break;
		case "skip":
			ops = [{ op: "update", id: taskRef(q, rest[0]).id, status: "skipped" }];
			break;
		case "at": {
			if (rest[0] === "off" || rest[0] === "none") ops = [{ op: "schedule", at: null }];
			else {
				const at = parseWhen(rest.join(" "));
				if (!at) throw new UsageError("queue at <+30m | 14:30 | 2025-01-31T08:00 | off>");
				ops = [{ op: "schedule", at }];
			}
			break;
		}
		default:
			throw new UsageError(`unknown queue command "${sub}" (ls, add, run, start, pause, clear, retry, rm, done, skip, at)`);
	}
	const next = await b.call("queue", { id: meta.id, ops });
	printQueue(readMeta(meta.id) ?? meta, next);
	if (!b.server && meta.status === "stopped" && next.autoRun && next.tasks.some(t => t.status === "pending")) {
		process.stdout.write(c.dim(`the session is stopped: omp-vs resume ${shortId(meta.id)} runs the queue (or start the server: omp-vs server start)\n`));
	}
}

async function cmdOrganize(cmd: string, args: Args): Promise<void> {
	const meta = findSession(args._[0]);
	const arg = args._[1];
	const b = await backend();
	let res: { changed: boolean };
	switch (cmd) {
		case "prio":
		case "priority":
			if (!isPriority(arg)) throw new UsageError(`prio <session> <${PRIORITIES.join("|")}>`);
			res = await b.call("organize", { id: meta.id, action: "priority", priority: arg });
			break;
		case "color":
			if (arg !== "none" && !isOrgColor(arg)) throw new UsageError(`color <session> <${ORG_COLORS.join("|")}|none>`);
			res = await b.call("organize", { id: meta.id, action: "color", color: isOrgColor(arg) ? arg : null });
			break;
		case "group": {
			const name = args._.slice(1).join(" ");
			if (!name) throw new UsageError("group <session> <group name|none>");
			res = await b.call("organize", { id: meta.id, action: "group", name: name === "none" ? null : name });
			break;
		}
		case "archive":
		case "unarchive":
			res = await b.call("organize", { id: meta.id, action: "archive", value: cmd === "archive" });
			break;
		case "move":
			if (arg !== "up" && arg !== "down" && arg !== "top" && arg !== "bottom") throw new UsageError("move <session> <up|down|top|bottom>");
			res = await b.call("organize", { id: meta.id, action: arg });
			break;
		default:
			throw new UsageError(`unknown command ${cmd}`);
	}
	process.stdout.write(res.changed ? `${c.green("updated")} ${shortId(meta.id)} ${meta.title}\n` : c.dim("no change\n"));
}

async function cmdSched(args: Args): Promise<void> {
	const b = await backend();
	const [sub, arg] = args._;
	let set: ServerOps["scheduler"]["args"]["set"];
	switch (sub) {
		case undefined:
		case "status":
			break;
		case "set":
		case "limit": {
			const n = Number(arg);
			if (!Number.isInteger(n) || n < 0) throw new UsageError("sched set <max concurrent queued tasks; 0 = unlimited>");
			set = { maxConcurrent: n };
			break;
		}
		case "pause":
			set = { paused: true };
			break;
		case "resume":
			set = { paused: false };
			break;
		case "stop-when-done":
			if (arg !== "on" && arg !== "off") throw new UsageError("sched stop-when-done <on|off>");
			set = { stopWhenQueueDone: arg === "on" };
			break;
		default:
			throw new UsageError(`unknown sched command "${sub}" (status, set N, pause, resume, stop-when-done on|off)`);
	}
	const s = await b.call("scheduler", set ? { set } : {});
	const yes = (v: boolean) => (v ? c.green("yes") : c.dim("no"));
	process.stdout.write(
		[
			`max concurrent  ${s.maxConcurrent ? c.bold(String(s.maxConcurrent)) : c.dim("unlimited")}`,
			`running         ${s.running}`,
			`waiting         ${s.waiting}`,
			`paused          ${yes(!!s.paused)}`,
			`stop when done  ${yes(s.stopWhenQueueDone !== false)}  ${c.dim("(sessions the server launched)")}`,
			`server          ${s.server ? c.green("running") : c.yellow("not running")}`,
		].join("\n") + "\n",
	);
}

// ---------- server management ----------

function unitPaths(): { systemd: string; launchd: string } {
	return {
		systemd: path.join(os.homedir(), ".config", "systemd", "user", "omp-vs.service"),
		launchd: path.join(os.homedir(), "Library", "LaunchAgents", "dev.omp.vs-server.plist"),
	};
}

function run(cmd: string, argv: string[]): boolean {
	const r = spawnSync(cmd, argv, { stdio: "inherit" });
	return r.status === 0;
}

async function cmdServer(args: Args): Promise<number> {
	const sub = args._[0] ?? "status";
	switch (sub) {
		case "start": {
			const client = await ensureServer(SERVER_SCRIPT);
			if (!client) throw new Error(`the server did not start (see ${serverLogPath()})`);
			const info = await client.request("ping", {});
			client.close();
			process.stdout.write(`${c.green("running")} pid ${info.pid} · ${info.version}\n`);
			return 0;
		}
		case "stop":
			process.stdout.write((await stopServer()) ? `${c.green("stopped")} (sessions keep running)\n` : c.dim("not running\n"));
			return 0;
		case "restart": {
			await stopServer();
			const client = await ensureServer(SERVER_SCRIPT);
			if (!client) throw new Error(`the server did not start (see ${serverLogPath()})`);
			const info = await client.request("ping", {});
			client.close();
			process.stdout.write(`${c.green("running")} pid ${info.pid} · ${info.version}\n`);
			return 0;
		}
		case "status": {
			const client = await ServerClient.connect();
			if (!client) {
				process.stdout.write(`${c.yellow("not running")} ${c.dim("· omp-vs server start (other commands start it on demand)")}\n`);
				return 3;
			}
			const info = await client.request("ping", {});
			client.close();
			process.stdout.write(`${c.green("running")} pid ${info.pid} · ${info.version} · up ${ago(info.startedAt)}\n${c.dim(`socket ${serverSocketPath()}\nlog    ${serverLogPath()}`)}\n`);
			return 0;
		}
		case "log": {
			process.stdout.write(readServerLog());
			if (!flag(args, "follow")) return 0;
			let offset = fs.existsSync(serverLogPath()) ? fs.statSync(serverLogPath()).size : 0;
			fs.watchFile(serverLogPath(), { interval: 500 }, cur => {
				if (cur.size < offset) offset = 0;
				if (cur.size === offset) return;
				const fd = fs.openSync(serverLogPath(), "r");
				const buf = Buffer.alloc(cur.size - offset);
				fs.readSync(fd, buf, 0, buf.length, offset);
				fs.closeSync(fd);
				offset = cur.size;
				process.stdout.write(buf.toString("utf8"));
			});
			await new Promise<void>(() => {});
			return 0;
		}
		case "install":
			return installService();
		case "uninstall":
			return uninstallService();
		default:
			throw new UsageError(`unknown server command "${sub}" (start, stop, restart, status, log [-f], install, uninstall)`);
	}
}

function installService(): number {
	const env = [`ELECTRON_RUN_AS_NODE=1`, ...(process.env.OMP_VSCODE_HOME ? [`OMP_VSCODE_HOME=${process.env.OMP_VSCODE_HOME}`] : []), `PATH=${process.env.PATH ?? ""}`];
	const { systemd, launchd } = unitPaths();
	if (process.platform === "linux") {
		fs.mkdirSync(path.dirname(systemd), { recursive: true });
		fs.writeFileSync(
			systemd,
			[
				"[Unit]",
				"Description=omp-vs server (omp Sessions: queued session launcher)",
				"",
				"[Service]",
				`ExecStart=${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER_SCRIPT)}`,
				...env.map(e => `Environment=${JSON.stringify(e)}`),
				"Restart=on-failure",
				"RestartSec=5",
				"",
				"[Install]",
				"WantedBy=default.target",
				"",
			].join("\n"),
		);
		void stopServer();
		const ok = run("systemctl", ["--user", "daemon-reload"]) && run("systemctl", ["--user", "enable", "--now", "omp-vs.service"]);
		process.stdout.write(ok ? `${c.green("installed")} ${systemd}\n` : `${c.yellow("wrote")} ${systemd} ${c.dim("(enable it with: systemctl --user enable --now omp-vs)")}\n`);
		return ok ? 0 : 1;
	}
	if (process.platform === "darwin") {
		fs.mkdirSync(path.dirname(launchd), { recursive: true });
		const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
		const envXml = env.map(e => {
			const i = e.indexOf("=");
			return `\t\t<key>${xml(e.slice(0, i))}</key><string>${xml(e.slice(i + 1))}</string>`;
		});
		fs.writeFileSync(
			launchd,
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>dev.omp.vs-server</string>
	<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(SERVER_SCRIPT)}</string></array>
	<key>EnvironmentVariables</key><dict>
${envXml.join("\n")}
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`,
		);
		const ok = run("launchctl", ["load", "-w", launchd]);
		process.stdout.write(ok ? `${c.green("installed")} ${launchd}\n` : `${c.yellow("wrote")} ${launchd}\n`);
		return ok ? 0 : 1;
	}
	throw new Error("server install supports Linux (systemd) and macOS (launchd); on Windows the server starts on demand");
}

function uninstallService(): number {
	const { systemd, launchd } = unitPaths();
	if (process.platform === "linux" && fs.existsSync(systemd)) {
		run("systemctl", ["--user", "disable", "--now", "omp-vs.service"]);
		fs.rmSync(systemd, { force: true });
		run("systemctl", ["--user", "daemon-reload"]);
		process.stdout.write(`${c.green("removed")} ${systemd}\n`);
		return 0;
	}
	if (process.platform === "darwin" && fs.existsSync(launchd)) {
		run("launchctl", ["unload", "-w", launchd]);
		fs.rmSync(launchd, { force: true });
		process.stdout.write(`${c.green("removed")} ${launchd}\n`);
		return 0;
	}
	process.stdout.write(c.dim("no service installed\n"));
	return 0;
}

// ---------- help ----------

const HELP = `${c.bold("omp-vs")} — omp Sessions from the terminal ${c.dim(`(${VERSION})`)}

${c.bold("Sessions")}  ${c.dim("<session> = id, id prefix, title words, or . (latest session in this folder)")}
  ls [-a|--all] [--json]          running sessions (--all: also finished and archived)
  board [--all]                   sessions by column: waiting, working, needs input, idle
  new [dir] [-p prompt|-] [--task t [--sub s]…] [--title t] [--model m] [--priority p] [--detach]
                                  start a session (no prompt: attach to it); --task queues it
  attach [session]                chat in the terminal (Ctrl-C aborts a turn, Ctrl-D detaches)
  send <session> <text|-> [--follow-up] [-w|--wait]
                                  prompt a session (resumes it if stopped); --wait streams the reply
  tail [session] [-n N] [-f]      last messages; -f follows live output
  stop|resume <session>…          stop or resume sessions
  abort [session]                 abort the current turn
  rm <session>… [-y]              remove sessions and their history

${c.bold("Queue")}
  queue <session>                 show its task queue
  queue <session> add <task> [--sub s]… [--top] [--run]
  queue <session> run [n] | start | pause | clear | retry [n] | rm n | done n | skip n
  queue <session> at <+30m|14:30|ISO time|off>

${c.bold("Organize")}
  prio <session> <urgent|high|normal|low>
  color <session> <${ORG_COLORS.join("|")}|none>
  group <session> <name|none>
  move <session> <up|down|top|bottom>
  archive|unarchive <session>

${c.bold("Scheduler")}  ${c.dim("(global limit on queued tasks running at once)")}
  sched                           status
  sched set <n>                   max concurrent queued tasks (0 = unlimited)
  sched pause|resume
  sched stop-when-done <on|off>   stop sessions the server launched once their queue is done

${c.bold("Server")}  ${c.dim("(started on demand; launches queued sessions when slots free up)")}
  server status|start|stop|restart|log [-f]|install|uninstall

  --no-color, NO_COLOR=1          plain output · OMP_VS_NO_SERVER=1 runs without the server
`;

// ---------- main ----------

async function main(argv: string[]): Promise<number> {
	if (argv.includes("--no-color")) setColor(false);
	const args = parseArgs(argv.filter(a => a !== "--no-color"));
	const cmd = args._.shift() ?? "ls";
	if (flag(args, "help") || cmd === "help") {
		process.stdout.write(HELP);
		return 0;
	}
	switch (cmd) {
		case "ls":
		case "list":
			await cmdList(args);
			return 0;
		case "board":
			await cmdBoard(args);
			return 0;
		case "new":
			return cmdNew(args);
		case "send":
			return cmdSend(args);
		case "attach":
		case "chat":
			return cmdAttach(args);
		case "tail":
		case "log":
			return cmdTail(args);
		case "stop":
			await cmdStop(args);
			return 0;
		case "resume":
		case "start":
			await cmdResume(args);
			return 0;
		case "rm":
		case "remove":
			return cmdRemove(args);
		case "abort":
			await cmdAbort(args);
			return 0;
		case "queue":
		case "q":
			await cmdQueue(args);
			return 0;
		case "prio":
		case "priority":
		case "color":
		case "group":
		case "archive":
		case "unarchive":
		case "move":
			await cmdOrganize(cmd, args);
			return 0;
		case "sched":
		case "scheduler":
			await cmdSched(args);
			return 0;
		case "server":
			return cmdServer(args);
		case "version":
		case "--version": {
			const client = await ServerClient.connect();
			const server = client ? await client.request("ping", {}).catch(() => undefined) : undefined;
			client?.close();
			process.stdout.write(`omp-vs ${VERSION}${server ? c.dim(` · server ${server.version} (pid ${server.pid})`) : ""}\n`);
			return 0;
		}
		default:
			throw new UsageError(`unknown command "${cmd}" (omp-vs help)`);
	}
}

if (require.main === module) {
	main(process.argv.slice(2))
		.then(code => {
			void backendPromise?.then(b => b.close());
			process.exitCode = code;
		})
		.catch(err => {
			void backendPromise?.then(b => b.close());
			errorLine(err instanceof Error ? err.message : String(err));
			process.exitCode = err instanceof UsageError ? 2 : 1;
		});
}
