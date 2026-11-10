// What other agents and scripts see of a session (`switchyard show|wait --json`, the agent skill):
// the same shape src/shared/session-report.ts gives today, built from an AoSessionModel.
import type { PrFacts } from "../shared/pr-review";
import type { AoConfigOptions, AoTurnSettings } from "./client";
import type { AoAgentState, AoQuestion, AoSessionModel } from "./model";
import { isOmpHarness } from "./harness";
import { prFactsOf } from "./pr";

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
	/** Failed tasks: `queue requeue` brings them back. */
	failed?: number;
	waiting?: { position: number; since: number };
}

export interface AoSessionReport {
	id: string;
	title: string;
	cwd: string;
	state: AoAgentState;
	status: AoReportStatus;
	mode?: AoPermissionMode;
	/** The AO harness it runs (claude-code, codex, omp, …). */
	harness?: string;
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
	/** The AO project the session works in (absent for a standalone session). */
	project?: string;
	/** The session's own branch: its work lands there. */
	branch?: string;
	/** Pull requests the session owns: AO's facts about each (state, CI, review, mergeability). */
	prs?: PrFacts[];
}

/**
 * The permission mode of a session as omp runs it, from AO's launch setting (VALIDATION.md §3,
 * `ompacp/driver.go`): `accept-edits` and `auto` both launch `--approval-mode write` (edits go
 * through, bash asks) = `edits`; `bypass-permissions` launches `yolo` = `auto`; `default` launches no
 * flag, so omp's own `tools.approvalMode` decides (G12) and the mode is unknown (undefined).
 * Plan mode is omp's live `mode` config option, not `settings.planMode` (unset for omp): pass
 * `plan` from `planModeOf(await client.configOptions(id))`; `settings.planMode` is honoured as well.
 * Another harness (`harness` given, not omp): AO's `default` is the harness asking through AO's approvals = `ask`
 * (its own baseline: Claude Code, e.g., follows its settings.json); AO's `auto` (the harness's own auto mode, which
 * still stops risky actions) reads `edits`.
 */
export function permissionModeOf(settings: AoTurnSettings | undefined, plan = false, harness?: string): AoPermissionMode | undefined {
	if (plan || settings?.planMode) return "plan";
	switch (settings?.approvalMode) {
		case "accept-edits":
		case "auto":
			return "edits";
		case "bypass-permissions":
			return "auto";
		case "default":
			return harness && !isOmpHarness(harness) ? "ask" : undefined;
		default:
			return undefined;
	}
}

/** True when omp's live `mode` config option (`GET /conversation/config-options`) is `plan`. */
export function planModeOf(options: AoConfigOptions): boolean {
	return options.options.some(o => o.id === "mode" && o.currentValue === "plan");
}

/**
 * The AO `approvalMode` to launch a session with for a permission mode: `auto` = `bypass-permissions`,
 * `edits` = `accept-edits`, `ask` and `plan` = `default`. omp fixes it at process launch (changing it
 * on a live session needs exit-agent + resume-agent); `plan` is then switched live with
 * `setConfigOption(id, "mode", {value: "plan"})` (back: `"default"`).
 */
export function approvalModeFor(mode: AoPermissionMode): NonNullable<AoTurnSettings["approvalMode"]> {
	switch (mode) {
		case "auto":
			return "bypass-permissions";
		case "edits":
			return "accept-edits";
		default:
			return "default";
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
	// omp's dialogs have a one-line title and the rest as the message ("Allow tool: write" / "Path: …").
	const [title, ...rest] = q.title.split("\n");
	const message = rest.join("\n").trim() || q.message;
	const base = { id: q.id, title, ...(message && { message }) };
	if (q.kind === "approval") return { ...base, kind: "select", options: q.options ?? [] };
	const fields = q.questions ?? [];
	// omp's `ask` tool: `ask` whatever the number of questions (one answer per question, separated by |). Its form shape is
	// one field per question plus a `<key>__other` free-text companion; a form without that is a plain question.
	if (fields.length > 1 || fields.some(f => f.multi || f.otherKey)) return { ...base, kind: "ask", questions: fields.map(f => ({ question: f.question, options: f.options, multi: f.multi })) };
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
	/** The live permission mode, when the caller read it (`permissionModeOf(settings, planModeOf(await client.configOptions(id)))`); default: from the conversation settings alone. */
	mode?: AoPermissionMode;
	/** The number of changed files, when the caller read it elsewhere; default: the model's (the watcher fills it from the workspace manifest). */
	changedFiles?: number;
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
		changedFiles: extra.changedFiles ?? model.changedFiles.length,
		queue: extra.queue ?? { pending, running, done, total, autoRun: true },
		tags: [...(extra.tags ?? [])],
		createdAt: model.createdAt,
		updatedAt: model.updatedAt,
	};
	const mode = extra.mode ?? permissionModeOf(model.conversation?.settings, false, model.harness);
	if (model.harness) report.harness = model.harness;
	if (mode) report.mode = mode;
	if (model.model) report.model = model.model;
	if (model.cost) report.cost = model.cost;
	if (model.question && model.state === "needs_input") report.question = reportQuestion(model.question);
	if (model.reply) report.reply = model.reply;
	if (model.exitReason && status === "stopped") report.exitReason = model.exitReason;
	// Where the work lands: the session's own branch in its AO project's worktree.
	if (model.projectId) report.project = model.projectId;
	if (model.branch) report.branch = model.branch;
	// AO's pull request facts for the session (CI, review decision, mergeability), as clients show them.
	if (model.view.prs.length) report.prs = model.view.prs.map(prFactsOf);
	return report;
}
