// What other agents and scripts see of a session (`omp-sessions show|wait --json`, the omp-sessions
// skill): one settled-or-not state, the pending question with its choices, and the full last reply.
import { isRecord } from "./bridge";
import type { PermissionMode } from "./permissions";
import { DIALOG_METHODS, type SessionMeta, type UiRequest } from "./protocol";
import type { SessionInfo } from "./server-protocol";

/**
 * `queued`: stopped (or waiting for a concurrency slot) with work the server will start.
 * `working`: a turn runs, or queued tasks continue on their own. `needs_input`: a question or
 * approval waits for an answer. `idle`: done for now. `stopped`: no omp process and no queued work.
 */
export type AgentState = "queued" | "starting" | "working" | "needs_input" | "idle" | "stopped";

/** States in which nothing happens until someone acts: what `omp-sessions wait` waits for. */
export const SETTLED_STATES: Readonly<Record<AgentState, boolean>> = { queued: false, starting: false, working: false, needs_input: true, idle: true, stopped: true };

export interface SessionQuestion {
	id: string;
	/** omp's dialog kind: select, confirm, input, editor, ask. */
	kind: string;
	title: string;
	message?: string;
	/** select: the options; ask: one entry per question with its options. */
	options?: string[];
	questions?: Array<{ question: string; options: string[]; multi: boolean }>;
}

export interface SessionReport {
	id: string;
	title: string;
	cwd: string;
	state: AgentState;
	status: SessionMeta["status"];
	mode?: PermissionMode;
	model?: string;
	cost?: number;
	changedFiles: number;
	queue: SessionInfo["queue"];
	/** The first dialog waiting for an answer (`omp-sessions answer` replies to it). */
	question?: SessionQuestion;
	/** The last assistant text in full (clipped at REPLY_MAX characters). */
	reply?: string;
	exitReason?: string;
	tags: string[];
	createdAt: number;
	updatedAt: number;
}

const REPLY_MAX = 20_000;

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** Work the queue still does on its own: a running task, or pending ones with auto-run on. */
function queueBusy(q: SessionInfo["queue"]): boolean {
	return q.running > 0 || (q.autoRun && q.pending > 0);
}

export function agentState(info: Pick<SessionInfo, "meta" | "queue" | "waiting">): AgentState {
	const { meta, queue, waiting } = info;
	if (meta.status === "waiting") return "needs_input";
	if (meta.status === "starting") return "starting";
	if (meta.status === "working") return "working";
	if (waiting) return "queued";
	if (meta.status === "stopped") return queue.pending > 0 && (queue.autoRun || queue.startAt !== undefined) ? "queued" : "stopped";
	if (queueBusy(queue)) return "working";
	return queue.pending > 0 && queue.startAt !== undefined ? "queued" : "idle";
}

export function questionOf(req: UiRequest): SessionQuestion {
	const q: SessionQuestion = { id: req.id, kind: req.method, title: str(req.title) || req.method };
	if (str(req.message)) q.message = str(req.message);
	if (Array.isArray(req.options)) q.options = req.options.map(String);
	if (Array.isArray(req.questions)) {
		q.questions = req.questions.filter(isRecord).map(x => ({
			question: str(x.question),
			options: (Array.isArray(x.options) ? x.options : []).map(o => (isRecord(o) ? str(o.label) : String(o))),
			multi: x.multi === true,
		}));
	}
	return q;
}

/** The first pending dialog (approvals, questions); notifications and status lines are not. */
export function firstQuestion(pending: readonly UiRequest[]): SessionQuestion | undefined {
	const req = pending.find(r => DIALOG_METHODS[r.method]);
	return req ? questionOf(req) : undefined;
}

/** Text of an assistant message, or "" for anything else. */
function assistantText(message: unknown): string {
	const m = isRecord(message) && isRecord(message.message) ? message.message : message;
	if (!isRecord(m) || m.role !== "assistant") return "";
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content
		.filter(isRecord)
		.filter(b => b.type === "text")
		.map(b => str(b.text))
		.join("\n")
		.trim();
}

/** The newest assistant text in a transcript (snapshot messages or omp's session file entries). */
export function lastReply(messages: readonly unknown[], max = REPLY_MAX): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = assistantText(messages[i]);
		if (text) return text.length > max ? `${text.slice(0, max)}\n… (clipped)` : text;
	}
	return undefined;
}

export function sessionReport(info: SessionInfo, extra: { messages: readonly unknown[]; pendingUi: readonly UiRequest[]; tags: readonly string[] }): SessionReport {
	const { meta } = info;
	const report: SessionReport = {
		id: meta.id,
		title: meta.title,
		cwd: meta.cwd,
		state: agentState(info),
		status: meta.status,
		changedFiles: meta.changedFiles,
		queue: info.queue,
		tags: [...extra.tags],
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
	};
	if (meta.permissionMode) report.mode = meta.permissionMode;
	if (meta.model) report.model = meta.model;
	if (meta.cost) report.cost = meta.cost;
	const question = meta.status === "waiting" ? firstQuestion(extra.pendingUi) : undefined;
	if (question) report.question = question;
	const reply = lastReply(extra.messages);
	if (reply) report.reply = reply;
	if (meta.exitReason && meta.status === "stopped") report.exitReason = meta.exitReason;
	return report;
}

/**
 * The `ui_response` for answering `req` with `answer`, as typed on a command line: select takes an
 * option number or text, confirm yes/no, input/editor the text, ask one answer per question
 * separated by `|` (option numbers, comma-separated for multi-select, or free text).
 */
export function dialogAnswer(req: UiRequest, answer: string): { res: Record<string, unknown> } | { error: string } {
	const text = answer.trim();
	switch (req.method) {
		case "select": {
			const options = Array.isArray(req.options) ? req.options.map(String) : [];
			const n = Number(text);
			const value = Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : options.find(o => o.toLowerCase() === text.toLowerCase());
			if (!value) return { error: `pick one of: ${options.map((o, i) => `${i + 1}. ${o}`).join(", ")}` };
			return { res: { value } };
		}
		case "confirm":
			if (/^y(es)?$/i.test(text)) return { res: { confirmed: true } };
			if (/^no?$/i.test(text)) return { res: { confirmed: false } };
			return { error: "answer yes or no" };
		case "input":
		case "editor":
			return { res: { value: text || str(req.prefill) } };
		case "ask": {
			const questions = (Array.isArray(req.questions) ? req.questions : []).filter(isRecord);
			const parts = text.split("|").map(s => s.trim());
			if (parts.length !== questions.length) return { error: `give ${questions.length} answer(s) separated by |` };
			const answers = questions.map((q, i) => {
				const options = (Array.isArray(q.options) ? q.options : []).map(o => (isRecord(o) ? str(o.label) : String(o)));
				const picks = parts[i].split(",").map(s => Number(s.trim()));
				const out: Record<string, unknown> = { id: str(q.id), selectedOptions: [] };
				if (parts[i] && picks.every(n => Number.isInteger(n) && n >= 1 && n <= options.length)) out.selectedOptions = [...new Set(picks.map(n => options[n - 1]))];
				else if (parts[i]) out.customInput = parts[i];
				return out;
			});
			return { res: { answers } };
		}
		default:
			return { error: `"${req.method}" dialogs can only be answered in VS Code or omp-sessions attach` };
	}
}
