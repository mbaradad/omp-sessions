// switchyard: the terminal client of Switchyard. Sessions are AO sessions (the AO daemon runs the agent
// harness its configuration picks, src/ao/harness.ts: claude-code, codex, omp through `omp acp`, …); queues, schedules, priorities and the concurrency limit belong to the
// planner service (PLANNER-API.md, plan.ts); groups, colors, tags and archive to organize.json.
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type AoClient, AoError, type AoHarnessInfo, type AoSchemas, type HarnessChoice, availableHarnesses, findDaemon, isOmpHarness, projectWorkerHarness, resolveHarness, resolveSessionHarness, switchyardHome, unwrap } from "../ao/client";
import { readSwitchyardConfig, switchyardConfigPath, writeSwitchyardConfig } from "../ao/config";
import { INSTALL_COMMAND, dashboardDir, dashboardEnabled, dashboardPort, dashboardUrl, probeDashboard, readDashboardInstall } from "../ao/dashboard";
import { installDashboard, uninstallDashboard } from "../ao/dashboard-install";
import { pairingLink } from "../ao/mobile";
// Two `permissionModeOf`s: src/ao's reads AO turn settings; src/shared/permissions' parses a typed word.
import { SETTLED_STATES, answerFor, approvalModeFor, permissionModeOf as aoPermissionMode } from "../ao/model";
import { SKILL_FILE, SKILL_NAME, SKILL_PLATFORMS, type SkillTarget, detectedPlatforms, installSkill, isSkillPlatform, skillTargets, uninstallSkill } from "../shared/agent-skill";
import { AFTER_INSTALL, PLUGIN_BUNDLE, disablePlugin, findHermes, hermesLookup, pluginReport, pluginTarget, reportLine, resolveTargets, uninstallPlugin, updatePlugin } from "../shared/hermes-plugin";
import { ORG_COLORS, OrganizeStore, PRIORITIES, isOrgColor, isPriority } from "../shared/organize";
import { PERMISSION_MODES, PERMISSION_MODE_INFO, type PermissionMode, isPermissionMode, permissionModeOf } from "../shared/permissions";
import { MAX_NOTES, MAX_TITLE } from "../shared/queue";
import { qrHalfBlocks } from "../shared/remote-qr";
import { setSessionMode } from "../shared/session-mode-ops";
import { holdText } from "../shared/task-text";
import { OPEN_REQUEST_TTL_MS, folderProblem, folderTarget, isAuthority, requestOpen, vscodeFolderLink, vscodeLink, windowFor } from "../shared/vscode-open";
import { type Args, UsageError, checkFlags, flag, parseArgs, parseWhen, value } from "./args";
import { attach } from "./attach";
import { ensureBundles, extensionReport, installBundles, shippedBundles, uninstallBundles } from "./extension";
import { modeProblem } from "./gate";
import { type GraphEdge, type LaneSummary, type Planner, type PlannerConfig, type PlannerQueue, type PlannerStatus, type QueueOp, canRequeue, connectPlanner, edgesOfRef, graphEdges, lanesOf, plannerService, tasksOfRef } from "./plan";
import { MIGRATE_HELP, cmdMigrate } from "./migrate";
import { itemLines, timeline } from "./render";
import { type AgentState, type CliReport, type ListFilter, type Session, ao, aoIfRunning, changedFileCount, columnOf, filterSessions, infoJson, livePlanMode, loadSession, loadSessions, orderOf, reportOf, resolveSession } from "./sessions";
import { PRIORITY_MARK, ago, c, colorEnabled, confirm, errorLine, oneLine, pad, priorityLabel, setColor, termWidth, truncate } from "./term";

function readVersion(): string {
	for (const file of [path.join(__dirname, "package.json"), path.join(__dirname, "..", "package.json")]) {
		try {
			const pkg: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
			if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") return pkg.version;
		} catch {
			/* not packaged here */
		}
	}
	return "unknown";
}

const VERSION = readVersion();

// ---------- planner and session lookup ----------

let plannerPromise: Promise<Planner | undefined> | undefined;

/** The planner when it runs (read-only commands never start it). */
function plannerIfRunning(): Promise<Planner | undefined> {
	plannerPromise ??= connectPlanner({ start: false });
	return plannerPromise;
}

/** The planner, started when it isn't running (it owns queues and schedules). */
async function planner(): Promise<Planner> {
	const running = await plannerIfRunning();
	if (running) return running;
	const started = await connectPlanner({ start: true });
	if (!started) throw new Error("the planner service did not start (switchyard server log)");
	plannerPromise = Promise.resolve(started);
	return started;
}

async function lanes(): Promise<Map<string, LaneSummary> | undefined> {
	const p = await plannerIfRunning();
	return p ? lanesOf(p).catch(() => undefined) : undefined;
}

async function allSessions(): Promise<Session[]> {
	return loadSessions(await ao(), { lanes: await lanes() });
}

/** The session `query` names (id, id prefix, title words, or `.` for the newest one in this folder). */
async function findSession(query: string | undefined): Promise<Session> {
	if (!query) throw new UsageError("which session? (id, id prefix, title words, or . for this folder)");
	const hit = resolveSession(query, await allSessions(), process.cwd());
	if ("error" in hit) throw new Error(hit.error);
	return hit;
}

async function fresh(id: string, conversationLimit?: number): Promise<Session> {
	return loadSession(await ao(), id, { lanes: await lanes(), ...(conversationLimit !== undefined && { conversationLimit }) });
}

/** A session with a live agent: an exited one is resumed (`resume-agent`), a terminated one restored, first. */
async function running(s: Session): Promise<Session> {
	const v = s.model.view;
	if (!v.isTerminated && v.activity.state !== "exited") return s;
	refreshBundles();
	process.stderr.write(c.dim(`resuming ${s.id} ${s.title}…\n`));
	await resumeAgent(await ao(), s);
	return fresh(s.id);
}

async function resumeAgent(client: AoClient, s: Session): Promise<boolean> {
	const v = s.model.view;
	if (v.isTerminated) {
		await client.restoreSession(s.id);
		return true;
	}
	if (v.activity.state !== "exited") return false;
	await client.resumeAgent(s.id);
	return true;
}

// ---------- formatting ----------

const STATE_COLOR: Record<AgentState, (s: string) => string> = { queued: c.blue, scheduled: c.blue, starting: c.dim, working: c.yellow, needs_input: c.magenta, idle: c.green, interrupted: c.red, stopped: c.dim };

function stateText(s: Session): string {
	if (s.lane?.blockedBy?.length && s.state === "queued") return c.blue("blocked");
	// Held (a provider limit, a usage window, the budget, a retry backoff): the reason is in `show` and under `ls`.
	if (s.lane?.waitReason && s.state === "queued") return c.yellow("held");
	if (s.lane?.waiting && s.state === "queued") return c.blue(`queued #${s.lane.waiting.position}`);
	return STATE_COLOR[s.state](s.state === "needs_input" ? "needs input" : s.state);
}

function queueText(l: LaneSummary | undefined): string {
	if (!l?.total) return "";
	const s = `${l.done}/${l.total}`;
	if (l.running) return c.yellow(`▶ ${s}`);
	if (l.pending && l.autoRun) return c.blue(`… ${s}`);
	if (l.pending && l.startAt) return c.blue(`⏲ ${s}`);
	return c.dim(s);
}

function costText(cost: number | undefined): string {
	if (!cost || cost < 0.005) return "";
	return `$${cost < 10 ? cost.toFixed(2) : cost.toFixed(0)}`;
}

function projectName(s: Session): string {
	return s.project?.name ?? (s.cwd ? path.basename(s.cwd) : "");
}

function printTable(sessions: Session[]): void {
	const width = termWidth();
	const idWidth = Math.max(4, ...sessions.map(s => s.id.length)) + 2;
	const fixed = idWidth + 13 + 3 + 9 + 16 + 8 + 7;
	const titleWidth = Math.max(16, width - fixed);
	process.stdout.write(c.dim(`${pad("ID", idWidth)}${pad("STATUS", 13)}${pad("", 3)}${pad("TITLE", titleWidth)}${pad("QUEUE", 9)}${pad("PROJECT", 16)}${pad("ACTIVE", 8)}COST\n`));
	for (const s of sessions) {
		const prio = s.priority === "urgent" ? c.red(PRIORITY_MARK.urgent) : s.priority === "high" ? c.yellow(PRIORITY_MARK.high) : c.dim(PRIORITY_MARK[s.priority] ?? "  ");
		const title = truncate(`${s.lane?.completed !== undefined ? "✓ " : ""}${oneLine(s.title)}`, titleWidth - 1);
		const group = s.group ? c.dim(` [${s.group}]`) : "";
		// omp is the usual case; another harness is named after the title.
		const harness = isOmpHarness(s.model.harness) ? "" : c.dim(` (${s.model.harness})`);
		process.stdout.write(
			`${pad(c.dim(s.id), idWidth)}${pad(stateText(s), 13)}${pad(prio, 3)}${pad(`${s.state === "stopped" ? c.dim(title) : title}${group}${harness}`, titleWidth)}${pad(queueText(s.lane), 9)}${pad(c.dim(truncate(projectName(s), 15)), 16)}${pad(c.dim(ago(s.model.updatedAt)), 8)}${c.dim(costText(s.model.cost))}\n`,
		);
	}
}

// ---------- commands ----------

async function cmdList(args: Args): Promise<void> {
	const all = flag(args, "all");
	const cwdArg = value(args, "cwd");
	const cwd = cwdArg === undefined ? undefined : path.resolve(cwdArg);
	const filter: ListFilter = { project: value(args, "project"), cwd, group: value(args, "group"), tags: args.multi.get("tag"), state: value(args, "state") };
	const state = filter.state;
	const filtered = Boolean(filter.project || cwd || filter.group || filter.tags?.length || state);
	const sessions = filterSessions(
		(await allSessions()).filter(s => all || !s.archived),
		filter,
	);
	// Finished sessions are hidden unless --all or --state; ones with work ahead (queued, scheduled, interrupted) stay.
	const shown = all || state ? sessions : sessions.filter(s => s.state !== "stopped");
	if (flag(args, "json")) {
		const order = orderOf(shown);
		process.stdout.write(`${JSON.stringify(
			shown.map(s => infoJson(s, order.get(s.id) ?? 0)),
			null,
			2,
		)}\n`);
		return;
	}
	if (shown.length === 0) process.stdout.write(c.dim(filtered ? "No matching sessions.\n" : all ? "No sessions.\n" : "No active sessions.\n"));
	else printTable(shown);
	const hidden = sessions.length - shown.length;
	if (hidden > 0) process.stdout.write(c.dim(`${hidden} finished session${hidden === 1 ? "" : "s"} hidden · switchyard ls --all\n`));
	for (const s of shown) if (s.lane?.waitReason && s.state === "queued") process.stdout.write(`${c.yellow("held")} ${c.dim(s.id)} ${holdText(s.lane.waitReason, s.lane.waitUntil)}\n`);
	if (shown.some(s => s.lane?.waiting)) {
		const p = await plannerIfRunning();
		const st = p ? await p.call("status", {}) : undefined;
		if (st) process.stdout.write(c.dim(`${st.running} queued task${st.running === 1 ? "" : "s"} running, ${st.waiting} waiting (${st.maxConcurrent ? `limit ${st.maxConcurrent}` : "no limit"}${st.paused ? ", paused" : ""})\n`));
	}
}

const COLUMNS: ReadonlyArray<{ id: string; label: string }> = [
	{ id: "waiting", label: "Waiting" },
	{ id: "scheduled", label: "Scheduled" },
	{ id: "working", label: "Working" },
	{ id: "input", label: "Needs input" },
	{ id: "idle", label: "Idle" },
	{ id: "interrupted", label: "Interrupted" },
	{ id: "stopped", label: "Stopped" },
];

async function cmdBoard(args: Args): Promise<void> {
	const all = flag(args, "all");
	const sessions = (await allSessions()).filter(s => !s.archived);
	const order = orderOf(sessions);
	// Interrupted sessions get a column of their own (someone has to continue them); Stopped only with --all.
	const columnOfSession = (s: Session) => (s.state === "interrupted" ? "interrupted" : columnOf(s.state));
	const columns = COLUMNS.filter(col => all || col.id !== "stopped").map(col => {
		const cards = sessions.filter(s => columnOfSession(s) === col.id).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
		if (col.id === "waiting") cards.sort((a, b) => (a.lane?.waiting?.position ?? 0) - (b.lane?.waiting?.position ?? 0));
		return { ...col, sessions: cards };
	});
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify({ columns: columns.map(col => ({ ...col, sessions: col.sessions.map(s => infoJson(s, order.get(s.id) ?? 0)) })) }, null, 2)}\n`);
		return;
	}
	const width = termWidth();
	for (const col of columns) {
		process.stdout.write(`${c.bold(col.label)} ${c.dim(`(${col.sessions.length})`)}\n`);
		for (const s of col.sessions) {
			const tags = [s.priority !== "normal" ? priorityLabel(s.priority) : "", queueText(s.lane), s.group ? c.dim(`[${s.group}]`) : ""].filter(Boolean).join(" ");
			const title = truncate(oneLine(s.title), Math.max(16, width - 14 - 30));
			process.stdout.write(`  ${c.dim(s.id)}  ${title}${tags ? `  ${tags}` : ""}\n`);
		}
		if (col.sessions.length === 0) process.stdout.write(c.dim("  —\n"));
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return Buffer.concat(chunks).toString("utf8").trim();
}

/** Title for a session created from a task or prompt: its first line, shortened. */
function titleFrom(text: string): string {
	const line = text.split("\n")[0].trim();
	return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New session";
}

/** Priority, tags and group (by name, created if missing) of a session just made (organize.json, MAPPING D5). */
function organizeNew(id: string, opts: { tags?: string[]; group?: string }): void {
	if (!opts.tags?.length && !opts.group?.trim()) return;
	const org = new OrganizeStore();
	if (opts.tags?.length) org.setTags([id], opts.tags);
	const name = opts.group?.trim();
	if (name) {
		const group = org.data.groups.find(g => g.name.toLowerCase() === name.toLowerCase()) ?? org.createGroup({ name });
		org.setGroup([id], group.id);
	}
}

/** Why this harness, for people: `--harness`, the config default, the project's worker harness, or AO's default. */
function harnessText(choice: HarnessChoice): string {
	return choice.source === "explicit" ? "--harness" : choice.reason;
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
	if (args.multi.has("after") && !task) throw new UsageError("--after makes a queued task wait for other sessions: add --task");
	const usage = value(args, "usage");
	if (usage !== undefined && usage !== "normal" && usage !== "spare") throw new UsageError("--usage must be normal or spare");
	if (usage === "spare" && !task) throw new UsageError("--usage spare holds a queued task until provider usage leaves room: add --task");
	if (task && prompt) throw new UsageError("--prompt starts the session now, --task queues it: pick one");
	const json = flag(args, "json");
	const dir = path.resolve(args._.slice(0, args._.length - args.dashes.length)[0] ?? process.cwd());
	const worktreeArg = value(args, "worktree");
	if (worktreeArg !== undefined && worktreeArg !== "auto" && worktreeArg !== "always" && worktreeArg !== "never") throw new UsageError("--worktree must be auto, always or never");
	if (worktreeArg !== undefined && flag(args, "no-worktree")) throw new UsageError("--worktree and --no-worktree contradict each other");
	const worktree = flag(args, "no-worktree") ? "never" : worktreeArg;
	if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a folder: ${dir}`);
	const defaults = readSwitchyardConfig();
	const harnessArg = value(args, "harness");
	if (harnessArg !== undefined && !harnessArg.trim()) throw new UsageError("--harness needs a harness id (switchyard harnesses lists them)");
	// Explicit flag, then the config file; none: the spawn helper's default (`auto`: AO's bypass, the gate lets everything through).
	const effectiveMode = mode ?? defaults.mode;
	// Words after `--` are omp's own flags for this session (G34): the `omp` shim appends them to `omp acp`.
	const ompArgs = args.dashes;
	const title = value(args, "title") ?? titleFrom(task ?? prompt ?? "");
	const client = await ao();
	// A git folder runs in its AO project (AO gives the session its own worktree); any other folder runs standalone (MAPPING D2, Q1).
	const project = await client.projectForFolder(dir);
	// The harness (src/ao/harness.ts): --harness, Switchyard's default, the project's worker harness, AO's default. Refused when AO can't chat with it.
	const choice = await resolveSessionHarness(client, { ...(harnessArg && { explicit: harnessArg }), ...(defaults.harness && { config: defaults.harness }), ...(project && { projectId: project.id }) });
	const omp = isOmpHarness(choice.harness);
	if (omp) {
		// Install or refresh Switchyard's omp extension and shim when this build ships them (G38): ask, edits and plan need the gate.
		refreshBundles();
		if (effectiveMode) {
			const problem = modeProblem(effectiveMode);
			if (problem) throw new Error(problem);
		}
		if (ompArgs.length) {
			const report = extensionReport((await findDaemon().catch(() => undefined))?.pid);
			if (!report.shim.installed) throw new Error(`omp flags after -- need Switchyard's omp shim (${report.shim.path}), which is not installed: it appends them to omp acp (switchyard omp-extension install)`);
			if (report.shim.onDaemonPath === false) throw new Error(`the AO daemon was not started with ${path.dirname(report.shim.path)} first on its PATH, so omp flags after -- would be ignored: restart AO through Switchyard (it starts it that way)`);
		}
	} else {
		if (ompArgs.length) throw new Error(`omp flags after -- are omp-only; this session would run ${choice.harness} (${harnessText(choice)})`);
		// A default mode of plan (config) starts another harness in ask (the spawn helper); asked for, it is refused.
		if (mode === "plan") throw new Error(`--mode plan is omp-only; this session would run ${choice.harness} (${harnessText(choice)}): use ask, edits or auto, or --harness omp`);
	}
	// The config's default model names an omp model: it applies to omp sessions only (an explicit --model applies to any harness).
	const model = value(args, "model") ?? (omp ? defaults.model : undefined);
	// A model no catalog knows or that the session doesn't offer is refused by the spawn helper before anything is left behind.
	// Worktrees (PARKED §8): AO gives every session of a git project its own worktree and branch, which is `auto` and `always`
	// here. A session in the checkout itself (`never`) is not something AO does (MAPPING Q1): refuse it rather than ignore it.
	if (!project && worktree === "always") throw new Error(`--worktree=always needs a git repository: ${dir} is not in one`);
	if (worktree === "never") throw new Error("--worktree=never / --no-worktree: AO runs every session of a git project in its own worktree; running in the checkout itself is not available (MAPPING Q1). Start the session in a folder outside git, or leave the flag out");
	// MAPPING Q1: a folder outside git is not opened by AO; the session gets an empty scratch directory.
	if (!project) process.stderr.write(c.yellow(`warning: ${dir} is not in a git repository: the session runs in an empty scratch directory, not in ${dir}\n`));
	// MAPPING D2: the session starts at its worktree's root, not at a subfolder of the repository.
	if (project) {
		const sub = path.relative(fs.realpathSync(project.path), fs.realpathSync(dir));
		if (sub && !sub.startsWith("..") && !path.isAbsolute(sub)) process.stderr.write(c.dim(`note: ${dir} is inside the git project ${project.path}: the session starts at its worktree root, not in ${sub}\n`));
	}
	// A queued task gets its session now (idle, no prompt), so its id is the session id like before; the planner prompts it.
	const lane = task ? await planner() : undefined;
	// Sessions this one waits for, checked before anything is created.
	const after: string[] = [];
	for (const ref of args.multi.get("after") ?? []) after.push((await findSession(ref)).id);
	// D11: AO's bypass, no prompt, model and omp flags checked, then the mode file the gate reads, then the first message.
	const res = await client.spawnSwitchyard({
		displayName: title,
		...(project ? { projectId: project.id } : { dir }),
		harness: choice.harness,
		...(prompt && { prompt }),
		...(model && { model }),
		defaultModel: null,
		// Asked for: refused when the harness can't run it. The config's default gives way to the nearest mode AO offers.
		...(mode && { mode }),
		defaultMode: defaults.mode ?? null,
		...(ompArgs.length && { ompArgs }),
		// checkpoints' setSessionMode: the mode file is never written by hand (D11, G40).
		setMode: async (sessionId, sessionMode) => void (await setSessionMode(client, sessionId, sessionMode)),
	});
	const id = res.session.id;
	organizeNew(id, { tags: args.multi.get("tag"), group: value(args, "group") });
	if (lane && task) {
		// A continued session keeps the mode it was started with; the planner's options carry the model only.
		const add: QueueOp = { op: "add", title: task, ...(notes && { notes }), ...(args.multi.get("sub") && { subtasks: args.multi.get("sub") }), ...(model && { options: { model } }) };
		const arm: QueueOp = startAt ? { op: "schedule", at: startAt } : { op: "autoRun", value: true };
		if (after.length || usage === "spare") {
			// Dependencies and the usage class go in before the queue is armed (the task must not start before
			// them), in calls of their own: the planner applies `after` to the tasks the lane has when the call starts.
			const queued = await lane.call("queue", { id, ops: [add] });
			const taskId = queued.tasks.at(-1)?.id;
			if (taskId && usage === "spare") await lane.call("edit", { ops: [{ op: "update", id: taskId, usage }] });
			if (after.length) await lane.call("queue", { id, ops: [{ op: "after", ids: after }] });
			await lane.call("queue", { id, ops: [arm] });
		} else await lane.call("queue", { id, ops: [add, arm] });
		if (priority && isPriority(priority)) await lane.call("edit", { ops: [{ op: "lane.update", id, priority }] });
	}
	const cwd = (await client.workspacePath(id).catch(() => undefined)) || project?.path || dir;
	// Which harness, and why: on stderr, so --json stays one object on stdout.
	process.stderr.write(c.dim(`harness ${choice.harness} (${harnessText(choice)})\n`));
	if (json) {
		process.stdout.write(`${JSON.stringify({ id, started: !task || !startAt, title, cwd, harness: choice.harness, harnessSource: choice.source, ...(project ? { worktree: { path: cwd, ...(res.session.branch && { branch: res.session.branch }), repo: project.path } } : {}), ...(startAt ? { startAt } : {}), ...(after.length ? { after } : {}) })}\n`);
		return 0;
	}
	const label = `${id} ${title}`;
	if (task) {
		const when = startAt ? c.dim(`(starts ${new Date(startAt).toLocaleString()}${after.length ? `, once ${after.join(", ")} finished` : ""})`) : after.length ? c.dim(`(starts once ${after.join(", ")} finished)`) : c.dim("(starts when a slot is free)");
		process.stdout.write(`${c.blue("queued")} ${label} ${when}\n`);
		return 0;
	}
	process.stdout.write(`${c.green("started")} ${label} ${c.dim(cwd)}\n`);
	const wantAttach = flag(args, "attach") || (!prompt && !flag(args, "detach") && process.stdin.isTTY && process.stdout.isTTY);
	if (!wantAttach) return 0;
	return attach(client, await fresh(id), { history: 20, readOnly: false });
}

async function cmdSend(args: Args): Promise<number> {
	const s = await findSession(args._[0]);
	let text = args._.slice(1).join(" ");
	if (text === "-" || (!text && !process.stdin.isTTY)) text = await readStdin();
	if (!text) throw new UsageError("nothing to send");
	if (flag(args, "steer") && flag(args, "follow-up")) throw new UsageError("--steer or --follow-up, not both");
	// While omp works, AO queues a message until the turn ends (follow-up) unless --steer redirects the turn.
	const mode = flag(args, "steer") ? "steer" : "followUp";
	const json = flag(args, "json");
	const client = await ao();
	const live = await running(s);
	if (flag(args, "wait") && !json) return attach(client, live, { history: 0, readOnly: true, prompt: text, steer: mode === "steer" });
	const sent = mode === "steer" ? await client.steerOrSend(s.id, { text }) : await client.sendMessage(s.id, { text });
	if (flag(args, "wait")) return waitFor(s.id, undefined, true, sent.turnId);
	if (json) process.stdout.write(`${JSON.stringify({ id: s.id, sent: true, mode })}\n`);
	else process.stdout.write(`${c.green("sent")} ${s.id} ${s.title}\n`);
	return 0;
}

async function cmdAttach(args: Args): Promise<number> {
	const s = await running(await findSession(args._[0] ?? "."));
	const lines = Number(value(args, "lines") ?? 20);
	return attach(await ao(), s, { history: Number.isFinite(lines) ? lines : 20, readOnly: !process.stdin.isTTY });
}

async function cmdTail(args: Args): Promise<number> {
	const s = await findSession(args._[0] ?? ".");
	const n = Number(value(args, "lines") ?? 10);
	const lines = Number.isFinite(n) && n > 0 ? n : 10;
	const client = await ao();
	const stopped = s.state === "stopped";
	if (!stopped && flag(args, "follow")) return attach(client, s, { history: lines, readOnly: true });
	const conversation = await client.getConversation(s.id, { limit: Math.max(lines, 20) });
	const width = termWidth();
	const items = timeline(conversation).filter(i => itemLines(i, width).length > 0);
	for (const item of items.slice(-lines)) for (const l of itemLines(item, width)) process.stdout.write(`${l}\n`);
	if (stopped) {
		process.stdout.write(c.dim(`session stopped${s.model.exitReason ? `: ${s.model.exitReason}` : ""} (${ago(s.model.updatedAt)} ago)\n`));
		if (flag(args, "follow")) process.stdout.write(c.dim(`switchyard resume ${s.id} to continue it\n`));
	}
	return 0;
}

// ---------- agent-facing: show / wait / answer ----------

/** The session's report for agents: state, pending question, full last reply. */
async function reportFor(id: string): Promise<CliReport> {
	const client = await ao();
	const s = await fresh(id, 200);
	const live = s.model.conversation && s.state !== "stopped";
	const edited = !!s.model.conversation?.activities.some(a => a.activityKind === "file_change" && a.status === "completed");
	const [plan, changedFiles] = await Promise.all([live ? livePlanMode(client, id) : undefined, changedFileCount(client, id, edited)]);
	return reportOf(s, { ...(s.model.conversation && { mode: aoPermissionMode(s.model.conversation.settings, plan === true, s.model.harness) }), ...(changedFiles !== undefined && { changedFiles }) });
}

function printReport(r: CliReport): void {
	const q = r.queue.total ? c.dim(` · queue ${r.queue.done}/${r.queue.total}`) : "";
	process.stdout.write(`${STATE_COLOR[r.state](r.state.replace("_", " "))} ${r.id} ${c.bold(r.title)}${r.completed ? c.green(" ✓") : ""}${r.harness && !isOmpHarness(r.harness) ? c.dim(` · ${r.harness}`) : ""}${q}${r.cost ? c.dim(` · $${r.cost.toFixed(2)}`) : ""}\n`);
	if (r.question) {
		process.stdout.write(`${c.magenta(`? ${r.question.title}`)}${r.question.message ? `\n${r.question.message}` : ""}\n`);
		r.question.options?.forEach((o, i) => process.stdout.write(`  ${c.bold(String(i + 1))}. ${o}\n`));
		r.question.questions?.forEach((q, i) => {
			process.stdout.write(`  ${c.bold(`${i + 1})`)} ${q.question}\n`);
			q.options.forEach((o, k) => process.stdout.write(`     ${c.bold(String(k + 1))}. ${o}\n`));
		});
		process.stdout.write(c.dim(`answer: switchyard answer ${r.id} <choice>${r.question.questions && r.question.questions.length > 1 ? " (one per question, separated by |)" : ""}\n`));
	}
	if (r.waitReason) process.stdout.write(c.yellow(`held: ${holdText(r.waitReason, r.waitUntil)}\n`));
	if (r.blockedBy?.length) process.stdout.write(c.blue(`waits for: ${r.blockedBy.join(", ")}\n`));
	if (r.upstream?.length && r.upstreamState && r.upstreamState !== "in-sync") process.stdout.write(`${(EDGE_COLOR[r.upstreamState] ?? c.dim)(`upstream ${r.upstreamState}`)} ${c.dim(r.upstream.map(e => `${e.parentSession ?? e.parent} ${e.state}${e.files?.length ? ` (${e.files.join(", ")})` : ""}`).join(" · "))}${r.upstreamState === "upstream-changed" ? c.dim(`\nre-run with the parents' changes: switchyard plan sync ${r.id} --rerun`) : ""}\n`);
	if (r.exitReason) process.stdout.write(c.dim(`stopped: ${r.exitReason}\n`));
	if (r.reply && !r.question) process.stdout.write(`\n${r.reply}\n`);
}

async function cmdShow(args: Args): Promise<number> {
	const report = await reportFor((await findSession(args._[0] ?? ".")).id);
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else printReport(report);
	return 0;
}

/**
 * Asks a VS Code window on this machine to open the session, or opens a folder (`--folder <dir>` exactly;
 * a path argument naming a folder: its checkout); prints the link that brings it up.
 */
async function cmdVscode(args: Args): Promise<number> {
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
	const s = await findSession(arg ?? ".");
	const win = pick(s.cwd);
	requestOpen(s.id);
	const url = vscodeLink(s, win);
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify({ id: s.id, url, authority: win?.authority ?? null, windowAt: win?.at || null }, null, 2)}\n`);
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
/** Extra time an unfinished reply (`replyPending`) may hold `wait` after the state settled (foundation's watcher re-reads for about 4.5 s). */
const REPLY_GRACE_MS = 3000;

/** "90", "90s", "30m", "2h" → ms. */
function parseDuration(text: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/.exec(text.trim());
	if (!m) return undefined;
	return Number(m[1]) * ({ "": 1000, s: 1000, m: 60_000, h: 3_600_000 }[m[2]] ?? 1000);
}

async function cmdWait(args: Args): Promise<number> {
	const s = await findSession(args._[0] ?? ".");
	const timeoutArg = value(args, "timeout");
	const timeout = timeoutArg === undefined ? undefined : parseDuration(timeoutArg);
	if (timeoutArg !== undefined && timeout === undefined) throw new UsageError("--timeout <seconds | 30m | 2h>");
	return waitFor(s.id, timeout, flag(args, "json"));
}

/**
 * Waits until the session settles (or `timeout` ms pass), prints its report; the exit code says why.
 * `turnId`: a turn just sent, which counts as work until AO has finished it. Times are on the monotonic
 * clock: a stepping wall clock (NTP, WSL2) must not stretch or cut the wait.
 */
async function waitFor(id: string, timeout: number | undefined, json: boolean, turnId?: string): Promise<number> {
	const client = await ao();
	const deadline = timeout === undefined ? Infinity : performance.now() + timeout;
	let settledSince: number | undefined;
	// Wake on AO's change events; poll once a second anyway (planner state changes don't go through AO).
	let wake: (() => void) | undefined;
	const events = client.events({
		after: "latest",
		onEvent: e => {
			if (e.sessionId === id) wake?.();
		},
	});
	try {
		for (;;) {
			const s = await fresh(id, 5);
			const pendingTurn = turnId ? s.model.conversation?.turns.find(t => t.id === turnId) : undefined;
			const ours = pendingTurn ? pendingTurn.state === "queued" || pendingTurn.state === "running" : false;
			const now = performance.now();
			if (SETTLED_STATES[s.state] && !ours) {
				settledSince ??= now;
				// AO can flag a turn completed before its last reply is final (the reply may be the previous turn's): hold a little longer, but never forever (a tool-only turn has no reply to wait for).
				if (now - settledSince >= SETTLE_MS + (s.model.replyPending ? REPLY_GRACE_MS : 0)) break;
			} else settledSince = undefined;
			if (now >= deadline) break;
			const { promise, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, Math.max(0, Math.min(1000, deadline - now)));
			wake = () => {
				clearTimeout(timer);
				resolve();
			};
			await promise;
			wake = undefined;
		}
	} finally {
		events.close();
	}
	// The exit code follows the printed report (a start time may pass, or a turn end, between the two reads).
	const report = await reportFor(id);
	if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else printReport(report);
	return SETTLED_STATES[report.state] ? WAIT_EXIT[report.state] : 124;
}

async function cmdAnswer(args: Args): Promise<number> {
	const s = await findSession(args._[0]);
	const text = args._.slice(1).join(" ");
	const client = await ao();
	const conversation = s.model.conversation;
	const question = s.model.question;
	if (!conversation || !question) throw new Error(`${s.id} ${s.title} is not waiting for an answer (${s.state.replace("_", " ")})`);
	// The caller checked this question (e.g. that it is no approval); another one may have come first since.
	const expected = value(args, "question");
	if (expected !== undefined && question.id !== expected) throw new Error(`the question changed (now ${question.id}: ${question.title})`);
	const answer = answerFor(question, text);
	if ("error" in answer) throw new UsageError(answer.error);
	if (answer.kind === "approval") await client.resolveApproval(s.id, question.id, answer.decisionId);
	else await client.resolveInput(s.id, question.id, answer.body);
	// AO takes the answer asynchronously: confirm the question is gone.
	const deadline = performance.now() + 5000;
	for (;;) {
		const after = await client.getConversation(s.id, { limit: 5 });
		const still = after.activities.some(a => a.requestId === question.id && a.status === "pending");
		if (!still) break;
		if (performance.now() > deadline) throw new Error("the session did not take the answer (answer it in VS Code, the phone app or switchyard attach)");
		await sleep(250);
	}
	const title = (question.message ?? question.title).split("\n")[0];
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify({ id: s.id, answered: true, question: question.id, title })}\n`);
	else process.stdout.write(`${c.green("answered")} ${s.id} ${title}\n`);
	return 0;
}

async function cmdProjects(args: Args): Promise<number> {
	const client = await ao();
	const [projects, { sessions }] = await Promise.all([client.listProjects(), client.listSessions({ kind: "worker" })]);
	const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);
	const out = projects
		.map(p => {
			const mine = sessions.filter(s => s.projectId === p.id);
			return { path: p.path, name: p.name, id: p.id, lastUsed: Math.max(0, ...mine.map(s => Math.max(ms(s.updatedAt), ms(s.lastEventAt)))), sessions: mine.length };
		})
		.sort((a, b) => b.lastUsed - a.lastUsed);
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		return 0;
	}
	if (!out.length) process.stdout.write(c.dim("no projects yet\n"));
	for (const p of out) process.stdout.write(`${pad(c.bold(p.name), 24)} ${pad(c.dim(`${p.sessions} session${p.sessions === 1 ? "" : "s"}${p.lastUsed ? ` · ${ago(p.lastUsed)} ago` : ""}`), 26)} ${p.path}\n`);
	return 0;
}

// ---------- skill ----------

function skillContent(): string {
	const file = path.join(__dirname, SKILL_FILE);
	if (!fs.existsSync(file)) throw new Error(`${SKILL_FILE} is missing next to the CLI (${__dirname}); reinstall switchyard`);
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
			if (skipped) process.stdout.write(c.dim("skipped: a SKILL.md switchyard didn't write is in the way (--force replaces it)\n"));
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
					process.stdout.write(c.dim("a plugin folder switchyard didn't write is in the way (--force replaces it)\n"));
					failed = true;
					continue;
				}
				if (u.outcome === "busy") {
					process.stdout.write(c.dim("another switchyard or VS Code window is installing the plugin there right now; run it again in a moment\n"));
					failed = true;
					continue;
				}
				const run = u.reload ?? u.enable;
				if (run?.output) process.stdout.write(`${run.output}\n`);
				if (u.reload?.ok) process.stdout.write(`${c.green("reloaded in the running gateway")} ${c.dim("(hooks and commands now, tools in new Hermes sessions)")}\n`);
				if (u.dashboardChanged) process.stdout.write(c.dim("the dashboard's Switchyard page backend changed: it loads when the dashboard restarts\n"));
				if (u.leftDisabled) process.stdout.write(`${c.red(`the plugin was left DISABLED in profile ${t.label}`)} (enabling it again failed twice): run ${c.bold(`hermes -p ${t.label} plugins enable switchyard`)}\n`);
				if (run && !run.ok) failed = true;
			}
			if (!hermes) {
				process.stdout.write(`${c.yellow("hermes not found")}: enable it with ${c.bold("hermes [-p <profile>] plugins enable switchyard")}\n`);
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
				process.stdout.write(uninstallPlugin(dir) ? `${c.yellow("removed")} ${dir}\n` : c.dim(`nothing switchyard installed at ${dir}\n`));
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

// ---------- stop / resume / rm / abort ----------

/** Stops sessions (`exit-agent`: the session, its workspace and transcript stay); exit 1 when one wasn't running. */
async function cmdStop(args: Args): Promise<number> {
	if (args._.length === 0) throw new UsageError("which session?");
	const client = await ao();
	const p = await plannerIfRunning();
	const results: Array<{ id: string; title: string; stopped: boolean; unqueued: boolean }> = [];
	for (const q of args._) {
		const s = await findSession(q);
		const v = s.model.view;
		const live = !v.isTerminated && v.activity.state !== "exited";
		if (live) await client.exitAgent(s.id);
		// Queued or scheduled work stops too: its lane pauses and loses its start time (`queue <s> start` re-arms it).
		const unqueued = !!(p && s.lane && s.lane.pending > 0 && (s.lane.autoRun || s.lane.startAt !== undefined));
		if (p && unqueued) await p.call("queue", { id: s.id, ops: [{ op: "schedule", at: null }, { op: "autoRun", value: false }] });
		results.push({ id: s.id, title: s.title, stopped: live, unqueued });
		if (flag(args, "json")) continue;
		if (live) process.stdout.write(`${c.green("stopped")} ${s.id} ${s.title}${unqueued ? c.dim(" (its queue is paused)") : ""}\n`);
		else if (unqueued) process.stdout.write(`${c.green("unqueued")} ${s.id} ${s.title} ${c.dim("(it won't start by itself; switchyard queue <session> start)")}\n`);
		else process.stderr.write(`switchyard: ${s.id} ${s.title} is not running (already stopped)\n`);
	}
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify(results)}\n`);
	return results.every(r => r.stopped || r.unqueued) ? 0 : 1;
}

async function cmdResume(args: Args): Promise<number> {
	if (args._.length === 0) throw new UsageError("which session?");
	refreshBundles();
	const client = await ao();
	const results: Array<{ id: string; title: string; started: boolean }> = [];
	for (const q of args._) {
		const s = await findSession(q);
		const started = await resumeAgent(client, s);
		results.push({ id: s.id, title: s.title, started });
		if (!flag(args, "json")) process.stdout.write(`${started ? c.green("resumed") : c.dim("already running")} ${s.id} ${s.title}\n`);
	}
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify(results)}\n`);
	return 0;
}

async function cmdRemove(args: Args): Promise<number> {
	if (args._.length === 0) throw new UsageError("which session?");
	const sessions: Session[] = [];
	for (const q of args._) sessions.push(await findSession(q));
	const names = sessions.map(s => `${s.id} ${s.title}${s.state !== "stopped" ? c.yellow(" (running)") : ""}`).join("\n  ");
	if (!(await confirm(`Remove ${sessions.length === 1 ? "this session" : `${sessions.length} sessions`} and their history?\n  ${names}\n`, flag(args, "yes")))) {
		process.stderr.write(c.dim(process.stdin.isTTY ? "cancelled\n" : "not removing without --yes\n"));
		return 1;
	}
	const client = await ao();
	const p = await plannerIfRunning();
	for (const s of sessions) {
		// AO deletes only terminated sessions; kill releases the workspace (a dirty worktree is kept on disk).
		if (!s.model.view.isTerminated) await client.killSession(s.id);
		// `cleanup`: release a workspace kill left on disk; AO refuses (and says so) when it holds uncommitted work.
		await client.deleteSession(s.id, true);
		if (p && s.lane) await p.call("edit", { ops: [{ op: "lane.remove", id: s.id }] }).catch(() => undefined);
		const org = new OrganizeStore();
		if (org.data.sessions[s.id]) org.cleanup(id => id !== s.id);
		process.stdout.write(`${c.green("removed")} ${s.id} ${s.title}\n`);
	}
	return 0;
}

/**
 * Aborts the current turn; exit 1 when there is none to abort. AO discards the prompts queued behind an
 * interrupted turn (G41): they are reported (`discarded` in --json, a warning otherwise) so the caller can send them again.
 */
async function cmdAbort(args: Args): Promise<number> {
	const s = await findSession(args._[0] ?? ".");
	const busy = !!s.model.conversation?.turns.some(t => t.state === "running");
	const discarded = busy ? (await (await ao()).interruptWithQueue(s.id)).discarded : [];
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify({ id: s.id, aborted: busy, discarded })}\n`);
	else if (busy) process.stdout.write(`${c.yellow("aborted")} ${s.id} ${s.title}\n`);
	if (!busy) process.stderr.write(`switchyard: ${s.id} ${s.title} is not working\n`);
	else if (discarded.length && !flag(args, "json")) {
		process.stderr.write(c.yellow(`AO discarded ${discarded.length} queued message${discarded.length === 1 ? "" : "s"}; send ${discarded.length === 1 ? "it" : "them"} again if still wanted:\n`));
		for (const d of discarded) process.stderr.write(c.dim(`  ${truncate(oneLine(d.text), 100)}\n`));
	}
	return busy ? 0 : 1;
}

// ---------- mode / model ----------

/** omp's own `mode` option (default/plan): live, also mid-turn. */
async function setOmpMode(client: AoClient, id: string, value: "default" | "plan"): Promise<void> {
	await client.setConfigOption(id, "mode", { value });
}

/**
 * Switches the permission mode. Plan is omp's live `mode` option. The approval level (ask/edits/auto)
 * is fixed when AO launches omp (MAPPING G7, Q4): AO's own way is to restart the agent with the new
 * level, which needs the session idle.
 */
async function switchMode(client: AoClient, s: Session, mode: PermissionMode): Promise<"live" | "restarted" | "next-resume"> {
	const approval = approvalModeFor(mode);
	const current = s.model.conversation?.settings.approvalMode;
	const live = !s.model.view.isTerminated && s.model.view.activity.state !== "exited";
	if (live && isOmpHarness(s.model.harness)) await setOmpMode(client, s.id, mode === "plan" ? "plan" : "default").catch(err => {
		if (mode === "plan") throw err;
	});
	if (current === approval || (mode === "plan" && current !== undefined)) return "live";
	await client.setTurnSettings(s.id, { approvalMode: approval });
	if (!live) return "next-resume";
	if (s.model.conversation?.turns.some(t => t.state === "running" || t.state === "queued")) throw new Error(`the agent's approval level changes only when AO restarts it, and ${s.id} is working: switch when it is idle, or abort it first (MAPPING G7)`);
	await client.exitAgent(s.id);
	await client.resumeAgent(s.id);
	return "restarted";
}

async function cmdMode(args: Args): Promise<void> {
	// `switchyard mode plan` = the latest session in this folder.
	const [ref, want] = args._.length === 1 && permissionModeOf(args._[0].toLowerCase()) ? [".", args._[0]] : [args._[0] ?? ".", args._[1]];
	const s = await findSession(ref);
	const client = await ao();
	if (!want) {
		const plan = (await livePlanMode(client, s.id)) === true;
		const current = s.mode ?? aoPermissionMode(s.model.conversation?.settings, plan, s.model.harness);
		process.stdout.write(`${c.bold(s.title)} ${c.dim(s.id)} · ${current ? PERMISSION_MODE_INFO[current].label : c.dim("omp's own approval setting (tools.approvalMode)")}\n`);
		for (const m of PERMISSION_MODES) process.stdout.write(`  ${m === current ? c.green("●") : c.dim("·")} ${pad(m, 6)} ${c.dim(PERMISSION_MODE_INFO[m].detail)}\n`);
		return;
	}
	const mode = permissionModeOf(want.toLowerCase());
	if (!mode) throw new UsageError(`unknown mode "${want}" (${PERMISSION_MODES.join(", ")})`);
	const omp = isOmpHarness(s.model.harness);
	if (!omp && mode === "plan") throw new Error(`plan mode is omp-only (Switchyard's omp extension); ${s.id} runs ${s.model.harness}: use ask, edits or auto`);
	// A session started by Switchyard has a mode file: the gate reads it at the next tool call, no restart (D11).
	if (omp && s.mode !== undefined) {
		const problem = modeProblem(mode, `mode ${mode}`);
		if (problem) throw new Error(problem);
		await setSessionMode(client, s.id, mode);
		process.stdout.write(`${c.green(PERMISSION_MODE_INFO[mode].label)} ${s.id} ${s.title}${c.dim(" (live)")}\n`);
		return;
	}
	const how = await switchMode(client, s, mode);
	const note = how === "restarted" ? c.dim(` (${omp ? "omp" : s.model.harness} restarted on the same transcript)`) : how === "next-resume" ? c.dim(" (applies when resumed)") : "";
	// AO can't launch omp in always-ask (MAPPING G12): ask leaves the decision to omp's own setting.
	if (mode === "ask" && omp) process.stderr.write(c.dim("ask: omp asks as its own tools.approvalMode says (AO has no always-ask)\n"));
	process.stdout.write(`${c.green(PERMISSION_MODE_INFO[mode].label)} ${s.id} ${s.title}${note}\n`);
}

/** Shows or switches a session's model (AO applies it from the next turn). */
async function cmdModel(args: Args): Promise<number> {
	const s = await findSession(args._[0] ?? ".");
	const want = args._[1];
	const json = flag(args, "json");
	const live = !s.model.view.isTerminated && s.model.view.activity.state !== "exited";
	if (!want) {
		const model = s.model.model ?? null;
		if (json) process.stdout.write(`${JSON.stringify({ id: s.id, model, running: live })}\n`);
		else process.stdout.write(`${model ?? c.dim(`${s.model.harness ?? "omp"}'s default`)} ${c.dim(`${s.id} ${s.title}`)}\n`);
		return 0;
	}
	const client = await ao();
	// A running omp says which models it offers (its own choices, not the catalog): refuse another one before changing the setting.
	if (live) {
		const choices = await sessionModelChoices(client, s.id);
		if (choices?.length && !choices.some(m => m.value === want)) throw new Error(`${s.model.harness ?? "omp"} offers no model ${want} to ${s.id} (switchyard models --session ${s.id} lists them)`);
	}
	await client.setTurnSettings(s.id, { model: want });
	const applied = live ? "live" : "next-resume";
	if (json) process.stdout.write(`${JSON.stringify({ id: s.id, model: want, applied })}\n`);
	else process.stdout.write(`${c.green(want)} ${s.id} ${s.title}${applied === "next-resume" ? c.dim(" (from its next resume)") : ""}\n`);
	return 0;
}

// ---------- queue (planner session lanes) ----------

type QueueTask = PlannerQueue["tasks"][number];
const TASK_MARK: Record<QueueTask["status"], string> = { pending: "·", running: "▶", done: "✓", failed: "✗", skipped: "−" };

function printQueue(s: Session, q: PlannerQueue): void {
	const state = q.tasks.some(t => t.status === "running") ? c.yellow("running") : q.autoRun ? c.blue("auto-run on") : q.startAt ? c.blue(`starts ${new Date(q.startAt).toLocaleString()}`) : c.dim("paused");
	process.stdout.write(`${c.bold(s.title)} ${c.dim(s.id)} · ${state}\n`);
	if (q.tasks.length === 0) process.stdout.write(c.dim("  no tasks · switchyard queue <session> add <task>\n"));
	const width = termWidth();
	q.tasks.forEach((t, i) => {
		const color = t.status === "done" ? c.green : t.status === "failed" ? c.red : t.status === "running" ? c.yellow : t.status === "skipped" ? c.dim : (x: string) => x;
		const subs = t.subtasks.length ? c.dim(` (${t.subtasks.filter(x => x.done).length}/${t.subtasks.length})`) : "";
		const wait = t.status === "pending" && t.state !== "waiting" && t.state !== "paused" ? c.dim(` ${t.state}`) : "";
		process.stdout.write(`  ${c.dim(String(i + 1).padStart(2))} ${color(TASK_MARK[t.status])} ${truncate(oneLine(t.title), width - 24)}${subs}${wait}\n`);
		if (t.status === "failed" && t.summary) process.stdout.write(`       ${c.red(truncate(oneLine(t.summary), width - 8))}\n`);
	});
}

function taskRef(q: PlannerQueue, ref: string | undefined): QueueTask {
	if (!ref) throw new UsageError("which task? (number or id)");
	const n = Number(ref);
	const t = Number.isInteger(n) && n >= 1 ? q.tasks[n - 1] : q.tasks.find(x => x.id.startsWith(ref));
	if (!t) throw new Error(`no task ${ref}`);
	return t;
}

async function cmdQueue(args: Args): Promise<void> {
	const s = await findSession(args._[0] ?? ".");
	const p = await planner();
	const sub = args._[1] ?? "ls";
	const rest = args._.slice(2);
	const q = await p.call("getQueue", { id: s.id });
	const json = flag(args, "json");
	let ops: QueueOp[];
	let spareTask: "top" | "last" | undefined;
	switch (sub) {
		case "ls":
		case "list":
			if (json) process.stdout.write(`${JSON.stringify(q, null, 2)}\n`);
			else printQueue(s, q);
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
			const subs = args.multi.get("sub");
			ops = [{ op: "add", title, ...(notes ? { notes } : {}), ...(subs && { subtasks: subs }), ...(flag(args, "top") ? { index: 0 } : {}) }];
			// A spare task is marked before the queue is armed: --run waits until it is.
			const usage = value(args, "usage");
			if (usage !== undefined && usage !== "normal" && usage !== "spare") throw new UsageError("--usage must be normal or spare");
			if (usage === "spare") spareTask = flag(args, "top") ? "top" : "last";
			if (flag(args, "run") && !spareTask) ops.push({ op: "autoRun", value: true });
			break;
		}
		case "run":
			refreshBundles();
			ops = [{ op: "run", ...(rest[0] ? { id: taskRef(q, rest[0]).id } : {}) }];
			break;
		case "pause":
			ops = [{ op: "autoRun", value: false }];
			break;
		case "start":
		case "resume":
			refreshBundles();
			ops = [{ op: "autoRun", value: true }];
			break;
		case "clear":
			ops = [{ op: "clearDone" }];
			break;
		case "requeue":
			// Failed tasks go back to pending; else a paused or interrupted queue restarts; else the last finished task runs again.
			if (!canRequeue(q)) throw new Error("nothing to requeue: the queue has no tasks, a task is running, or its pending tasks already wait to run (queue run starts them now)");
			ops = [{ op: "requeue" }];
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
		case "after": {
			// Sessions this queue waits for (replacing its dependencies); `off` or none clears them.
			const ids: string[] = [];
			if (!(rest.length === 0 || (rest.length === 1 && (rest[0] === "off" || rest[0] === "none")))) for (const ref of rest) ids.push((await findSession(ref)).id);
			ops = [{ op: "after", ids }];
			break;
		}
		default:
			throw new UsageError(`unknown queue command "${sub}" (ls, add, run, start, pause, clear, retry, requeue, rm, done, skip, at, after)`);
	}
	let next = await p.call("queue", { id: s.id, ops });
	if (spareTask) {
		const t = spareTask === "top" ? next.tasks[0] : next.tasks.at(-1);
		if (t) await p.call("edit", { ops: [{ op: "update", id: t.id, usage: "spare" }] });
		if (flag(args, "run")) next = await p.call("queue", { id: s.id, ops: [{ op: "autoRun", value: true }] });
	}
	if (json) process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
	else printQueue(s, next);
}

// ---------- organize (organize.json, MAPPING D5; priority: the planner) ----------

async function cmdOrganize(cmd: string, args: Args): Promise<void> {
	const s = await findSession(args._[0]);
	const arg = args._[1];
	const store = new OrganizeStore(undefined, id => (id === s.id ? s.model.createdAt : undefined));
	const before = JSON.stringify(store.session(s.id));
	const ids = [s.id];
	const siblings = async () => store.groupSiblings(s.id, (await allSessions()).map(x => x.id));
	let changed: boolean | undefined;
	switch (cmd) {
		case "prio": {
			if (!isPriority(arg)) throw new UsageError(`prio <session> <${PRIORITIES.join("|")}>`);
			// The planner orders dispatch by lane priority; organize.json keeps it for the board's sort.
			changed = s.priority !== arg;
			const p = await plannerIfRunning();
			if (p && s.lane) await p.call("edit", { ops: [{ op: "lane.update", id: s.id, priority: arg }] });
			store.setPriority(ids, arg);
			break;
		}
		case "color":
			if (arg !== "none" && !isOrgColor(arg)) throw new UsageError(`color <session> <${ORG_COLORS.join("|")}|none>`);
			store.setColor(ids, isOrgColor(arg) ? arg : undefined);
			break;
		case "group": {
			const name = args._.slice(1).join(" ").trim();
			if (!name) throw new UsageError("group <session> <group name|none>");
			if (name === "none") store.setGroup(ids, undefined);
			else store.setGroup(ids, (store.data.groups.find(g => g.name.toLowerCase() === name.toLowerCase()) ?? store.createGroup({ name })).id);
			break;
		}
		case "archive":
		case "unarchive":
			store.setArchived(ids, cmd === "archive");
			break;
		case "move": {
			if (arg !== "up" && arg !== "down" && arg !== "top" && arg !== "bottom") throw new UsageError("move <session> <up|down|top|bottom>");
			const list = await siblings();
			if (arg === "up" || arg === "down") store.move(s.id, arg === "up" ? -1 : 1, list);
			else if (arg === "top") store.moveToTop(ids, list);
			else store.place(ids, list, list.length - 1);
			break;
		}
		default:
			throw new UsageError(`unknown command ${cmd}`);
	}
	changed ||= JSON.stringify(store.session(s.id)) !== before;
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify({ id: s.id, archived: store.session(s.id)?.archived === true, changed })}\n`);
	else process.stdout.write(changed ? `${c.green("updated")} ${s.id} ${s.title}\n` : c.dim("no change\n"));
}

// ---------- plan: graph propagation (the planner's edge state) ----------

const EDGE_COLOR: Record<string, (s: string) => string> = { "in-sync": c.green, merged: c.green, pending: c.yellow, resolving: c.yellow, "upstream-changed": c.blue, conflict: c.red };

function printEdges(edges: GraphEdge[]): void {
	if (!edges.length) {
		process.stdout.write(c.dim("no graph edges with propagation state (tasks in a git project that wait for other tasks)\n"));
		return;
	}
	for (const e of edges) {
		const arrow = `${e.parentSession ?? e.parent} → ${e.childSession ?? e.child}`;
		const heads = e.parentHead ? c.dim(` ${e.parentHead.slice(0, 8)}`) : "";
		const files = e.files?.length ? c.red(` ${e.files.join(", ")}`) : "";
		process.stdout.write(`${(EDGE_COLOR[e.state] ?? c.dim)(pad(e.state, 17))}${arrow}${heads}${files}\n`);
	}
}

/**
 * `plan status [ref]` lists the graph's edges and how far each parent's changes reached its child.
 * `plan sync <ref> [--rerun]` brings the parents' changes into the task's worktree now (it re-checks each
 * parent's branch and propagates; a task without parents re-checks its own branch for its children);
 * `--rerun` also runs a finished task again whose edge says `upstream-changed`.
 */
async function cmdPlan(args: Args): Promise<number> {
	const sub = args._[0] ?? "status";
	const ref = args._[1];
	const json = flag(args, "json");
	const p = sub === "status" && !(await plannerIfRunning()) ? undefined : await planner();
	if (sub === "status") {
		let edges: GraphEdge[] = [];
		if (p) {
			const plan = await p.call("plan", {});
			if (!ref) edges = graphEdges(plan);
			else {
				// A task id, a session (or its lane), or title words and `.` as everywhere else.
				const named = tasksOfRef(plan, ref).length ? ref : (await findSession(ref)).id;
				edges = edgesOfRef(plan, named);
			}
		}
		if (json) process.stdout.write(`${JSON.stringify({ edges })}\n`);
		else printEdges(edges);
		return 0;
	}
	if (sub !== "sync") throw new UsageError(`unknown plan command "${sub}" (status [ref], sync <ref> [--rerun])`);
	if (!ref || !p) throw new UsageError("plan sync <task|session> [--rerun]");
	let plan = await p.call("plan", {});
	let tasks = tasksOfRef(plan, ref);
	// Title words and `.` name sessions, as everywhere else.
	if (!tasks.length) tasks = tasksOfRef(plan, (await findSession(ref)).id);
	if (!tasks.length) throw new Error(`no task or session matches "${ref}" in the plan`);
	const targets = [...new Set(tasks.flatMap(t => (t.after?.length ? t.after : [t.id])))];
	await p.call("edit", { ops: targets.map(id => ({ op: "sync" as const, id })) });
	plan = await p.call("plan", {});
	const mine = new Set(tasks.map(t => t.id));
	const rerun = flag(args, "rerun") ? graphEdges(plan).filter(e => mine.has(e.child) && e.state === "upstream-changed").map(e => e.child) : [];
	if (rerun.length) {
		await p.call("edit", { ops: [...new Set(rerun)].map(id => ({ op: "requeue" as const, id })) });
		plan = await p.call("plan", {});
	}
	const edges = graphEdges(plan).filter(e => mine.has(e.child) || mine.has(e.parent));
	// `task`: the one task the ref named (the ref itself when a session ran several); `rerun`: a re-run was started, for `rerunTasks`.
	const rerunTasks = [...new Set(rerun)];
	if (json) process.stdout.write(`${JSON.stringify({ task: tasks.length === 1 ? tasks[0].id : ref, id: ref, synced: targets, rerun: rerunTasks.length > 0, rerunTasks, edges })}\n`);
	else {
		process.stdout.write(`${c.green("synced")} ${targets.join(", ")}${rerun.length ? c.dim(` · re-running ${[...new Set(rerun)].join(", ")}`) : ""}\n`);
		printEdges(edges);
	}
	return 0;
}

/** `complete|uncomplete <session>`: the completed marker (PARKED §5), kept on the session's planner lane. */
async function cmdComplete(args: Args, cmd: string): Promise<number> {
	const s = await findSession(args._[0] ?? ".");
	const completed = cmd === "complete";
	const p = await planner();
	// A session that never had a task has no lane yet: the marker needs one (it holds no tasks).
	if (!s.lane) await p.call("edit", { ops: [{ op: "lane.add", id: s.id, session: s.id, autoRun: false }] });
	const before = (await lanesOf(p)).get(s.id)?.completed;
	if ((before !== undefined) !== completed) await p.call("edit", { ops: [{ op: "lane.complete", id: s.id, completed }] });
	const after = (await lanesOf(p)).get(s.id)?.completed;
	const changed = (before !== undefined) !== (after !== undefined);
	if (flag(args, "json")) process.stdout.write(`${JSON.stringify({ id: s.id, completed: after !== undefined, ...(after ? { completedAt: after } : {}), changed })}\n`);
	else if (changed) process.stdout.write(`${completed ? c.green("completed ✓") : c.yellow("reopened")} ${s.id} ${s.title}\n`);
	else process.stdout.write(c.dim("no change\n"));
	return 0;
}

// ---------- scheduler (the planner) ----------

async function cmdSched(args: Args): Promise<void> {
	const [sub, arg] = args._;
	let set: Partial<PlannerConfig> | undefined;
	let budgetSet: ((now: PlannerStatus) => Partial<PlannerConfig>) | undefined;
	let clearLimits: true | string[] | undefined;
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
			throw new UsageError("sched stop-when-done is gone: the planner has no per-queue stop. A finished queue frees its agent process only when AO's chat hibernation is on (it hibernates a chat nobody views after 90 s; off by default on a headless daemon: start AO with hibernation on). MAPPING: stopWhenQueueDone dropped");
		case "budget": {
			// budget <hour|day|week> <usd|off>: a cap on what planner-dispatched work may spend in a rolling window.
			if (arg === undefined) break;
			const window = arg;
			if (window !== "hour" && window !== "day" && window !== "week") throw new UsageError("sched budget <hour|day|week> <usd|off>");
			const amount = args._[2];
			const usd = amount === "off" || amount === "none" ? null : Number(amount);
			if (usd !== null && !(Number.isFinite(usd) && usd > 0)) throw new UsageError("sched budget <hour|day|week> <usd|off>");
			budgetSet = now => {
				const next = { ...now.budget };
				if (usd === null) delete next[window];
				else next[window] = usd;
				return { budget: next };
			};
			break;
		}
		case "usage": {
			// usage hold|spare <percent>: where a provider's usage window holds work, and below which "spare" tasks start.
			const pct = Number(args._[2]);
			if ((arg !== "hold" && arg !== "spare") || !(Number.isFinite(pct) && pct > 0 && pct <= 100)) throw new UsageError("sched usage <hold|spare> <percent 1-100>");
			budgetSet = now => ({ usage: { ...now.usage, ...(arg === "hold" ? { holdAtPercent: pct } : { spareBelowPercent: pct }) } });
			break;
		}
		case "limits": {
			// limits [clear [provider…]]: the provider limits learned from failed turns; clear forgets them so held work may start.
			if (arg === undefined) break;
			if (arg !== "clear") throw new UsageError("sched limits [clear [provider…]]");
			const providers = args._.slice(2);
			clearLimits = providers.length ? providers : true;
			break;
		}
		default:
			throw new UsageError(`unknown sched command "${sub}" (status, set N, pause, resume, budget, usage, limits)`);
	}
	const p = set || budgetSet || clearLimits ? await planner() : await plannerIfRunning();
	// Budget and usage thresholds replace their whole object in the planner: start from what it has.
	if (p && budgetSet) set = budgetSet(await p.call("scheduler", {}));
	const s = p ? await p.call("scheduler", { ...(set ? { set } : {}), ...(clearLimits ? { clearLimits } : {}) }) : undefined;
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify(s ? { ...s, server: true } : { server: false })}\n`);
		return;
	}
	if (!s) {
		process.stdout.write(`${c.yellow("planner not running")} ${c.dim("· switchyard server start (queue and sched commands start it)")}\n`);
		return;
	}
	const yes = (v: boolean) => (v ? c.green("yes") : c.dim("no"));
	const at = (ms: number) => new Date(ms).toLocaleString();
	const rows = [
		`max concurrent  ${s.maxConcurrent ? c.bold(String(s.maxConcurrent)) : c.dim("unlimited")}`,
		`running         ${s.running}`,
		`waiting         ${s.waiting}`,
		`scheduled       ${s.scheduled}  ${c.dim("(start at a set time)")}`,
		`held            ${s.held}  ${c.dim("(usage limits, budget, retry backoff)")}`,
		`blocked         ${s.blocked}  ${c.dim("(waiting for other tasks)")}`,
		`interrupted     ${s.interrupted}`,
		`paused          ${yes(!!s.paused)}`,
		`usage           ${c.dim(`hold work at ${s.usage.holdAtPercent}% of a provider's window; "spare" tasks start below ${s.usage.spareBelowPercent}%`)}`,
		`budget          ${s.budget && Object.keys(s.budget).length ? Object.entries(s.budget).map(([w, usd]) => `${w} $${usd}`).join(" · ") : c.dim("none")}`,
		...s.spend.map(u => `  ${u.window.padEnd(5)} $${u.spent.toFixed(2)} of $${u.cap}${u.over ? c.red(` over${u.freesAt ? `, frees ${at(u.freesAt)}` : ""}`) : ""}`),
		...s.limits.map(l => `limit           ${c.yellow(l.provider)}${l.model ? `/${l.model}` : ""} until ${at(l.until)}${l.guessed ? c.dim(" (guessed)") : ""}  ${c.dim(oneLine(l.reason).slice(0, 80))}`),
		...s.usageWindows.map(w => `window          ${w.provider} ${w.window} ${w.usedPercent}%${w.resetsAt ? c.dim(` resets ${at(w.resetsAt)}`) : ""}`),
		`planner         ${c.green("running")} ${c.dim(s.version)}`,
	];
	process.stdout.write(`${rows.join("\n")}\n`);
}

// ---------- server (the planner service) ----------

async function cmdServer(args: Args): Promise<number> {
	const sub = args._[0] ?? "status";
	const svc = plannerService();
	switch (sub) {
		case "start":
		case "restart": {
			if (sub === "restart") await svc.stop();
			const info = await svc.start();
			process.stdout.write(`${c.green("running")} pid ${info.pid} · ${info.version}\n`);
			return 0;
		}
		case "stop":
			process.stdout.write((await svc.stop()) ? `${c.green("stopped")} ${c.dim("(AO keeps the sessions running; queued work waits until it starts again)")}\n` : c.dim("not running\n"));
			return 0;
		case "status": {
			const info = await svc.status();
			if (flag(args, "json")) {
				process.stdout.write(`${JSON.stringify({ running: !!info, ...(info ? { pid: info.pid, version: info.version, startedAt: info.startedAt } : {}), socket: svc.socket() ?? null, log: svc.logPath() })}\n`);
				return info ? 0 : 3;
			}
			if (!info) {
				process.stdout.write(`${c.yellow("not running")} ${c.dim("· switchyard server start (queue and sched commands start it on demand)")}\n`);
				return 3;
			}
			process.stdout.write(`${c.green("running")} pid ${info.pid} · ${info.version} · up ${ago(info.startedAt)}\n${c.dim(`socket ${svc.socket() ?? "(not recorded)"}\nlog    ${svc.logPath()}`)}\n`);
			return 0;
		}
		case "log": {
			const file = svc.logPath();
			process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
			if (!flag(args, "follow")) return 0;
			let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
			fs.watchFile(file, { interval: 500 }, cur => {
				if (cur.size < offset) offset = 0;
				if (cur.size === offset) return;
				const fd = fs.openSync(file, "r");
				const buf = Buffer.alloc(cur.size - offset);
				fs.readSync(fd, buf, 0, buf.length, offset);
				fs.closeSync(fd);
				offset = cur.size;
				process.stdout.write(buf.toString("utf8"));
			});
			await new Promise<void>(() => {});
			return 0;
		}
		case "install": {
			const r = await svc.install();
			process.stdout.write(r.ok ? `${c.green("installed")} ${r.file}\n` : `${c.yellow("wrote")} ${r.file} ${c.dim(`(${r.hint})`)}\n`);
			return r.ok ? 0 : 1;
		}
		case "uninstall": {
			const file = await svc.uninstall();
			process.stdout.write(file ? `${c.green("removed")} ${file}\n` : c.dim("no service installed\n"));
			return 0;
		}
		default:
			throw new UsageError(`unknown server command "${sub}" (start, stop, restart, status, log [-f], install, uninstall)`);
	}
}

// ---------- AO's dashboard: AO's own web UI, served by the planner (src/ao/dashboard.ts) ----------

/** What `dashboard status` and `status` report: config, the installed UI, and whether the server answers. */
async function dashboardState(startPlanner: boolean) {
	const config = readSwitchyardConfig();
	const enabled = dashboardEnabled(config);
	const port = dashboardPort(config);
	const install = readDashboardInstall();
	if (enabled && startPlanner) await plannerService().start();
	const served = enabled ? await probeDashboard(port) : undefined;
	return { enabled, installed: !!install, version: install?.version ?? null, source: install?.source ?? null, port, url: dashboardUrl(port), serving: !!served, ...(served && { daemon: served.daemon }) };
}

async function cmdDashboard(args: Args): Promise<number> {
	const sub = args._[0] ?? "status";
	const json = flag(args, "json");
	switch (sub) {
		case "install": {
			const from = value(args, "from");
			const release = value(args, "release");
			if (from && release) throw new UsageError("dashboard install takes --from or --release, not both");
			const install = await installDashboard({ ...(from && { from }), ...(release && { release }), log: line => json || process.stderr.write(c.dim(`${line}\n`)) });
			const state = await dashboardState(true);
			if (json) process.stdout.write(`${JSON.stringify({ ...state, installedAt: install.installedAt })}\n`);
			else process.stdout.write(`${c.green("installed")} AO ${install.version ?? "(unknown version)"} ${c.dim(`from ${install.source}`)}\n${state.serving ? `${c.green("serving")} ${state.url}` : !state.enabled ? c.yellow(`not served: dashboard is off (switchyard config set dashboard on)`) : c.yellow(`not served yet on port ${state.port}: a planner started before this version doesn't serve it (switchyard server restart); else see switchyard server log`)}\n`);
			return 0;
		}
		case "uninstall":
			process.stdout.write(json ? `${JSON.stringify({ removed: uninstallDashboard() })}\n` : uninstallDashboard() ? `${c.green("removed")} ${c.dim(dashboardDir())}\n` : c.dim("not installed\n"));
			return 0;
		case "url": {
			const state = await dashboardState(true);
			process.stdout.write(json ? `${JSON.stringify(state.url)}\n` : `${state.url}\n`);
			return state.serving && state.installed ? 0 : 1;
		}
		case "status": {
			const state = await dashboardState(true);
			if (json) {
				process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
				return 0;
			}
			const row = (label: string, text: string) => `${c.dim(pad(label, 10))}${text}`;
			process.stdout.write(
				[
					row("installed", state.installed ? `AO ${state.version ?? "(unknown version)"} ${c.dim(`from ${state.source}`)}` : `${c.yellow("no")} ${c.dim(`(${INSTALL_COMMAND})`)}`),
					row("server", !state.enabled ? c.dim("off (switchyard config set dashboard on)") : state.serving ? `${c.green("serving")} ${state.url}${state.daemon === false ? c.yellow(" · AO's daemon is not running") : ""}` : c.red(`nothing answers on port ${state.port} (switchyard server log; another program may hold the port: switchyard config set dashboard.port <n>)`)),
				].join("\n") + "\n",
			);
			return 0;
		}
		default:
			throw new UsageError(`unknown dashboard command "${sub}" (status, url, install [--release <tag>|--from <path>], uninstall)`);
	}
}

// ---------- remote access: AO's mobile pairing (MAPPING "Phone and remote access") ----------

type MobileStatus = AoSchemas["MobileStatusResponse"];

function remoteJson(s: MobileStatus) {
	return {
		enabled: s.enabled,
		listening: s.enabled && s.endpoints.length > 0,
		endpoints: s.endpoints,
		...(s.endpoints[0] && { url: `${s.endpoints[0].secure ? "https" : "http"}://${s.endpoints[0].host}:${s.endpoints[0].port}` }),
		securePairing: s.securePairing,
		tunnel: { running: s.tunnel.running, ready: s.tunnel.ready, ...(s.tunnel.hostname && { hostname: s.tunnel.hostname }), ...(s.tunnel.lastError && { error: s.tunnel.lastError }) },
		...(s.warning && { warning: s.warning }),
	};
}

function printRemote(s: MobileStatus, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(remoteJson(s))}\n`);
		return;
	}
	const state = !s.enabled ? c.dim("off") : s.endpoints.length ? c.green("on") : c.yellow("on, preparing");
	const rows = [`remote  ${state}${s.securePairing.active ? c.dim(" · Tailscale secure pairing") : ""}`];
	for (const e of s.endpoints) rows.push(`        ${e.kind.padEnd(10)} ${e.secure ? "https" : "http"}://${e.host}:${e.port}`);
	if (s.securePairing.enabled && !s.securePairing.active && s.securePairing.reason) rows.push(c.yellow(`secure pairing: ${s.securePairing.reason}`));
	if (s.tunnel.lastError) rows.push(c.red(`tunnel: ${s.tunnel.lastError}`));
	if (s.enabled && s.warning) rows.push(c.yellow(s.warning));
	if (s.enabled) rows.push(c.dim("pair a phone: switchyard remote qr (scan it with the AO mobile app)"));
	process.stdout.write(`${rows.join("\n")}\n`);
}

/** AO's mobile status after `call`; its `endpoints` is null rather than [] while pairing is off. */
async function mobile(client: AoClient, call: "status" | "secure-pairing" | "/api/v1/mobile/enable" | "/api/v1/mobile/enable-lan-only" | "/api/v1/mobile/enable-tunnel-only" | "/api/v1/mobile/disable" | "/api/v1/mobile/regenerate"): Promise<MobileStatus> {
	const s = await unwrap<MobileStatus>(call === "status" ? client.api.GET("/api/v1/mobile/status") : call === "secure-pairing" ? client.api.POST("/api/v1/mobile/secure-pairing", { body: { enabled: true } }) : client.api.POST(call));
	return { ...s, endpoints: s.endpoints ?? [] };
}

async function cmdRemote(args: Args): Promise<number> {
	const sub = args._[0] ?? "status";
	const client = await ao();
	const status = () => mobile(client, "status");
	switch (sub) {
		case "on": {
			if (value(args, "port") !== undefined || value(args, "url") !== undefined) throw new UsageError("--port and --url are gone: AO chooses the port, and reaches phones over LAN, Tailscale secure pairing or its tunnel (--bind)");
			const bind = value(args, "bind") ?? "tailscale";
			let s: MobileStatus;
			if (bind === "tailscale") {
				await mobile(client, "/api/v1/mobile/enable-lan-only");
				s = await mobile(client, "secure-pairing");
			} else if (bind === "lan") s = await mobile(client, "/api/v1/mobile/enable-lan-only");
			else if (bind === "tunnel") s = await mobile(client, "/api/v1/mobile/enable-tunnel-only");
			else if (bind === "all") s = await mobile(client, "/api/v1/mobile/enable");
			else throw new UsageError("--bind must be tailscale, lan, tunnel or all");
			printRemote(s, flag(args, "json"));
			return s.enabled ? 0 : 1;
		}
		case "off": {
			const s = await mobile(client, "/api/v1/mobile/disable");
			if (flag(args, "json")) printRemote(s, true);
			else process.stdout.write(`remote  ${c.dim("off")}\n`);
			return 0;
		}
		case "status": {
			const s = await status();
			printRemote(s, flag(args, "json"));
			return 0;
		}
		case "qr": {
			const s = await status();
			if (!s.enabled) throw new Error("remote access is off (switchyard remote on)");
			const url = pairingLink(s);
			if (!url) throw new Error("AO has no address to offer the phone yet (switchyard remote status)");
			process.stdout.write(`${qrHalfBlocks(url, colorEnabled())}\n${url}\n${c.dim("Scan with the AO mobile app. Anyone with this code can control your sessions.")}\n`);
			return 0;
		}
		case "rotate": {
			const s = await mobile(client, "/api/v1/mobile/regenerate");
			process.stdout.write(`${c.green("new password")} · paired phones must pair again${s.enabled ? c.dim(" (switchyard remote qr)") : ""}\n`);
			return 0;
		}
		default:
			throw new UsageError(`unknown remote command "${sub}" (on, off, status, qr, rotate)`);
	}
}

// ---------- machine status ----------

/** Display order of `show` states; any other state follows. */
const STATE_ORDER = ["needs_input", "working", "starting", "queued", "scheduled", "interrupted", "idle", "stopped"];

type Readiness = AoSchemas["AgentReadinessResponse"]["agents"][number];

/**
 * Before `new`, `resume`, a `send` that wakes a stopped session, `queue run` and on `status`: installs or refreshes
 * Switchyard's omp extension and shim when this build ships newer ones (G38, G46); one notice on a first install,
 * and a read-only folder (EACCES) is a warning, not a failure: the mode check then says what it breaks.
 */
function refreshBundles(): void {
	try {
		const done = ensureBundles();
		if (done?.error) process.stderr.write(c.yellow(`warning: ${done.error}\n`));
		else if (done?.firstInstall) process.stderr.write(c.dim(`installed Switchyard's omp extension into ${done.dir} (switchyard omp-extension status; config set omp-extension off stops this)\n`));
	} catch (err) {
		process.stderr.write(c.yellow(`warning: could not install Switchyard's omp extension: ${err instanceof Error ? err.message : String(err)}\n`));
	}
}

/** `omp-extension install|status|uninstall`: the omp extension (mode gate, checkpoints, todos, bridge) and the `omp` shim, without VS Code. */
async function cmdOmpExtension(args: Args): Promise<number> {
	const sub = args._[0] ?? "status";
	const json = flag(args, "json");
	if (sub === "install") {
		const result = installBundles();
		const report = extensionReport((await findDaemon().catch(() => undefined))?.pid);
		if (json) process.stdout.write(`${JSON.stringify({ ...result, ...report })}\n`);
		else {
			// installed lists what this call wrote; upToDate: both were already as shipped.
			process.stdout.write(`${c.green("extension")} ${result.installed.includes("gate") ? "installed" : "unchanged"} ${c.dim(report.dir)}\n`);
			process.stdout.write(`${c.green("shim")} ${result.installed.includes("shim") ? "installed" : "unchanged"} ${c.dim(report.shim.path)}\n`);
			if (result.skipped) process.stderr.write(c.yellow(`skipped: ${result.skipped}\n`));
			if (result.error) process.stderr.write(c.red(`${result.error}${result.code ? ` [${result.code}]` : ""}\n`));
			if (report.shim.onDaemonPath === false) process.stderr.write(c.yellow(`note: the running AO daemon doesn't have ${path.dirname(report.shim.path)} first on its PATH: restart it through Switchyard for omp flags to apply\n`));
		}
		return result.error || result.skipped ? 1 : 0;
	}
	if (sub === "uninstall") {
		const result = uninstallBundles();
		if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
		else process.stdout.write(`${result.extensions || result.shim ? c.green("removed") : c.dim("nothing installed")}${result.extensions ? " extension" : ""}${result.shim ? " shim" : ""}\n`);
		return 0;
	}
	if (sub !== "status") throw new UsageError(`unknown omp-extension command "${sub}" (status, install, uninstall)`);
	const report = extensionReport((await findDaemon().catch(() => undefined))?.pid);
	const ok = report.installed && report.current;
	if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else {
		process.stdout.write(`${c.bold("extension")} ${report.installed ? (report.current ? c.green("installed") : c.yellow("installed, older than this build")) : c.red("not installed")} ${c.dim(report.dir)}\n`);
		if (report.modules.length) process.stdout.write(c.dim(`  modules: ${report.modules.join(", ")}\n`));
		process.stdout.write(`${c.bold("shim")}      ${report.shim.installed ? (report.shim.current ? c.green("installed") : c.yellow("installed, older than this build")) : c.red("not installed")} ${c.dim(report.shim.path)}${report.shim.onDaemonPath === false ? c.yellow(" (not first on the running AO daemon's PATH)") : ""}\n`);
		process.stdout.write(c.dim(`auto-install ${report.auto}${report.shipped ? "" : " · this build ships neither (no omp-extension/ or omp-shim/ next to cli.js)"}\n`));
		if (!ok) process.stdout.write(c.dim("switchyard omp-extension install\n"));
	}
	return ok ? 0 : 1;
}

async function cmdStatus(args: Args): Promise<number> {
	refreshBundles();
	const problems: string[] = [];
	// omp's own issues when new sessions run another harness: worth saying, not a failure.
	const notesFirst: string[] = [];
	const daemon = await findDaemon().catch(() => undefined);
	const client = daemon ? await aoIfRunning() : undefined;
	if (!client) problems.push("the AO daemon is not running: sessions can't start (any switchyard command starts it, or: systemctl --user start ao-daemon)");
	const svc = plannerService();
	const p = await plannerIfRunning();
	const plannerStatus = p ? await p.call("status", {}).catch(() => undefined) : undefined;
	const plannerInfo = await svc.status();
	if (!plannerInfo) problems.push("the planner is not running: queued and scheduled tasks won't start until a command starts it (switchyard server start)");
	let omp: Readiness | undefined;
	let sessions: Session[] = [];
	let remote: MobileStatus | undefined;
	let hibernation: boolean | undefined;
	const config = readSwitchyardConfig();
	// The harness new sessions start with when they name none (the AO project's worker harness may still decide per project).
	let harness: { default?: HarnessChoice; problem?: string } | undefined;
	if (client) {
		const [ready, list, mob, harnesses] = await Promise.all([
			unwrap<AoSchemas["AgentReadinessResponse"]>(client.api.GET("/api/v1/agents/readiness")).catch(() => undefined),
			loadSessions(client, { conversationLimit: 1, ...(plannerStatus && p ? { lanes: await lanesOf(p).catch(() => undefined) } : {}) }).catch(() => []),
			mobile(client, "status").catch(() => undefined),
			availableHarnesses(client).catch(() => undefined),
		]);
		omp = ready?.agents.find(a => a.id === "omp");
		sessions = list;
		remote = mob;
		hibernation = await client.chatHibernation().catch(() => undefined);
		if (harnesses) {
			try {
				harness = { default: resolveHarness({ ...(config.harness && { config: config.harness }), harnesses }) };
			} catch (err) {
				harness = { problem: err instanceof Error ? err.message : String(err) };
				problems.push(`harness: ${harness.problem}`);
			}
		}
		// omp's readiness is a problem when new sessions run omp; otherwise a note (omp sessions can still be asked for).
		const ompIssues = harness?.default && !isOmpHarness(harness.default.harness) ? notesFirst : problems;
		if (!omp) ompIssues.push("AO does not know the omp agent");
		else if (omp.installation.state !== "installed") ompIssues.push(`omp: ${omp.installation.reason || omp.installation.state} (install omp, then: ao doctor)`);
		else if (omp.authentication.state === "unauthorized") ompIssues.push(`omp: ${omp.authentication.reason || "log in to a provider in omp"}`);
	}
	const ompDefault = !harness?.default || isOmpHarness(harness.default.harness);
	const byState: Record<string, number> = {};
	let pending = 0;
	let runningTasks = 0;
	for (const s of sessions) {
		byState[s.state] = (byState[s.state] ?? 0) + 1;
		pending += s.lane?.pending ?? 0;
		runningTasks += s.lane?.running ?? 0;
	}
	const dashboard = await dashboardState(false);
	// Mode gating of omp sessions depends on the omp extension (G38): without it nothing asks in ask, edits or plan.
	const extReport = extensionReport(daemon?.pid);
	const extensionInstalled = extReport.installed;
	const shimInstalled = extReport.shim.installed;
	if (!extensionInstalled) (ompDefault ? problems : notesFirst).push("Switchyard's omp extension is not installed: the ask, edits and plan modes cannot be enforced (auto works); no /undo, no todo mirror (switchyard omp-extension install)");
	else if (!extReport.current) problems.push("Switchyard's omp extension is older than this build (switchyard omp-extension install)");
	if (extReport.shim.onDaemonPath === false) problems.push(`the AO daemon was not started with ${path.dirname(extReport.shim.path)} first on its PATH: omp flags (config omp.extraArgs, new -- …) are ignored until AO is restarted through Switchyard`);
	const HIBERNATION_FIX = `curl -X PATCH ${daemon?.baseUrl ?? "http://127.0.0.1:3001"}/api/v1/settings/chat-hibernation -H 'content-type: application/json' -d '{"enabled":true}'`;
	const notes: string[] = [...notesFirst];
	if (hibernation === false && config.hibernation === "on") notes.push(`config.json says hibernation on but AO's chat hibernation reads off: it has not been applied yet (the daemon was not started by Switchyard, or was restarted by systemd). Apply it now: switchyard config set hibernation on`);
	else if (hibernation === false) notes.push(`AO's chat hibernation is off: idle agent hosts stay running. ${HIBERNATION_FIX} (docs/SETUP.md#idle-sessions-and-chat-hibernation). AO keeps the setting in memory only, so it reads off again after every AO restart, even if you turned it on: apply the fix again, or switchyard config set hibernation on, which Switchyard re-applies whenever it starts the daemon or the planner reconnects`);
	const status = {
		cli: VERSION,
		ok: problems.length === 0,
		problems,
		notes,
		home: switchyardHome(),
		ao: { running: !!client, ...(hibernation !== undefined && { chatHibernation: hibernation }), ...(daemon && { url: daemon.baseUrl, pid: daemon.pid, ...(daemon.executablePath && { executable: daemon.executablePath }) }) },
		harness: harness?.default ? { default: harness.default.harness, source: harness.default.source, reason: harness.default.reason, ...(config.harness && { configured: config.harness }) } : { default: null, ...(harness?.problem && { problem: harness.problem }), ...(config.harness && { configured: config.harness }) },
		server: { running: !!plannerInfo, ...(plannerInfo && { pid: plannerInfo.pid, version: plannerInfo.version, startedAt: plannerInfo.startedAt }), socket: svc.socket(), log: svc.logPath() },
		service: svc.serviceState(),
		omp: {
			...(omp && { installed: omp.installation.state === "installed", authenticated: omp.authentication.state, readiness: omp.effectiveReadiness }),
			extraArgs: config.omp?.extraArgs ?? [],
			extension: { installed: extensionInstalled, path: extReport.dir, modules: extReport.modules, current: extReport.current, shipped: extReport.shipped, auto: extReport.auto },
			shim: extReport.shim,
			...(config.model && { defaultModel: config.model }),
			...(config.mode && { defaultMode: config.mode }),
		},
		sessions: { total: sessions.length, archived: sessions.filter(s => s.archived).length, byState },
		tasks: { pending, running: runningTasks },
		scheduler: plannerStatus ? { ...plannerStatus, server: true } : { server: false },
		remote: remote ? remoteJson(remote) : { enabled: false },
		dashboard,
	};
	if (flag(args, "json")) {
		process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
		return status.ok ? 0 : 1;
	}
	const row = (label: string, text: string) => `${c.dim(pad(label, 10))}${text}`;
	const rows = [`${c.bold("switchyard")} ${VERSION} ${c.dim(`· home ${status.home}`)}`];
	rows.push(row("ao", daemon ? `${c.green("running")} ${daemon.baseUrl} pid ${daemon.pid}` : `${c.red("not running")} ${c.dim("(systemctl --user start ao-daemon)")}`));
	rows.push(row("idle", hibernation === undefined ? c.dim("unknown") : hibernation ? c.green("hibernation on") + c.dim(" (AO stops the agent of a chat nobody views after 90 s)") : `hibernation off ${c.dim("(idle agent hosts stay up; a note, not a problem)")}`));
	if (hibernation === false && config.hibernation === "on") rows.push(`${" ".repeat(10)}${c.yellow("config says on but AO reads off: not applied yet")} ${c.dim("(the daemon wasn't started by Switchyard, or was restarted by systemd) · apply it now: switchyard config set hibernation on")}`);
	else if (hibernation === false) rows.push(`${" ".repeat(10)}${c.dim(`${HIBERNATION_FIX} · lost when AO restarts (it reads off after every boot, even if you turned it on); switchyard config set hibernation on makes Switchyard re-apply it`)}`);
	rows.push(row("planner", plannerInfo ? `${c.green("running")} pid ${plannerInfo.pid} · ${plannerInfo.version} · up ${ago(plannerInfo.startedAt)}` : `${c.red("not running")} ${c.dim("(switchyard server start)")}`));
	const sv = status.service;
	rows.push(row("service", sv.installed ? `${sv.kind} ${c.green("installed")}${sv.file ? c.dim(` · ${sv.file}`) : ""}` : c.dim(sv.kind ? `not installed (switchyard server install sets up a ${sv.kind} service)` : "none on this platform (the planner starts on demand)")));
	rows.push(row("harness", harness?.default ? `${c.green(harness.default.harness)} ${c.dim(`(${harness.default.reason}; a project's worker harness may differ · switchyard harnesses)`)}` : harness?.problem ? c.red(harness.problem) : c.dim("unknown (AO not running)")));
	rows.push(row("omp", !omp ? c.dim("unknown (AO not running)") : omp.effectiveReadiness === "ready" ? c.green("ready") : c.yellow(`${omp.effectiveReadiness}: ${omp.installation.reason || omp.authentication.reason || ""}`)));
	rows.push(row("model", config.model ? `${config.model} ${c.dim("(omp sessions)")}` : c.dim("omp's default (switchyard config set model <provider/id>)")));
	rows.push(row("mode", config.mode ?? c.dim("auto (switchyard config set mode <auto|edits|ask|plan>)")));
	rows.push(row("extension", extensionInstalled ? c.green("installed") : (ompDefault ? c.red : c.yellow)("not installed") + c.dim(" (omp sessions: ask, edits and plan modes need it; auto does not)")));
	const inEffect = extReport.shim.inEffect;
	rows.push(row("shim", !shimInstalled ? c.dim("not installed (omp flags per session or machine are not applied)") : inEffect === true ? c.green("in effect") + c.dim(" (installed, first on the AO daemon's PATH)") : inEffect === false ? c.yellow("installed, not in effect") + c.dim(" (not first on the running AO daemon's PATH)") : c.green("installed") + c.dim(" (the daemon's PATH can't be read here)")));
	const states = Object.entries(byState).sort(([a], [b]) => (STATE_ORDER.indexOf(a) + 1 || 99) - (STATE_ORDER.indexOf(b) + 1 || 99));
	rows.push(row("sessions", `${sessions.length}${states.length ? ` · ${states.map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(" · ")}` : ""}${status.sessions.archived ? c.dim(` (${status.sessions.archived} archived)`) : ""}`));
	rows.push(row("tasks", `${pending} pending · ${runningTasks} running`));
	if (plannerStatus) rows.push(row("scheduler", `${plannerStatus.maxConcurrent ? `limit ${plannerStatus.maxConcurrent}` : "no limit"}${plannerStatus.paused ? c.yellow(" · paused") : ""} · ${plannerStatus.running} running · ${plannerStatus.waiting} waiting · ${plannerStatus.scheduled} scheduled`));
	if (plannerStatus) {
		const when = (ms: number) => new Date(ms).toLocaleString();
		const limits = plannerStatus.limits.filter(l => l.until > Date.now());
		if (plannerStatus.held) rows.push(row("held", `${plannerStatus.held} task${plannerStatus.held === 1 ? "" : "s"} ${c.dim("(provider limit, usage window, budget or retry backoff: switchyard sched)")}`));
		for (const l of limits) rows.push(row("limit", `${c.yellow(l.provider)} until ${when(l.until)}${l.guessed ? c.dim(" (guessed)") : ""}`));
		const budget = Object.entries(plannerStatus.budget ?? {});
		if (budget.length) rows.push(row("budget", budget.map(([w, usd]) => `${w} $${usd}`).join(" · ") + plannerStatus.spend.map(u => `  ${u.window} $${u.spent.toFixed(2)}${u.over ? c.red(" over") : ""}`).join("")));
		const hot = plannerStatus.usageWindows.filter(w => w.usedPercent >= plannerStatus.usage.spareBelowPercent);
		if (hot.length) rows.push(row("usage", hot.map(w => `${w.provider} ${w.window} ${Math.round(w.usedPercent)}%`).join(" · ")));
	}
	rows.push(row("remote", !remote ? c.dim("unknown") : !remote.enabled ? c.dim("off") : remote.endpoints.length ? `${c.green("on")} ${remote.endpoints.map(e => `${e.kind} ${e.host}:${e.port}`).join(", ")}` : c.yellow("on, preparing")));
	rows.push(row("dashboard", !dashboard.enabled ? c.dim("off") : !dashboard.installed ? c.dim(`AO's UI not installed (${INSTALL_COMMAND})`) : dashboard.serving ? `${c.green("serving")} ${dashboard.url} ${c.dim(`AO ${dashboard.version ?? "?"}`)}` : c.yellow(`installed, nothing answers on port ${dashboard.port} (switchyard dashboard status)`)));
	for (const problem of problems) rows.push(`${c.red("✗")} ${problem}`);
	process.stdout.write(`${rows.join("\n")}\n`);
	return status.ok ? 0 : 1;
}

// ---------- config (~/.switchyard/config.json: the model and mode of new sessions, the planner service) ----------

const CONFIG_KEYS = ["harness", "model", "mode", "service", "omp-extension", "hibernation", "dashboard", "dashboard.port", "omp.path", "omp.extraArgs"];
/** The on/off settings and the config.json key each is stored under. */
const ON_OFF_KEYS: Record<string, "service" | "ompExtension" | "hibernation" | "dashboard"> = { service: "service", "omp-extension": "ompExtension", hibernation: "hibernation", dashboard: "dashboard" };
/** AO resolves omp itself (the daemon's PATH): there is no path to set (MAPPING Q3). */
const NO_OMP_PATH = "omp.path is gone: AO finds omp on the daemon's PATH (set PATH in its unit); omp.extraArgs still works (config set omp.extraArgs -- --profile work)";

function configValue(key: string): unknown {
	const s = readSwitchyardConfig();
	if (key === "harness") return s.harness ?? null;
	if (key === "model") return s.model ?? null;
	if (key === "mode") return s.mode ?? null;
	if (key === "service") return s.service ?? "on";
	if (key === "omp-extension") return s.ompExtension ?? "on";
	if (key === "hibernation") return s.hibernation ?? null;
	if (key === "dashboard") return s.dashboard ?? "on";
	if (key === "dashboard.port") return dashboardPort(s);
	if (key === "omp.extraArgs") return s.omp?.extraArgs ?? [];
	return null;
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
			if (json) {
				process.stdout.write(`${JSON.stringify({ file: switchyardConfigPath(), ...Object.fromEntries(CONFIG_KEYS.map(k => [k, configValue(k)])) }, null, 2)}\n`);
				return 0;
			}
			const s = readSwitchyardConfig();
			process.stdout.write(
				[
					`harness        ${s.harness ?? c.dim("(not set: the AO project's worker harness, else AO's default; switchyard harnesses)")}`,
					`model          ${s.model ?? c.dim("(not set: omp's default model)")} ${c.dim("(model of new omp sessions that name none)")}`,
					`mode           ${s.mode ?? c.dim("(not set: auto)")} ${c.dim("(permission mode of new sessions that ask for none)")}`,
					`service        ${s.service ?? "on"} ${c.dim("(off: the planner isn't installed as a login service by itself)")}`,
					`omp-extension  ${s.ompExtension ?? "on"} ${c.dim("(off: the CLI doesn't install or refresh Switchyard's omp extension and shim by itself)")}`,
					`hibernation    ${s.hibernation ?? c.dim("(not set: AO's own setting)")} ${c.dim("(on: AO stops the agent of a chat nobody views after 90 s)")}`,
					`dashboard      ${s.dashboard ?? "on"} ${c.dim("(off: the planner doesn't serve AO's own UI)")}`,
					`dashboard.port ${dashboardPort(s)} ${c.dim("(the loopback port AO's UI is served on)")}`,
					`omp.extraArgs  ${s.omp?.extraArgs?.length ? s.omp.extraArgs.join(" ") : c.dim("(none)")} ${c.dim("(added to every omp acp an AO session starts; needs the Switchyard omp shim)")}`,
				].join("\n") + "\n",
			);
			return 0;
		}
		case "set": {
			if (key === undefined) throw new UsageError(`config set <${CONFIG_KEYS.filter(k => k !== "omp.path").join("|")}> <value>`);
			if (key === "omp.path") throw new Error(NO_OMP_PATH);
			if (key === "omp.extraArgs") {
				// Added to every `omp acp` an AO session starts (the omp shim reads the nested key, G34); `none` or no arguments clears them.
				const clear = rest.length === 0 || (rest.length === 1 && rest[0] === "none");
				writeSwitchyardConfig({ omp: { extraArgs: clear ? undefined : rest } });
				break;
			}
			if (rest.length !== 1 || !rest[0].trim()) throw new UsageError(key === "harness" ? "config set harness <id | none> [--force]" : key === "model" ? "config set model <provider/id | none> [--force]" : key === "mode" ? "config set mode <auto|edits|ask|plan|none>" : key === "dashboard.port" ? "config set dashboard.port <1-65535>" : `config set ${key} <on|off>`);
			const v = rest[0].trim();
			if (key === "harness") {
				// Every new session that names no harness would start with it: only one of AO's chat harnesses, unless --force.
				if (v !== "none" && !flag(args, "force")) {
					let harnesses: AoHarnessInfo[];
					try {
						harnesses = await availableHarnesses(await ao());
					} catch (err) {
						throw new Error(`could not check the harness with AO (${err instanceof Error ? err.message : String(err)}); --force saves it anyway`);
					}
					resolveHarness({ explicit: v, harnesses });
				}
				writeSwitchyardConfig({ harness: v === "none" ? undefined : v });
			} else if (key === "model") {
				if (v !== "none" && !/^[^/\s]+\/\S+$/.test(v)) throw new UsageError(`a model is provider/id (switchyard models lists them), not "${v}"`);
				// Every new session would start with it: only a model omp offers, unless --force.
				if (v !== "none" && !flag(args, "force")) {
					let known: boolean;
					try {
						known = (await agentModels()).some(m => m.id === v);
					} catch (err) {
						throw new Error(`could not check the model with AO (${err instanceof Error ? err.message : String(err)}); --force saves it anyway`);
					}
					if (!known) throw new Error(`omp has no model ${v} in its catalog (switchyard models lists what a running session offers); --force saves it anyway`);
				}
				writeSwitchyardConfig({ model: v === "none" ? undefined : v });
			} else if (key === "dashboard.port") {
				const port = Number(v);
				if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError("config set dashboard.port <1-65535>");
				writeSwitchyardConfig({ dashboardPort: port });
			} else if (key === "mode") {
				if (v !== "none" && !isPermissionMode(v)) throw new UsageError("config set mode <auto|edits|ask|plan|none> (auto approves every tool call; edits asks before commands; ask asks for edits and commands; plan is read-only)");
				writeSwitchyardConfig({ mode: isPermissionMode(v) ? v : undefined });
			} else {
				if (v !== "on" && v !== "off") throw new UsageError(`config set ${key} <on|off>`);
				writeSwitchyardConfig({ [ON_OFF_KEYS[key]]: v });
			}
			break;
		}
		case "unset":
			if (key === undefined) throw new UsageError(`config unset <${CONFIG_KEYS.filter(k => k !== "omp.path").join("|")}>`);
			if (key === "omp.path") throw new Error(NO_OMP_PATH);
			if (key === "omp.extraArgs") writeSwitchyardConfig({ omp: { extraArgs: undefined } });
			else if (key === "model") writeSwitchyardConfig({ model: undefined });
			else if (key === "harness") writeSwitchyardConfig({ harness: undefined });
			else if (key === "mode") writeSwitchyardConfig({ mode: undefined });
			else if (key === "dashboard.port") writeSwitchyardConfig({ dashboardPort: undefined });
			else writeSwitchyardConfig({ [ON_OFF_KEYS[key]]: undefined });
			break;
		default:
			throw new UsageError(`unknown config command "${sub}" (get, set, unset)`);
	}
	// hibernation: apply it to the running AO at once (no argument: follow the file; an absent key leaves AO alone).
	const aoNow = key === "hibernation" ? await aoIfRunning() : undefined;
	const applied = aoNow ? await aoNow.applyChatHibernation().catch(() => undefined) : undefined;
	if (json) {
		process.stdout.write(`${JSON.stringify(key === undefined ? null : configValue(key))}\n`);
		return 0;
	}
	if (key === "service") {
		process.stdout.write(`${c.green("saved")} service ${configValue("service")} ${c.dim(configValue("service") === "off" ? "(the planner still starts on demand; switchyard server uninstall removes an installed service)" : "(installed on the next on-demand start)")}\n`);
		return 0;
	}
	if (key === "hibernation") {
		process.stdout.write(`${c.green("saved")} hibernation ${configValue("hibernation") ?? c.dim("(unset)")} ${c.dim(applied ? `· applied to the running AO now (${applied.enabled ? "on" : "off"}${applied.changed ? "" : ", it already was"})` : aoNow ? "· AO left as it is" : "· applied when Switchyard next starts AO or the planner reconnects")}\n`);
		return 0;
	}
	if (key === "dashboard" || key === "dashboard.port") {
		process.stdout.write(`${c.green("saved")} ${key} ${String(configValue(key))} ${c.dim("· the planner reads it when it starts: switchyard server restart")}\n`);
		return 0;
	}
	process.stdout.write(`${c.green("saved")} ${c.dim(switchyardConfigPath())} · applies to sessions started from now on\n`);
	return 0;
}

// ---------- harnesses ----------

/** `harnesses [--json]`: AO's chat harnesses with their auth status, and the one a new session here would run (and why). */
async function cmdHarnesses(args: Args): Promise<number> {
	const client = await ao();
	const harnesses = await availableHarnesses(client);
	const configured = readSwitchyardConfig().harness;
	// In a git folder AO knows, its project's worker harness is part of the order.
	const project = await client.projectForFolder(process.cwd(), { create: false }).catch(() => undefined);
	const worker = project ? await projectWorkerHarness(client, project.id) : undefined;
	let choice: HarnessChoice | undefined;
	let problem: string | undefined;
	try {
		choice = resolveHarness({ ...(configured && { config: configured }), ...(worker && { project: worker }), harnesses });
	} catch (err) {
		problem = err instanceof Error ? err.message : String(err);
	}
	if (flag(args, "json")) {
		const out = {
			harnesses: harnesses.map(h => ({ ...h, default: h.id === choice?.harness })),
			default: choice ? { harness: choice.harness, source: choice.source, reason: choice.reason } : null,
			...(problem && { problem }),
			configured: configured ?? null,
			...(project && { project: { id: project.id, worker: worker ?? null } }),
		};
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		return choice ? 0 : 1;
	}
	const authColor = (h: AoHarnessInfo) => (h.authStatus === "authorized" ? c.green : h.authStatus === "unauthorized" ? c.red : c.dim);
	for (const h of harnesses) {
		const used = h.usageCount ? c.dim(` ${h.usageCount} session${h.usageCount === 1 ? "" : "s"}`) : "";
		const off = h.unavailable ? c.yellow(` can't chat here: ${h.unavailable}`) : "";
		process.stdout.write(`${h.id === choice?.harness ? c.green("●") : " "} ${pad(h.id, 18)} ${pad(authColor(h)(h.authStatus), 14)}${c.dim(pad(h.label, 16))}${used}${off}\n`);
	}
	if (choice) process.stdout.write(`${c.dim("default:")} ${c.bold(choice.harness)} ${c.dim(`(${choice.reason})`)}\n`);
	else process.stderr.write(`switchyard: ${problem}\n`);
	process.stdout.write(c.dim("new --harness <id> picks one per session · switchyard config set harness <id>|none sets the default\n"));
	return choice ? 0 : 1;
}

// ---------- models ----------

type AgentModel = AoSchemas["AgentModelsResponse"]["models"][number];

/** AO's omp catalog: every model omp knows, usable or not (3768 here, against the 53 a session offers). Only good for "does this id exist at all". */
async function agentModels(): Promise<AgentModel[]> {
	const client = await ao();
	return (await unwrap<AoSchemas["AgentModelsResponse"]>(client.api.GET("/api/v1/agents/{agent}/models", { params: { path: { agent: "omp" } } }))).models;
}

/**
 * The models omp actually offers: the `model` choices of a live session's config options (VALIDATION §19). The catalog
 * and its `configuredProviders` are not that list (they drop models that run, e.g. zai/*, vllm, ollama).
 */
async function sessionModelChoices(client: AoClient, sessionId: string): Promise<Array<{ value: string; name: string }> | undefined> {
	try {
		const option = (await client.configOptions(sessionId)).options.find(o => o.id === "model");
		return option?.choices?.map(ch => ({ value: ch.value, name: ch.name }));
	} catch {
		return undefined;
	}
}

/** A harness's models from AO's catalog (`/agents/{harness}/models`): what a harness other than omp offers. */
async function printCatalogModels(client: AoClient, harness: string, search: string, json: boolean, source: string | null): Promise<number> {
	const catalog = await client.agentModels(harness);
	const models = catalog.models
		.filter(m => !search || m.id.toLowerCase().includes(search) || (m.label ?? "").toLowerCase().includes(search))
		.map(m => ({ selector: m.id, name: m.label ?? m.id, ...(m.contextWindow && { contextWindow: m.contextWindow }) }));
	if (json) {
		process.stdout.write(`${JSON.stringify({ harness, models, default: null, source, allowCustom: catalog.allowCustom }, null, 2)}\n`);
		return 0;
	}
	for (const m of models) process.stdout.write(`  ${pad(m.selector, 40)} ${c.dim(m.name === m.selector ? "" : m.name)}\n`);
	if (!models.length) process.stdout.write(c.dim(`no models in AO's ${harness} catalog${search ? ` matching "${search}"` : ""}\n`));
	process.stdout.write(c.dim(`${harness}: AO's model catalog${catalog.allowCustom ? " (other model ids are accepted too)" : ""} · new --harness ${harness} --model <id>\n`));
	return 0;
}

/** `models [search] [--session <session>] [--harness <h>]`: the choices of that session, else of the newest session whose omp is running; another harness: AO's catalog of it. */
async function cmdModels(args: Args): Promise<number> {
	const search = args._.join(" ").toLowerCase();
	const def = readSwitchyardConfig().model;
	const json = flag(args, "json");
	const client = await ao();
	const ref = value(args, "session");
	const harnessArg = value(args, "harness");
	if (harnessArg !== undefined && ref !== undefined) throw new UsageError("--session and --harness: pick one");
	if (harnessArg !== undefined && !isOmpHarness(harnessArg)) return printCatalogModels(client, resolveHarness({ explicit: harnessArg, harnesses: await availableHarnesses(client) }).harness, search, json, null);
	const named = ref !== undefined ? await findSession(ref) : undefined;
	// A session of another harness: its models are AO's catalog of that harness (it has no omp choices).
	if (named && !isOmpHarness(named.model.harness)) return printCatalogModels(client, named.model.harness as string, search, json, named.id);
	const chosen = named ?? (await loadSessions(client, { conversationLimit: 1 })).find(s => isOmpHarness(s.model.harness) && !s.model.view.isTerminated && s.model.view.activity.state !== "exited");
	const choices = chosen ? await sessionModelChoices(client, chosen.id) : undefined;
	if (!chosen || !choices) {
		// omp offers its models per running session: with none there is no exact list to show.
		const note = chosen ? `${chosen.id}'s omp is not running, so it can't say which models it offers (switchyard resume ${chosen.id}, or use --session with a running one)` : "no running session to read omp's model choices from: omp offers them per session. Start one (switchyard new …) or pass --session <session>";
		if (json) process.stdout.write(`${JSON.stringify({ models: [], default: def ?? null, ompDefault: null, source: null, note }, null, 2)}\n`);
		else process.stderr.write(`switchyard: ${note}\n`);
		return json ? 0 : 1;
	}
	const catalog = new Map((await agentModels().catch(() => [])).map(m => [m.id, m]));
	const models = choices
		.filter(m => !search || m.value.toLowerCase().includes(search) || m.name.toLowerCase().includes(search))
		.map(m => {
			const slash = m.value.indexOf("/");
			const contextWindow = catalog.get(m.value)?.contextWindow;
			return { selector: m.value, provider: slash < 0 ? "" : m.value.slice(0, slash), id: slash < 0 ? m.value : m.value.slice(slash + 1), name: m.name, ...(contextWindow && { contextWindow }), ...(m.value === def && { default: true }) };
		})
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.selector.localeCompare(b.selector));
	if (json) {
		process.stdout.write(`${JSON.stringify({ models, default: def ?? null, ompDefault: null, source: chosen.id }, null, 2)}\n`);
		return 0;
	}
	let provider: string | undefined;
	for (const m of models) {
		if (m.provider !== provider) process.stdout.write(`${c.bold((provider = m.provider))}\n`);
		const ctx = m.contextWindow ? c.dim(` ${m.contextWindow >= 1_000_000 ? `${+(m.contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(m.contextWindow / 1000)}K`}`) : "";
		process.stdout.write(`  ${m.default ? c.green("●") : " "} ${pad(m.selector, 40)} ${c.dim(m.name)}${ctx}\n`);
	}
	if (!models.length) process.stdout.write(c.dim("no models (log in to a provider in omp)\n"));
	process.stdout.write(c.dim(`default: ${def ?? "omp's own"} · switchyard config set model <provider/id>\n`));
	return 0;
}

// ---------- help ----------

const HELP = `${c.bold("switchyard")} — agent sessions on Agent Orchestrator, from the terminal ${c.dim(`(${VERSION})`)}

${c.bold("Machine")}
  status [--json]                 AO daemon, planner, default harness, omp, sessions by state, queued tasks,
                                  scheduler and remote access; exit 1 when something is wrong (never starts anything)
  harnesses [--json]              AO's chat harnesses with their auth status, and which one new sessions use and why
  config [get [key]] [--json]     settings (~/.switchyard/config.json): harness, model, mode, service, omp.extraArgs
  config set harness <id|none>    harness of new sessions that name none (an explicit --harness wins; none: the
                                  AO project's worker harness, else AO's default: see harnesses)
  config set model <provider/id|none> [--force]
                                  default model of new omp sessions (an explicit --model wins; none: omp's);
                                  only a model omp offers, unless --force
  config set mode <auto|edits|ask|plan|none>
                                  permission mode of new sessions that ask for none (an explicit --mode wins)
  config set service <on|off>     off: never install the planner as a login service by itself · config unset <key>
  config set omp.extraArgs [--] <arg>…
                                  arguments added to every omp acp an AO session starts (e.g. -- --profile
                                  work; none: clear). Applied by the Switchyard omp shim on the daemon's PATH
  models [search] [--session s] [--harness h] [--json]
                                  the models a session offers: the choices of a running omp session (the given
                                  one, else the newest running; none: say so); another harness's session, or
                                  --harness: AO's model catalog of that harness. ● = the default
  version [--json]                this CLI, the planner and the AO daemon (also --version, -v)

${c.bold("Sessions")}  ${c.dim("<session> = id, id prefix, title words, or . (latest session in this folder)")}
  ls [-a|--all] [--json] [--project p] [--cwd dir] [--group g] [--tag t]… [--state s]
                                  lists sessions that are active or have work ahead (--all: also finished
                                  and archived); --project: an AO project by id, name or path; --state: a
                                  show state (working, needs_input, idle, queued, scheduled, interrupted,
                                  stopped), else a board column
  board [--all] [--json]          sessions by column: waiting, scheduled, working, needs input, idle,
                                  interrupted (--all: also stopped)
  new [dir] [-p prompt|-] [--task t [--sub s]… [--notes n|-] [--at when]] [--title t] [--mode m]
      [--harness h] [--tag t]… [--group g] [--model m] [--priority p] [--usage spare] [--worktree auto|always]
      [--detach] [--json] [-- <omp flags>]
                                  start a session in dir's git project (AO gives it its own worktree; a
                                  folder outside git runs in an AO scratch folder); no prompt: attach to
                                  it; --task queues it, --at schedules it (+30m, 14:30, ISO time);
                                  --harness: one of AO's chat harnesses (default: see harnesses); plan mode
                                  and omp flags are omp-only
  show [session] [--json]         state, waiting question and last reply (for scripts and agents)
  wait [session] [--timeout 30m] [--json]
                                  block until it settles: idle (exit 0), needs input (3), stopped or
                                  interrupted (4), scheduled (5); 124 on timeout
  answer <session> [--question id] [--json] [--] <choice>
                                  answer its waiting question: option number/text, yes/no, text; several
                                  questions: one answer each, separated by | (--question: refuse if
                                  another question is now first)
  vscode [session | path/to/dir] [--folder dir] [--authority a] [--json]
                                  open it in a VS Code window on this machine (prints the link to open
                                  on the computer running VS Code, e.g. over Remote-SSH); a folder opens
                                  its checkout, --folder exactly that folder; --authority: that remote
                                  (ssh-remote+box, wsl+Ubuntu; "" local), even if no window of it is known
  projects [--json]               AO projects (git folders sessions run in), newest first
  attach [session]                chat in the terminal (Ctrl-C aborts a turn, Ctrl-D detaches)
  send <session> <text|-> [--steer] [-w|--wait] [--json]
                                  prompt a session (resumes it if stopped). While it works the prompt
                                  waits for the turn to end (a follow-up); --steer redirects the turn.
                                  --wait streams the reply, exits like wait (3: it asks a question)
  tail [session] [-n N] [-f]      last messages; -f follows live output
  stop|resume <session>… [--json] stop or resume sessions' agents (stop: exit 1 when one wasn't running)
  abort [session] [--json]        abort the current turn (exit 1 when it isn't working)
  mode [session] [ask|edits|plan|auto]
                                  show or switch the permission mode (plan: live, omp only; ask/edits/auto: AO
                                  restarts the agent on the same transcript, so only while it is idle)
  model [session] [provider/id] [--json]
                                  show or switch its model (from its next turn)
  rm <session>… [-y]              remove sessions, their workspace and history

${c.bold("Queue")}  ${c.dim("(the planner runs a session's tasks one by one)")}
  queue <session> [--json]        show its task queue
  queue <session> add <task|-> [--notes n|-] [--sub s]… [--top] [--run] [--usage spare] [--json]
                                  add a task; - reads stdin: its first line is the title, the rest the
                                  notes (long prompts keep their lines; the agent gets title and notes)
  queue <session> run [n] | start | pause | clear | retry [n] | rm n | done n | skip n [--json]
                                  run: run now from task n (continues an interrupted queue); start: turn
                                  auto-run on; pause: off
  queue <session> at <when|off> [--json]
                                  start the queue at that time: +30m, in 2h, 14:30, 9pm, tomorrow 9:00 or
                                  an ISO time like 2025-01-31T08:00 (off: cancel the schedule)
  queue <session> after <session>…|off [--json]
                                  the queue waits until those sessions finished (replaces its dependencies;
                                  refused for itself, unknown sessions and cycles); new --task … --after <s>
  queue <session> requeue [--json]
                                  run again: failed tasks go back to pending, else a paused or interrupted
                                  queue restarts, else the last finished task runs again; a scheduled start
                                  is kept (refused when there is nothing to requeue)

${c.bold("Organize")}
  prio <session> <urgent|high|normal|low>
  color <session> <${ORG_COLORS.join("|")}|none>
  group <session> <name|none>
  move <session> <up|down|top|bottom>
  archive|unarchive <session> [--json]
  complete|uncomplete <session> [--json]
                                  mark it completed (a ✓ in ls and show; queued work still runs)

${c.bold("Plan graph")}  ${c.dim("(a task in a git project starts from its parents' commits; later parent changes are merged into it)")}
  plan [status] [task|session] [--json]
                                  edges and how far each parent's changes reached its child: in-sync,
                                  pending, merged, upstream-changed (finished child, not re-run), resolving,
                                  conflict
  plan sync <task|session> [--rerun] [--json]
                                  bring its parents' changes in now; --rerun also runs a finished task whose
                                  edge says upstream-changed

${c.bold("Scheduler")}  ${c.dim("(the planner's global limit on queued tasks running at once)")}
  sched [--json]                  status
  sched set <n>                   max concurrent queued tasks (0 = unlimited)
  sched pause|resume
  sched budget [hour|day|week <usd|off>]
                                  cap what queued work may spend per rolling hour, day or week
  sched usage <hold|spare> <percent>
                                  hold work at that percent of a provider's usage window; "spare" tasks start
                                  only while every window is below theirs
  sched limits [clear [provider…]] provider limits in force and usage windows (shown by sched too); clear lets held work start

${c.bold("Server")}  ${c.dim("(the planner service: starts queued and scheduled tasks; started on demand)")}
  server status [--json] | start | stop | restart | log [-f] | install | uninstall

${c.bold("Dashboard")}  ${c.dim("(AO's own web UI, served by the planner on 127.0.0.1:3012 with the daemon behind it)")}
  dashboard install [--release <tag>|--from <file.deb|app.asar|folder>]
                                  install or update AO's UI: from AO's official release (default latest),
                                  or a local AO package, app.asar or built renderer
  dashboard status [--json] | url | uninstall
                                  installed version and whether it is served · its URL · remove it

${c.bold("Remote")}  ${c.dim("(AO's mobile app pairing; the phone talks to the AO daemon)")}
  remote on [--bind tailscale|lan|tunnel|all] [--json]
                                  turn on phone access: tailscale (default) pairs securely over Tailscale,
                                  lan on this network, tunnel through AO's Cloudflare tunnel, all: every way
  remote off|status|qr|rotate     turn off · show state · pairing QR for the AO app · new password (unpairs phones)

${c.bold("Agents")}  ${c.dim("(the switchyard skill teaches other agents to use the switchyard command)")}
  skill [status]                  where it is installed
  skill install [agents|claude|codex]… [--dir d] [--force]
                                  install or update it (default: every platform found)
  skill uninstall [platform]… | print | path

${c.bold("Hermes")}  ${c.dim("(switchyard plugin: switchyard tools, notifications and a kanban lane in Hermes Agent; docs/HERMES.md)")}
  hermes install [--force]        copy the plugin into $HERMES_HOME/plugins (~/.hermes) and enable it
  hermes uninstall | status [--json]
      [--profile <name>]… [--all-profiles]
                                  plugins are per Hermes profile; default: $HERMES_HOME, else ~/.hermes
                                  (%LOCALAPPDATA%\\hermes on Windows)

${c.bold("Omp extension")}  ${c.dim("(omp sessions only: permission modes, /undo and the todo mirror run in an omp extension; extra omp flags through a shim)")}
  omp-extension [status] [--json] whether Switchyard's omp extension and shim are installed and current
  omp-extension install|uninstall copy them into omp's agent folder and ~/.switchyard/bin (new and status do it
                                  by themselves unless: config set omp-extension off)

${c.bold("Migration")}  ${c.dim("(from omp Sessions to Switchyard)")}
${MIGRATE_HELP}

  --no-color, NO_COLOR=1          plain output
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
	return out.length ? `${out.join("\n")}\n${c.dim("switchyard help lists every command")}\n` : undefined;
}

// ---------- main ----------

async function cmdVersion(json: boolean): Promise<number> {
	const info = await plannerService().status();
	const daemon = await findDaemon().catch(() => undefined);
	if (json) process.stdout.write(`${JSON.stringify({ cli: VERSION, server: info?.version ?? null, pid: info?.pid ?? null, ao: daemon ? { url: daemon.baseUrl, pid: daemon.pid } : null })}\n`);
	else process.stdout.write(`switchyard ${VERSION}${info ? c.dim(` · planner ${info.version} (pid ${info.pid})`) : ""}${daemon ? c.dim(` · AO ${daemon.baseUrl} (pid ${daemon.pid})`) : ""}\n`);
	return 0;
}

const ALIASES: Record<string, string> = { list: "ls", chat: "attach", log: "tail", start: "resume", remove: "rm", q: "queue", priority: "prio", scheduler: "sched", skills: "skill" };

/** Each command with the flags it takes (`--help` and `--no-color` always work). */
const COMMANDS: Record<string, { flags: readonly string[]; run: (args: Args, cmd: string) => Promise<number> | number }> = {
	status: { flags: ["json"], run: cmdStatus },
	config: { flags: ["json", "force"], run: cmdConfig },
	models: { flags: ["json", "session", "harness"], run: cmdModels },
	harnesses: { flags: ["json"], run: cmdHarnesses },
	model: { flags: ["json"], run: cmdModel },
	version: { flags: ["json"], run: args => cmdVersion(flag(args, "json")) },
	ls: { flags: ["all", "json", "project", "cwd", "group", "tag", "state"], run: async args => (await cmdList(args), 0) },
	board: { flags: ["all", "json"], run: async args => (await cmdBoard(args), 0) },
	new: { flags: ["prompt", "task", "sub", "notes", "at", "after", "usage", "worktree", "no-worktree", "title", "mode", "harness", "tag", "group", "model", "priority", "detach", "attach", "json"], run: cmdNew },
	send: { flags: ["wait", "steer", "follow-up", "json"], run: cmdSend },
	attach: { flags: ["lines"], run: cmdAttach },
	tail: { flags: ["lines", "follow"], run: cmdTail },
	stop: { flags: ["json"], run: cmdStop },
	resume: { flags: ["json"], run: cmdResume },
	rm: { flags: ["yes"], run: cmdRemove },
	abort: { flags: ["json"], run: cmdAbort },
	mode: { flags: [], run: async args => (await cmdMode(args), 0) },
	queue: { flags: ["sub", "top", "run", "notes", "usage", "json"], run: async args => (await cmdQueue(args), 0) },
	prio: { flags: [], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	color: { flags: [], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	group: { flags: [], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	archive: { flags: ["json"], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	unarchive: { flags: ["json"], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	plan: { flags: ["json", "rerun"], run: cmdPlan },
	complete: { flags: ["json"], run: cmdComplete },
	uncomplete: { flags: ["json"], run: cmdComplete },
	move: { flags: [], run: async (args, cmd) => (await cmdOrganize(cmd, args), 0) },
	sched: { flags: ["json"], run: async args => (await cmdSched(args), 0) },
	server: { flags: ["follow", "json"], run: cmdServer },
	remote: { flags: ["bind", "port", "url", "json"], run: cmdRemote },
	dashboard: { flags: ["from", "release", "json"], run: cmdDashboard },
	show: { flags: ["json"], run: cmdShow },
	wait: { flags: ["timeout", "json"], run: cmdWait },
	answer: { flags: ["question", "json"], run: cmdAnswer },
	vscode: { flags: ["folder", "authority", "json"], run: cmdVscode },
	projects: { flags: ["json"], run: cmdProjects },
	skill: { flags: ["dir", "force"], run: cmdSkill },
	hermes: { flags: ["force", "profile", "all-profiles", "json"], run: cmdHermes },
	"omp-extension": { flags: ["json"], run: cmdOmpExtension },
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
		if (!text) throw new UsageError(`unknown command "${about}" (switchyard help)`);
		process.stdout.write(text);
		return 0;
	}
	const cmd = resolve(name);
	const command = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
	if (!command) throw new UsageError(`unknown command "${name}" (switchyard help)`);
	checkFlags(args, name, command.flags);
	return command.run(args, cmd);
}

/** Errors as one line: AO's error envelope reads well as is. */
function errorText(err: unknown): string {
	if (err instanceof AoError && err.code === "DAEMON_UNREACHABLE") return `${err.message} (is the AO daemon installed? switchyard status)`;
	return err instanceof Error ? err.message : String(err);
}

/**
 * Open event streams and keep-alive sockets must not hold the process, but a pipe is written
 * asynchronously: exiting before stdout and stderr have drained cuts long output (`models --json`) short.
 */
function exitAfterFlush(code: number): void {
	let pending = 2;
	const done = () => {
		if (--pending === 0) process.exit(code);
	};
	process.stdout.write("", done);
	process.stderr.write("", done);
}

if (require.main === module) {
	main(process.argv.slice(2))
		.then(code => {
			void plannerPromise?.then(p => p?.close());
			process.exitCode = code;
			exitAfterFlush(code);
		})
		.catch(err => {
			void plannerPromise?.then(p => p?.close());
			errorLine(errorText(err));
			process.exitCode = err instanceof UsageError ? 2 : 1;
			exitAfterFlush(process.exitCode);
		});
}
