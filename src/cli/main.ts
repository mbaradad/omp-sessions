// omp-vs: the omp Sessions CLI. Lists, starts, chats with and organizes the same background
// sessions the VS Code extension shows, through the omp-vs server (started on demand) or, when
// it can't run, directly in-process.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Control, resolveSession, waitForHost } from "../shared/control";
import { HostConnection } from "../shared/host-conn";
import { type HostLauncher, findOmp, listMetas, readHostVersion, readLauncherSettings, readMeta, sessionPermissionMode, setSessionPermissionMode } from "../shared/launch";
import { PERMISSION_MODES, PERMISSION_MODE_INFO, permissionModeOf } from "../shared/permissions";
import { ORG_COLORS, PRIORITIES, isOrgColor, isPriority } from "../shared/organize";
import { DIALOG_METHODS, type QueueOp, type QueueTask, type SessionMeta, type TaskQueue, type UiRequest, stateRoot } from "../shared/protocol";
import { type RemoteStatus, isRemoteBind, newRemoteToken, pairingUrl, readRemoteConfig, updateRemoteConfig } from "../shared/remote";
import { qrHalfBlocks } from "../shared/remote-qr";
import { recentProjects } from "../shared/projects";
import { transcriptMessages } from "../shared/remote-snapshot";
import { ServerClient, compareVersions, ensureServer, readServerLog, stopServer } from "../shared/server-client";
import { COLUMNS, type OpName, type ServerOps, type SessionInfo, serverLogPath, serverSocketPath } from "../shared/server-protocol";
import { type AgentState, SETTLED_STATES, type SessionReport, agentState, dialogAnswer, sessionReport } from "../shared/session-report";
import { SKILL_FILE, SKILL_NAME, SKILL_PLATFORMS, type SkillTarget, detectedPlatforms, installSkill, isSkillPlatform, skillTargets, uninstallSkill } from "../shared/agent-skill";
import { AFTER_INSTALL, PLUGIN_BUNDLE, disablePlugin, enablePlugin, findHermes, installPlugin, pluginReport, pluginTarget, reportLine, resolveTargets, uninstallPlugin } from "../shared/hermes-plugin";
import { type Args, UsageError, flag, parseArgs, parseWhen, value } from "./args";
import { attach } from "./attach";
import { renderMessage } from "./render";
import { PRIORITY_MARK, STATUS_COLOR, ago, c, colorEnabled, confirm, errorLine, oneLine, pad, priorityLabel, setColor, shortId, termWidth, truncate } from "./term";

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
		remote: () => {
			const { enabled, bind, port } = readRemoteConfig();
			return { enabled, bind, port, ...(enabled ? { error: "the omp-vs server is not running (it serves remote access)" } : {}) };
		},
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
	const modeArg = value(args, "mode");
	const mode = modeArg === undefined ? undefined : permissionModeOf(modeArg.toLowerCase());
	if (modeArg !== undefined && !mode) throw new UsageError(`--mode must be one of ${PERMISSION_MODES.join(", ")}`);
	let prompt = value(args, "prompt");
	if (prompt === "-") prompt = await readStdin();
	const task = value(args, "task");
	let notes = value(args, "notes");
	if (notes !== undefined && !task) throw new UsageError("--notes belong to a queued task: add --task");
	if (notes === "-") {
		if (prompt === "-") throw new UsageError("only one of --prompt and --notes can read stdin");
		notes = await readStdin();
	}
	const atArg = value(args, "at");
	const startAt = atArg === undefined ? undefined : parseWhen(atArg);
	if (atArg !== undefined && !task) throw new UsageError("--at schedules a queued task: add --task");
	if (atArg !== undefined && startAt === undefined) throw new UsageError("--at <+30m | 14:30 | 2025-01-31T08:00>");
	const json = flag(args, "json");
	const cwd = path.resolve(args._[0] ?? process.cwd());
	const b = await backend();
	const res = await b.call("create", {
		cwd,
		title: value(args, "title"),
		model: value(args, "model"),
		prompt,
		task,
		subtasks: args.multi.get("sub"),
		startAt,
		priority: priority !== undefined && isPriority(priority) ? priority : undefined,
		mode,
		tags: args.multi.get("tag"),
		group: value(args, "group"),
		notes,
	});
	const meta = readMeta(res.id);
	if (json) {
		process.stdout.write(`${JSON.stringify({ id: res.id, started: res.started, title: meta?.title ?? "", cwd, ...(startAt ? { startAt } : {}) })}\n`);
		return 0;
	}
	const label = `${shortId(res.id)} ${meta?.title ?? ""}`.trim();
	if (task) {
		const when = startAt ? c.dim(`(starts ${new Date(startAt).toLocaleString()})`) : c.dim("(starts when a slot is free)");
		process.stdout.write(res.started && !startAt ? `${c.green("started")} ${label}\n` : `${c.blue("queued")} ${label} ${when}\n`);
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

// ---------- agent-facing: show / wait / answer ----------

/** The session's report for agents: state, pending question, full last reply. */
async function reportFor(meta: SessionMeta): Promise<SessionReport> {
	const infos = await (await backend()).call("list", { all: true });
	const info = infos.find(i => i.meta.id === meta.id);
	if (!info) throw new Error(`session ${shortId(meta.id)} is gone`);
	let messages: unknown[] = [];
	let pendingUi: UiRequest[] = [];
	if (info.meta.status !== "stopped") {
		try {
			const { conn, snapshot } = await HostConnection.open(info.meta.socket, "omp-vs-show");
			conn.close();
			messages = snapshot.messages;
			pendingUi = snapshot.pendingUi;
		} catch {
			/* the host just exited: the transcript below still has the reply */
			messages = transcriptMessages(info.meta.ompSessionFile);
		}
	} else messages = transcriptMessages(info.meta.ompSessionFile);
	return sessionReport(info, { messages, pendingUi, tags: info.tags ?? [] });
}

const STATE_COLOR: Record<AgentState, (s: string) => string> = { queued: c.blue, starting: c.dim, working: c.yellow, needs_input: c.magenta, idle: c.green, stopped: c.dim };

function printReport(r: SessionReport): void {
	const q = r.queue.total ? c.dim(` · queue ${r.queue.done}/${r.queue.total}`) : "";
	process.stdout.write(`${STATE_COLOR[r.state](r.state.replace("_", " "))} ${shortId(r.id)} ${c.bold(r.title)}${q}${r.cost ? c.dim(` · $${r.cost.toFixed(2)}`) : ""}\n`);
	if (r.question) {
		process.stdout.write(`${c.magenta(`? ${r.question.title}`)}${r.question.message ? `\n${r.question.message}` : ""}\n`);
		r.question.options?.forEach((o, i) => process.stdout.write(`  ${c.bold(String(i + 1))}. ${o}\n`));
		process.stdout.write(c.dim(`answer: omp-vs answer ${shortId(r.id)} <choice>\n`));
	}
	if (r.exitReason) process.stdout.write(c.dim(`stopped: ${r.exitReason}\n`));
	if (r.reply && !r.question) process.stdout.write(`\n${r.reply}\n`);
}

async function cmdShow(args: Args): Promise<number> {
	const report = await reportFor(findSession(args._[0] ?? "."));
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else printReport(report);
	return 0;
}

/** `wait` exit codes: why it stopped waiting. */
const WAIT_EXIT: Record<AgentState, number> = { idle: 0, needs_input: 3, stopped: 4, queued: 124, starting: 124, working: 124 };
/** A settled state must hold this long, so a prompt that was just sent has time to start. */
const SETTLE_MS = 3000;

/** "90", "90s", "30m", "2h" → ms. */
function parseDuration(text: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/.exec(text.trim());
	if (!m) return undefined;
	return Number(m[1]) * ({ "": 1000, s: 1000, m: 60_000, h: 3_600_000 }[m[2]] ?? 1000);
}

async function cmdWait(args: Args): Promise<number> {
	const meta = findSession(args._[0] ?? ".");
	const timeoutArg = value(args, "timeout");
	const timeout = timeoutArg === undefined ? undefined : parseDuration(timeoutArg);
	if (timeoutArg !== undefined && timeout === undefined) throw new UsageError("--timeout <seconds | 30m | 2h>");
	const b = await backend();
	const deadline = timeout === undefined ? Infinity : Date.now() + timeout;
	let settledSince: number | undefined;
	let state: AgentState = "working";
	for (;;) {
		const info = (await b.call("list", { all: true })).find(i => i.meta.id === meta.id);
		if (!info) throw new Error(`session ${shortId(meta.id)} is gone`);
		state = agentState(info);
		const now = Date.now();
		if (SETTLED_STATES[state]) {
			settledSince ??= now;
			if (now - settledSince >= SETTLE_MS) break;
		} else settledSince = undefined;
		if (now >= deadline) break;
		await new Promise(r => setTimeout(r, 1000));
	}
	const report = await reportFor(meta);
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else printReport(report);
	return SETTLED_STATES[state] ? WAIT_EXIT[report.state] : 124;
}

async function cmdAnswer(args: Args): Promise<number> {
	const meta = findSession(args._[0]);
	const text = args._.slice(1).join(" ");
	if (meta.status !== "waiting") throw new Error(`${shortId(meta.id)} ${meta.title} is not waiting for an answer (${meta.status})`);
	const { conn, snapshot } = await HostConnection.open(meta.socket, "omp-vs-answer");
	try {
		const req = snapshot.pendingUi.find(r => DIALOG_METHODS[r.method]);
		if (!req) throw new Error("no question is waiting");
		const answer = dialogAnswer(req, text);
		if ("error" in answer) throw new UsageError(answer.error);
		const resolved = new Promise<boolean>(resolve => {
			const off = conn.onMessage(msg => {
				if (msg.t === "ui_resolved" && msg.id === req.id) {
					off();
					resolve(true);
				}
			});
			setTimeout(() => resolve(false), 5000).unref();
		});
		conn.write({ t: "ui_response", res: { id: req.id, ...answer.res } });
		if (!(await resolved)) throw new Error("the session did not take the answer (answer it in VS Code or omp-vs attach)");
		process.stdout.write(`${c.green("answered")} ${shortId(meta.id)} ${typeof req.title === "string" && req.title ? req.title : req.method}\n`);
		return 0;
	} finally {
		conn.close();
	}
}

function cmdProjects(args: Args): number {
	const projects = recentProjects();
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify(projects, null, 2)}\n`);
		return 0;
	}
	if (!projects.length) process.stdout.write(c.dim("no sessions yet\n"));
	for (const p of projects) process.stdout.write(`${pad(c.bold(p.name), 24)} ${pad(c.dim(`${p.sessions} session${p.sessions === 1 ? "" : "s"} · ${ago(p.lastUsed)} ago`), 26)} ${p.path}\n`);
	return 0;
}

// ---------- skill ----------

function skillContent(): string {
	const file = path.join(__dirname, SKILL_FILE);
	if (!fs.existsSync(file)) throw new Error(`${SKILL_FILE} is missing next to the CLI (reinstall it: omp: Install omp-vs Command)`);
	return fs.readFileSync(file, "utf8");
}

function cmdSkill(args: Args): number {
	const sub = args._[0] ?? "status";
	const names = args._.slice(1);
	for (const n of names) if (!isSkillPlatform(n)) throw new UsageError(`unknown platform "${n}" (${SKILL_PLATFORMS.join(", ")})`);
	const platforms = names.filter(isSkillPlatform);
	const dir = value(args, "dir");
	const targets = (): SkillTarget[] => [
		...(platforms.length || dir ? platforms : detectedPlatforms()).flatMap(p => skillTargets(p)),
		...(dir ? [{ platform: "dir" as const, dir: path.join(path.resolve(dir), SKILL_NAME) }] : []),
	];
	switch (sub) {
		case "print":
		case "show":
			process.stdout.write(skillContent());
			return 0;
		case "path":
			process.stdout.write(`${path.join(__dirname, SKILL_FILE)}\n`);
			return 0;
		case "install": {
			const content = skillContent();
			let skipped = 0;
			for (const t of targets()) {
				const outcome = installSkill(t, content, flag(args, "force"));
				if (outcome === "skipped") skipped++;
				const mark = outcome === "skipped" ? c.yellow(outcome) : outcome === "unchanged" ? c.dim(outcome) : c.green(outcome);
				process.stdout.write(`${pad(mark, 10)} ${t.platform}  ${c.dim(path.join(t.dir, "SKILL.md"))}\n`);
			}
			if (skipped) process.stdout.write(c.dim("skipped: a SKILL.md omp-vs didn't write is in the way (--force replaces it)\n"));
			return 0;
		}
		case "uninstall": {
			for (const t of targets()) if (uninstallSkill(t)) process.stdout.write(`${c.yellow("removed")} ${path.join(t.dir, "SKILL.md")}\n`);
			return 0;
		}
		case "status": {
			const content = skillContent();
			for (const p of SKILL_PLATFORMS) {
				const ts = skillTargets(p);
				if (!ts.length) {
					process.stdout.write(`${pad(p, 8)} ${c.dim("not found")}\n`);
					continue;
				}
				for (const t of ts) {
					const file = path.join(t.dir, "SKILL.md");
					const state = !fs.existsSync(file) ? c.dim("not installed") : fs.readFileSync(file, "utf8") === content ? c.green("installed") : c.yellow("outdated or not ours");
					process.stdout.write(`${pad(p, 8)} ${state}  ${c.dim(file)}\n`);
				}
			}
			return 0;
		}
		default:
			throw new UsageError(`unknown skill command "${sub}" (status, install, uninstall, print, path)`);
	}
}

// ---------- hermes plugin ----------

function cmdHermes(args: Args): number {
	const sub = args._[0] ?? "status";
	const source = path.join(__dirname, PLUGIN_BUNDLE);
	const targets = resolveTargets({ profiles: args.multi.get("profile"), all: flag(args, "all-profiles") });
	const hermes = findHermes();
	const several = targets.length > 1;
	let failed = false;
	switch (sub) {
		case "install": {
			for (const t of targets) {
				const dir = pluginTarget(t.home);
				const outcome = installPlugin(source, dir, flag(args, "force"));
				const mark = outcome === "skipped" ? c.yellow(outcome) : outcome === "unchanged" ? c.dim(outcome) : c.green(outcome);
				process.stdout.write(`${pad(mark, 10)} ${several || t.profile ? `${c.bold(t.label)} ` : ""}${dir}\n`);
				if (outcome === "skipped") {
					process.stdout.write(c.dim("a plugin folder omp-vs didn't write is in the way (--force replaces it)\n"));
					failed = true;
					continue;
				}
				if (!hermes) continue;
				const res = enablePlugin(hermes, t);
				if (res.output) process.stdout.write(`${res.output}\n`);
				if (!res.ok) failed = true;
			}
			if (!hermes) {
				process.stdout.write(`${c.yellow("hermes not found")}: enable it with ${c.bold("hermes [-p <profile>] plugins enable omp-sessions")}\n`);
				return 1;
			}
			if (!failed) for (const line of AFTER_INSTALL) process.stdout.write(`${c.dim(line)}\n`);
			return failed ? 1 : 0;
		}
		case "uninstall": {
			for (const t of targets) {
				const dir = pluginTarget(t.home);
				if (hermes && fs.existsSync(dir)) {
					const res = disablePlugin(hermes, t);
					if (res.output) process.stdout.write(`${res.output}\n`);
				}
				process.stdout.write(uninstallPlugin(dir) ? `${c.yellow("removed")} ${dir}\n` : c.dim(`nothing omp-vs installed at ${dir}\n`));
			}
			return 0;
		}
		case "status": {
			const reports = targets.map(t => pluginReport(source, t, hermes));
			if (flag(args, "json")) {
				process.stdout.write(`${JSON.stringify({ hermes: hermes ?? null, profiles: reports })}\n`);
				return 0;
			}
			process.stdout.write(`hermes: ${hermes ?? c.yellow("not found (PATH, ~/.local/bin/hermes)")}\n`);
			for (const r of reports) process.stdout.write(`${reportLine(r)}\n`);
			const lanes = reports.filter(r => r.lane).map(r => r.label);
			if (lanes.length > 1) process.stdout.write(c.yellow(`the kanban lane is on in ${lanes.join(", ")}: they take turns (one machine-wide lock), but keep it on in one profile so one set of lane settings applies\n`));
			return 0;
		}
		default:
			throw new UsageError(`unknown hermes command "${sub}" (install, uninstall, status)`);
	}
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

async function cmdMode(args: Args): Promise<void> {
	// `omp-vs mode plan` = the latest session in this folder.
	const [ref, want] = args._.length === 1 && permissionModeOf(args._[0].toLowerCase()) ? [".", args._[0]] : [args._[0] ?? ".", args._[1]];
	const meta = findSession(ref);
	if (!want) {
		const current = sessionPermissionMode(meta);
		process.stdout.write(`${c.bold(meta.title)} ${c.dim(shortId(meta.id))} · ${current ? PERMISSION_MODE_INFO[current].label : c.dim("omp default")}\n`);
		for (const m of PERMISSION_MODES) process.stdout.write(`  ${m === current ? c.green("●") : c.dim("·")} ${pad(m, 6)} ${c.dim(PERMISSION_MODE_INFO[m].detail)}\n`);
		return;
	}
	const mode = permissionModeOf(want.toLowerCase());
	if (!mode) throw new UsageError(`unknown mode "${want}" (${PERMISSION_MODES.join(", ")})`);
	if (!(await setSessionPermissionMode(meta, mode))) throw new Error(meta.permissionMode ? "the session host is unreachable" : "this session's host predates permission modes; restart it (omp-vs stop + resume) to switch live");
	process.stdout.write(`${c.green(PERMISSION_MODE_INFO[mode].label)} ${shortId(meta.id)} ${meta.title}${meta.status === "stopped" ? c.dim(" (applies when resumed)") : ""}\n`);
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
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify(s)}\n`);
		return;
	}
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

// ---------- remote access (phone app + HTTP API, docs/REMOTE-API.md) ----------

function printRemote(s: RemoteStatus): void {
	const state = !s.enabled ? c.dim("off") : s.listening ? c.green("on") : c.red("not listening");
	const rows = [`remote  ${state}  ${c.dim(`bind ${s.bind} · port ${s.listening?.port ?? s.port}`)}`];
	if (s.url) rows.push(`url     ${s.url}`);
	if (s.error) rows.push(`error   ${c.red(s.error)}`);
	if (s.listening && s.bind === "lan") rows.push(c.yellow("plain HTTP: anyone on this network can see the traffic; prefer --bind tailscale"));
	if (s.url) rows.push(c.dim("pair a phone: omp-vs remote qr (scan it, or open the pairing URL on the phone)"));
	process.stdout.write(`${rows.join("\n")}\n`);
}

async function cmdRemote(args: Args): Promise<number> {
	const sub = args._[0] ?? "status";
	const apply = async () => (await backend()).call("remote", {});
	switch (sub) {
		case "on": {
			const bind = value(args, "bind");
			if (bind !== undefined && !isRemoteBind(bind)) throw new UsageError("--bind must be tailscale, lan, localhost or an IP address");
			const portText = value(args, "port");
			const port = portText === undefined ? undefined : Number(portText);
			if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new UsageError("--port must be 1-65535");
			updateRemoteConfig({ enabled: true, ...(bind !== undefined && isRemoteBind(bind) ? { bind } : {}), ...(port !== undefined ? { port } : {}) });
			const s = await apply();
			printRemote(s);
			return s.listening ? 0 : 1;
		}
		case "off":
			updateRemoteConfig({ enabled: false });
			await apply();
			process.stdout.write(`remote  ${c.dim("off")}\n`);
			return 0;
		case "status": {
			const s = await apply();
			printRemote(s);
			return s.enabled && !s.listening ? 1 : 0;
		}
		case "qr": {
			if (!readRemoteConfig().enabled) throw new Error("remote access is off (omp-vs remote on)");
			const s = await apply();
			if (!s.url) throw new Error(s.error ?? "remote access is not listening");
			const url = pairingUrl(s.url, readRemoteConfig().token);
			process.stdout.write(`${qrHalfBlocks(url, colorEnabled())}\n${url}\n${c.dim("Scan with the phone's camera, or open the URL on it. Anyone with this URL can control your sessions.")}\n`);
			return 0;
		}
		case "rotate": {
			const cfg = updateRemoteConfig({ token: newRemoteToken() });
			await apply();
			process.stdout.write(`${c.green("new token")} · paired phones must pair again${cfg.enabled ? c.dim(" (omp-vs remote qr)") : ""}\n`);
			return 0;
		}
		default:
			throw new UsageError(`unknown remote command "${sub}" (on, off, status, qr, rotate)`);
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
  new [dir] [-p prompt|-] [--task t [--sub s]… [--notes n|-] [--at when]] [--title t] [--mode m]
      [--tag t]… [--group g] [--model m] [--priority p] [--detach] [--json]
                                  start a session (no prompt: attach to it); --task queues it,
                                  --at schedules it (+30m, 14:30, ISO time); --json prints its id
  show [session] [--json]         state, waiting question and last reply (for scripts and agents)
  wait [session] [--timeout 30m] [--json]
                                  block until it is idle (exit 0), needs input (3) or stopped (4)
  answer <session> <choice>       answer its waiting question: option number/text, yes/no, text
  projects [--json]               folders sessions ran in, newest first
  attach [session]                chat in the terminal (Ctrl-C aborts a turn, Ctrl-D detaches)
  send <session> <text|-> [--follow-up] [-w|--wait]
                                  prompt a session (resumes it if stopped); --wait streams the reply
  tail [session] [-n N] [-f]      last messages; -f follows live output
  stop|resume <session>…          stop or resume sessions
  abort [session]                 abort the current turn
  mode [session] [ask|edits|plan|auto]
                                  show or switch the permission mode (live, also while working)
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
  sched [--json]                  status
  sched set <n>                   max concurrent queued tasks (0 = unlimited)
  sched pause|resume
  sched stop-when-done <on|off>   stop sessions the server launched once their queue is done

${c.bold("Server")}  ${c.dim("(started on demand; launches queued sessions when slots free up)")}
  server status|start|stop|restart|log [-f]|install|uninstall

${c.bold("Remote")}  ${c.dim("(phone app + HTTP API on this machine; prefer Tailscale, LAN is plain HTTP)")}
  remote on [--bind tailscale|lan|localhost|<ip>] [--port n]
                                  turn on remote access (default bind tailscale, port 7413)
  remote off|status|qr|rotate     turn off · show state · pairing QR + URL · new token (unpairs phones)

${c.bold("Agents")}  ${c.dim("(the omp-sessions skill teaches other agents to use omp-vs)")}
  skill [status]                  where it is installed
  skill install [agents|claude|codex]… [--dir d] [--force]
                                  install or update it (default: every platform found)
  skill uninstall [platform]… | print | path

${c.bold("Hermes")}  ${c.dim("(omp-sessions plugin: omp tools, notifications and a kanban lane in Hermes Agent; docs/HERMES.md)")}
  hermes install [--force]        copy the plugin into $HERMES_HOME/plugins (~/.hermes) and enable it
  hermes uninstall | status [--json]
      [--profile <name>]… [--all-profiles]
                                  plugins are per Hermes profile; default: $HERMES_HOME or ~/.hermes

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
		case "mode":
			await cmdMode(args);
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
		case "remote":
			return cmdRemote(args);
		case "show":
		case "status":
			return cmdShow(args);
		case "wait":
			return cmdWait(args);
		case "answer":
			return cmdAnswer(args);
		case "projects":
			return cmdProjects(args);
		case "skill":
		case "skills":
			return cmdSkill(args);
		case "hermes":
			return cmdHermes(args);
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
