// The CLI's sessions: AO sessions (through src/ao) with the folder each works in, the Switchyard
// organization (group, color, tags, archive, order: organize.json, MAPPING D5) and the planner's lane
// (queue, waiting for a slot, scheduled, interrupted: MAPPING D3). Builds what `ls/board/show/wait --json`
// print, and resolves what a user typed to one session.
import * as path from "node:path";
import { AoClient, AoError, type AoConversation, type AoProject, type AoSchemas, type AoSessionView, unwrap } from "../ao/client";
import { type AoAgentState, type AoPlannedState, type AoQuestion, type AoSessionModel, SETTLED_STATES, sessionModel } from "../ao/model";
import { type OrgData, type Priority, readOrgFile, schedulingOrder } from "../shared/organize";
import type { PermissionMode } from "../shared/permissions";
import type { LaneSummary } from "./plan";

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

/** The Switchyard mode of AO turn settings; `plan` when omp's own `mode` option says so; undefined for AO's `default` (omp's own setting decides). */
export function modeOf(approval: AoApprovalMode | undefined, ompMode?: string): PermissionMode | undefined {
	if (ompMode === "plan") return "plan";
	switch (approval) {
		case "bypass-permissions":
			return "auto";
		case "accept-edits":
		case "auto":
			return "edits";
		default:
			return undefined;
	}
}

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

/** The old `meta.status` word: scripts and the Hermes plugin still read it. */
export type LegacyStatus = "starting" | "working" | "waiting" | "idle" | "stopped";

export function legacyStatus(s: Session): LegacyStatus {
	switch (s.model.state) {
		case "needs_input":
			return "waiting";
		case "working":
			return "working";
		case "starting":
			return "starting";
		case "stopped":
			return "stopped";
		default:
			return s.model.view.isTerminated || s.model.view.activity.state === "exited" ? "stopped" : "idle";
	}
}

/** What the planner says about a lane when the session runs nothing (MAPPING D3; `agentState` applies it). */
export function plannedState(lane: LaneSummary | undefined): AoPlannedState | undefined {
	if (!lane) return undefined;
	if (lane.scheduled) return "scheduled";
	if (lane.waiting) return "queued";
	if (lane.interrupted) return "interrupted";
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

/** The folder AO runs the session in; undefined once its workspace is gone (terminated) or the daemon doesn't say. */
export async function workspacePath(client: AoClient, sessionId: string): Promise<string | undefined> {
	try {
		const res = await unwrap<AoSchemas["DesktopWorkspaceLocationResponse"]>(client.api.GET("/api/v1/desktop/sessions/{sessionId}/workspace", { params: { path: { sessionId } } }));
		return res.workspacePath || undefined;
	} catch {
		return undefined;
	}
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
	const [conv, workspace] = await Promise.all([conversation ? Promise.resolve(conversation) : conversationOf(client, view, opts.conversationLimit), view.isTerminated ? Promise.resolve(undefined) : workspacePath(client, view.id)]);
	const lane = opts.lanes?.get(view.id);
	const model = sessionModel(view, conv, plannedState(lane));
	const project = view.projectId ? projects.get(view.projectId) : undefined;
	const org = opts.org ?? readOrgFile();
	const e = org.sessions[view.id];
	const session: Session = {
		id: view.id,
		title: model.title,
		cwd: workspace ?? project?.path ?? "",
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
		if (state && (isState ? s.state !== state : columnOf(s.state) !== state && legacyStatus(s) !== state)) return false;
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

// ---------- JSON shapes (skills/omp-sessions/SKILL.md) ----------

export interface QueueSummary {
	pending: number;
	running: number;
	done: number;
	total: number;
	autoRun: boolean;
	startAt?: number;
	interrupted?: boolean;
}

export function queueSummary(s: Session): QueueSummary {
	const l = s.lane;
	if (!l) return { pending: 0, running: 0, done: 0, total: 0, autoRun: false };
	return { pending: l.pending, running: l.running, done: l.done, total: l.total, autoRun: l.autoRun, ...(l.startAt !== undefined && { startAt: l.startAt }), ...(l.interrupted && { interrupted: true }) };
}

/** A question as `show --json` has always printed it: `{id, kind, title, message?, options?, questions?}`. */
export interface QuestionJson {
	id: string;
	/** `select`, `confirm`, `input` or `ask` (omp's dialog kinds), or `approval` (an AO permission request). */
	kind: string;
	title: string;
	message?: string;
	options?: string[];
	questions?: Array<{ question: string; options: string[]; multi: boolean }>;
}

/** omp asks everything through ACP forms: one `value` field is select/confirm/input; several fields are its `ask` tool. */
export function questionJson(q: AoQuestion): QuestionJson {
	const text = q.message ?? q.title;
	const nl = text.indexOf("\n");
	const title = (nl < 0 ? text : text.slice(0, nl)).trim() || q.title;
	const rest = nl < 0 ? "" : text.slice(nl + 1).trim();
	const out: QuestionJson = { id: q.id, kind: "input", title };
	if (rest) out.message = rest;
	if (q.kind === "approval") {
		out.kind = "approval";
		out.options = q.options ?? [];
		return out;
	}
	const fields = q.questions ?? [];
	if (fields.length === 1 && fields[0].key === "value" && !fields[0].otherKey) {
		const f = fields[0];
		if (f.type === "boolean") out.kind = "confirm";
		else if (f.options.length) {
			out.kind = "select";
			out.options = f.options;
		}
		return out;
	}
	if (fields.length) {
		out.kind = "ask";
		out.questions = fields.map(f => ({ question: f.question, options: f.options, multi: f.multi }));
	}
	return out;
}

/** `ls --json` / `board --json`: one entry per session, `meta` kept for scripts that read `meta.id`/`meta.title`. */
export function infoJson(s: Session, order: number) {
	const m = s.model;
	return {
		meta: {
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			status: legacyStatus(s),
			createdAt: m.createdAt,
			updatedAt: m.updatedAt,
			changedFiles: m.changedFiles.length,
			...(m.model && { model: m.model }),
			...(m.cost !== undefined && { cost: m.cost }),
			...(m.exitReason && s.state === "stopped" && { exitReason: m.exitReason }),
			...(s.project && { project: s.project.id }),
			...(m.branch && { branch: m.branch }),
		},
		column: columnOf(s.state),
		state: s.state,
		queue: queueSummary(s),
		priority: s.priority,
		order,
		...(s.group && { group: s.group }),
		...(s.color && { color: s.color }),
		...(s.archived && { archived: true }),
		...(s.tags.length && { tags: s.tags }),
		...(s.lane?.waiting && { waiting: s.lane.waiting }),
	};
}

export interface SessionReport {
	id: string;
	title: string;
	cwd: string;
	state: AgentState;
	status: LegacyStatus;
	mode?: PermissionMode;
	model?: string;
	cost?: number;
	changedFiles: number;
	queue: QueueSummary;
	question?: QuestionJson;
	reply?: string;
	exitReason?: string;
	tags: string[];
	createdAt: number;
	updatedAt: number;
	project?: string;
	branch?: string;
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

/** Files the session changed in its workspace (AO's workspace manifest; omp's turns carry no per-turn diff); undefined when AO can't say. */
export async function changedFileCount(client: AoClient, sessionId: string): Promise<number | undefined> {
	try {
		const res = await unwrap<AoSchemas["WorkspaceManifestResponse"]>(client.api.GET("/api/v1/sessions/{sessionId}/workspace/manifest", { params: { path: { sessionId } } }));
		return res.files.length;
	} catch {
		return undefined;
	}
}

/** `live`: what only a running agent or workspace can say (omp's `mode` option, the workspace's changed files). */
export function sessionReport(s: Session, live: { ompMode?: string; changedFiles?: number } = {}): SessionReport {
	const m = s.model;
	const mode = modeOf(m.conversation?.settings.approvalMode, live.ompMode ?? (m.conversation?.settings.planMode ? "plan" : undefined));
	const report: SessionReport = {
		id: s.id,
		title: s.title,
		cwd: s.cwd,
		state: s.state,
		status: legacyStatus(s),
		changedFiles: live.changedFiles ?? m.changedFiles.length,
		queue: queueSummary(s),
		tags: s.tags,
		createdAt: m.createdAt,
		updatedAt: m.updatedAt,
	};
	if (mode) report.mode = mode;
	if (m.model) report.model = m.model;
	if (m.cost !== undefined) report.cost = m.cost;
	if (m.question && s.state === "needs_input") report.question = questionJson(m.question);
	if (m.reply) report.reply = m.reply;
	if (m.exitReason && (s.state === "stopped" || s.state === "interrupted")) report.exitReason = m.exitReason;
	if (s.project) report.project = s.project.id;
	if (m.branch) report.branch = m.branch;
	return report;
}

/** Ranks sessions the way the board and the planner order them (priority, then manual order). */
export function orderOf(sessions: readonly Session[], org: OrgData = readOrgFile()): Map<string, number> {
	const order = schedulingOrder(
		org,
		sessions.map(s => s.id),
	);
	return new Map(order.map((id, i) => [id, i]));
}
