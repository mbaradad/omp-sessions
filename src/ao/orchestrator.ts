// AO's orchestrator: the coordinating agent AO runs for a project. It takes a high-level task (a feature,
// a refactoring, "get the flaky tests green"), splits it, starts and steers worker sessions, asks AO's
// reviewer to look at their PRs, and reports back. Switchyard's other views list workers only
// (`kind: "worker"`); this is the view and the controls of the one coordinator above them, the same for
// every client (CLI, VS Code, Hermes):
//
//   const project = await resolveProject(client, "myrepo", process.cwd());
//   const sent = await submitTask(client, project, "Move the billing module to the new API and update its tests");
//   const view = await orchestratorOf(client, project);          // state, last reply, workers with their PRs
//   await setOrchestratorConfig(client, project.id, { harness: "claude-code", rules: "Always ask for review." });
//
// AO keeps at most one active orchestrator per project and starts it on demand (`spawnOrchestrator` returns
// the active one). Which workers it started is not in AO's API (the link lives in the worker's spawn
// request), so a project's "workers" are its worker sessions.
import * as path from "node:path";
import type { PrFacts } from "../shared/pr-review";
import { type AoClient, AoError, type AoProject, type AoSchemas, type AoSessionView } from "./client";
import { resolveSessionHarness } from "./harness";
import { type AoAgentState, agentState, lastReply, questionsOf } from "./model";
import { prFactsOf } from "./pr";
import { gitRoot, projectForFolder } from "./projects";

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

export type OrchestratorPermissions = "default" | "accept-edits" | "auto" | "bypass-permissions";
export const ORCHESTRATOR_PERMISSIONS: readonly OrchestratorPermissions[] = ["default", "accept-edits", "auto", "bypass-permissions"];
/** What an orchestrator starts with when nobody chose: it coordinates (runs `ao` commands), so a prompt per command would stall unattended work. */
export const DEFAULT_ORCHESTRATOR_PERMISSIONS: OrchestratorPermissions = "bypass-permissions";

export interface OrchestratorConfig {
	/** The harness the orchestrator runs (AO project setting `orchestrator.agent`); unset: AO's choice. */
	harness?: string;
	model?: string;
	effort?: string;
	/** Approval mode a new orchestrator starts in (`orchestrator.agentConfig.permissions`). */
	permissions?: string;
	/** Standing instructions for the project's orchestrator (`orchestratorRules`), and the file they come from (`orchestratorRulesFile`, relative to the project). */
	rules?: string;
	rulesFile?: string;
	/** The harness and model of the workers the orchestrator starts (`worker.agent`, `worker.agentConfig.model`). */
	workerHarness?: string;
	workerModel?: string;
	/** Workers ask AO's reviewer for a review of their PRs / AO reviews them by itself. */
	workersRequestReview?: boolean;
	autoReview?: boolean;
}

/** Keys of OrchestratorConfig that are text a person may clear. `null` in a patch clears a setting; `undefined` keeps it. */
export type OrchestratorConfigPatch = { [K in keyof OrchestratorConfig]?: OrchestratorConfig[K] | null };

export interface OrchestratorWorker {
	id: string;
	title: string;
	harness?: string;
	state: AoAgentState;
	/** AO's status line for the session (`Working`, `Awaiting PR`, `CI failing`, `Mergeable`, …). */
	displayStatus: string;
	branch?: string;
	prs: PrFacts[];
	createdAt: number;
	updatedAt: number;
}

export interface OrchestratorQuestion {
	id: string;
	title: string;
	message?: string;
	approval: boolean;
}

export interface OrchestratorInfo {
	/** The orchestrator's session id (`switchyard show|send|answer|tail <id>` work on it like on any session). */
	id: string;
	projectId: string;
	projectName: string;
	projectPath: string;
	harness?: string;
	model?: string;
	mode: "chat" | "tui";
	state: AoAgentState;
	displayStatus: string;
	/** Not terminated: the one AO routes the project's coordination to. */
	active: boolean;
	branch?: string;
	createdAt: number;
	updatedAt: number;
	/** What it waits to have answered, when `state` is `needs_input`. */
	question?: OrchestratorQuestion;
	/** The last thing it said, in full. */
	reply?: string;
	config: OrchestratorConfig;
	workers: OrchestratorWorker[];
	/** Worker sessions by state, for a summary line. */
	counts: { workers: number; working: number; needsInput: number; idle: number; stopped: number; openPrs: number };
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

// ---------- projects ----------

/** The name or folder given matches no AO project (a read-only command may treat it as "no orchestrator yet"). */
export class NoProjectError extends Error {}

/** What a user typed to name a project: its id or name, or a folder (its repository's project, registered on first use). */
export async function resolveProject(client: AoClient, query: string | undefined, cwd: string, options: { create?: boolean } = {}): Promise<AoProject> {
	const projects = await client.listProjects();
	const q = query?.trim();
	if (q) {
		const byId = projects.find(p => p.id === q);
		if (byId) return byId;
		const byName = projects.filter(p => p.name === q || p.name.toLowerCase() === q.toLowerCase());
		if (byName.length === 1) return byName[0];
		if (byName.length > 1) throw new Error(`"${q}" names ${byName.length} projects: ${byName.map(p => `${p.id} (${p.path})`).join(", ")}; use the id`);
	}
	const dir = q && (path.isAbsolute(q) || /[\\/]/.test(q) || q === ".") ? path.resolve(cwd, q) : q ? undefined : cwd;
	if (dir) {
		const found = await projectForFolder(client, dir, { create: options.create ?? true });
		if (found) return found;
		throw new NoProjectError(gitRoot(dir) ? `${dir} is in a git repository AO has no project for yet` : `${dir} is not in a git repository (an orchestrator coordinates a project: use a folder of one)`);
	}
	const known = projects.map(p => `${p.id} (${p.name})`).join(", ");
	throw new NoProjectError(`no project "${q}"${known ? `; AO's projects: ${known}` : "; AO has none yet: name a git folder"}`);
}

// ---------- configuration ----------

/** The project's orchestrator settings (`switchyard orchestrator config`). */
export async function orchestratorConfig(client: AoClient, projectId: string): Promise<OrchestratorConfig> {
	const project = await client.getProject(projectId);
	return configOf("config" in project ? project.config : undefined);
}

function configOf(c: AoSchemas["ProjectConfig"] | undefined): OrchestratorConfig {
	const text = (v: string | undefined) => (v?.trim() ? v : undefined);
	const out: OrchestratorConfig = {};
	const set = <K extends keyof OrchestratorConfig>(key: K, value: OrchestratorConfig[K] | undefined) => {
		if (value !== undefined) out[key] = value;
	};
	set("harness", text(c?.orchestrator?.agent));
	set("model", text(c?.orchestrator?.agentConfig?.model));
	set("effort", text(c?.orchestrator?.agentConfig?.effort));
	set("permissions", text(c?.orchestrator?.agentConfig?.permissions));
	set("rules", text(c?.orchestratorRules));
	set("rulesFile", text(c?.orchestratorRulesFile));
	set("workerHarness", text(c?.worker?.agent));
	set("workerModel", text(c?.worker?.agentConfig?.model));
	set("workersRequestReview", c?.workersRequestReview);
	set("autoReview", c?.autoReview);
	return out;
}

/** The project's config with `patch` applied (a pure step of setOrchestratorConfig). */
export function applyConfigPatch(config: AoSchemas["ProjectConfig"], patch: OrchestratorConfigPatch): AoSchemas["ProjectConfig"] {
	const next: AoSchemas["ProjectConfig"] = { ...config };
	const has = (k: keyof OrchestratorConfigPatch) => Object.hasOwn(patch, k) && patch[k] !== undefined;
	const text = (k: "rules" | "rulesFile") => (typeof patch[k] === "string" ? (patch[k] as string).trim() : undefined);
	// Role overrides: `agent` and the fields of `agentConfig`, each set or cleared on its own.
	const role = (current: AoSchemas["RoleOverride"] | undefined, agent: keyof OrchestratorConfigPatch, fields: ReadonlyArray<[keyof NonNullable<AoSchemas["RoleOverride"]["agentConfig"]>, keyof OrchestratorConfigPatch]>): AoSchemas["RoleOverride"] | undefined => {
		const out: AoSchemas["RoleOverride"] = { ...current, ...(current?.agentConfig && { agentConfig: { ...current.agentConfig } }) };
		if (has(agent)) {
			if (patch[agent] === null) delete out.agent;
			else out.agent = String(patch[agent]);
		}
		for (const [field, key] of fields) {
			if (!has(key)) continue;
			const cfg = { ...out.agentConfig };
			if (patch[key] === null) delete cfg[field];
			else cfg[field] = String(patch[key]);
			if (Object.keys(cfg).length) out.agentConfig = cfg;
			else delete out.agentConfig;
		}
		return out.agent || out.agentConfig ? out : undefined;
	};
	if (["harness", "model", "effort", "permissions"].some(k => has(k as keyof OrchestratorConfigPatch))) {
		const o = role(config.orchestrator, "harness", [["model", "model"], ["effort", "effort"], ["permissions", "permissions"]]);
		if (o) next.orchestrator = o;
		else delete next.orchestrator;
	}
	if (["workerHarness", "workerModel"].some(k => has(k as keyof OrchestratorConfigPatch))) {
		const w = role(config.worker, "workerHarness", [["model", "workerModel"]]);
		if (w) next.worker = w;
		else delete next.worker;
	}
	if (has("rules")) {
		const rules = text("rules");
		if (rules) next.orchestratorRules = rules;
		else delete next.orchestratorRules;
	}
	if (has("rulesFile")) {
		const file = text("rulesFile");
		if (file) next.orchestratorRulesFile = file;
		else delete next.orchestratorRulesFile;
	}
	if (has("workersRequestReview")) {
		if (patch.workersRequestReview === null) delete next.workersRequestReview;
		else next.workersRequestReview = !!patch.workersRequestReview;
	}
	if (has("autoReview")) {
		if (patch.autoReview === null) delete next.autoReview;
		else next.autoReview = !!patch.autoReview;
	}
	return next;
}

/**
 * Changes the project's orchestrator settings, keeping every other AO project setting (AO replaces the whole
 * config on write; AO validates what it is given). A running orchestrator keeps what it started with:
 * `restartOrchestrator` applies them.
 */
export async function setOrchestratorConfig(client: AoClient, projectId: string, patch: OrchestratorConfigPatch): Promise<OrchestratorConfig> {
	const project = await client.getProject(projectId);
	if (!("config" in project)) throw new Error(`AO can't read project ${projectId}'s settings (${"resolveError" in project ? project.resolveError : "degraded project"})`);
	const trimmed: OrchestratorConfigPatch = { ...patch };
	for (const key of ["harness", "model", "effort", "permissions", "workerHarness", "workerModel"] as const) if (typeof trimmed[key] === "string") trimmed[key] = (trimmed[key] as string).trim() || null;
	await client.setProjectConfig(projectId, applyConfigPatch(project.config ?? {}, trimmed));
	return orchestratorConfig(client, projectId);
}

// ---------- the orchestrator and its workers ----------

function workerOf(view: AoSessionView): OrchestratorWorker {
	return {
		id: view.id,
		title: view.displayName || view.id,
		...(view.harness && { harness: view.harness }),
		state: agentState(view),
		displayStatus: view.displayStatus,
		...(view.branch && { branch: view.branch }),
		prs: view.prs.map(prFactsOf),
		createdAt: ms(view.createdAt),
		updatedAt: Math.max(ms(view.updatedAt), ms(view.lastEventAt)),
	};
}

/** Workers shown per orchestrator, newest first (a project can have hundreds of old ones). */
export const WORKERS_SHOWN = 60;

async function infoOf(client: AoClient, view: AoSessionView, project: AoProject | undefined, workerViews: readonly AoSessionView[]): Promise<OrchestratorInfo> {
	const conversation = view.mode === "chat" && !view.isTerminated ? await client.getConversation(view.id, { limit: 20 }).catch(() => undefined) : undefined;
	const workers = workerViews
		.filter(w => w.projectId === view.projectId)
		.map(workerOf)
		.sort((a, b) => (a.state === "stopped" ? 1 : 0) - (b.state === "stopped" ? 1 : 0) || b.updatedAt - a.updatedAt)
		.slice(0, WORKERS_SHOWN);
	const question = conversation ? questionsOf(conversation)[0] : undefined;
	const reply = conversation ? lastReply(conversation) : undefined;
	const config = view.projectId ? await orchestratorConfig(client, view.projectId).catch(() => ({})) : {};
	const state = agentState(view, conversation);
	return {
		id: view.id,
		projectId: view.projectId ?? "",
		projectName: project?.name ?? view.projectId ?? "",
		projectPath: project?.path ?? "",
		...(view.harness && { harness: view.harness }),
		...((conversation?.settings.model ?? view.model) && { model: conversation?.settings.model ?? view.model }),
		mode: view.mode,
		state,
		displayStatus: view.displayStatus,
		active: !view.isTerminated,
		...(view.branch && { branch: view.branch }),
		createdAt: ms(view.createdAt),
		updatedAt: Math.max(ms(view.updatedAt), ms(view.lastEventAt)),
		...(question && { question: { id: question.id, title: question.title, ...(question.message && { message: question.message }), approval: question.kind === "approval" } }),
		...(reply && { reply }),
		config,
		workers,
		counts: {
			workers: workers.length,
			working: workers.filter(w => w.state === "working" || w.state === "starting").length,
			needsInput: workers.filter(w => w.state === "needs_input").length,
			idle: workers.filter(w => w.state === "idle").length,
			stopped: workers.filter(w => w.state === "stopped" || w.state === "interrupted").length,
			openPrs: workers.reduce((n, w) => n + w.prs.filter(p => p.state === "open" || p.state === "draft").length, 0),
		},
	};
}

/**
 * The project's orchestrator (the newest one when AO kept several; active ones first) with its
 * workers, or undefined when it has none yet.
 */
export async function orchestratorOf(client: AoClient, project: AoProject): Promise<OrchestratorInfo | undefined> {
	const [orchestrators, workers] = await Promise.all([client.listOrchestrators({ projectId: project.id }), client.listSessions({ kind: "worker", project: project.id })]);
	const view = [...orchestrators].sort((a, b) => Number(a.isTerminated) - Number(b.isTerminated) || ms(b.updatedAt) - ms(a.updatedAt))[0];
	return view ? infoOf(client, view, project, workers.sessions) : undefined;
}

/** Every project's orchestrator, active ones first, then by last activity. Projects without one are left out. */
export async function listOrchestrators(client: AoClient, options: { includeStopped?: boolean } = {}): Promise<OrchestratorInfo[]> {
	const [views, workers, projects] = await Promise.all([client.listOrchestrators(), client.listSessions({ kind: "worker" }), client.listProjects()]);
	const byProject = new Map<string, AoSessionView>();
	for (const v of [...views].sort((a, b) => Number(b.isTerminated) - Number(a.isTerminated) || ms(a.updatedAt) - ms(b.updatedAt))) if (v.projectId) byProject.set(v.projectId, v);
	const names = new Map(projects.map(p => [p.id, p]));
	const infos = await Promise.all([...byProject.values()].filter(v => options.includeStopped || !v.isTerminated).map(v => infoOf(client, v, v.projectId ? names.get(v.projectId) : undefined, workers.sessions)));
	return infos.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt);
}

// ---------- starting, steering, submitting ----------

export interface StartOptions {
	/** Sets the project's orchestrator harness before starting (persisted in AO's project settings). */
	harness?: string;
	permissions?: OrchestratorPermissions;
	/** Replace the active orchestrator with a fresh one (new workspace, empty context; the old one is told to stop). */
	clean?: boolean;
	/** Switchyard's default harness (`switchyard config get harness`), used only when the project names none. */
	defaultHarness?: string;
}

const READY_TIMEOUT_MS = 120_000;

async function waitReady(client: AoClient, id: string, timeoutMs = READY_TIMEOUT_MS): Promise<AoSessionView> {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const view = await client.getSession(id);
		if (view.provisionState === "failed") throw new Error(`the orchestrator failed to start: ${view.provisionError || "AO gave no reason"}`);
		if (view.provisionState !== "provisioning") return view;
		if (performance.now() > deadline) throw new Error(`the orchestrator did not finish starting within ${Math.round(timeoutMs / 1000)} s (AO is still provisioning ${id})`);
		await delay(500);
	}
}

/** Brings a stopped orchestrator back (a terminated session is restored, an exited agent resumed); true when it did. */
async function revive(client: AoClient, view: AoSessionView): Promise<boolean> {
	if (view.isTerminated) {
		await client.restoreSession(view.id);
		return true;
	}
	if (view.activity.state === "exited") {
		await client.resumeAgent(view.id);
		return true;
	}
	return false;
}

export interface StartedOrchestrator {
	id: string;
	/** This call started it (false: it was already running). */
	started: boolean;
	/** It was stopped and is running again. */
	revived: boolean;
	harness?: string;
}

/**
 * The project's active orchestrator, started when there is none. `started` says whether this call started it.
 * AO starts an orchestrator only for a project that names its harness, so one is chosen and saved in the project's
 * settings first: `options.harness`, else the one the project already has, else Switchyard's default
 * (`defaultHarness`), the project's worker harness, then AO's default (the order every new session follows, harness.ts).
 */
export async function ensureOrchestrator(client: AoClient, project: AoProject, options: StartOptions = {}): Promise<StartedOrchestrator> {
	const config = await orchestratorConfig(client, project.id).catch(() => ({}) as OrchestratorConfig);
	const active = (await client.listOrchestrators({ projectId: project.id, active: true }))[0];
	if (active && !options.clean) {
		if (options.harness && active.harness && options.harness !== active.harness) {
			throw new Error(`the orchestrator of ${project.name} already runs ${active.harness}; replace it to use ${options.harness} (switchyard orchestrator restart ${project.id} --harness ${options.harness})`);
		}
		const ready = await waitReady(client, active.id);
		return { id: ready.id, started: false, revived: await revive(client, ready), ...(ready.harness && { harness: ready.harness }) };
	}
	const harness = options.harness ?? config.harness ?? (await resolveSessionHarness(client, { ...(options.defaultHarness && { config: options.defaultHarness }), projectId: project.id })).harness;
	if (harness !== config.harness) await setOrchestratorConfig(client, project.id, { harness });
	const approvalMode = options.permissions ?? ORCHESTRATOR_PERMISSIONS.find(p => p === config.permissions) ?? DEFAULT_ORCHESTRATOR_PERMISSIONS;
	const spawned = await client.spawnOrchestrator({ projectId: project.id, mode: "chat", approvalMode, ...(options.clean && { clean: true }) });
	await waitReady(client, spawned.id);
	return { id: spawned.id, started: true, revived: false, harness };
}

/** Replaces the orchestrator with a fresh one, which starts with the project's current settings (harness, model, rules). */
export function restartOrchestrator(client: AoClient, project: AoProject, options: Omit<StartOptions, "clean"> = {}): Promise<StartedOrchestrator> {
	return ensureOrchestrator(client, project, { ...options, clean: true });
}

export interface SubmitOptions extends StartOptions {
	/** Redirect the turn in progress with this text instead of queueing it behind. */
	steer?: boolean;
}

export interface SubmitResult {
	orchestrator: string;
	projectId: string;
	/** The harness the orchestrator runs. */
	harness?: string;
	/** This call started the orchestrator. */
	started: boolean;
	/** It was stopped and is running again. */
	revived: boolean;
	/** The AO turn this message started or queued behind, for `switchyard wait`/`show`. */
	turnId?: string;
	mode: "send" | "steer";
}

/** Retried while AO's chat is still coming up after a start or a resume. */
function notReady(err: unknown): boolean {
	return err instanceof AoError && (err.status === 409 || err.status === 503 || /not.?ready|connecting|starting|no .*controller/i.test(`${err.code} ${err.message}`));
}

/** Gives the project's orchestrator a high-level task (starting it when needed); it plans and starts workers by itself. */
export async function submitTask(client: AoClient, project: AoProject, text: string, options: SubmitOptions = {}): Promise<SubmitResult> {
	const body = text.trim();
	if (!body) throw new Error("nothing to submit: give the orchestrator a task");
	const target = await ensureOrchestrator(client, project, options);
	const mode = options.steer ? "steer" : "send";
	let lastError: unknown;
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			const sent = options.steer ? await client.steerOrSend(target.id, { text: body }) : await client.sendMessage(target.id, { text: body });
			const { turnId } = sent;
			return { orchestrator: target.id, projectId: project.id, ...(target.harness && { harness: target.harness }), started: target.started, revived: target.revived, ...(turnId && { turnId }), mode };
		} catch (err) {
			if (!notReady(err)) throw err;
			lastError = err;
			await delay(1500);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("the orchestrator never became ready to take a message");
}
