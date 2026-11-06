// Reading omp transcripts (`~/.omp/agent/sessions/<project>/<stamp>_<id>.jsonl`) without loading them
// whole: usage records for the dashboard and user/assistant text for history search. Pure Node (no
// `vscode`), so it is unit-testable.
//
// Transcript facts (omp 18.x): line 1 is a `title` record rewritten in place (padded to keep its size),
// line 2 the `session` header (`cwd`, `id`, `parentSession` for subagents). Model calls are
// `{type:"message", message:{role:"assistant", provider, model, usage:{totalTokens, cost:{total}}, timestamp}}`
// plus `{type:"model_usage", provider, model, usage, timestamp}` for side calls (titles, widgets).
// Subagent transcripts live in `<transcript without .jsonl>/<Agent>.jsonl` (possibly nested deeper).
// Apart from the title line, transcripts are append-only, so caches parse only the new tail.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Root of omp's own session transcripts. */
export function ompSessionsRoot(): string {
	return path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), "sessions");
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function parseJson(line: string): Record<string, unknown> | undefined {
	try {
		const o: unknown = JSON.parse(line);
		return isRecord(o) ? o : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------- usage

/** One billed model call. */
export interface UsageRecord {
	/** Epoch ms of the call. */
	ts: number;
	/** `provider/model`. */
	model: string;
	/** USD. */
	cost: number;
	tokens: number;
}

/** Usage of one transcript line, or undefined for anything that is not a billed model call. */
export function parseUsageLine(line: string): UsageRecord | undefined {
	if (!line.includes('"usage"')) return undefined;
	const o = parseJson(line);
	if (!o) return undefined;
	let src: Record<string, unknown> | undefined;
	if (o.type === "message" && isRecord(o.message) && o.message.role === "assistant") src = o.message;
	else if (o.type === "model_usage") src = o;
	if (!src || !isRecord(src.usage)) return undefined;
	const u = src.usage;
	const cost = isRecord(u.cost) ? num(u.cost.total) : 0;
	const tokens = num(u.totalTokens) || num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
	if (cost <= 0 && tokens <= 0) return undefined;
	const ts = typeof src.timestamp === "number" ? src.timestamp : Date.parse(str(src.timestamp) || str(o.timestamp));
	if (!Number.isFinite(ts)) return undefined;
	const model = str(src.model);
	const provider = str(src.provider);
	return { ts, model: !model ? "unknown" : provider && !model.includes("/") ? `${provider}/${model}` : model, cost, tokens };
}

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
	const o = parseJson(line);
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
	const ts = typeof m.timestamp === "number" ? m.timestamp : Date.parse(str(o.timestamp));
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

// ---------------------------------------------------------------- transcript files

export interface TranscriptHead {
	title: string;
	cwd: string;
	/** omp session id. */
	id: string;
	/** Set on subagent transcripts. */
	parentSession: string;
}

/** Title/session records from the first lines of a transcript. */
export function parseHead(text: string): TranscriptHead {
	const head: TranscriptHead = { title: "", cwd: "", id: "", parentSession: "" };
	for (const line of text.split("\n").slice(0, 4)) {
		const o = parseJson(line);
		if (o?.type === "title" && typeof o.title === "string") head.title = o.title;
		else if (o?.type === "session") {
			head.cwd = str(o.cwd);
			head.id = str(o.id);
			head.parentSession = str(o.parentSession);
			if (!head.title) head.title = str(o.title);
		}
	}
	return head;
}

/** Head of a transcript file (8 KiB read); undefined when unreadable. */
export function readTranscriptHead(file: string): TranscriptHead | undefined {
	try {
		return parseHead(readHead(file, 8192));
	} catch {
		return undefined;
	}
}

function readHead(file: string, bytes: number): string {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const n = fs.readSync(fd, buf, 0, bytes, 0);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/** Lines longer than this are skipped (huge tool results; never usage or chat text worth indexing). */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

/**
 * Streams complete lines of `file` from byte `start`; returns the offset just past the last complete
 * line, so a later call continues where this one stopped (a torn last line is re-read then).
 */
export async function scanLines(file: string, start: number, onLine: (line: string) => void): Promise<number> {
	const fh = await fs.promises.open(file, "r");
	try {
		const buf = Buffer.alloc(CHUNK_BYTES);
		let pos = start;
		let lineStart = start;
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		let skipping = false;
		for (;;) {
			const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, pos);
			if (bytesRead === 0) break;
			let from = 0;
			for (;;) {
				const nl = buf.indexOf(10, from);
				if (nl < 0 || nl >= bytesRead) break;
				if (!skipping) {
					const piece = buf.subarray(from, nl);
					const line = pending.length ? Buffer.concat([...pending, piece]).toString("utf8") : piece.toString("utf8");
					if (line) onLine(line);
				}
				pending = [];
				pendingBytes = 0;
				skipping = false;
				from = nl + 1;
				lineStart = pos + from;
			}
			if (from < bytesRead && !skipping) {
				pendingBytes += bytesRead - from;
				if (pendingBytes > MAX_LINE_BYTES) {
					skipping = true;
					pending = [];
				} else pending.push(Buffer.from(buf.subarray(from, bytesRead)));
			}
			pos += bytesRead;
		}
		return lineStart;
	} finally {
		await fh.close();
	}
}

export interface CachedTranscript<T> {
	file: string;
	head: TranscriptHead;
	size: number;
	mtimeMs: number;
	data: T;
}

interface Entry<T> extends CachedTranscript<T> {
	offset: number;
}

/**
 * Per-file parse cache: unchanged files (size + mtime) cost one stat; grown files parse only the
 * appended lines; shrunk files are parsed again from scratch.
 */
export class TranscriptCache<T> {
	private readonly entries = new Map<string, Entry<T>>();
	private readonly inFlight = new Map<string, Promise<CachedTranscript<T> | undefined>>();

	constructor(
		private readonly init: () => T,
		private readonly onLine: (data: T, line: string) => void,
	) {}

	get(file: string): Promise<CachedTranscript<T> | undefined> {
		let p = this.inFlight.get(file);
		if (!p) {
			p = this.load(file).finally(() => this.inFlight.delete(file));
			this.inFlight.set(file, p);
		}
		return p;
	}

	/** Last parsed state without touching the disk. */
	peek(file: string): CachedTranscript<T> | undefined {
		return this.entries.get(file);
	}

	private async load(file: string): Promise<CachedTranscript<T> | undefined> {
		let st: fs.Stats;
		try {
			st = await fs.promises.stat(file);
		} catch {
			this.entries.delete(file);
			return undefined;
		}
		let e = this.entries.get(file);
		if (e && e.size === st.size && e.mtimeMs === st.mtimeMs) return e;
		try {
			const head = parseHead(readHead(file, 8192));
			if (!e || st.size < e.offset) e = { file, head, size: 0, mtimeMs: 0, offset: 0, data: this.init() };
			const entry = e;
			entry.offset = await scanLines(file, entry.offset, line => this.onLine(entry.data, line));
			entry.head = head;
			entry.size = st.size;
			entry.mtimeMs = st.mtimeMs;
			this.entries.set(file, entry);
			return entry;
		} catch {
			return e;
		}
	}
}

/** Top-level transcripts (not subagents) under omp's sessions root, newest first. */
export async function listTranscripts(root = ompSessionsRoot()): Promise<Array<{ file: string; mtimeMs: number }>> {
	const out: Array<{ file: string; mtimeMs: number }> = [];
	let dirs: string[];
	try {
		dirs = await fs.promises.readdir(root);
	} catch {
		return out;
	}
	for (const d of dirs) {
		let names: string[];
		try {
			names = await fs.promises.readdir(path.join(root, d));
		} catch {
			continue;
		}
		for (const n of names) {
			if (!n.endsWith(".jsonl")) continue;
			const file = path.join(root, d, n);
			try {
				const st = await fs.promises.stat(file);
				if (st.isFile()) out.push({ file, mtimeMs: st.mtimeMs });
			} catch {
				/* vanished */
			}
		}
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Subagent transcripts of `file`: every `.jsonl` below `<file without .jsonl>/`, a few levels deep. */
export async function listSubagentTranscripts(file: string, maxDepth = 4): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
			else if (e.isDirectory() && depth < maxDepth) await walk(full, depth + 1);
		}
	};
	if (file.endsWith(".jsonl")) await walk(file.slice(0, -".jsonl".length), 1);
	return out;
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
