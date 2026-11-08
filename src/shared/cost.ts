// Model usage and cost of omp sessions, read from omp's own transcripts. One aggregation for every
// client: the host computes `meta.cost` (→ `ls`, phone, Hermes cards, skill) and per-task cost with
// it, and the VS Code dashboard charts the same records. A session's cost covers the main agent,
// its subagents (nested transcripts) and `model_usage` side calls (titles, widgets), across every
// transcript the session used (a fresh-context task switches to a new file), archived ones included.
// `~/.omp/stats.db` is not used: omp fills it only when `omp stats` runs.
//
// Model calls are `{type:"message", message:{role:"assistant", provider, model, usage:{totalTokens,
// cost:{total}}, timestamp}}` plus `{type:"model_usage", provider, model, usage, timestamp}`.
// Node-only.

import { setImmediate as yieldToLoop } from "node:timers/promises";
import { locateTranscript } from "./omp-paths";
import type { SessionMeta } from "./protocol";
import { type CachedTranscript, TranscriptCache, isRecord, listSubagentTranscripts, parseTranscriptLine } from "./transcript-files";

/** Every omp transcript a session used, oldest first (earlier ones, then the current one). */
export function sessionTranscripts(meta: Pick<SessionMeta, "ompSessionFile" | "ompSessionFiles">): string[] {
	const files = [...(meta.ompSessionFiles ?? [])];
	if (meta.ompSessionFile && !files.includes(meta.ompSessionFile)) files.push(meta.ompSessionFile);
	return files;
}

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

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Usage of one transcript line, or undefined for anything that is not a billed model call. */
export function parseUsageLine(line: string): UsageRecord | undefined {
	if (!line.includes('"usage"')) return undefined;
	const o = parseTranscriptLine(line);
	if (!o) return undefined;
	let src: Record<string, unknown> | undefined;
	if (o.type === "message" && isRecord(o.message) && o.message.role === "assistant") src = o.message;
	else if (o.type === "model_usage") src = o;
	if (!src || !isRecord(src.usage)) return undefined;
	const u = src.usage;
	const cost = isRecord(u.cost) ? num(u.cost.total) : 0;
	const tokens = num(u.totalTokens) || num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
	if (cost <= 0 && tokens <= 0) return undefined;
	const stamp = typeof src.timestamp === "string" ? src.timestamp : typeof o.timestamp === "string" ? o.timestamp : "";
	const ts = typeof src.timestamp === "number" ? src.timestamp : Date.parse(stamp);
	if (!Number.isFinite(ts)) return undefined;
	const model = typeof src.model === "string" ? src.model : "";
	const provider = typeof src.provider === "string" ? src.provider : "";
	return { ts, model: !model ? "unknown" : provider && !model.includes("/") ? `${provider}/${model}` : model, cost, tokens };
}

export function totalCost(records: readonly UsageRecord[]): number {
	let sum = 0;
	for (const r of records) sum += r.cost;
	return sum;
}

/** Usage records per transcript file, parsed incrementally (see TranscriptCache). */
export class TranscriptUsage {
	private readonly cache = new TranscriptCache<UsageRecord[]>(
		() => [],
		(acc, line) => {
			const r = parseUsageLine(line);
			if (r) acc.push(r);
		},
	);

	/** Last parsed state of `file` (head included) without touching the disk. */
	peek(file: string): CachedTranscript<UsageRecord[]> | undefined {
		return this.cache.peek(file);
	}

	/**
	 * Billed calls of one session: each of `files` (its transcripts, oldest first) with its subagent
	 * transcripts; a transcript `omp gc` archived is read from the archive. Calls copied into several
	 * files (forks, moved sessions) count once.
	 */
	async records(files: readonly string[]): Promise<UsageRecord[]> {
		const out: UsageRecord[] = [];
		const seen = new Set<string>();
		const done = new Set<string>();
		for (const listed of files) {
			const main = locateTranscript(listed);
			if (!main || done.has(main)) continue;
			done.add(main);
			for (const f of [main, ...(await listSubagentTranscripts(main))]) {
				const e = await this.cache.get(f);
				for (const r of e?.data ?? []) {
					const key = `${r.ts}|${r.model}|${r.cost}|${r.tokens}`;
					if (seen.has(key)) continue;
					seen.add(key);
					out.push(r);
				}
				await yieldToLoop();
			}
		}
		return out;
	}
}
