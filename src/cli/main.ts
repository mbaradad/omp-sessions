// omp-sessions: the omp Sessions CLI. Lists, starts, chats with and organizes the same background
// sessions the VS Code extension shows, through the omp-sessions server (started on demand) or, when
// it can't run, directly in-process.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Control, resolveSession, waitForHost } from "../shared/control";
import { HostConnection } from "../shared/host-conn";
import { type HostLauncher, findOmp, launcherSettingsPath, listMetas, readHostVersion, readLauncherSettings, readMeta, sessionPermissionMode, setSessionPermissionMode, writeLauncherSettings } from "../shared/launch";
import { type ListFilter, filterSessions, hasFilter } from "../shared/list-filter";
import { listModels, sessionModel, setSessionModel } from "../shared/models";
import { PERMISSION_MODES, PERMISSION_MODE_INFO, isPermissionMode, permissionModeOf } from "../shared/permissions";
import { ORG_COLORS, PRIORITIES, isOrgColor, isPriority } from "../shared/organize";
import { DIALOG_METHODS, type QueueOp, type QueueTask, type SessionMeta, type TaskQueue, type UiRequest, stateRoot } from "../shared/protocol";
import { type RemoteStatus, isRemoteBind, newRemoteToken, normalizePublicUrl, pairingUrl, readRemoteConfig, trustsProxy, updateRemoteConfig } from "../shared/remote";
import { qrHalfBlocks } from "../shared/remote-qr";
import { recentProjects } from "../shared/projects";
import { transcriptMessages } from "../shared/remote-snapshot";
import { type EnsureServerOptions, LAUNCHD_LABEL, SYSTEMD_UNIT, ServerClient, type ServiceInstall, compareVersions, ensureServer, installUserService, readServerLog, removeServiceUnit, serviceKind, serviceUnitPaths, stopServer } from "../shared/server-client";
import { migrateLegacyLauncher, removeLegacyService } from "../shared/rename-migration";
import { COLUMNS, type OpName, type ServerOps, type SessionInfo, serverLogPath, serverSocketPath } from "../shared/server-protocol";
import { type MachineStatus, machineStatus, ompState } from "../shared/server-status";
import { type AgentState, SETTLED_STATES, type SessionReport, agentState, dialogAnswer, sessionReport } from "../shared/session-report";
import { SKILL_FILE, SKILL_NAME, SKILL_PLATFORMS, type SkillTarget, detectedPlatforms, installSkill, isSkillPlatform, skillTargets, uninstallSkill } from "../shared/agent-skill";
import { AFTER_INSTALL, PLUGIN_BUNDLE, disablePlugin, findHermes, hermesLookup, pluginReport, pluginTarget, reportLine, resolveTargets, uninstallPlugin, updatePlugin } from "../shared/hermes-plugin";
import { OPEN_REQUEST_TTL_MS, folderProblem, folderTarget, isAuthority, requestOpen, vscodeFolderLink, vscodeLink, windowFor } from "../shared/vscode-open";
import { MAX_NOTES, MAX_TITLE } from "../shared/queue";
import { type Args, UsageError, checkFlags, flag, parseArgs, parseWhen, value } from "./args";
import { attach } from "./attach";
import { MIGRATE_HELP, cmdMigrate } from "./migrate";
import { renderMessage } from "./render";
import { PRIORITY_MARK, ago, c, colorEnabled, confirm, errorLine, oneLine, pad, priorityLabel, setColor, shortId, termWidth, truncate } from "./term";

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
	if (!omp) throw new Error("could not find the omp executable (install omp, or run: omp-sessions config set omp.path <path to omp>)");
	return { hostScript: HOST_SCRIPT, omp, hostVersion: VERSION, extraArgs: settings.extraArgs ?? [], nodePath: process.execPath };
}

/** The machine overview built from the files: no server runs (`status` never starts one), or one too old to tell. */
function localStatus(control: Control, server?: { pid: number; version: string; startedAt: number }): MachineStatus {
	const remoteConfig = readRemoteConfig();
	const { enabled, bind, port } = remoteConfig;
	return machineStatus({ server, infos: control.list({ all: true }), scheduler: { ...control.scheduler({}), server: !!server }, remote: { enabled, bind, port }, remoteConfig });
}

function localBackend(): Backend {
	const control = new Control({ launcher, serverUp: () => false, clientName: "omp-sessions-server/cli" });
	const ops: { [K in OpName]: (args: ServerOps[K]["args"]) => ServerOps[K]["result"] | Promise<ServerOps[K]["result"]> } = {
		ping: () => ({ pid: process.pid, version: VERSION, root: stateRoot(), startedAt: Date.now() }),
		list: a => filterSessions(control.list(a), a),
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
			return { enabled, bind, port, ...(enabled ? { error: "the omp-sessions server is not running (it serves remote access)" } : {}) };
		},
		status: () => localStatus(control),
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

/** Says once, on stderr, that this start installed the login service (the server now survives reboots). */
function serviceInstalled(i: ServiceInstall): void {
	const how = i.ok ? "it starts the server at login and after a crash" : `it couldn't be started (${i.kind === "systemd" ? `systemctl --user enable --now ${SYSTEMD_UNIT}` : "launchctl bootstrap"})`;
	process.stderr.write(c.dim(`omp-sessions: installed the server as a ${i.kind} user service (${i.file}); ${how}. Opt out: omp-sessions server uninstall && omp-sessions config set service off\n`));
}

/**
 * How this CLI starts the server. VS Code's own runtime (the launcher sets ELECTRON_RUN_AS_NODE when it
 * runs us with it) is replaced by VS Code updates, so no new login service is written for it.
 */
const SERVER_START: EnsureServerOptions = {
	onServiceInstalled: serviceInstalled,
	onServiceRepaired: i => process.stderr.write(c.dim(`omp-sessions: the ${i.kind} user service ran a node or server.js that is gone; it now runs ${process.execPath} (${i.file})\n`)),
	installService: !process.env.ELECTRON_RUN_AS_NODE && !process.versions.electron,
};

/** The server when it runs (started on demand, upgraded when older than this CLI), else in-process. */
function backend(): Promise<Backend> {
	backendPromise ??= (async () => {
		if (process.env.OMP_SESSIONS_NO_SERVER) return localBackend();
		const canStart = fs.existsSync(SERVER_SCRIPT);
		const start = () => ensureServer(SERVER_SCRIPT, process.execPath, undefined, SERVER_START);
		let client = canStart ? await start() : await ServerClient.connect();
		if (client && canStart) {
			try {
				const info = await client.request("ping", {}, 3000);
				if (compareVersions(info.version, VERSION) < 0) {
					client.close();
					await stopServer();
					client = await start();
				}
			} catch {
				/* keep the connection we have */
			}
		}
		if (client) return serverBackend(client);
		process.stderr.write(c.dim(`omp-sessions: the server did not start (see ${serverLogPath()}); running without it\n`));
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
	if (!(await waitForHost(meta.id))) throw new Error(`session ${shortId(meta.id)} did not start (omp-sessions tail ${shortId(meta.id)})`);
	return readMeta(meta.id) ?? meta;
}

// ---------- formatting ----------

/** `show`'s state colours, used by every listing. */
const STATE_COLOR: Record<AgentState, (s: string) => string> = { queued: c.blue, scheduled: c.blue, starting: c.dim, working: c.yellow, needs_input: c.magenta, idle: c.green, interrupted: c.red, stopped: c.dim };

function statusText(info: SessionInfo): string {
	if (info.waiting) return c.blue(info.waiting.launch ? `queued #${info.waiting.position}` : `waiting #${info.waiting.position}`);
	if (info.meta.authProblem) return c.red("no model");
	const state = agentState(info);
	return STATE_COLOR[state](state === "needs_input" ? "needs input" : state);
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
	const fixed = 9 + 13 + 3 + 9 + 16 + 8 + 7;
	const titleWidth = Math.max(16, width - fixed);
	process.stdout.write(c.dim(`${pad("ID", 9)}${pad("STATUS", 13)}${pad("", 3)}${pad("TITLE", titleWidth)}${pad("QUEUE", 9)}${pad("PROJECT", 16)}${pad("ACTIVE", 8)}COST\n`));
	for (const info of infos) {
		const m = info.meta;
		const prio = info.priority === "urgent" ? c.red(PRIORITY_MARK.urgent) : info.priority === "high" ? c.yellow(PRIORITY_MARK.high) : c.dim(PRIORITY_MARK[info.priority] ?? "  ");
		const title = truncate(oneLine(m.title), titleWidth - 1);
		const group = info.group ? c.dim(` [${info.group}]`) : "";
		process.stdout.write(
			`${pad(c.dim(shortId(m.id)), 9)}${pad(statusText(info), 13)}${pad(prio, 3)}${pad(`${m.status === "stopped" ? c.dim(title) : title}${group}`, titleWidth)}${pad(queueText(info.queue), 9)}${pad(c.dim(truncate(path.basename(m.cwd), 15)), 16)}${pad(c.dim(ago(m.updatedAt)), 8)}${c.dim(costText(m.cost))}\n`,
		);
	}
}

// ---------- commands ----------

async function cmdList(args: Args): Promise<void> {
	const all = flag(args, "all");
	const cwd = value(args, "cwd");
	const filter: ListFilter = {
		project: value(args, "project"),
		cwd: cwd === undefined ? undefined : path.resolve(cwd),
		group: value(args, "group"),
		tags: args.multi.get("tag"),
		state: value(args, "state"),
	};
	const b = await backend();
	const infos = await b.call("list", { all, ...filter });
	// Finished sessions are hidden unless --all or --state; ones with work ahead (queued, scheduled, interrupted) stay.
	const shown = all || filter.state ? infos : infos.filter(i => agentState(i) !== "stopped");
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
		return;
	}
	if (shown.length === 0) process.stdout.write(c.dim(hasFilter(filter) ? "No matching sessions.\n" : all ? "No sessions.\n" : "No active sessions.\n"));
	else printTable(shown);
	const hidden = infos.length - shown.length;
	if (hidden > 0) process.stdout.write(c.dim(`${hidden} finished session${hidden === 1 ? "" : "s"} hidden · omp-sessions ls --all\n`));
	if (shown.some(i => i.waiting)) {
		const s = await b.call("scheduler", {});
		const limit = s.maxConcurrent ? `limit ${s.maxConcurrent}` : "no limit";
		process.stdout.write(c.dim(`${s.running} queued task${s.running === 1 ? "" : "s"} running, ${s.waiting} waiting (${limit}${s.paused ? ", paused" : ""})${s.server ? "" : " · server not running: queued sessions won't start"}\n`));
	}
}

async function cmdBoard(args: Args): Promise<void> {
	const all = flag(args, "all");
	const infos = await (await backend()).call("list", { all: false });
	// Interrupted sessions get a column of their own (someone has to continue them); the rest of the
	// Stopped column only with --all.
	const columnOf = (i: SessionInfo): string => (agentState(i) === "interrupted" ? "interrupted" : i.column);
	const ids: Array<{ id: string; label: string }> = [...COLUMNS.filter(col => col.id !== "stopped"), { id: "interrupted", label: "Interrupted" }, ...(all ? COLUMNS.filter(col => col.id === "stopped") : [])];
	const columns = ids.map(col => {
		const cards = infos.filter(i => columnOf(i) === col.id).sort((a, b) => a.order - b.order);
		if (col.id === "waiting") cards.sort((a, b) => (a.waiting?.position ?? 0) - (b.waiting?.position ?? 0));
		return { ...col, sessions: cards };
	});
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify({ columns }, null, 2)}\n`);
		return;
	}
	const width = termWidth();
	for (const col of columns) {
		process.stdout.write(`${c.bold(col.label)} ${c.dim(`(${col.sessions.length})`)}\n`);
		for (const info of col.sessions) {
			const tags = [info.priority !== "normal" ? priorityLabel(info.priority) : "", queueText(info.queue), info.group ? c.dim(`[${info.group}]`) : ""].filter(Boolean).join(" ");
			const title = truncate(oneLine(info.meta.title), Math.max(16, width - 14 - 30));
			process.stdout.write(`  ${c.dim(shortId(info.meta.id))}  ${title}${tags ? `  ${tags}` : ""}\n`);
		}
		if (col.sessions.length === 0) process.stdout.write(c.dim("  —\n"));
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
	const promptArg = value(args, "prompt");
	const task = value(args, "task");
	const notesArg = value(args, "notes");
	if (notesArg !== undefined && !task) throw new UsageError("--notes belong to a queued task: add --task");
	if (promptArg === "-" && notesArg === "-") throw new UsageError("only one of --prompt and --notes can read stdin");
	const prompt = promptArg === "-" ? await readStdin() : promptArg;
	const notes = notesArg === "-" ? await readStdin() : notesArg;
	const atArg = value(args, "at");
	if (atArg !== undefined && !task) throw new UsageError("--at schedules a queued task: add --task");
	const startAt = atArg === undefined ? undefined : parseWhen(atArg);
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
	// A started session's meta is written by its host as it comes up: wait for it, so the title is known and
	// the next command (`omp-sessions wait .`, `show .`) finds the session.
	if (!task && res.started && !(await waitForHost(res.id))) throw new Error(`session ${shortId(res.id)} did not start (omp-sessions tail ${shortId(res.id)})`);
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
	return meta ? attach(meta, { history: 20, readOnly: false }) : 1;
}

async function cmdSend(args: Args): Promise<number> {
	const meta = findSession(args._[0]);
	let text = args._.slice(1).join(" ");
	if (text === "-" || (!text && !process.stdin.isTTY)) text = await readStdin();
	if (!text) throw new UsageError("nothing to send");
	if (flag(args, "steer") && flag(args, "follow-up")) throw new UsageError("--steer or --follow-up, not both");
	// While omp works, a prompt waits for the turn to end (follow-up) unless --steer redirects the turn.
	const mode = flag(args, "steer") ? "steer" : "followUp";
	const json = flag(args, "json");
	if (flag(args, "wait") && !json) return attach(await running(meta), { history: 0, readOnly: true, prompt: text, steer: mode === "steer" });
	await (await backend()).call("prompt", { id: meta.id, text, mode });
	if (flag(args, "wait")) return waitFor(meta, undefined, true);
	if (json) process.stdout.write(`${JSON.stringify({ id: meta.id, sent: true, mode })}\n`);
	else process.stdout.write(`${c.green("sent")} ${shortId(meta.id)} ${meta.title}\n`);
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
		const { conn, snapshot } = await HostConnection.open(meta.socket, "omp-sessions-tail");
		conn.close();
		messages = snapshot.messages;
	} else messages = transcriptMessages(meta.ompSessionFile);
	const width = termWidth();
	for (const m of messages.slice(-lines)) for (const l of renderMessage(m, width)) process.stdout.write(`${l}\n`);
	if (meta.status === "stopped") {
		process.stdout.write(c.dim(`session stopped${meta.exitReason ? `: ${meta.exitReason}` : ""} (${ago(meta.updatedAt)} ago)\n`));
		if (flag(args, "follow")) process.stdout.write(c.dim(`omp-sessions resume ${shortId(meta.id)} to continue it\n`));
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
			const { conn, snapshot } = await HostConnection.open(info.meta.socket, "omp-sessions-show");
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

function printReport(r: SessionReport): void {
	const q = r.queue.total ? c.dim(` · queue ${r.queue.done}/${r.queue.total}`) : "";
	process.stdout.write(`${STATE_COLOR[r.state](r.state.replace("_", " "))} ${shortId(r.id)} ${c.bold(r.title)}${q}${r.cost ? c.dim(` · $${r.cost.toFixed(2)}`) : ""}\n`);
	if (r.question) {
		process.stdout.write(`${c.magenta(`? ${r.question.title}`)}${r.question.message ? `\n${r.question.message}` : ""}\n`);
		r.question.options?.forEach((o, i) => process.stdout.write(`  ${c.bold(String(i + 1))}. ${o}\n`));
		process.stdout.write(c.dim(`answer: omp-sessions answer ${shortId(r.id)} <choice>\n`));
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

/**
 * Asks a VS Code window on this machine to open the session, or opens a folder (`--folder <dir>` exactly;
 * a path argument naming a folder: its checkout); prints the link that brings it up.
 */
function cmdVscode(args: Args): number {
	const authority = value(args, "authority");
	if (authority !== undefined && authority !== "" && !isAuthority(authority)) throw new UsageError(`--authority is a VS Code remote authority like ssh-remote+box or wsl+Ubuntu ("" for a local window), not "${authority}"`);
	const pick = (cwd: string) => windowFor({ cwd, ...(authority !== undefined ? { authority } : {}) });
	const folderArg = value(args, "folder");
	const arg = args._[0];
	// "." and title words name sessions; a path with a separator naming a folder is a folder.
	const pathArg = arg !== undefined && /[\\/]/.test(arg) && fs.statSync(path.resolve(arg), { throwIfNoEntry: false })?.isDirectory() ? arg : undefined;
	if (folderArg !== undefined || pathArg !== undefined) {
		const dir = path.resolve(folderArg ?? pathArg ?? "");
		const problem = folderProblem(dir);
		if (problem) throw new Error(problem);
		const win = pick(dir);
		const exact = folderArg !== undefined;
		const folder = exact ? dir : folderTarget(dir, win);
		const url = vscodeFolderLink(dir, win, { exact });
		if (flag(args, "json")) {
			process.stdout.write(`${JSON.stringify({ folder, url, authority: win?.authority ?? null, windowAt: win?.at || null }, null, 2)}\n`);
			return 0;
		}
		process.stdout.write(`${url}\n${c.dim(`Open this link on the computer running VS Code: it opens ${folder}, or focuses the window that has it.`)}\n`);
		return 0;
	}
	const meta = findSession(arg ?? ".");
	const win = pick(meta.cwd);
	requestOpen(meta.id);
	const url = vscodeLink(meta, win);
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify({ id: meta.id, url, authority: win?.authority ?? null, windowAt: win?.at || null }, null, 2)}\n`);
		return 0;
	}
	const where = !win ? "no VS Code window recorded on this machine yet" : !win.at ? `no window of ${win.authority || "local VS Code"} recorded yet` : `last used: ${win.authority || "a local window"}, ${ago(win.at)} ago`;
	process.stdout.write(`${url}\n${c.dim(`Open this link on the computer running VS Code (${where}); the window takes the request within ${OPEN_REQUEST_TTL_MS / 60_000} minutes.`)}\n`);
	return 0;
}

/** `wait` exit codes: why it stopped waiting. */
const WAIT_EXIT: Record<AgentState, number> = { idle: 0, needs_input: 3, stopped: 4, interrupted: 4, scheduled: 5, queued: 124, starting: 124, working: 124 };
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
	return waitFor(meta, timeout, flag(args, "json"));
}

/** Waits until the session settles (or `timeout` ms pass), prints its report; the exit code says why.
 *  Times are on the monotonic clock: a stepping wall clock (NTP, WSL2) must not stretch or cut the wait. */
async function waitFor(meta: SessionMeta, timeout: number | undefined, json: boolean): Promise<number> {
	const b = await backend();
	const deadline = timeout === undefined ? Infinity : performance.now() + timeout;
	let settledSince: number | undefined;
	for (;;) {
		const info = (await b.call("list", { all: true })).find(i => i.meta.id === meta.id);
		if (!info) throw new Error(`session ${shortId(meta.id)} is gone`);
		const now = performance.now();
		if (SETTLED_STATES[agentState(info)]) {
			settledSince ??= now;
			if (now - settledSince >= SETTLE_MS) break;
		} else settledSince = undefined;
		if (now >= deadline) break;
		await sleep(1000);
	}
	// The exit code follows the printed report (a start time may pass, or a turn end, between the two reads).
	const report = await reportFor(meta);
	if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else printReport(report);
	return SETTLED_STATES[report.state] ? WAIT_EXIT[report.state] : 124;
}

async function cmdAnswer(args: Args): Promise<number> {
	const meta = findSession(args._[0]);
	const text = args._.slice(1).join(" ");
	// The host's own pending dialogs decide, not meta.json: `send --wait` returns on the dialog frame,
	// before the host has written its `waiting` status.
	const notWaiting = () => new Error(`${shortId(meta.id)} ${meta.title} is not waiting for an answer (${meta.status === "waiting" ? "no question is open" : meta.status})`);
	if (meta.status === "stopped") throw notWaiting();
	const { conn, snapshot } = await HostConnection.open(meta.socket, "omp-sessions-answer");
	try {
		const req = snapshot.pendingUi.find(r => DIALOG_METHODS[r.method]);
		if (!req) throw notWaiting();
		// The caller checked this question (e.g. that it is no approval); another one may have come first since.
		const expected = value(args, "question");
		if (expected !== undefined && req.id !== expected) throw new Error(`the question changed (now ${req.id}: ${typeof req.title === "string" && req.title ? req.title : req.method})`);
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
		if (!(await resolved)) throw new Error("the session did not take the answer (answer it in VS Code, the phone app or omp-sessions attach)");
		const title = typeof req.title === "string" && req.title ? req.title : req.method;
		if (flag(args, "json")) process.stdout.write(`${JSON.stringify({ id: meta.id, answered: true, question: req.id, title })}\n`);
		else process.stdout.write(`${c.green("answered")} ${shortId(meta.id)} ${title}\n`);
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
	if (!fs.existsSync(file)) throw new Error(`${SKILL_FILE} is missing next to the CLI (${__dirname}); reinstall omp-sessions`);
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
			if (skipped) process.stdout.write(c.dim("skipped: a SKILL.md omp-sessions didn't write is in the way (--force replaces it)\n"));
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
				const u = updatePlugin(source, t, hermes, { force: flag(args, "force") });
				const mark = u.outcome === "skipped" || u.outcome === "busy" ? c.yellow(u.outcome) : u.outcome === "unchanged" ? c.dim(u.outcome) : c.green(u.outcome);
				process.stdout.write(`${pad(mark, 10)} ${several || t.label !== "default" ? `${c.bold(t.label)} ` : ""}${dir}\n`);
				if (u.outcome === "skipped") {
					process.stdout.write(c.dim("a plugin folder omp-sessions didn't write is in the way (--force replaces it)\n"));
					failed = true;
					continue;
				}
				if (u.outcome === "busy") {
					process.stdout.write(c.dim("another omp-sessions or VS Code window is installing the plugin there right now; run it again in a moment\n"));
					failed = true;
					continue;
				}
				const run = u.reload ?? u.enable;
				if (run?.output) process.stdout.write(`${run.output}\n`);
				if (u.reload?.ok) process.stdout.write(`${c.green("reloaded in the running gateway")} ${c.dim("(hooks and commands now, tools in new Hermes sessions)")}\n`);
				if (u.dashboardChanged) process.stdout.write(c.dim("the dashboard's omp Sessions page backend changed: it loads when the dashboard restarts\n"));
				if (u.leftDisabled) process.stdout.write(`${c.red(`the plugin was left DISABLED in profile ${t.label}`)} (enabling it again failed twice): run ${c.bold(`hermes -p ${t.label} plugins enable omp-sessions`)}\n`);
				if (run && !run.ok) failed = true;
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
				process.stdout.write(uninstallPlugin(dir) ? `${c.yellow("removed")} ${dir}\n` : c.dim(`nothing omp-sessions installed at ${dir}\n`));
			}
			return 0;
		}
		case "status": {
			const reports = targets.map(t => pluginReport(source, t));
			if (flag(args, "json")) {
				process.stdout.write(`${JSON.stringify({ hermes: hermes ?? null, profiles: reports })}\n`);
				return 0;
			}
			process.stdout.write(`hermes: ${hermes ?? c.yellow(`not found (${hermesLookup()})`)}\n`);
			for (const r of reports) process.stdout.write(`${reportLine(r)}\n`);
			const lanes = reports.filter(r => r.lane).map(r => r.label);
			if (lanes.length > 1) process.stdout.write(c.yellow(`the kanban lane is on in ${lanes.join(", ")}: they take turns (one machine-wide lock), but keep it on in one profile so one set of lane settings applies\n`));
			return 0;
		}
		default:
			throw new UsageError(`unknown hermes command "${sub}" (install, uninstall, status)`);
	}
}

/** Stops sessions; exit 1 when one of them wasn't running. */
async function cmdStop(args: Args): Promise<number> {
	if (args._.length === 0) throw new UsageError("which session?");
	const b = await backend();
	const results: Array<{ id: string; title: string; stopped: boolean; unqueued: boolean }> = [];
	for (const q of args._) {
		const meta = findSession(q);
		const res = await b.call("stop", { id: meta.id });
		results.push({ id: meta.id, title: meta.title, stopped: res.stopped, unqueued: res.unqueued === true });
		if (flag(args, "json")) continue;
		if (res.stopped) process.stdout.write(`${c.green("stopped")} ${shortId(meta.id)} ${meta.title}${res.unqueued ? c.dim(" (its queue is paused)") : ""}\n`);
		else if (res.unqueued) process.stdout.write(`${c.green("unqueued")} ${shortId(meta.id)} ${meta.title} ${c.dim("(it won't start by itself; omp-sessions queue <session> start)")}\n`);
		else process.stderr.write(`omp-sessions: ${shortId(meta.id)} ${meta.title} is not running (already stopped)\n`);
	}
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify(results)}\n`);
	return results.every(r => r.stopped || r.unqueued) ? 0 : 1;
}

async function cmdResume(args: Args): Promise<number> {
	if (args._.length === 0) throw new UsageError("which session?");
	const b = await backend();
	const results: Array<{ id: string; title: string; started: boolean }> = [];
	for (const q of args._) {
		const meta = findSession(q);
		const res = await b.call("resume", { id: meta.id });
		results.push({ id: meta.id, title: meta.title, started: res.started });
		if (!flag(args, "json")) process.stdout.write(`${res.started ? c.green("resumed") : c.dim("already running")} ${shortId(meta.id)} ${meta.title}\n`);
	}
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify(results)}\n`);
	return 0;
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

/** Aborts the current turn; exit 1 when there is none to abort (the session isn't running). */
async function cmdAbort(args: Args): Promise<number> {
	const meta = findSession(args._[0] ?? ".");
	const res = await (await backend()).call("abort", { id: meta.id });
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify({ id: meta.id, aborted: res.sent })}\n`);
	else if (res.sent) process.stdout.write(`${c.yellow("aborted")} ${shortId(meta.id)} ${meta.title}\n`);
	if (!res.sent) process.stderr.write(`omp-sessions: ${shortId(meta.id)} ${meta.title} is not running\n`);
	return res.sent ? 0 : 1;
}

async function cmdMode(args: Args): Promise<void> {
	// `omp-sessions mode plan` = the latest session in this folder.
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
	if (!(await setSessionPermissionMode(meta, mode))) throw new Error(meta.permissionMode ? "the session host is unreachable" : "this session's host predates permission modes; restart it (omp-sessions stop + resume) to switch live");
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
	if (q.tasks.length === 0) process.stdout.write(c.dim("  no tasks · omp-sessions queue <session> add <task>\n"));
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
	const json = flag(args, "json");
	let ops: QueueOp[];
	switch (sub) {
		case "ls":
		case "list":
			if (json) process.stdout.write(`${JSON.stringify(q, null, 2)}\n`);
			else printQueue(meta, q);
			return;
		case "add": {
			const given = rest.join(" ");
			const notesArg = value(args, "notes");
			const fromStdin = given === "-" || (!given && !process.stdin.isTTY && notesArg !== "-");
			if (fromStdin && notesArg === "-") throw new UsageError("only one of the task and --notes can read stdin");
			const text = fromStdin ? await readStdin() : given;
			// From stdin the first line is the title and the rest the notes, so long prompts keep their lines.
			const nl = fromStdin ? text.indexOf("\n") : -1;
			let title = (nl < 0 ? text : text.slice(0, nl)).trim();
			let notes = notesArg === "-" ? await readStdin() : (notesArg ?? (nl < 0 ? "" : text.slice(nl + 1).trim()));
			if (!title) throw new UsageError("queue add <task title | -> [--notes <text | ->]");
			// A title too long to keep goes into the notes whole (omp gets title and notes).
			if (title.length > MAX_TITLE) {
				notes = notes ? `${title}\n\n${notes}` : title;
				title = `${title.slice(0, 120).trimEnd()}…`;
			}
			if (notes.length > MAX_NOTES) throw new UsageError(`the notes are ${notes.length} characters; a task takes up to ${MAX_NOTES}`);
			ops = [{ op: "add", title, ...(notes ? { notes } : {}), subtasks: args.multi.get("sub"), ...(flag(args, "top") ? { index: 0 } : {}) }];
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
		case "at":
			ops = [{ op: "schedule", at: rest[0] === "off" || rest[0] === "none" ? null : parseWhen(rest.join(" ")) }];
			break;
		default:
			throw new UsageError(`unknown queue command "${sub}" (ls, add, run, start, pause, clear, retry, rm, done, skip, at)`);
	}
	const next = await b.call("queue", { id: meta.id, ops });
	if (json) {
		process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
		return;
	}
	printQueue(readMeta(meta.id) ?? meta, next);
	if (!b.server && meta.status === "stopped" && next.autoRun && next.tasks.some(t => t.status === "pending")) {
		process.stdout.write(c.dim(`the session is stopped: omp-sessions resume ${shortId(meta.id)} runs the queue (or start the server: omp-sessions server start)\n`));
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
			`scheduled       ${s.scheduled}  ${c.dim("(start at a set time)")}`,
			`paused          ${yes(!!s.paused)}`,
			`stop when done  ${yes(s.stopWhenQueueDone !== false)}  ${c.dim("(sessions the server launched)")}`,
			`server          ${s.server ? c.green("running") : c.yellow("not running")}`,
		].join("\n") + "\n",
	);
}

// ---------- server management ----------

function run(cmd: string, argv: string[]): boolean {
	const r = spawnSync(cmd, argv, { stdio: "inherit" });
	return r.status === 0;
}

async function cmdServer(args: Args): Promise<number> {
	const sub = args._[0] ?? "status";
	switch (sub) {
		case "start": {
			const client = await ensureServer(SERVER_SCRIPT, process.execPath, undefined, SERVER_START);
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
			const client = await ensureServer(SERVER_SCRIPT, process.execPath, undefined, SERVER_START);
			if (!client) throw new Error(`the server did not start (see ${serverLogPath()})`);
			const info = await client.request("ping", {});
			client.close();
			process.stdout.write(`${c.green("running")} pid ${info.pid} · ${info.version}\n`);
			return 0;
		}
		case "status": {
			const client = await ServerClient.connect();
			const info = client ? await client.request("ping", {}).finally(() => client.close()) : undefined;
			if (flag(args, "json")) {
				process.stdout.write(`${JSON.stringify({ running: !!info, ...(info ? { pid: info.pid, version: info.version, startedAt: info.startedAt } : {}), socket: serverSocketPath() ?? null, log: serverLogPath() })}\n`);
				return info ? 0 : 3;
			}
			if (!info) {
				process.stdout.write(`${c.yellow("not running")} ${c.dim("· omp-sessions server start (other commands start it on demand)")}\n`);
				return 3;
			}
			process.stdout.write(`${c.green("running")} pid ${info.pid} · ${info.version} · up ${ago(info.startedAt)}\n${c.dim(`socket ${serverSocketPath() ?? "(not recorded)"}\nlog    ${serverLogPath()}`)}\n`);
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
			return await installService();
		case "uninstall":
			return uninstallService();
		default:
			throw new UsageError(`unknown server command "${sub}" (start, stop, restart, status, log [-f], install, uninstall)`);
	}
}

// ---------- remote access (phone app + HTTP API, docs/REMOTE-API.md) ----------

function printRemote(s: RemoteStatus, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(s)}\n`);
		return;
	}
	const state = !s.enabled ? c.dim("off") : s.listening ? c.green("on") : c.red("not listening");
	const rows = [`remote  ${state}  ${c.dim(`bind ${s.bind} · port ${s.listening?.port ?? s.port}`)}`];
	if (s.url) rows.push(`url     ${s.url}`);
	if (s.localUrl) rows.push(`local   ${s.localUrl} ${c.dim("(the proxy in front forwards here)")}`);
	if (s.error) rows.push(`error   ${c.red(s.error)}`);
	if (s.listening && s.bind === "lan" && !s.url?.startsWith("https:")) rows.push(c.yellow("plain HTTP: anyone on this network can see the traffic; prefer --bind tailscale"));
	const cfg = readRemoteConfig();
	if (s.enabled && cfg.publicUrl && !trustsProxy(cfg, s.listening?.host)) {
		rows.push(c.yellow("the public URL's proxy is not trusted (the listener isn't bound to localhost): lockouts apply to the proxy's address as a whole; use --bind localhost"));
	}
	if (s.url) rows.push(c.dim("pair a phone: omp-sessions remote qr (scan it, or open the pairing URL on the phone)"));
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
			const urlText = value(args, "url");
			const publicUrl = urlText === undefined || urlText === "none" ? undefined : normalizePublicUrl(urlText);
			if (urlText !== undefined && urlText !== "none" && !publicUrl) throw new UsageError("--url must be an http(s) address without a path or query, e.g. https://box.tailnet.ts.net (or none)");
			updateRemoteConfig({
				enabled: true,
				...(bind !== undefined && isRemoteBind(bind) ? { bind } : {}),
				...(port !== undefined ? { port } : {}),
				...(urlText !== undefined ? { publicUrl } : {}),
			});
			const s = await apply();
			printRemote(s, flag(args, "json"));
			return s.listening ? 0 : 1;
		}
		case "off": {
			updateRemoteConfig({ enabled: false });
			const s = await apply();
			if (flag(args, "json")) printRemote(s, true);
			else process.stdout.write(`remote  ${c.dim("off")}\n`);
			return 0;
		}
		case "status": {
			const s = await apply();
			printRemote(s, flag(args, "json"));
			return s.enabled && !s.listening ? 1 : 0;
		}
		case "qr": {
			if (!readRemoteConfig().enabled) throw new Error("remote access is off (omp-sessions remote on)");
			const s = await apply();
			if (!s.url) throw new Error(s.error ?? "remote access is not listening");
			const url = pairingUrl(s.url, readRemoteConfig().token);
			process.stdout.write(`${qrHalfBlocks(url, colorEnabled())}\n${url}\n${c.dim("Scan with the phone's camera, or open the URL on it. Anyone with this URL can control your sessions.")}\n`);
			return 0;
		}
		case "rotate": {
			const cfg = updateRemoteConfig({ token: newRemoteToken() });
			await apply();
			process.stdout.write(`${c.green("new token")} · paired phones must pair again${cfg.enabled ? c.dim(" (omp-sessions remote qr)") : ""}\n`);
			return 0;
		}
		default:
			throw new UsageError(`unknown remote command "${sub}" (on, off, status, qr, rotate)`);
	}
}

async function installService(): Promise<number> {
	// What 0.5.0 and earlier installed goes first: the old service would hold the server socket.
	migrateLegacyLauncher();
	removeLegacyService(undefined, undefined, run);
	const installed = await installUserService(SERVER_SCRIPT, process.execPath, run);
	if (!installed) throw new Error("server install supports Linux (systemd) and macOS (launchd); on Windows the server starts on demand");
	const { kind, file, ok } = installed;
	const hint = kind === "systemd" ? `enable it with: systemctl --user enable --now ${SYSTEMD_UNIT}` : `load it with: launchctl bootstrap gui/${os.userInfo().uid} ${file}`;
	process.stdout.write(ok ? `${c.green("installed")} ${file}\n` : `${c.yellow("wrote")} ${file} ${c.dim(`(${hint})`)}\n`);
	return ok ? 0 : 1;
}

function uninstallService(): number {
	const kind = serviceKind();
	const file = kind && serviceUnitPaths()[kind];
	if (!kind || !file || !fs.existsSync(file)) {
		process.stdout.write(c.dim("no service installed\n"));
		return 0;
	}
	removeServiceUnit(kind, file, kind === "systemd" ? SYSTEMD_UNIT : LAUNCHD_LABEL, run);
	process.stdout.write(`${c.green("removed")} ${file}\n`);
	return 0;
}

// ---------- machine status ----------

/** The overview from the running server, else from the files; never starts the server. */
async function machineOverview(): Promise<MachineStatus> {
	const local = (server?: { pid: number; version: string; startedAt: number }) => localStatus(new Control({ launcher, serverUp: () => !!server, clientName: "omp-sessions-server/cli" }), server);
	const client = process.env.OMP_SESSIONS_NO_SERVER ? undefined : await ServerClient.connect();
	if (!client) return local();
	try {
		return await client.request("status", {}, 15_000);
	} catch {
		// A server from before the `status` op.
		const info = await client.request("ping", {}, 3000).catch(() => undefined);
		return local(info);
	} finally {
		client.close();
	}
}

/** Display order of `show` states; any other state follows. */
const STATE_ORDER = ["needs_input", "working", "starting", "queued", "scheduled", "interrupted", "idle", "stopped"];

async function cmdStatus(args: Args): Promise<number> {
	const s = await machineOverview();
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify({ cli: VERSION, ...s }, null, 2)}\n`);
		return s.ok ? 0 : 1;
	}
	const row = (label: string, text: string) => `${c.dim(pad(label, 10))}${text}`;
	const rows = [`${c.bold("omp-sessions")} ${VERSION} ${c.dim(`· home ${s.home}`)}`];
	const srv = s.server;
	if (srv.running) {
		const older = srv.version && compareVersions(srv.version, VERSION) < 0 ? c.yellow(" (older than this CLI: the next command restarts it)") : "";
		rows.push(row("server", `${c.green("running")} pid ${srv.pid} · ${srv.version}${srv.startedAt ? ` · up ${ago(srv.startedAt)}` : ""}${older}`));
	} else rows.push(row("server", `${c.red("not running")} ${c.dim("(omp-sessions server start)")}`));
	const svc = s.service;
	const notInstalled = (): string => {
		const how = `omp-sessions server install sets up a ${svc.kind} service`;
		if (svc.noAutoInstall === "service off") return "not installed (service off: omp-sessions config set service on)";
		if (svc.noAutoInstall) return `not installed (${svc.noAutoInstall}, so it isn't installed by itself; ${how})`;
		return svc.autoInstall ? `not installed (the next on-demand server start installs it; or ${how})` : `not installed (${how})`;
	};
	const missing = [svc.nodeExists === false ? svc.node : undefined, svc.scriptExists === false ? svc.script : undefined].filter(Boolean).map(f => c.red(` · ${f} is missing`));
	rows.push(
		row(
			"service",
			!svc.kind
				? c.dim("none on this platform (the server starts on demand)")
				: !svc.installed
					? c.dim(notInstalled())
					: `${svc.kind} ${svc.servesThisHome ? c.green("installed") : c.yellow(`installed for ${svc.home}, not this home`)}${missing.join("")}${svc.file ? c.dim(` · ${svc.file}`) : ""}`,
		),
	);
	const omp = s.omp;
	const extra = omp.extraArgs.length ? c.dim(` ${omp.extraArgs.join(" ")}`) : "";
	rows.push(row("omp", omp.path ? `${omp.path}${extra}${omp.configured ? c.dim(" (omp.path)") : ""}` : c.red(omp.error ?? "not found")));
	if (omp.path && omp.launchError) rows.push(row("", c.red(`last launch failed: ${omp.launchError}`)));
	rows.push(row("model", omp.defaultModel ?? c.dim("omp's default (omp-sessions config set model <provider/id>)")));
	rows.push(row("mode", omp.defaultMode ?? c.dim("omp's tools.approvalMode, else auto (omp-sessions config set mode <auto|edits|ask|plan>)")));
	const states = Object.entries(s.sessions.byState).sort(([a], [b]) => (STATE_ORDER.indexOf(a) + 1 || 99) - (STATE_ORDER.indexOf(b) + 1 || 99));
	rows.push(row("sessions", `${s.sessions.total}${states.length ? ` · ${states.map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(" · ")}` : ""}${s.sessions.archived ? c.dim(` (${s.sessions.archived} archived)`) : ""}`));
	rows.push(row("tasks", `${s.tasks.pending} pending · ${s.tasks.running} running`));
	const sch = s.scheduler;
	rows.push(row("scheduler", `${sch.maxConcurrent ? `limit ${sch.maxConcurrent}` : "no limit"}${sch.paused ? c.yellow(" · paused") : ""} · ${sch.running} running · ${sch.waiting} waiting · ${sch.scheduled} scheduled`));
	const r = s.remote;
	const remoteText = !r.enabled
		? c.dim("off")
		: r.listening
			? `${c.green("on")} ${r.url ?? ""} ${c.dim(`(bind ${r.bind}; token${r.https ? ", secure cookie" : ""}${r.trustedProxy ? ", behind a trusted proxy" : ""})`)}`
			: c.red(`on, not listening${r.error ? `: ${r.error}` : ""}`);
	rows.push(row("remote", remoteText));
	for (const p of s.problems) rows.push(`${c.red("✗")} ${p}`);
	process.stdout.write(`${rows.join("\n")}\n`);
	return s.ok ? 0 : 1;
}

// ---------- config (launcher.json: how sessions start omp, the default model, the service) ----------

const CONFIG_KEYS = ["omp.path", "omp.extraArgs", "model", "mode", "service"];

/** A key's value as `config get <key> --json` prints it (null: unset). */
function configValue(key: string): unknown {
	const s = readLauncherSettings();
	if (key === "omp.path") return s.ompPath ?? null;
	if (key === "omp.extraArgs") return s.extraArgs ?? [];
	if (key === "model") return s.model ?? null;
	if (key === "mode") return s.mode ?? null;
	return s.service ?? "on";
}

async function cmdConfig(args: Args): Promise<number> {
	const [sub = "get", key, ...rest] = args._;
	if (key !== undefined && !CONFIG_KEYS.includes(key)) throw new UsageError(`unknown setting "${key}" (${CONFIG_KEYS.join(", ")})`);
	const json = flag(args, "json");
	switch (sub) {
		case "get":
		case "list": {
			if (key !== undefined) {
				const v = configValue(key);
				const text = Array.isArray(v) ? v.join(" ") : v === null ? "" : String(v);
				process.stdout.write(json ? `${JSON.stringify(v)}\n` : text ? `${text}\n` : "");
				return 0;
			}
			const omp = ompState();
			if (json) {
				process.stdout.write(`${JSON.stringify({ file: launcherSettingsPath(), ...Object.fromEntries(CONFIG_KEYS.map(k => [k, configValue(k)])), omp: omp.path ?? null, ...(omp.error ? { error: omp.error } : {}) }, null, 2)}\n`);
				return 0;
			}
			const s = readLauncherSettings();
			process.stdout.write(
				[
					`omp.path       ${s.ompPath ?? c.dim("(not set: PATH and the usual install folders)")}`,
					`omp.extraArgs  ${s.extraArgs?.length ? s.extraArgs.join(" ") : c.dim("(none)")}`,
					`model          ${s.model ?? c.dim("(not set: omp's default model)")}`,
					`mode           ${s.mode ?? c.dim("(not set: omp's tools.approvalMode, else auto)")} ${c.dim("(permission mode of new sessions that ask for none)")}`,
					`service        ${s.service ?? "on"} ${c.dim("(off: the server isn't installed as a login service by itself)")}`,
					`omp            ${omp.path ?? c.red(omp.error ?? "not found")}`,
					c.dim(`${launcherSettingsPath()} · VS Code's omp.path / omp.extraArgs settings, when set, write it too`),
				].join("\n") + "\n",
			);
			return 0;
		}
		case "set": {
			if (key === undefined) throw new UsageError(`config set <${CONFIG_KEYS.join("|")}> <value…>`);
			const one = (usage: string): string => {
				if (rest.length !== 1 || !rest[0].trim()) throw new UsageError(usage);
				return rest[0].trim();
			};
			if (key === "omp.path") {
				const p = one("config set omp.path <path to omp>");
				// A relative path would resolve against each session's folder: run whatever file a repository puts there.
				if (/[\\/]/.test(p) && !path.isAbsolute(p) && !p.startsWith("~/")) throw new UsageError("omp.path must be an absolute path, ~/…, or a command name on PATH");
				writeLauncherSettings({ ompPath: p });
			} else if (key === "omp.extraArgs") writeLauncherSettings({ extraArgs: rest });
			else if (key === "model") {
				const m = one("config set model <provider/id | none> [--force] (omp-sessions models lists them)");
				if (m !== "none" && !/^[^/\s]+\/\S+$/.test(m)) throw new UsageError(`a model is provider/id (omp-sessions models lists them), not "${m}"`);
				// Every new session would start with it: only a model omp lists, unless --force (e.g. omp can't list right now).
				if (m !== "none" && !flag(args, "force")) {
					let known: boolean;
					try {
						known = (await listModels(process.cwd())).models.some(x => x.selector === m);
					} catch (err) {
						throw new Error(`could not check the model with omp (${err instanceof Error ? err.message : String(err)}); --force saves it anyway`);
					}
					if (!known) throw new Error(`omp doesn't list the model ${m} (omp-sessions models lists them); --force saves it anyway`);
				}
				writeLauncherSettings({ model: m === "none" ? undefined : m });
			} else if (key === "mode") {
				const v = one("config set mode <auto|edits|ask|plan|none>");
				if (v !== "none" && !isPermissionMode(v)) throw new UsageError("config set mode <auto|edits|ask|plan|none> (auto approves every tool call; edits asks before commands; ask asks for edits and commands; plan is read-only)");
				writeLauncherSettings({ mode: isPermissionMode(v) ? v : undefined });
			} else {
				const v = one("config set service <on|off>");
				if (v !== "on" && v !== "off") throw new UsageError("config set service <on|off>");
				writeLauncherSettings({ service: v });
			}
			break;
		}
		case "unset":
			if (key === undefined) throw new UsageError(`config unset <${CONFIG_KEYS.join("|")}>`);
			writeLauncherSettings(key === "omp.path" ? { ompPath: undefined } : key === "omp.extraArgs" ? { extraArgs: undefined } : key === "model" ? { model: undefined } : key === "mode" ? { mode: undefined } : { service: undefined });
			break;
		default:
			throw new UsageError(`unknown config command "${sub}" (get, set, unset)`);
	}
	if (json) {
		process.stdout.write(`${JSON.stringify(key === undefined ? null : configValue(key))}\n`);
		return 0;
	}
	if (key === "service") {
		process.stdout.write(`${c.green("saved")} service ${configValue("service")} ${c.dim(configValue("service") === "off" ? "(the server still starts on demand; omp-sessions server uninstall removes an installed service)" : "(installed on the next on-demand start)")}\n`);
		return 0;
	}
	const omp = ompState();
	process.stdout.write(`${c.green("saved")} ${c.dim(launcherSettingsPath())} · applies to sessions started from now on\n`);
	if (omp.error) process.stdout.write(`${c.yellow("but:")} ${omp.error}\n`);
	return omp.error ? 1 : 0;
}

// ---------- models ----------

async function cmdModels(args: Args): Promise<number> {
	const list = await listModels(process.cwd(), args._.join(" ") || undefined);
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
		return 0;
	}
	let provider: string | undefined;
	for (const m of list.models) {
		if (m.provider !== provider) process.stdout.write(`${c.bold((provider = m.provider))}\n`);
		const ctx = m.contextWindow ? c.dim(` ${m.contextWindow >= 1_000_000 ? `${+(m.contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(m.contextWindow / 1000)}K`}`) : "";
		process.stdout.write(`  ${m.default ? c.green("●") : " "} ${pad(m.selector, 40)} ${c.dim(m.name)}${ctx}\n`);
	}
	if (!list.models.length) process.stdout.write(c.dim("no models (omp models lists what omp can use; log in to a provider in omp)\n"));
	process.stdout.write(c.dim(`default: ${list.default ?? `omp's own${list.ompDefault ? ` (${list.ompDefault})` : ""}`} · omp-sessions config set model <provider/id>\n`));
	return 0;
}

/** Shows or switches a session's model (a stopped session: from its next resume on). */
async function cmdModel(args: Args): Promise<number> {
	const meta = findSession(args._[0] ?? ".");
	const want = args._[1];
	const json = flag(args, "json");
	if (!want) {
		const model = sessionModel(meta);
		if (json) process.stdout.write(`${JSON.stringify({ id: meta.id, model, running: meta.status !== "stopped" })}\n`);
		else process.stdout.write(`${model ?? c.dim("omp's default")} ${c.dim(`${shortId(meta.id)} ${meta.title}`)}\n`);
		return 0;
	}
	const applied = await setSessionModel(meta, want);
	if (json) process.stdout.write(`${JSON.stringify({ id: meta.id, model: want, applied })}\n`);
	else process.stdout.write(`${c.green(want)} ${shortId(meta.id)} ${meta.title}${applied === "next-resume" ? c.dim(" (from its next resume)") : ""}\n`);
	return 0;
}

// ---------- help ----------

const HELP = `${c.bold("omp-sessions")} — omp Sessions from the terminal ${c.dim(`(${VERSION})`)}

${c.bold("Machine")}
  status [--json]                 server, service, omp, sessions by state, queued tasks, scheduler and
                                  remote access; exit 1 when something is wrong (never starts the server)
  config [get [key]] [--json]     settings (launcher.json): omp.path, omp.extraArgs, model, mode, service
  config set omp.path <path>      an absolute path, ~/…, or a command name on PATH
  config set omp.extraArgs -- <arg>…
  config set model <provider/id|none> [--force]
                                  default model of new sessions (an explicit --model wins; none: omp's);
                                  only a model omp lists, unless --force
  config set mode <auto|edits|ask|plan|none>
                                  permission mode of new sessions that ask for none (an explicit --mode
                                  wins; none: omp's tools.approvalMode, else auto)
  config set service <on|off>     off: never install the login service by itself · config unset <key>
  models [search] [--json]        the models omp can use (● = the default)
  version [--json]                this CLI and the running server (also --version, -v)

${c.bold("Sessions")}  ${c.dim("<session> = id, id prefix, title words, or . (latest session in this folder)")}
  ls [-a|--all] [--json] [--project p] [--cwd dir] [--group g] [--tag t]… [--state s]
                                  lists sessions that are active or have work ahead (--all: also finished
                                  and archived); --project: a folder or project root, by name or path, as
                                  projects lists them; --state: a show state (working, needs_input, idle,
                                  queued, scheduled, interrupted, stopped), else a board column or status
  board [--all] [--json]          sessions by column: waiting, scheduled, working, needs input, idle,
                                  interrupted (--all: also stopped)
  new [dir] [-p prompt|-] [--task t [--sub s]… [--notes n|-] [--at when]] [--title t] [--mode m]
      [--tag t]… [--group g] [--model m] [--priority p] [--detach] [--json]
                                  start a session (no prompt: attach to it); --task queues it,
                                  --at schedules it (+30m, 14:30, ISO time); --json prints its id
  show [session] [--json]         state, waiting question and last reply (for scripts and agents)
  wait [session] [--timeout 30m] [--json]
                                  block until it settles: idle (exit 0), needs input (3), stopped or
                                  interrupted (4), scheduled (5); 124 on timeout
  answer <session> [--question id] [--json] [--] <choice>
                                  answer its waiting question: option number/text, yes/no, text
                                  (--question: refuse if another question is now first)
  vscode [session | path/to/dir] [--folder dir] [--authority a] [--json]
                                  open it in a VS Code window on this machine (prints the link to open
                                  on the computer running VS Code, e.g. over Remote-SSH); a folder opens
                                  its checkout, --folder exactly that folder; --authority: that remote
                                  (ssh-remote+box, wsl+Ubuntu; "" local), even if no window of it is known
  projects [--json]               folders sessions ran in, newest first
  attach [session]                chat in the terminal (Ctrl-C aborts a turn, Ctrl-D detaches)
  send <session> <text|-> [--steer] [-w|--wait] [--json]
                                  prompt a session (resumes it if stopped). While omp works the prompt
                                  waits for the turn to end (a follow-up); --steer redirects the turn.
                                  --wait streams the reply, exits like wait (3: it asks a question)
  tail [session] [-n N] [-f]      last messages; -f follows live output
  stop|resume <session>… [--json] stop or resume sessions (stop: exit 1 when one wasn't running)
  abort [session] [--json]        abort the current turn (exit 1 when it isn't running)
  mode [session] [ask|edits|plan|auto]
                                  show or switch the permission mode (live, also while working)
  model [session] [provider/id] [--json]
                                  show or switch its model (live; a stopped session: from its resume)
  rm <session>… [-y]              remove sessions and their history

${c.bold("Queue")}
  queue <session> [--json]        show its task queue
  queue <session> add <task|-> [--notes n|-] [--sub s]… [--top] [--run] [--json]
                                  add a task; - reads stdin: its first line is the title, the rest the
                                  notes (long prompts keep their lines; omp gets title and notes)
  queue <session> run [n] | start | pause | clear | retry [n] | rm n | done n | skip n [--json]
                                  run: run now from task n (continues an interrupted queue); start: turn
                                  auto-run on; pause: off
  queue <session> at <+30m|14:30|ISO time|off> [--json]
                                  start the queue at that time (off: cancel the schedule)

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
  server status [--json] | start | stop | restart | log [-f] | install | uninstall

${c.bold("Remote")}  ${c.dim("(phone app + HTTP API on this machine; prefer Tailscale, LAN is plain HTTP)")}
  remote on [--bind tailscale|lan|localhost|<ip>] [--port n] [--url <public url>|none] [--json]
                                  turn on remote access (default bind tailscale, port 7413); --url when a
                                  proxy fronts it (tailscale serve, HTTPS): the pairing link uses that URL;
                                  with --bind localhost the proxy is trusted to name clients (lockouts)
  remote off|status|qr|rotate     turn off · show state · pairing QR + URL · new token (unpairs phones)

${c.bold("Agents")}  ${c.dim("(the omp-sessions skill teaches other agents to use the omp-sessions command)")}
  skill [status]                  where it is installed
  skill install [agents|claude|codex]… [--dir d] [--force]
                                  install or update it (default: every platform found)
  skill uninstall [platform]… | print | path

${c.bold("Hermes")}  ${c.dim("(omp-sessions plugin: omp tools, notifications and a kanban lane in Hermes Agent; docs/HERMES.md)")}
  hermes install [--force]        copy the plugin into $HERMES_HOME/plugins (~/.hermes) and enable it
  hermes uninstall | status [--json]
      [--profile <name>]… [--all-profiles]
                                  plugins are per Hermes profile; default: $HERMES_HOME, else ~/.hermes
                                  (%LOCALAPPDATA%\\hermes on Windows)

${c.bold("Migration")}  ${c.dim("(from omp Sessions to Switchyard on AO)")}
${MIGRATE_HELP}

  --no-color, NO_COLOR=1          plain output · OMP_SESSIONS_NO_SERVER=1 runs without the server
  --                              everything after it is text, not flags (e.g. answer . -- --yes)
`;

/** `help <command>` and `<command> --help`: that command's entries of HELP under their section heading; undefined for no command. */
function commandHelp(cmd: string): string | undefined {
	const out: string[] = [];
	let heading = "";
	let taking = false;
	for (const line of HELP.split("\n")) {
		if (line && !line.startsWith(" ")) {
			heading = line;
			taking = false;
			continue;
		}
		// An entry starts at two spaces (`stop|resume <session>…`); deeper lines continue it.
		if (/^ {2}\S/.test(line)) {
			taking = line.trim().split(/\s/)[0].split("|").includes(cmd);
			if (taking && heading) out.push(heading);
			if (taking) heading = "";
		} else if (!/^ {4,}\S/.test(line)) taking = false;
		if (taking) out.push(line);
	}
	return out.length ? `${out.join("\n")}\n${c.dim("omp-sessions help lists every command")}\n` : undefined;
}

// ---------- main ----------

async function cmdVersion(json: boolean): Promise<number> {
	const client = await ServerClient.connect();
	const server = client ? await client.request("ping", {}).catch(() => undefined) : undefined;
	client?.close();
	if (json) process.stdout.write(`${JSON.stringify({ cli: VERSION, server: server?.version ?? null, pid: server?.pid ?? null })}\n`);
	else process.stdout.write(`omp-sessions ${VERSION}${server ? c.dim(` · server ${server.version} (pid ${server.pid})`) : ""}\n`);
	return 0;
}

const ALIASES: Record<string, string> = { list: "ls", chat: "attach", log: "tail", start: "resume", remove: "rm", q: "queue", priority: "prio", scheduler: "sched", skills: "skill" };

/** Each command with the flags it takes (`--help` and `--no-color` always work). */
const COMMANDS: Record<string, { flags: readonly string[]; run: (args: Args, cmd: string) => Promise<number> | number }> = {
	status: { flags: ["json"], run: cmdStatus },
	config: { flags: ["json", "force"], run: cmdConfig },
	models: { flags: ["json"], run: cmdModels },
	model: { flags: ["json"], run: cmdModel },
	version: { flags: ["json"], run: args => cmdVersion(flag(args, "json")) },
	ls: { flags: ["all", "json", "project", "cwd", "group", "tag", "state"], run: async args => (await cmdList(args), 0) },
	board: { flags: ["all", "json"], run: async args => (await cmdBoard(args), 0) },
	new: { flags: ["prompt", "task", "sub", "notes", "at", "title", "mode", "tag", "group", "model", "priority", "detach", "attach", "json"], run: cmdNew },
	send: { flags: ["wait", "steer", "follow-up", "json"], run: cmdSend },
	attach: { flags: ["lines"], run: cmdAttach },
	tail: { flags: ["lines", "follow"], run: cmdTail },
	stop: { flags: ["json"], run: cmdStop },
	resume: { flags: ["json"], run: cmdResume },
	rm: { flags: ["yes"], run: cmdRemove },
	abort: { flags: ["json"], run: cmdAbort },
	mode: { flags: [], run: async args => (await cmdMode(args), 0) },
	queue: { flags: ["sub", "top", "run", "notes", "json"], run: async args => (await cmdQueue(args), 0) },
	prio: { flags: [], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	color: { flags: [], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	group: { flags: [], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	archive: { flags: [], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	unarchive: { flags: [], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	move: { flags: [], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	sched: { flags: ["json"], run: async args => (await cmdSched(args), 0) },
	server: { flags: ["follow", "json"], run: cmdServer },
	remote: { flags: ["bind", "port", "url", "json"], run: cmdRemote },
	show: { flags: ["json"], run: cmdShow },
	wait: { flags: ["timeout", "json"], run: cmdWait },
	answer: { flags: ["question", "json"], run: cmdAnswer },
	vscode: { flags: ["folder", "authority", "json"], run: cmdVscode },
	projects: { flags: ["json"], run: cmdProjects },
	skill: { flags: ["dir", "force"], run: cmdSkill },
	hermes: { flags: ["force", "profile", "all-profiles", "json"], run: cmdHermes },
	migrate: { flags: ["apply", "json"], run: cmdMigrate },
};

async function main(argv: string[]): Promise<number> {
	if (argv.includes("--no-color")) setColor(false);
	const rest = argv.filter(a => a !== "--no-color");
	if (rest[0] === "--version" || rest[0] === "-v") return cmdVersion(rest.includes("--json"));
	const args = parseArgs(rest);
	const given = args._.shift();
	const name = given ?? "ls";
	const resolve = (n: string) => (Object.hasOwn(ALIASES, n) ? ALIASES[n] : n);
	if (flag(args, "help") || name === "help") {
		// `help`, `help <command>`, `<command> --help`.
		const about = name === "help" ? args._[0] : given;
		if (about === undefined) {
			process.stdout.write(HELP);
			return 0;
		}
		const text = commandHelp(resolve(about));
		if (!text) throw new UsageError(`unknown command "${about}" (omp-sessions help)`);
		process.stdout.write(text);
		return 0;
	}
	const cmd = resolve(name);
	const command = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
	if (!command) throw new UsageError(`unknown command "${name}" (omp-sessions help)`);
	checkFlags(args, name, command.flags);
	return command.run(args, cmd);
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
