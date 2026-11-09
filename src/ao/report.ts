// What other agents and scripts see of a session (`switchyard show|wait --json`, the agent skill):
// the same shape src/shared/session-report.ts gives today, built from an AoSessionModel.
import type { AoTurnSettings } from "./client";
import type { AoAgentState, AoQuestion, AoSessionModel } from "./model";

/** The permission modes the CLI and skill speak (src/shared/permissions.ts). */
export type AoPermissionMode = "ask" | "edits" | "plan" | "auto";

/** The old SessionMeta status, kept in reports for scripts that read it. */
export type AoReportStatus = "starting" | "idle" | "working" | "waiting" | "stopped";

/** A pending dialog as the CLI showed it: omp's dialog kinds `select`, `confirm`, `input`, `ask`. */
export interface AoReportQuestion {
	id: string;
	kind: string;
	title: string;
	message?: string;
	options?: string[];
	questions?: Array<{ question: string; options: string[]; multi: boolean }>;
}

export interface AoReportQueue {
	pending: number;
	running: number;
	done: number;
	total: number;
	autoRun: boolean;
	startAt?: number;
	interrupted?: number;
	waiting?: { position: number; since: number };
}

export interface AoSessionReport {
	id: string;
	title: string;
	cwd: string;
	state: AoAgentState;
	status: AoReportStatus;
	mode?: AoPermissionMode;
	model?: string;
	cost?: number;
	changedFiles: number;
	queue: AoReportQueue;
	question?: AoReportQuestion;
	reply?: string;
	exitReason?: string;
	tags: string[];
	createdAt: number;
	updatedAt: number;
}

/**
 * AO's approval settings as a permission mode: plan mode wins; `default` asks, `accept-edits` allows
 * edits, `auto` and `bypass-permissions` ask nothing. (Whether live switching survives is MAPPING Q4.)
 */
export function permissionModeOf(settings: AoTurnSettings | undefined): AoPermissionMode | undefined {
	if (settings?.planMode) return "plan";
	switch (settings?.approvalMode) {
		case "default":
			return "ask";
		case "accept-edits":
			return "edits";
		case "auto":
		case "bypass-permissions":
			return "auto";
		default:
			return undefined;
	}
}

const STATUS: Readonly<Record<AoAgentState, AoReportStatus>> = {
	queued: "idle",
	scheduled: "idle",
	starting: "starting",
	working: "working",
	needs_input: "waiting",
	interrupted: "stopped",
	idle: "idle",
	stopped: "stopped",
};

/**
 * The question in omp's dialog terms: an approval is a `select` among its decisions; a form with
 * several fields (omp's `ask`) is `ask`; a single field is `select` (choices), `confirm` (yes/no) or
 * `input`. Answer it with answerFor/answerQuestion on the AoQuestion.
 */
export function reportQuestion(q: AoQuestion): AoReportQuestion {
	const base = { id: q.id, title: q.title, ...(q.message && { message: q.message }) };
	if (q.kind === "approval") return { ...base, kind: "select", options: q.options ?? [] };
	const fields = q.questions ?? [];
	if (fields.length > 1 || fields.some(f => f.multi)) return { ...base, kind: "ask", questions: fields.map(f => ({ question: f.question, options: f.options, multi: f.multi })) };
	const [field] = fields;
	if (field?.options.length) return { ...base, kind: "select", options: field.options };
	if (field?.type === "boolean") return { ...base, kind: "confirm" };
	return { ...base, kind: "input" };
}

export interface AoReportExtra {
	/** Client-side tags (organize data). */
	tags?: readonly string[];
	/** The planner's lane summary, when the session has a lane; default: AO's turn queue (which runs on its own). */
	queue?: AoReportQueue;
}

export function sessionReport(model: AoSessionModel, extra: AoReportExtra = {}): AoSessionReport {
	const { pending, running, done, total } = model.queue;
	const status = STATUS[model.state];
	const report: AoSessionReport = {
		id: model.id,
		title: model.title,
		cwd: model.cwd ?? "",
		state: model.state,
		status,
		changedFiles: model.changedFiles.length,
		queue: extra.queue ?? { pending, running, done, total, autoRun: true },
		tags: [...(extra.tags ?? [])],
		createdAt: model.createdAt,
		updatedAt: model.updatedAt,
	};
	const mode = permissionModeOf(model.conversation?.settings);
	if (mode) report.mode = mode;
	if (model.model) report.model = model.model;
	if (model.cost) report.cost = model.cost;
	if (model.question && model.state === "needs_input") report.question = reportQuestion(model.question);
	if (model.reply) report.reply = model.reply;
	if (model.exitReason && status === "stopped") report.exitReason = model.exitReason;
	return report;
}
