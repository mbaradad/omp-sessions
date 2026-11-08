// Text and usage views over omp transcripts: user/assistant text for history search and the
// dashboard's usage aggregation. Reading the files (live or archived) is in
// src/shared/transcript-files.ts, usage records in src/shared/cost.ts. Pure Node (no `vscode`), so
// it is unit-testable.

import type { UsageRecord } from "../shared/cost";
import { isRecord, parseTranscriptLine } from "../shared/transcript-files";

// ---------------------------------------------------------------- text (history search)

export interface MessageText {
	role: "user" | "assistant";
	ts: number;
	/** Text blocks joined, whitespace collapsed, capped. */
	text: string;
}

const MAX_MESSAGE_CHARS = 20_000;

/** User/assistant text of one transcript line (thinking, tool calls and tool results are skipped). */
export function parseTextLine(line: string): MessageText | undefined {
	if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) return undefined;
	const o = parseTranscriptLine(line);
	if (!o || o.type !== "message" || !isRecord(o.message)) return undefined;
	const m = o.message;
	if (m.role !== "user" && m.role !== "assistant") return undefined;
	let raw = "";
	if (typeof m.content === "string") raw = m.content;
	else if (Array.isArray(m.content)) {
		const parts: string[] = [];
		for (const b of m.content) if (isRecord(b) && b.type === "text" && typeof b.text === "string") parts.push(b.text);
		raw = parts.join("\n");
	}
	const text = collapse(raw).slice(0, MAX_MESSAGE_CHARS);
	if (!text) return undefined;
	const ts = typeof m.timestamp === "number" ? m.timestamp : Date.parse(typeof o.timestamp === "string" ? o.timestamp : "");
	return { role: m.role, ts: Number.isFinite(ts) ? ts : 0, text };
}

function collapse(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** Lowercased search terms; `"quoted phrases"` stay one term. */
export function parseQuery(query: string): string[] {
	const terms: string[] = [];
	for (const m of query.toLowerCase().matchAll(/"([^"]*)"|(\S+)/g)) {
		const t = collapse(m[1] ?? m[2] ?? "");
		if (t && !terms.includes(t)) terms.push(t);
	}
	return terms;
}

/** Where the earliest term occurs when every term occurs in `text` (case-insensitive), else undefined. */
export function matchTerms(text: string, terms: string[]): { index: number; length: number } | undefined {
	if (terms.length === 0) return undefined;
	const lower = text.toLowerCase();
	let best: { index: number; length: number } | undefined;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i < 0) return undefined;
		if (!best || i < best.index) best = { index: i, length: t.length };
	}
	return best;
}

/** About `width` chars of `text` around a match, cut at word boundaries, with ellipses where cut. */
export function buildSnippet(text: string, index: number, length: number, width = 100): string {
	const flat = collapse(text);
	if (flat.length <= width) return flat;
	const at = Math.min(Math.max(0, index), flat.length);
	const lead = Math.max(0, Math.floor((width - length) / 3));
	let start = Math.max(0, at - lead);
	let end = Math.min(flat.length, start + width);
	start = Math.max(0, end - width);
	if (start > 0) {
		const sp = flat.indexOf(" ", start);
		if (sp >= 0 && sp < at && sp - start <= 15) start = sp + 1;
	}
	if (end < flat.length) {
		const sp = flat.lastIndexOf(" ", end);
		if (sp > at + length && end - sp <= 15) end = sp;
	}
	return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

export interface TranscriptHit {
	/** Matching messages. */
	count: number;
	/** The newest matching message. */
	message: MessageText;
	snippet: string;
}

/** Search one transcript's messages; the snippet comes from the newest match. */
export function searchMessages(messages: readonly MessageText[], terms: string[], width = 100): TranscriptHit | undefined {
	let hit: TranscriptHit | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = matchTerms(messages[i].text, terms);
		if (!m) continue;
		if (hit) hit.count++;
		else hit = { count: 1, message: messages[i], snippet: buildSnippet(messages[i].text, m.index, m.length, width) };
	}
	return hit;
}

// ---------------------------------------------------------------- aggregation

export interface Totals {
	cost: number;
	tokens: number;
	/** Model calls. */
	turns: number;
}

const zero = (): Totals => ({ cost: 0, tokens: 0, turns: 0 });

function add(t: Totals, r: UsageRecord): void {
	t.cost += r.cost;
	t.tokens += r.tokens;
	t.turns++;
}

/** Local calendar day `YYYY-MM-DD`. */
export function dayKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local midnight `daysBack` days before the day of `now` (DST-safe). */
export function startOfDay(now: number, daysBack = 0): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - daysBack);
	return d.getTime();
}

export interface UsageSource {
	project: string;
	records: readonly UsageRecord[];
}

export interface SessionSummary<S> {
	source: S;
	total: Totals;
	today: Totals;
	/** Newest call (epoch ms); 0 without calls. */
	last: number;
	models: string[];
}

export interface Summary<S> {
	/** today, last 7 days, last 30 days (calendar days incl. today), all time. */
	periods: { today: Totals; week: Totals; month: Totals; all: Totals };
	/** One entry per local day, oldest first, ending today (zeros included). */
	days: Array<{ day: string } & Totals>;
	models: Array<{ model: string } & Totals>;
	projects: Array<{ project: string; sessions: number } & Totals>;
	sessions: Array<SessionSummary<S>>;
}

export function summarize<S extends UsageSource>(sources: readonly S[], now = Date.now(), chartDays = 30): Summary<S> {
	const today = startOfDay(now);
	const week = startOfDay(now, 6);
	const month = startOfDay(now, 29);
	const periods = { today: zero(), week: zero(), month: zero(), all: zero() };
	const days = new Map<string, Totals>();
	for (let i = chartDays - 1; i >= 0; i--) days.set(dayKey(startOfDay(now, i)), zero());
	const models = new Map<string, Totals>();
	const projects = new Map<string, Totals & { sessions: number }>();
	const sessions: Array<SessionSummary<S>> = [];
	for (const source of sources) {
		const s: SessionSummary<S> = { source, total: zero(), today: zero(), last: 0, models: [] };
		const used = new Set<string>();
		for (const r of source.records) {
			add(s.total, r);
			add(periods.all, r);
			if (r.ts >= month) add(periods.month, r);
			if (r.ts >= week) add(periods.week, r);
			if (r.ts >= today) {
				add(periods.today, r);
				add(s.today, r);
			}
			const day = days.get(dayKey(r.ts));
			if (day) add(day, r);
			let m = models.get(r.model);
			if (!m) models.set(r.model, (m = zero()));
			add(m, r);
			used.add(r.model);
			if (r.ts > s.last) s.last = r.ts;
		}
		s.models = [...used].sort();
		let p = projects.get(source.project);
		if (!p) projects.set(source.project, (p = { ...zero(), sessions: 0 }));
		p.cost += s.total.cost;
		p.tokens += s.total.tokens;
		p.turns += s.total.turns;
		p.sessions++;
		sessions.push(s);
	}
	const byCost = (a: Totals, b: Totals) => b.cost - a.cost || b.tokens - a.tokens;
	return {
		periods,
		days: [...days].map(([day, t]) => ({ day, ...t })),
		models: [...models].map(([model, t]) => ({ model, ...t })).sort(byCost),
		projects: [...projects].map(([project, t]) => ({ project, ...t })).sort(byCost),
		sessions: sessions.sort((a, b) => b.last - a.last),
	};
}

/** `$1.23`, `<$0.01`, `$0.00`. */
export function formatCost(usd: number): string {
	if (usd > 0 && usd < 0.01) return "<$0.01";
	return `$${usd.toFixed(2)}`;
}

/** `950`, `12.3k`, `4.5M`, `1.2B`. */
export function formatTokens(n: number): string {
	if (n < 1000) return String(Math.round(n));
	if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
	if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
	return `${(n / 1e9).toFixed(1)}B`;
}
