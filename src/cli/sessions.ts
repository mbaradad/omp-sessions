// The CLI's sessions: AO sessions (through src/ao) with the folder each works in, the Switchyard
// organization (group, color, tags, archive, order: organize.json, MAPPING D5) and the planner's lane
// (queue, waiting for a slot, scheduled, interrupted: MAPPING D3). Builds what `ls/board/show/wait --json`
// print, and resolves what a user typed to one session.
import * as path from "node:path";
import { AoClient, AoError, type AoConversation, type AoProject, type AoSchemas, type AoSessionView, unwrap } from "../ao/client";
import { type AoAgentState, type AoPlannedState, type AoReportQueue, type AoSessionModel, type AoSessionReport, SETTLED_STATES, sessionModel, sessionReport } from "../ao/model";
import { type OrgData, type Priority, readOrgFile, schedulingOrder } from "../shared/organize";
import type { PermissionMode } from "../shared/permissions";
import type { LaneSummary } from "./plan";
import { oneLine } from "./term";

/** Board column of a session (`board`, `ls --json`); `interrupted` sessions sit under `stopped` here. */
export type Column = "waiting" | "scheduled" | "working" | "input" | "idle" | "stopped";

export type AgentState = AoAgentState;

// ---------- daemon ----------

let clientPromise: Promise<AoClient> | undefined;

/** The AO daemon's client; starts `ao daemon` when none runs (like the old CLI started its server on demand). */
export function ao(): Promise<AoClient> {
	clientPromise ??= AoClient.connect({ start: true, log: message => process.stderr.write(`omp-sessions: ${message}\n`) });
	return clientPromise;
}

/** The daemon's client when one runs; never starts it (`status`, `version`). */
export async function aoIfRunning(): Promise<AoClient | undefined> {
	try {
		return await AoClient.connect();
	} catch {
		return undefined;
	}
}

// ---------- permission modes (MAPPING G7: AO fixes omp's approval mode at launch) ----------

export type AoApprovalMode = NonNullable<AoSchemas["ConversationTurnSettingsPayload"]["approvalMode"]>;

/**
 * How each Switchyard mode launches omp under AO (`ompacp/driver.go`: bypass → `--approval-mode yolo`,
 * accept-edits → `write`, default → no flag). AO has no `always-ask`: `ask` runs omp on its own
 * `tools.approvalMode` (MAPPING G12), so it asks only where omp's config does.
 */
export const APPROVAL_OF: Record<PermissionMode, AoApprovalMode> = { auto: "bypass-permissions", edits: "accept-edits", ask: "default", plan: "default" };

// ---------- sessions ----------

export interface Session {
	id: string;
	title: string;
	/** The folder omp works in: the session's AO workspace (its worktree), else its project folder. */
	cwd: string;
	project?: AoProject;
	model: AoSessionModel;
	/** AO's state, with the planner's lane state on top (MAPPING D3). */
	state: AgentState;
	lane?: LaneSummary;
	priority: Priority;
	group?: string;
	color?: string;
	archived?: boolean;
	tags: string[];
}

/** What the planner says about a lane when the session runs nothing (MAPPING D3; `agentState` applies it). */
export function plannedState(lane: LaneSummary | undefined): AoPlannedState | undefined {
	if (!lane) return undefined;
	if (lane.scheduled) return "scheduled";
	if (lane.waiting) return "queued";
	if (lane.interrupted !== undefined) return "interrupted";
	return undefined;
}

export function columnOf(state: AgentState): Column {
	switch (state) {
		case "queued":
			return "waiting";
		case "scheduled":
			return "scheduled";
		case "starting":
		case "working":
			return "working";
		case "needs_input":
			return "input";
		case "idle":
			return "idle";
		default:
			return "stopped";
	}
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}


/** The conversation snapshot (`limit` messages), or undefined for sessions without one (TUI, not started yet). */
export async function conversationOf(client: AoClient, view: AoSessionView, limit = 20): Promise<AoConversation | undefined> {
	if (view.mode !== "chat") return undefined;
	try {
		return await client.getConversation(view.id, { limit });
	} catch {
		return undefined;
	}
}

export interface LoadOptions {
	/** Messages of each conversation to read (the reply needs only the newest). */
	conversationLimit?: number;
	/** The planner's lanes by session id (absent: no planner data). */
	lanes?: ReadonlyMap<string, LaneSummary>;
	org?: OrgData;
}

function inside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function buildSession(client: AoClient, view: AoSessionView, projects: ReadonlyMap<string, AoProject>, opts: LoadOptions, conversation?: AoConversation): Promise<Session> {
	// A terminated session's workspace is gone: its project folder stands in.
	const workspace = view.isTerminated ? undefined : client.workspacePath(view.id).catch(() => undefined);
	const [conv, cwd] = await Promise.all([conversation ?? conversationOf(client, view, opts.conversationLimit), workspace]);
	const lane = opts.lanes?.get(view.id);
	const model = sessionModel(view, conv, plannedState(lane));
	const project = view.projectId ? projects.get(view.projectId) : undefined;
	const org = opts.org ?? readOrgFile();
	const e = org.sessions[view.id];
	const session: Session = {
		id: view.id,
		title: model.title,
		cwd: cwd || project?.path || "",
		...(project && { project }),
		model,
		state: model.state,
		...(lane && { lane }),
		priority: lane?.priority ?? e?.priority ?? "normal",
		tags: e?.tags ? [...e.tags] : [],
	};
	if (e?.groupId) {
		const g = org.groups.find(x => x.id === e.groupId);
		if (g) session.group = g.name;
	}
	if (e?.color) session.color = e.color;
	if (e?.archived) session.archived = true;
	return session;
}

/** Every worker session AO has (terminated ones too), newest first with stopped ones last. */
export async function loadSessions(client: AoClient, opts: LoadOptions = {}): Promise<Session[]> {
	const [{ sessions }, projectList] = await Promise.all([client.listSessions({ kind: "worker" }), client.listProjects()]);
	const projects = new Map(projectList.map(p => [p.id, p]));
	const org = opts.org ?? readOrgFile();
	const out = await mapLimit(sessions, 6, view => buildSession(client, view, projects, { ...opts, org }));
	return out.sort((a, b) => (a.state === "stopped" ? 1 : 0) - (b.state === "stopped" ? 1 : 0) || b.model.updatedAt - a.model.updatedAt);
}

/** One session, fresh from AO. */
export async function loadSession(client: AoClient, id: string, opts: LoadOptions = {}): Promise<Session> {
	let view: AoSessionView;
	try {
		view = await client.getSession(id);
	} catch (err) {
		if (err instanceof AoError && err.status === 404) throw new Error(`session ${id} is gone`);
		throw err;
	}
	const projects = new Map((await client.listProjects()).map(p => [p.id, p]));
	return buildSession(client, view, projects, opts);
}

/** `ls` filters. */
export interface ListFilter {
	/** An AO project by id or name, or a folder path: the session's project folder or its own folder. */
	project?: string;
	/** Absolute folder: sessions working in it or below it, or whose project is. */
	cwd?: string;
	/** Group name (case-insensitive). */
	group?: string;
	/** Every one of these tags. */
	tags?: string[];
	/** A `show` state matches the state only; other words the board column or the old status word. */
	state?: string;
}

export function filterSessions(sessions: readonly Session[], f: ListFilter): Session[] {
	const group = f.group?.toLowerCase();
	const state = f.state?.toLowerCase().replace("-", "_");
	const isState = state !== undefined && Object.hasOwn(SETTLED_STATES, state);
	return sessions.filter(s => {
		if (f.project) {
			const want = f.project;
			const named = path.isAbsolute(want) ? [s.project?.path, s.cwd].some(p => p && path.resolve(p) === path.resolve(want)) : s.project?.id === want || s.project?.name === want || (!!s.cwd && path.basename(s.cwd) === want);
			if (!named) return false;
		}
		if (f.cwd && !((s.cwd && inside(s.cwd, f.cwd)) || (s.project && inside(s.project.path, f.cwd)))) return false;
		if (group !== undefined && s.group?.toLowerCase() !== group) return false;
		if (f.tags?.length && !f.tags.every(t => s.tags.includes(t))) return false;
		if (state && (isState ? s.state !== state : columnOf(s.state) !== state && reportOf(s).status !== state)) return false;
		return true;
	});
}

/**
 * Resolves what a user typed to one session: `.` (the newest session working in, or for the project
 * of, the current folder), an exact id, a unique id prefix, or a unique case-insensitive title substring.
 */
export function resolveSession(query: string, sessions: readonly Session[], cwd: string): Session | { error: string } {
	const q = query.trim();
	if (!q) return { error: "no session given" };
	if (q === ".") {
		const here = sessions.find(s => (s.cwd && (inside(cwd, s.cwd) || inside(s.cwd, cwd))) || (s.project && inside(cwd, s.project.path)));
		return here ?? { error: `no session for ${cwd}` };
	}
	const exact = sessions.find(s => s.id === q);
	if (exact) return exact;
	const describe = (list: readonly Session[]) =>
		list
			.slice(0, 6)
			.map(s => `${s.id} ${s.title}`)
			.join(", ");
	const byPrefix = sessions.filter(s => s.id.startsWith(q));
	if (byPrefix.length === 1) return byPrefix[0];
	if (byPrefix.length > 1) return { error: `"${q}" matches ${byPrefix.length} sessions: ${describe(byPrefix)}` };
	const needle = q.toLowerCase();
	const byTitle = sessions.filter(s => s.title.toLowerCase().includes(needle));
	if (byTitle.length === 1) return byTitle[0];
	const exactTitle = byTitle.filter(s => s.title.toLowerCase() === needle);
	if (exactTitle.length === 1) return exactTitle[0];
	if (byTitle.length > 1) return { error: `"${q}" matches ${byTitle.length} sessions: ${describe(byTitle)}` };
	return { error: `no session matches "${q}"` };
}

// ---------- JSON shapes (skills/omp-sessions/SKILL.md; the report itself is src/ao's) ----------

/** The `queue` of `ls`/`show --json`: the session's planner lane (none: an empty, paused queue). */
export function queueSummary(s: Session): AoReportQueue {
	const l = s.lane;
	if (!l) return { pending: 0, running: 0, done: 0, total: 0, autoRun: false };
	return { pending: l.pending, running: l.running, done: l.done, total: l.total, autoRun: l.autoRun, ...(l.startAt !== undefined && { startAt: l.startAt }), ...(l.interrupted !== undefined && { interrupted: l.interrupted }) };
}

/**
 * `show`/`wait --json`: src/ao's report, plus the session's AO project and branch (where its work lands),
 * the completed marker (PARKED §5: `completed`, `completedAt?`) and why queued work is held (`waitReason`).
 */
export type CliReport = AoSessionReport & { project?: string; branch?: string; completed: boolean; completedAt?: number; waitReason?: string; waitUntil?: number };

/**
 * `live`: what only the running agent or the workspace can say. omp's plan mode is its own `mode`
 * option, not AO's settings, and omp's turns carry no diff (GAPS G31), so the workspace manifest
 * counts the changed files.
 */
export function reportOf(s: Session, live: { ompMode?: string; changedFiles?: number } = {}): CliReport {
	const report: CliReport = { ...sessionReport({ ...s.model, cwd: s.cwd }, { tags: s.tags, queue: queueSummary(s) }), completed: s.lane?.completed !== undefined };
	if (live.ompMode === "plan") report.mode = "plan";
	if (live.changedFiles !== undefined) report.changedFiles = live.changedFiles;
	if (s.project) report.project = s.project.id;
	if (s.model.branch) report.branch = s.model.branch;
	if (s.lane?.completed) report.completedAt = s.lane.completed;
	if (s.lane?.waitReason) report.waitReason = s.lane.waitReason;
	if (s.lane?.waitUntil !== undefined) report.waitUntil = s.lane.waitUntil;
	return report;
}

/** `ls --json` / `board --json`: one entry per session, `meta` kept for scripts that read `meta.id`/`meta.title`. */
export function infoJson(s: Session, order: number) {
	const m = s.model;
	const report = reportOf(s);
	return {
		meta: {
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			status: report.status,
			createdAt: m.createdAt,
			updatedAt: m.updatedAt,
			changedFiles: report.changedFiles,
			// Old SessionMeta fields scripts and the Hermes plugin read: the mode (AO's setting; omp's live plan mode shows in `show`) and the reply's first line.
			...(report.mode && { permissionMode: report.mode }),
			...(report.reply && { lastText: oneLine(report.reply).slice(0, 200) }),
			...(m.model && { model: m.model }),
			...(m.cost !== undefined && { cost: m.cost }),
			...(report.exitReason && { exitReason: report.exitReason }),
			...(report.project && { project: report.project }),
			...(report.branch && { branch: report.branch }),
		},
		column: columnOf(s.state),
		state: s.state,
		queue: report.queue,
		priority: s.priority,
		order,
		...(s.group && { group: s.group }),
		...(s.color && { color: s.color }),
		...(s.archived && { archived: true }),
		...(s.tags.length && { tags: s.tags }),
		...(s.lane?.waiting && { waiting: s.lane.waiting }),
		completed: report.completed,
		...(report.completedAt && { completedAt: report.completedAt }),
		...(report.waitReason && { waitReason: report.waitReason }),
		...(report.waitUntil !== undefined && { waitUntil: report.waitUntil }),
	};
}

/** omp's live `mode` config option (`default`/`plan`); undefined when no agent runs to say. */
export async function ompModeOption(client: AoClient, sessionId: string): Promise<string | undefined> {
	try {
		const res = await unwrap<AoSchemas["ConversationConfigOptionsResponse"]>(client.api.GET("/api/v1/sessions/{sessionId}/conversation/config-options", { params: { path: { sessionId } } }));
		const opt = (res.options ?? []).find(o => o.id === "mode");
		return typeof opt?.currentValue === "string" ? opt.currentValue : undefined;
	} catch {
		return undefined;
	}
}

/** Files the session changed in its workspace (AO's workspace manifest); undefined when AO can't say. */
export async function changedFileCount(client: AoClient, sessionId: string): Promise<number | undefined> {
	try {
		const res = await unwrap<AoSchemas["WorkspaceManifestResponse"]>(client.api.GET("/api/v1/sessions/{sessionId}/workspace/manifest", { params: { path: { sessionId } } }));
		return res.files.length;
	} catch {
		return undefined;
	}
}

/** Ranks sessions the way the board and the planner order them (priority, then manual order). */
export function orderOf(sessions: readonly Session[], org: OrgData = readOrgFile()): Map<string, number> {
	const order = schedulingOrder(
		org,
		sessions.map(s => s.id),
	);
	return new Map(order.map((id, i) => [id, i]));
}
