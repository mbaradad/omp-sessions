// Switchyard's view of AO sessions: one agent state, the pending question with its choices, the
// last reply, cost, the turn queue and the files the agent changed, derived from an AO session view
// and (for chat sessions) its conversation snapshot. Pure functions, plus AoSessionWatcher, which
// keeps those models current from the daemon's change stream; the report (`show --json` shape) and the
// conversation follower (attach, tail) live in ./report and ./follow and are exported from here.
import type { AoActivity, AoClient, AoConversation, AoListSessionsQuery, AoResolveInputRequest, AoSessionView, AoStreamStatus, AoTurn, AoWorkspaceManifest } from "./client";

export type { AoConversationFollow, AoConversationUpdate, AoFollowOptions } from "./follow";
export { deltaCursor, followConversation, mergeConversation } from "./follow";
export type { AoPermissionMode, AoReportExtra, AoReportQuestion, AoReportQueue, AoReportStatus, AoSessionReport } from "./report";
export { approvalModeFor, permissionModeOf, planModeOf, reportQuestion, sessionReport } from "./report";

/**
 * `queued`: turns wait while the agent is not connected (hibernated or stopped), or the planner holds
 * work for the session. `scheduled`: the planner starts it later (AO has no start times).
 * `starting`: the session is being provisioned or its agent connects. `working`: a turn runs, or
 * queued turns continue on their own. `needs_input`: an approval or question waits for an answer.
 * `interrupted`: the agent died while a turn ran (AO failed it with AO_LOST_TURN_ERROR), or the
 * planner's task was cut short. `idle`: done for now. `stopped`: terminated, failed to start, or its
 * agent exited.
 */
export type AoAgentState = "queued" | "scheduled" | "starting" | "working" | "needs_input" | "interrupted" | "idle" | "stopped";

/** States in which nothing happens until someone acts (or a start time comes): what `switchyard wait` waits for. */
export const SETTLED_STATES: Readonly<Record<AoAgentState, boolean>> = { queued: false, scheduled: true, starting: false, working: false, needs_input: true, interrupted: true, idle: true, stopped: true };

export interface AoDecision {
	id: string;
	label: string;
	/** ACP option kind: allow_once, allow_always, reject_once, reject_always. */
	kind?: string;
}

export interface AoQuestionField {
	/** Property name in the answer's `content`. */
	key: string;
	question: string;
	/** Choice labels, when the schema enumerates them. */
	options: string[];
	/** The value each choice puts in the answer (the schema's `const`, or the enum value). */
	values: unknown[];
	multi: boolean;
	type: "string" | "number" | "integer" | "boolean" | "array";
	required: boolean;
	/** The free-text companion property (`<key>__other`, how omp's `ask` offers "Other"), when there is one. */
	otherKey?: string;
}

/** A pending approval (`kind: "approval"`, answered with a decision) or structured question (`kind: "input"`, answered with form content). */
export interface AoQuestion {
	/** AO's request id: what the resolve endpoints take. */
	id: string;
	kind: "approval" | "input";
	title: string;
	message?: string;
	/** approval: the decision labels, in order. input: the choices of a single-field question. */
	options?: string[];
	decisions?: AoDecision[];
	/** input: one entry per form field (`ask` with several questions). */
	questions?: AoQuestionField[];
	/** input: the JSON schema the answer's content must match. */
	schema?: unknown;
	/** input in URL mode: the page that answers it. */
	url?: string;
	/** approval that arrived as a `user_input` form (omp's write/edit prompts): the form field the chosen decision's id goes into, resolved through the inputs route. */
	inputField?: string;
	turnId?: string;
	createdAt: number;
}

export interface AoQueueItem {
	turnId: string;
	text: string;
	requestedAt: number;
}

export interface AoQueue {
	pending: number;
	running: number;
	done: number;
	total: number;
	/** Queued turns in dispatch order. */
	items: AoQueueItem[];
}

export interface AoChangedFile {
	path: string;
	oldPath?: string;
	status: "added" | "modified" | "deleted" | "renamed";
	additions: number;
	deletions: number;
}

export interface AoSessionModel {
	id: string;
	title: string;
	projectId?: string;
	/** The folder the agent works in: its worktree, or its standalone scratch dir. Set by AoSessionWatcher (AoClient.workspacePath). */
	cwd?: string;
	harness?: string;
	model?: string;
	mode: AoSessionView["mode"];
	state: AoAgentState;
	/** AO's own status (`working`, `needs_input`, `idle`, PR states, `terminated`…). */
	status: AoSessionView["status"];
	branch?: string;
	pinned: boolean;
	createdAt: number;
	updatedAt: number;
	/** Model cost so far, in `currency` (USD for omp). */
	cost?: number;
	currency?: string;
	changedFiles: AoChangedFile[];
	queue: AoQueue;
	/** The first question waiting for an answer. */
	question?: AoQuestion;
	/** The last assistant text in full (clipped at REPLY_MAX characters). */
	reply?: string;
	/** Why it stopped, when it did: a provisioning error or the failed turn's message. */
	exitReason?: string;
	/** The AO view and conversation this model came from. */
	view: AoSessionView;
	conversation?: AoConversation;
}

export const REPLY_MAX = 20_000;

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const OPEN_TURNS: Readonly<Partial<Record<AoTurn["state"], true>>> = { queued: true, running: true };

/**
 * Approvals and questions still waiting for an answer, oldest first. A request belongs to a turn that
 * waits on it: when that turn has ended (a person's Stop leaves the approval row `pending` although the
 * turn is `interrupted` and the agent ready, checked live) nobody can answer it any more.
 */
export function pendingActivities(conversation: AoConversation): AoActivity[] {
	const turns = new Map(conversation.turns.map(t => [t.id, t]));
	return conversation.activities.filter(a => {
		if (a.status !== "pending" || !a.requestId || (a.activityKind !== "approval" && a.activityKind !== "user_input")) return false;
		const turn = a.turnId ? turns.get(a.turnId) : undefined;
		return !turn || OPEN_TURNS[turn.state] === true;
	});
}

/** Labels for ACP's permission option kinds, for decisions that come without one. */
const ACP_DECISION_LABELS: Readonly<Record<string, string>> = { allow_once: "Allow once", allow_always: "Always allow", reject_once: "Reject", reject_always: "Always reject" };

const OTHER_SUFFIX = "__other";

/** The choices of a schema property: `enum`, or `oneOf`/`anyOf` of `{const, title}` (for arrays, of its `items`). */
function choices(prop: Record<string, unknown>): { options: string[]; values: unknown[] } {
	const source = prop.type === "array" && isRecord(prop.items) ? prop.items : prop;
	if (Array.isArray(source.enum)) return { options: source.enum.map(String), values: [...source.enum] };
	const list = Array.isArray(source.oneOf) ? source.oneOf : Array.isArray(source.anyOf) ? source.anyOf : [];
	const entries = list.filter(isRecord).filter(o => o.const !== undefined);
	return { options: entries.map(o => str(o.title) ?? String(o.const)), values: entries.map(o => o.const) };
}

/** The fields of an elicitation schema (`{type: "object", properties, required}`), as questions; `<key>__other` folds into `<key>`. */
export function schemaFields(schema: unknown): AoQuestionField[] {
	if (!isRecord(schema) || !isRecord(schema.properties)) return [];
	const props = schema.properties;
	const required = Array.isArray(schema.required) ? schema.required.filter(k => typeof k === "string") : [];
	return Object.entries(props).flatMap(([key, raw]): AoQuestionField[] => {
		if (!isRecord(raw)) return [];
		if (key.endsWith(OTHER_SUFFIX) && isRecord(props[key.slice(0, -OTHER_SUFFIX.length)])) return [];
		const type = raw.type === "number" || raw.type === "integer" || raw.type === "boolean" || raw.type === "array" ? raw.type : "string";
		const otherKey = isRecord(props[key + OTHER_SUFFIX]) ? key + OTHER_SUFFIX : undefined;
		return [{ key, question: str(raw.title) ?? str(raw.description) ?? key, ...choices(raw), multi: type === "array", type, required: required.includes(key), ...(otherKey && { otherKey }) }];
	});
}

export function questionOf(activity: AoActivity): AoQuestion {
	const detail = isRecord(activity.detail) ? activity.detail : {};
	const base = { id: activity.requestId ?? activity.id, title: activity.summary, createdAt: ms(activity.createdAt), ...(activity.turnId && { turnId: activity.turnId }) };
	if (activity.activityKind === "approval") {
		// omp sends its ACP permission options as bare ids (`{"id":"allow_once"}`, VALIDATION.md §3): the id is the kind.
		const decisions: AoDecision[] = (Array.isArray(detail.decisions) ? detail.decisions : []).flatMap(d => {
			if (!isRecord(d) || typeof d.id !== "string") return [];
			const kind = str(d.kind) ?? (ACP_DECISION_LABELS[d.id] ? d.id : undefined);
			return [{ id: d.id, label: str(d.label) ?? ACP_DECISION_LABELS[d.id] ?? d.id, ...(kind && { kind }) }];
		});
		const message = str(detail.message) ?? str(detail.title);
		return { ...base, kind: "approval", decisions, options: decisions.map(d => d.label), ...(message && { message }) };
	}
	const fields = schemaFields(detail.schema);
	const message = str(detail.message);
	const permission = permissionPrompt(fields);
	if (permission) {
		// omp's write/edit permission prompts arrive as a `user_input` form (VALIDATION.md §3, G12): one
		// field offering Approve / Approve … for this session / Deny. Same concept as bash's approval.
		const decisions = permission.options.map((label, i): AoDecision => ({ id: String(permission.values[i]), label, kind: permissionKind(label) }));
		return { ...base, kind: "approval", decisions, options: permission.options, inputField: permission.key, ...(message && message !== activity.summary && { message }) };
	}
	return {
		...base,
		kind: "input",
		...(message && message !== activity.summary && { message }),
		...(fields.length > 0 && { questions: fields }),
		...(fields.length === 1 && fields[0].options.length > 0 && { options: fields[0].options }),
		...(detail.schema !== undefined && { schema: detail.schema }),
		...(str(detail.url) && { url: str(detail.url) }),
	};
}

/** ACP option kind of a permission choice: `Approve` once, `Approve … for this session` always, `Deny` rejects. */
function permissionKind(label: string): string {
	if (/^deny\b|^reject\b/i.test(label)) return "reject_once";
	return /session|always/i.test(label) ? "allow_always" : "allow_once";
}

/** The single field of a form that is a tool-permission prompt: choices include an approval and a denial. */
function permissionPrompt(fields: AoQuestionField[]): AoQuestionField | undefined {
	const [field] = fields;
	if (fields.length !== 1 || field.multi || field.options.length < 2) return undefined;
	return field.options.some(o => /^approve\b|^allow\b/i.test(o)) && field.options.some(o => /^deny\b|^reject\b/i.test(o)) ? field : undefined;
}

export function questionsOf(conversation: AoConversation): AoQuestion[] {
	return pendingActivities(conversation).map(questionOf);
}

/** The newest assistant text, clipped at `max` characters. */
export function lastReply(conversation: AoConversation, max = REPLY_MAX): string | undefined {
	for (let i = conversation.messages.length - 1; i >= 0; i--) {
		const m = conversation.messages[i];
		if (m.role === "assistant" && m.text.trim()) return m.text.length > max ? `${m.text.slice(0, max)}\n… (clipped)` : m.text;
	}
	return undefined;
}

const DONE_TURNS: Readonly<Partial<Record<AoTurn["state"], true>>> = { completed: true, recovered: true, interrupted: true, failed: true };

/** providerTurnId of a turn AO imported from omp's recorded history after exit-agent + resume-agent (G33). */
const HISTORY_TURN_PREFIX = "acp-history-turn:";

/**
 * The turns that ran in this conversation: those AO replays from omp's history on resume (prompts
 * already recorded, steered or with images, come back as `recovered` turns whose providerTurnId starts
 * with `acp-history-turn:`) are not new work. They are not counted in the queue, and are never "the
 * last turn" that decides interrupted or the exit reason.
 */
export function realTurns(conversation: AoConversation): AoTurn[] {
	return conversation.turns.filter(t => !t.providerTurnId?.startsWith(HISTORY_TURN_PREFIX));
}

export function queueOf(conversation: AoConversation): AoQueue {
	const textOf = new Map<string, string>();
	for (const m of conversation.messages) if (m.role === "user" && m.turnId && !textOf.has(m.turnId)) textOf.set(m.turnId, m.text);
	const turns = realTurns(conversation);
	const queued = turns.filter(t => t.state === "queued");
	const running = turns.filter(t => t.state === "running").length;
	const done = turns.filter(t => DONE_TURNS[t.state]).length;
	return {
		pending: queued.length,
		running,
		done,
		total: queued.length + running + done,
		items: queued.map(t => ({ turnId: t.id, text: textOf.get(t.id) ?? "", requestedAt: ms(t.requestedAt) })),
	};
}

/**
 * The files the session changed: its workspace against the base it started from (AO's workspace
 * manifest). omp chat turns carry no `diff` (checked live), so the turns cannot tell; the manifest also
 * reflects whatever omp's /undo put back, since it reads the files themselves.
 */
export function changedFiles(manifest: AoWorkspaceManifest): AoChangedFile[] {
	return manifest.files.flatMap((f): AoChangedFile[] =>
		f.status === "unmodified" ? [] : [{ path: f.path, ...(f.status === "renamed" && f.previousPath && { oldPath: f.previousPath }), status: f.status, additions: f.additions, deletions: f.deletions }],
	);
}

/**
 * What the planner (PLANNER-API.md) says about the session's lane when it is not running a turn:
 * `queued` (a task is waiting, held or blocked), `scheduled` (the next task or the lane has a future
 * start), `interrupted` (a task was cut short and needs a person).
 */
export type AoPlannedState = "queued" | "scheduled" | "interrupted";

/**
 * The Switchyard state of an AO session (MAPPING.md D3). Pass its conversation snapshot when there is one
 * (chat sessions) for questions, queue and turns, and the planner's state of its lane when it has one:
 * that wins whenever the session itself is idle or stopped.
 */
export function agentState(view: AoSessionView, conversation?: AoConversation, planned?: AoPlannedState): AoAgentState {
	const own = sessionState(view, conversation);
	return planned && (own === "idle" || own === "stopped") ? planned : own;
}

function sessionState(view: AoSessionView, conversation: AoConversation | undefined): AoAgentState {
	if (view.isTerminated || view.status === "terminated") return "stopped";
	if (view.provisionState === "failed") return "stopped";
	if (view.provisionState === "provisioning") return "starting";
	if (conversation) {
		const running = conversation.turns.some(t => t.state === "running");
		const pending = pendingActivities(conversation).length > 0;
		// The agent died mid-turn (omp crashed or was killed): AO stops the controller and reports it
		// exited, and either keeps the turn (and any question) open for a replacement agent or fails it
		// with AO_LOST_TURN_ERROR. Nothing continues and nobody can answer until someone resumes it
		// (`resume-agent`; a message is refused meanwhile). After the resume it is idle again.
		const down = conversation.controller === "stopped" || view.activity.state === "exited";
		if (down && (running || pending || lostTurn(realTurns(conversation).at(-1)))) return "interrupted";
		if (pending) return "needs_input";
		if (running) return "working";
		const connecting = conversation.controller === "connecting" || conversation.controller === "recovering";
		if (conversation.turns.some(t => t.state === "queued")) {
			if (connecting) return "starting";
			return conversation.controller === "hibernated" || conversation.controller === "stopped" ? "queued" : "working";
		}
		if (connecting) return "starting";
		// Busy with no turn: compaction, a steer being applied.
		if (conversation.controller === "busy") return "working";
		if (view.activity.state === "exited") return "stopped";
		// `interrupted` turns are a person's stop; `recovered` ones were replayed from omp's history
		// (resume, adoption) without a known outcome. Neither needs anyone.
		return "idle";
	}
	switch (view.activity.state) {
		case "active":
			return "working";
		// A chat session with a pending question or approval reports waiting_input; blocked is a TUI permission prompt.
		case "blocked":
		case "waiting_input":
			return "needs_input";
		case "exited":
			return "stopped";
		default:
			return "idle";
	}
}

/** AO's reason for turns its controller still owned when it ended (SettleOrphanedConversationTurns). */
export const AO_LOST_TURN_ERROR = "controller ended before the turn completed";

function lostTurn(turn: AoTurn | undefined): boolean {
	return turn?.state === "failed" && turn.errorMessage === AO_LOST_TURN_ERROR;
}

/** Why a session stopped or its last turn failed, when AO says. */
export function exitReasonOf(view: AoSessionView, conversation?: AoConversation): string | undefined {
	if (view.provisionError) return view.provisionError;
	const last = conversation && realTurns(conversation).at(-1);
	return last?.state === "failed" ? last.errorMessage || "The turn failed." : undefined;
}

/** `files`: the session's changed files (changedFiles of its workspace manifest), when read. */
export function sessionModel(view: AoSessionView, conversation?: AoConversation, planned?: AoPlannedState, files: AoChangedFile[] = []): AoSessionModel {
	const question = conversation ? questionsOf(conversation)[0] : undefined;
	const reply = conversation ? lastReply(conversation) : undefined;
	const exitReason = exitReasonOf(view, conversation);
	const model = conversation?.settings.model ?? view.model;
	const usage = conversation?.usage;
	return {
		id: view.id,
		title: view.displayName || conversation?.title || view.id,
		...(view.projectId && { projectId: view.projectId }),
		...(view.harness && { harness: view.harness }),
		...(model && { model }),
		mode: view.mode,
		state: agentState(view, conversation, planned),
		status: view.status,
		...(view.branch && { branch: view.branch }),
		pinned: view.isPinned,
		createdAt: ms(view.createdAt),
		updatedAt: Math.max(ms(view.updatedAt), ms(view.lastEventAt)),
		...(typeof usage?.cost === "number" && { cost: usage.cost, currency: usage.currency || "USD" }),
		changedFiles: files,
		queue: conversation ? queueOf(conversation) : { pending: 0, running: 0, done: 0, total: 0, items: [] },
		...(question && { question }),
		...(reply && { reply }),
		...(exitReason && { exitReason }),
		view,
		...(conversation && { conversation }),
	};
}

// ---- answering ----

export type AoAnswer = { kind: "approval"; decisionId: string } | { kind: "input"; body: AoResolveInputRequest } | { error: string };

const YES = /^(y|yes|allow|approve|ok|accept)$/i;
const NO = /^(n|no|deny|reject|decline)$/i;

function pick(options: readonly string[], answer: string): number | undefined {
	const n = Number(answer);
	if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
	const exact = options.findIndex(o => o === answer);
	if (exact !== -1) return exact;
	const loose = options.findIndex(o => o.toLowerCase() === answer.toLowerCase());
	return loose === -1 ? undefined : loose;
}

/** The content one field's answer contributes: its value under `key`, or free text under `otherKey` when no choice matches. */
function fieldContent(field: AoQuestionField, answer: string): { content: Record<string, unknown> } | { error: string } {
	const text = answer.trim();
	const listed = () => field.options.map((o, k) => `${k + 1}. ${o}`).join(", ");
	if (field.options.length > 0) {
		const parts = field.multi ? text.split(",").map(s => s.trim()).filter(Boolean) : [text];
		const chosen: unknown[] = [];
		const other: string[] = [];
		for (const part of parts) {
			const i = pick(field.options, part);
			if (i !== undefined) chosen.push(field.values[i]);
			else if (field.otherKey) other.push(part);
			else return { error: `${field.question}: "${part}" is not one of ${listed()}` };
		}
		const content: Record<string, unknown> = {};
		if (field.multi) content[field.key] = chosen;
		else if (chosen.length > 0) content[field.key] = chosen[0];
		if (other.length > 0 && field.otherKey) content[field.otherKey] = other.join(", ");
		return { content };
	}
	if (field.type === "boolean") return YES.test(text) ? { content: { [field.key]: true } } : NO.test(text) ? { content: { [field.key]: false } } : { error: `${field.question}: answer yes or no` };
	if (field.type === "number" || field.type === "integer") {
		const n = Number(text);
		return text !== "" && Number.isFinite(n) && (field.type === "number" || Number.isInteger(n)) ? { content: { [field.key]: n } } : { error: `${field.question}: expects a ${field.type}` };
	}
	if (field.multi) return { content: { [field.key]: text.split(",").map(s => s.trim()).filter(Boolean) } };
	return text === "" && !field.required ? { content: {} } : { content: { [field.key]: answer } };
}

/**
 * The resolve call for answering `question` with `answer`, as typed on a command line: an approval
 * takes a decision number or label (or yes/no); a question takes its text, an option number or text,
 * comma-separated options for multi-select, and one answer per field separated by `|` when it asks
 * several things. `decline` and `cancel` are separate calls (`resolveInput` with that action).
 */
export function answerFor(question: AoQuestion, answer: string): AoAnswer {
	const text = answer.trim();
	if (question.kind === "approval") {
		const decisions = question.decisions ?? [];
		if (decisions.length === 0) return { error: "This approval offers no decisions." };
		const i = pick(decisions.map(d => d.label), text) ?? pick(decisions.map(d => d.id), text);
		const kindMatch = YES.test(text) ? ["allow_once", "allow_always"] : NO.test(text) ? ["reject_once", "reject_always"] : undefined;
		const chosen = i !== undefined ? decisions[i] : kindMatch && (decisions.find(d => d.kind === kindMatch[0]) ?? decisions.find(d => d.kind === kindMatch[1]));
		if (!chosen) return { error: `Answer with one of: ${decisions.map((d, k) => `${k + 1}. ${d.label}`).join(", ")}` };
		// A permission prompt that arrived as a question is answered through the inputs route, the choice as the field's value.
		if (question.inputField) return { kind: "input", body: { action: "accept", content: { [question.inputField]: chosen.id } } };
		return { kind: "approval", decisionId: chosen.id };
	}
	if (question.url && !question.questions) return { error: `This question is answered in a browser: ${question.url}` };
	const fields = question.questions ?? [];
	if (fields.length === 0) return { kind: "input", body: { action: "accept", content: {} } };
	const parts = fields.length === 1 ? [answer] : answer.split("|");
	if (parts.length !== fields.length) return { error: `This asks ${fields.length} things; separate the answers with |: ${fields.map(f => f.question).join(" | ")}` };
	const content: Record<string, unknown> = {};
	for (const [k, field] of fields.entries()) {
		const part = fieldContent(field, parts[k]);
		if ("error" in part) return part;
		Object.assign(content, part.content);
	}
	return { kind: "input", body: { action: "accept", content } };
}

/** Answers `question` in `sessionId` (see answerFor); throws on an answer that does not fit. */
export async function answerQuestion(client: AoClient, sessionId: string, question: AoQuestion, answer: string): Promise<void> {
	const resolved = answerFor(question, answer);
	if ("error" in resolved) throw new Error(resolved.error);
	if (resolved.kind === "approval") await client.resolveApproval(sessionId, question.id, resolved.decisionId);
	else await client.resolveInput(sessionId, question.id, resolved.body);
}

// ---- live models ----

export interface AoWatcherChange {
	changed: AoSessionModel[];
	removed: string[];
}

export interface AoWatcherOptions {
	/** Which sessions to list (default: all, terminated included). */
	query?: AoListSessionsQuery;
	/** Read the conversation of chat sessions (questions, queue, reply, cost, changed files). Default true. */
	conversations?: boolean;
	/** Messages per conversation read (`limit`). Default 50. */
	conversationLimit?: number;
	/** Read each session's workspace manifest for its changed files (again only when its conversation moved). Default true. */
	changedFiles?: boolean;
	/** Coalesce a session's change events for this long before refetching it. Default 100 ms. */
	debounceMs?: number;
}

/**
 * Keeps an AoSessionModel per session current: lists them, follows the change stream (resuming after
 * the last event), refetches a session (and its conversation) when it changes, and everything after
 * every reconnect (the stream cannot say what a gap missed).
 */
export class AoSessionWatcher {
	private readonly models = new Map<string, AoSessionModel>();
	private readonly listeners = new Set<(change: AoWatcherChange) => void>();
	private readonly statusListeners = new Set<(status: AoStreamStatus) => void>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly cwds = new Map<string, string>();
	private readonly files = new Map<string, { key: string; files: AoChangedFile[] }>();
	private subscription: { close(): void } | undefined;
	private closed = false;
	private opens = 0;
	private reloading: Promise<void> | undefined;
	private reloadAgain = false;

	constructor(
		private readonly client: AoClient,
		private readonly options: AoWatcherOptions = {},
	) {}

	/** Subscribes, then loads every session; resolves once they are loaded. */
	async start(): Promise<void> {
		this.subscription = this.client.events({
			after: "latest",
			onEvent: event => {
				if (event.sessionId && (event.type === "session_created" || event.type === "session_updated")) this.schedule(event.sessionId);
			},
			onStatus: status => {
				// The first open is covered by start()'s own load; later ones may follow a gap.
				if (status.state === "open" && this.opens++ > 0) void this.reload().catch(() => undefined);
				for (const l of this.statusListeners) l(status);
			},
		});
		await this.reload();
	}

	all(): AoSessionModel[] {
		return [...this.models.values()];
	}

	get(sessionId: string): AoSessionModel | undefined {
		return this.models.get(sessionId);
	}

	onChange(listener: (change: AoWatcherChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onStatus(listener: (status: AoStreamStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	/** Refetches one session now. */
	async refresh(sessionId: string): Promise<AoSessionModel | undefined> {
		let view: AoSessionView;
		try {
			view = await this.client.getSession(sessionId);
		} catch (error) {
			if (error instanceof Error && "status" in error && error.status === 404 && this.models.delete(sessionId)) this.emit({ changed: [], removed: [sessionId] });
			throw error;
		}
		const model = await this.build(view);
		if (this.closed) return model;
		this.models.set(sessionId, model);
		this.emit({ changed: [model], removed: [] });
		return model;
	}

	/** Relists every session and refetches each. */
	reload(): Promise<void> {
		if (this.reloading) {
			this.reloadAgain = true;
			return this.reloading;
		}
		this.reloading = (async () => {
			do {
				this.reloadAgain = false;
				const { sessions } = await this.client.listSessions(this.options.query ?? {});
				const models = await mapLimit(sessions, 4, view => this.build(view));
				if (this.closed) return;
				const seen = new Set(models.map(m => m.id));
				const removed = [...this.models.keys()].filter(id => !seen.has(id));
				for (const id of removed) this.models.delete(id);
				for (const m of models) this.models.set(m.id, m);
				this.emit({ changed: models, removed });
			} while (this.reloadAgain && !this.closed);
		})().finally(() => {
			this.reloading = undefined;
		});
		return this.reloading;
	}

	close(): void {
		this.closed = true;
		this.subscription?.close();
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		this.listeners.clear();
		this.statusListeners.clear();
	}

	private schedule(sessionId: string): void {
		if (this.closed || this.timers.has(sessionId)) return;
		this.timers.set(
			sessionId,
			setTimeout(() => {
				this.timers.delete(sessionId);
				void this.refresh(sessionId).catch(() => undefined);
			}, this.options.debounceMs ?? 100),
		);
	}

	private async build(view: AoSessionView): Promise<AoSessionModel> {
		const cwd = await this.cwdOf(view.id);
		// Not ready yet (409 while the controller starts), or gone with a terminated session: the view alone.
		const conversation = this.options.conversations === false || view.mode !== "chat" ? undefined : await this.client.getConversation(view.id, { limit: this.options.conversationLimit ?? 50 }).catch(() => undefined);
		const files = this.options.changedFiles === false ? [] : await this.filesOf(view, conversation);
		const model = sessionModel(view, conversation, undefined, files);
		return cwd ? { ...model, cwd } : model;
	}

	/**
	 * Files change only while the agent works, which adds conversation items or settles turns: the
	 * manifest (a git diff on the daemon) is read again only when those moved.
	 */
	private async filesOf(view: AoSessionView, conversation: AoConversation | undefined): Promise<AoChangedFile[]> {
		const key = conversation ? `${conversation.latestSequence}|${conversation.turns.map(t => `${t.id}:${t.state}`).join(",")}` : view.updatedAt;
		const known = this.files.get(view.id);
		if (known?.key === key) return known.files;
		try {
			const files = changedFiles(await this.client.workspaceManifest(view.id));
			this.files.set(view.id, { key, files });
			return files;
		} catch {
			// No workspace any more (terminated and released), or a transient failure: keep what was known.
			return known?.files ?? [];
		}
	}

	/** A session's workspace never moves: read it once (a failed read is retried on the next build). */
	private async cwdOf(sessionId: string): Promise<string | undefined> {
		const known = this.cwds.get(sessionId);
		if (known) return known;
		const cwd = await this.client.workspacePath(sessionId).catch(() => undefined);
		if (cwd) this.cwds.set(sessionId, cwd);
		return cwd;
	}

	private emit(change: AoWatcherChange): void {
		for (const l of this.listeners) {
			try {
				l(change);
			} catch {
				// One listener's bug must not starve the others.
			}
		}
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
