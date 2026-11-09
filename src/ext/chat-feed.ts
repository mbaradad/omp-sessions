// AO conversation → the chat webview's transcript and live frames.
//
// The webview renders omp's own message and event shapes (user / assistant messages with text,
// thinking and toolCall blocks, toolResult messages, tool_execution_* and extension_ui_request
// frames). AO keeps a chat as rows instead: messages (user and assistant text) and activities
// (reasoning, tool calls, approvals, questions, errors, steers), each with a `revision` that grows
// while it streams. This module turns AO snapshots into those shapes: `reset` for a full history,
// `apply` for every later page, emitting frames only for rows that changed.
import type { AoActivity, AoConversation, AoMessage, AoTurn, AoUsage } from "../ao/client";
import { type AoQuestion, questionOf } from "../ao/model";
import { diffTexts } from "../shared/diff";
import type { OmpFrame, UiRequest } from "../shared/protocol";
import type { DiffsByPath, SlimState, ToWebview } from "../shared/webview";

type Row = AoMessage | AoActivity;

/** Files larger than this are not diffed line by line in the chat. */
const MAX_INLINE_DIFF_CHARS = 2 * 1024 * 1024;

const TOOL_KINDS: Readonly<Record<string, true>> = { command: true, file_change: true, mcp_tool: true };
const OPEN_TURNS: Readonly<Partial<Record<AoTurn["state"], true>>> = { queued: true, running: true };

function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ms = (iso: string | undefined | null): number | undefined => (iso ? Date.parse(iso) || undefined : undefined);

/** A tool call row. omp's `todo` (ACP kind `think`) lands in AO as `reasoning`; real reasoning carries no tool kind. */
function isTool(a: AoActivity): boolean {
	return !!TOOL_KINDS[a.activityKind] || (a.activityKind === "reasoning" && !!rec(a.detail)?.toolKind);
}

/** omp's tool name for an ACP tool activity: AO keeps only ACP's kind and omp's raw arguments. */
export function toolNameOf(a: AoActivity): string {
	const d = rec(a.detail) ?? {};
	const input = rec(d.input) ?? {};
	const has = (k: string) => input[k] !== undefined;
	switch (str(d.toolKind)) {
		case "execute":
			return has("command") ? "bash" : has("code") || has("cells") ? "eval" : "bash";
		case "read":
			return "read";
		case "edit":
			return has("content") && !has("edits") && !has("oldText") ? "write" : "edit";
		case "delete":
			return "delete";
		case "move":
			return "move";
		case "search":
			return /[*?{]/.test(str(input.pattern)) && !has("glob") ? "glob" : "grep";
		case "fetch":
			return has("query") ? "web_search" : "fetch";
		case "think":
			return "todo";
	}
	if (Array.isArray(input.questions)) return "ask";
	if (Array.isArray(input.tasks) || has("agent")) return "task";
	return a.activityKind === "command" ? "bash" : "tool";
}

/** The tool's intent line: AO's summary is omp's title, which is the intent unless omp fell back to the path/command/pattern. */
function intentOf(a: AoActivity): string | undefined {
	const d = rec(a.detail) ?? {};
	const input = rec(d.input) ?? {};
	const s = a.summary.trim();
	if (!s || s === "Agent tool" || s.startsWith("$ ")) return undefined;
	for (const k of ["path", "command", "pattern", "query", "url"]) if (str(input[k]) === s) return undefined;
	return s;
}

function textBlocks(items: unknown): Array<{ type: "text"; text: string }> {
	const out: Array<{ type: "text"; text: string }> = [];
	if (!Array.isArray(items)) return out;
	for (const it of items) {
		const r = rec(it);
		const c = rec(r?.content) ?? r;
		if (c?.type === "text" && typeof c.text === "string") out.push({ type: "text", text: c.text });
	}
	return out;
}

/** The tool's result as omp shaped it (`{content, details}`), recovered from AO's `detail.output` when it is omp's JSON, else from ACP content. */
export function toolResultOf(a: AoActivity): { content: unknown[]; details: Record<string, unknown>; isError: boolean } {
	const d = rec(a.detail) ?? {};
	const output = str(d.output);
	let content: unknown[] | undefined;
	let details: Record<string, unknown> = {};
	if (output.startsWith("{") && !d.outputTruncated) {
		try {
			const parsed = rec(JSON.parse(output));
			if (parsed && Array.isArray(parsed.content)) {
				content = parsed.content;
				details = rec(parsed.details) ?? {};
			}
		} catch {
			/* terminal output that happens to start with "{" */
		}
	}
	if (!content) {
		if (output && !output.startsWith("{")) content = [{ type: "text", text: output }];
		else {
			// ACP content repeats a command's "$ cmd" header and its output; keep each text once.
			const seen = new Set<string>(d.command ? [`$ ${str(d.command)}`] : []);
			content = textBlocks(d.content).filter(b => {
				const key = b.text.trim();
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}
	}
	if (typeof d.exitCode === "number") details = { ...details, exitCode: d.exitCode };
	return { content, details, isError: a.status === "failed" };
}

/** Per-file inline diffs of a file_change activity, from the old/new texts AO keeps. */
export function toolDiffsOf(a: AoActivity): DiffsByPath | undefined {
	const files = rec(a.detail)?.files;
	if (!Array.isArray(files)) return undefined;
	const out: DiffsByPath = {};
	for (const f of files.map(x => rec(x) ?? {})) {
		const path = str(f.path);
		if (!path || typeof f.newText !== "string") continue;
		const before = str(f.oldText);
		if (before.length + f.newText.length < MAX_INLINE_DIFF_CHARS) out[path] = diffTexts(before, f.newText);
	}
	return Object.keys(out).length ? out : undefined;
}

/** What the composer needs to answer a pending AO request through the webview's dialogs. */
export interface PendingRequest {
	question: AoQuestion;
	ui: UiRequest;
}

/** The webview dialog for an approval or question. */
export function uiRequestOf(a: AoActivity, toolName?: string): PendingRequest {
	const question = questionOf(a);
	const base = { type: "extension_ui_request" as const, id: question.id };
	if (question.kind === "approval") {
		const tool = toolName ?? toolNameOf(a);
		return { question, ui: { ...base, method: "select", title: `Allow ${tool}: ${question.title}`, options: question.options ?? [] } };
	}
	const fields = question.questions ?? [];
	const title = question.message ? `${question.title}\n${question.message}` : question.title;
	if (question.url && !fields.length) return { question, ui: { ...base, method: "select", title: `${title}\nAnswer it at ${question.url}, then choose Done.`, options: [OPEN_LINK, "Done"] } };
	if (fields.length === 1 && fields[0].type === "boolean") return { question, ui: { ...base, method: "confirm", title, message: fields[0].question } };
	if (fields.length === 1 && !fields[0].options.length && !fields[0].multi) return { question, ui: { ...base, method: "input", title: fields[0].question === title ? title : `${title}: ${fields[0].question}` } };
	// omp's `ask` puts each question's short header in the property's description.
	const props = rec(rec(question.schema)?.properties) ?? {};
	return {
		question,
		ui: {
			...base,
			method: "ask",
			title,
			questions: fields.map(f => {
				const header = str(rec(props[f.key])?.description);
				return { id: f.key, ...(header && header !== f.question && { header }), question: f.question, options: f.options.map(label => ({ label })), multi: f.multi };
			}),
		},
	};
}

/** The URL question's option that opens its page (the dialog comes back after). */
export const OPEN_LINK = "Open link";

export type AoReply = { kind: "approval"; decisionId: string } | { kind: "input"; action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/** Turns a webview dialog answer into the AO resolve call; undefined when the answer doesn't fit the request. */
export function replyFor(p: PendingRequest, res: Record<string, unknown>): AoReply | undefined {
	const q = p.question;
	if (q.kind === "approval") {
		const decisions = q.decisions ?? [];
		const chosen = res.cancelled ? decisions.find(d => d.kind === "reject_once") ?? decisions.find(d => d.kind?.startsWith("reject")) : decisions.find(d => d.label === res.value);
		return chosen ? { kind: "approval", decisionId: chosen.id } : undefined;
	}
	if (res.cancelled) return { kind: "input", action: "decline" };
	const fields = q.questions ?? [];
	if (p.ui.method === "select") return { kind: "input", action: "accept", content: {} };
	if (p.ui.method === "confirm") return { kind: "input", action: "accept", content: { [fields[0].key]: res.confirmed === true } };
	if (p.ui.method === "input") return { kind: "input", action: "accept", content: { [fields[0].key]: str(res.value) } };
	const answers = Array.isArray(res.answers) ? res.answers.map(x => rec(x) ?? {}) : [];
	const content: Record<string, unknown> = {};
	for (const f of fields) {
		const a = answers.find(x => x.id === f.key);
		const labels = Array.isArray(a?.selectedOptions) ? a.selectedOptions.map(String) : [];
		const values = labels.map(l => f.values[f.options.indexOf(l)]).filter(v => v !== undefined);
		const custom = str(a?.customInput).trim();
		if (f.multi) content[f.key] = values;
		else if (values.length) content[f.key] = values[0];
		if (custom) {
			if (f.otherKey) content[f.otherKey] = custom;
			else if (!f.options.length) content[f.key] = f.multi ? custom.split(",").map(s => s.trim()).filter(Boolean) : custom;
		}
	}
	return { kind: "input", action: "accept", content };
}

/** One rendered state of a row; a row is re-emitted when it changes. */
interface Shown {
	sig: string;
	/** Tool rows: whether the webview has seen its end. */
	ended?: boolean;
}

/** What a full history becomes in the webview: its transcript, open dialogs, inline diffs, and frames to post right after it (rows still streaming). */
export interface FeedSnapshot {
	messages: unknown[];
	pendingUi: UiRequest[];
	diffs: Record<string, DiffsByPath>;
	live: ToWebview[];
}

/**
 * Holds one session's conversation as the webview knows it. Not thread-safe; feed it pages in the
 * order they were fetched.
 */
export class ChatFeed {
	private rows = new Map<string, Row>();
	private turns = new Map<string, AoTurn>();
	private shown = new Map<string, Shown>();
	private pending = new Map<string, PendingRequest>();
	private noticedTurns = new Set<string>();
	private busy = false;
	private conv: AoConversation | undefined;

	/** Latest top-level fields (usage, controller, settings, capabilities…). */
	get conversation(): AoConversation | undefined {
		return this.conv;
	}

	/** Replaces everything with a complete history (all pages merged by the caller). */
	reset(conv: AoConversation): FeedSnapshot {
		this.rows.clear();
		this.turns.clear();
		this.shown.clear();
		this.pending.clear();
		this.noticedTurns.clear();
		this.merge(conv);
		const messages: unknown[] = [];
		const diffs: Record<string, DiffsByPath> = {};
		const live: ToWebview[] = [];
		const pendingUi: UiRequest[] = [];
		for (const row of this.ordered()) {
			if (!this.visible(row)) continue;
			for (const f of this.render(row, false)) {
				if (f.kind === "message") messages.push(f.message);
				else if (f.kind === "diffs") diffs[f.toolCallId] = f.diffs;
				else if (f.kind === "ui") pendingUi.push(f.ui);
				else live.push(f.post);
			}
		}
		for (const t of this.turns.values()) {
			const n = this.turnNotice(t);
			if (n) {
				messages.push({ role: "notice", level: n.level, message: n.text });
				this.noticedTurns.add(t.id);
			}
		}
		this.busy = this.isBusy();
		return { messages, pendingUi, diffs, live };
	}

	/** Merges a later page (a tail fetched with `afterSequence: floor()`); returns what the webview must hear. */
	apply(page: AoConversation): ToWebview[] {
		const before = new Map([...this.turns].map(([id, t]) => [id, t.state]));
		this.merge(page);
		const posts: ToWebview[] = [];
		for (const row of this.ordered()) {
			if (!this.visible(row)) continue;
			for (const f of this.render(row, true)) {
				if (f.kind === "post") posts.push(f.post);
				else if (f.kind === "message") posts.push({ type: "event", ev: { type: "message_end", message: f.message, messageId: f.id } });
				else if (f.kind === "diffs") posts.push({ type: "diffs", toolCallId: f.toolCallId, diffs: f.diffs });
				else if (f.kind === "ui") posts.push({ type: "event", ev: f.ui as unknown as OmpFrame });
			}
		}
		for (const t of this.turns.values()) {
			if (before.get(t.id) === t.state || this.noticedTurns.has(t.id)) continue;
			const n = this.turnNotice(t);
			if (n) {
				this.noticedTurns.add(t.id);
				posts.push({ type: "event", ev: { type: "notice", level: n.level, message: n.text } });
			}
		}
		const busy = this.isBusy();
		if (busy !== this.busy) posts.push({ type: "event", ev: { type: busy ? "agent_start" : "session_settled" } });
		this.busy = busy;
		return posts;
	}

	/** `afterSequence` for the next tail fetch: below every row that may still change. */
	floor(): number {
		let floor = this.conv?.latestSequence ?? 0;
		const open = new Set([...this.turns.values()].filter(t => OPEN_TURNS[t.state]).map(t => t.id));
		for (const r of this.rows.values()) {
			const unsettled =
				(r.turnId && open.has(r.turnId)) || (r.kind === "message" ? r.streaming : r.status === "running" || r.status === "pending");
			if (unsettled) floor = Math.min(floor, r.sequence - 1);
		}
		return Math.max(0, floor);
	}

	/** The request behind a dialog the webview shows. */
	request(id: string): PendingRequest | undefined {
		return this.pending.get(id);
	}

	/** Queued user messages (AO's turn queue), oldest first. */
	queued(): Array<{ turnId: string; text: string }> {
		const out: Array<{ turnId: string; text: string; seq: number }> = [];
		for (const r of this.rows.values()) {
			if (r.kind !== "message" || r.role !== "user" || !r.turnId) continue;
			if (this.turns.get(r.turnId)?.state === "queued") out.push({ turnId: r.turnId, text: r.text, seq: r.sequence });
		}
		return out.sort((a, b) => a.seq - b.seq).map(({ turnId, text }) => ({ turnId, text }));
	}

	isBusy(): boolean {
		return [...this.turns.values()].some(t => t.state === "running") || this.conv?.controller === "busy";
	}

	/** The whole transcript as omp-shaped messages (export, copy), without touching what the webview was sent. */
	transcript(): unknown[] {
		if (!this.conv) return [];
		const rows = [...this.rows.values()];
		const copy = new ChatFeed();
		return copy.reset({ ...this.conv, turns: [...this.turns.values()], messages: rows.filter(r => r.kind === "message"), activities: rows.filter(r => r.kind === "activity") }).messages;
	}

	/** Old and new texts of the files a file_change activity edited (AO drops them past its patch cap). */
	fileTexts(toolCallId: string): Array<{ path: string; oldText: string; newText: string }> {
		const r = this.rows.get(toolCallId);
		const files = r?.kind === "activity" ? rec(r.detail)?.files : undefined;
		if (!Array.isArray(files)) return [];
		return files.map(f => rec(f) ?? {}).flatMap(f => (typeof f.path === "string" && typeof f.newText === "string" ? [{ path: f.path, oldText: str(f.oldText), newText: f.newText }] : []));
	}

	/** The newest finished assistant text. */
	lastReply(): string | undefined {
		const done = [...this.rows.values()].filter((r): r is AoMessage => r.kind === "message" && r.role === "assistant" && !r.streaming && !!r.text.trim());
		return done.sort((a, b) => b.sequence - a.sequence)[0]?.text;
	}

	/** The webview state AO can fill; the caller adds model and thinking level. */
	state(): SlimState {
		const usage: AoUsage | undefined = this.conv?.usage;
		const turns = [...this.turns.values()].sort((a, b) => (ms(a.requestedAt) ?? 0) - (ms(b.requestedAt) ?? 0));
		const planned = [...turns].reverse().find(t => t.plan && !t.plan.superseded && t.plan.steps.length);
		const limited = [...turns].reverse().find(t => t.usageLimit && OPEN_TURNS[t.state]);
		const out: SlimState = {
			isStreaming: this.isBusy(),
			queuedMessages: { steering: [], followUp: this.queued().map(q => q.text) },
		};
		if (usage?.contextWindow && typeof usage.contextUsed === "number") {
			out.contextUsage = { tokens: usage.contextUsed, contextWindow: usage.contextWindow, percent: (usage.contextUsed / usage.contextWindow) * 100 };
		}
		if (typeof usage?.cost === "number") out.cost = usage.cost;
		if (planned?.plan) out.todoPhases = [{ name: "Plan", tasks: planned.plan.steps.map(s => ({ content: s.text, status: s.status })) }];
		if (limited?.usageLimit) out.usageLimit = { stage: "paused", autoResume: !!limited.usageLimit.autoResume, ...(limited.usageLimit.resetsAt && { resetsAtSec: Math.round((ms(limited.usageLimit.resetsAt) ?? 0) / 1000) }) };
		return out;
	}

	// ---------- internals ----------

	private merge(page: AoConversation): void {
		this.conv = { ...page, messages: [], activities: [], turns: [] };
		for (const t of page.turns) this.turns.set(t.id, t);
		for (const r of [...page.messages, ...page.activities]) {
			const prev = this.rows.get(r.id);
			if (!prev || prev.revision <= r.revision) this.rows.set(r.id, r);
		}
	}

	/**
	 * Rows by sequence, except that a queued prompt moves to where its turn started running: AO
	 * writes it when it is queued, but it belongs before the first reply of its own turn.
	 */
	private ordered(): Row[] {
		const rows = [...this.rows.values()].sort((a, b) => a.sequence - b.sequence);
		const firstReply = new Map<string, number>();
		for (const r of rows) if (r.turnId && !(r.kind === "message" && r.role === "user") && !firstReply.has(r.turnId)) firstReply.set(r.turnId, r.sequence);
		const key = (r: Row) => (r.kind === "message" && r.role === "user" && r.turnId && (firstReply.get(r.turnId) ?? 0) > r.sequence ? (firstReply.get(r.turnId) ?? 0) - 0.5 : r.sequence);
		return rows.sort((a, b) => key(a) - key(b));
	}

	/** A queued prompt shows as a queue chip, and one withdrawn before it ran not at all. */
	private visible(r: Row): boolean {
		if (r.kind !== "message" || r.role !== "user" || !r.turnId) return true;
		const t = this.turns.get(r.turnId);
		return !(t && (t.state === "queued" || (t.state === "cancelled" && !t.startedAt)));
	}

	private turnNotice(t: AoTurn): { level: "error" | "warning"; text: string } | undefined {
		if (t.state === "failed") return { level: "error", text: `⚠ ${t.errorMessage || "The turn failed."}` };
		// AO files turns it imports from omp's own history on a reload as recovered: nothing was lost.
		if (t.state === "recovered") return t.providerTurnId?.startsWith("acp-history-turn:") ? undefined : { level: "warning", text: t.errorMessage || "The daemon lost this turn while it ran." };
		if (t.state === "interrupted" || t.state === "cancelled") return t.hasHumanPrompt && t.startedAt ? { level: "warning", text: "Interrupted" } : undefined;
		return undefined;
	}

	private render(r: Row, live: boolean): Frame[] {
		if (r.kind === "message") return this.renderMessage(r, live);
		if (isTool(r)) return this.renderTool(r);
		const sig = `${r.revision}|${r.status}`;
		if (this.shown.get(r.id)?.sig === sig) return [];
		const first = !this.shown.has(r.id);
		this.shown.set(r.id, { sig });
		const d = rec(r.detail) ?? {};
		const ts = ms(r.createdAt);
		switch (r.activityKind) {
			case "reasoning": {
				const message = { role: "assistant", content: [{ type: "thinking", thinking: str(d.text) }], timestamp: ts };
				return r.status === "running" && live ? [{ kind: "post", post: { type: "event", ev: { type: "message_update", message, messageId: r.id } } }] : [{ kind: "message", id: r.id, message }];
			}
			case "approval":
			case "user_input": {
				if (r.status === "pending" && r.requestId) {
					const tool = this.toolFor(r);
					const p = uiRequestOf(r, tool);
					this.pending.set(p.question.id, p);
					return [{ kind: "ui", ui: p.ui }];
				}
				const id = r.requestId ?? r.id;
				if (this.pending.delete(id)) return [{ kind: "post", post: { type: "uiResolved", id } }];
				return [];
			}
			case "error":
				return first ? [{ kind: "message", id: r.id, message: { role: "notice", level: "error", message: r.summary } }] : [];
			case "system": {
				if (!first) return [];
				if (d.event === "steer") return [{ kind: "message", id: r.id, message: { role: "user", content: [{ type: "text", text: str(d.text) }], timestamp: ts, ...(str(d.origin) && d.origin !== "human" ? { attribution: "agent" } : {}) } }];
				if (d.event === "compaction") return [{ kind: "message", id: r.id, message: { role: "compactionSummary", summary: r.summary } }];
				return r.summary ? [{ kind: "message", id: r.id, message: { role: "notice", level: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info", message: r.summary } }] : [];
			}
		}
		// plan (the turn carries it: footer todos), usage, auto_review, ao_action: nothing in the transcript.
		return [];
	}

	private renderMessage(m: AoMessage, live: boolean): Frame[] {
		const sig = `${m.revision}|${m.streaming}`;
		if (this.shown.get(m.id)?.sig === sig) return [];
		this.shown.set(m.id, { sig });
		const ts = ms(m.createdAt);
		if (m.role === "user") {
			const images = (m.content ?? []).filter(c => c.type === "image").map(c => ({ type: "image", mimeType: c.mimeType }));
			const message = { role: "user", content: [{ type: "text", text: m.text }, ...images], timestamp: ts, ...(m.origin !== "human" && { attribution: "agent" }) };
			return [{ kind: "message", id: m.id, message }];
		}
		const message = { role: "assistant", content: [{ type: "text", text: m.text }], timestamp: ts };
		if (m.streaming && live) return [{ kind: "post", post: { type: "event", ev: { type: "message_update", message, messageId: m.id } } }];
		return [{ kind: "message", id: m.id, message }];
	}

	private renderTool(a: AoActivity): Frame[] {
		const sig = `${a.revision}|${a.status}`;
		const prev = this.shown.get(a.id);
		if (prev?.sig === sig) return [];
		const name = toolNameOf(a);
		const d = rec(a.detail) ?? {};
		const args = rec(d.input) ?? {};
		const intent = intentOf(a);
		const done = a.status === "completed" || a.status === "failed" || a.status === "cancelled" || a.status === "recovered" || a.status === "resolved";
		const out: Frame[] = [{ kind: "message", id: `tool:${a.id}`, message: { role: "assistant", content: [{ type: "toolCall", id: a.id, name, arguments: args, ...(intent && { intent }) }], timestamp: ms(a.createdAt) } }];
		const diffs = toolDiffsOf(a);
		if (diffs) out.push({ kind: "diffs", toolCallId: a.id, diffs });
		if (done) {
			if (!prev?.ended) {
				const r = toolResultOf(a);
				out.push({ kind: "message", id: `result:${a.id}`, message: { role: "toolResult", toolCallId: a.id, toolName: name, content: r.content, details: r.details, isError: r.isError || a.status === "cancelled" } });
			}
		} else {
			if (!prev) out.push({ kind: "post", post: { type: "event", ev: { type: "tool_execution_start", toolCallId: a.id, toolName: name, args, ...(intent && { intent }) } } });
			const text = toolResultOf(a).content;
			if (text.length) out.push({ kind: "post", post: { type: "event", ev: { type: "tool_execution_update", toolCallId: a.id, toolName: name, partialResult: { content: text } } } });
		}
		this.shown.set(a.id, { sig, ended: done });
		return out;
	}

	/** The tool an approval asks about: the pending tool row of the same turn with the same input, if AO wrote it already. */
	private toolFor(a: AoActivity): string | undefined {
		if (a.activityKind !== "approval") return undefined;
		const input = JSON.stringify(rec(a.detail)?.input ?? null);
		for (const r of this.rows.values()) {
			if (r.kind === "activity" && isTool(r) && r.turnId === a.turnId && JSON.stringify(rec(r.detail)?.input ?? null) === input) return toolNameOf(r);
		}
		return undefined;
	}
}

type Frame =
	| { kind: "message"; id: string; message: Record<string, unknown> }
	| { kind: "diffs"; toolCallId: string; diffs: DiffsByPath }
	| { kind: "ui"; ui: UiRequest }
	| { kind: "post"; post: ToWebview };
