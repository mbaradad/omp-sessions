// Times for plans: the start-time parser every client shares (ported from omp/requeue `when.ts`) and
// the next occurrence of a recurring rule. Pure; no Node or DOM APIs.
import type { RecurRule } from "./types";

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The forms parseStartTime reads, for prompts and error messages. */
export const START_TIME_HELP = "+30m, +2h, 14:30 (next occurrence) or an ISO time like 2025-01-31T08:00";

/**
 * "+30m" / "30m", "+2h", "+1d", "14:30" (the next occurrence, local time), or an ISO date/time
 * ("2025-01-31T08:00", "2025-01-31 08:00", with or without a zone) → epoch ms. Throws an Error
 * that says what is wrong for anything else or a time in the past.
 */
export function parseStartTime(text: string, now = Date.now()): number {
	const t = text.trim();
	const rel = /^\+?(\d+)\s*([smhd])$/i.exec(t);
	if (rel) return now + Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()];
	const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
	if (hm) {
		const hours = Number(hm[1]);
		const minutes = Number(hm[2]);
		if (hours > 23 || minutes > 59) throw new Error(`${t} is not a time of day (00:00-23:59)`);
		const d = new Date(now);
		d.setHours(hours, minutes, 0, 0);
		if (d.getTime() <= now) d.setDate(d.getDate() + 1);
		return d.getTime();
	}
	const at = /^\d{4}-\d{2}-\d{2}/.test(t) ? Date.parse(t) : Number.NaN;
	if (!Number.isFinite(at)) throw new Error(`can't read "${t}" as a time: use ${START_TIME_HELP}`);
	if (at <= now) throw new Error(`${t} is in the past`);
	return at;
}

/** Shortest interval a recurring rule may use. */
export const MIN_EVERY_MINUTES = 5;

/** A rule as clients may send it → a valid rule, or an error message. */
export function normalizeRule(raw: unknown): RecurRule | string {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "a recurring rule needs `every` (minutes) or `at` (HH:MM times)";
	const r = raw as Record<string, unknown>;
	const out: RecurRule = {};
	if (r.every !== undefined) {
		if (typeof r.every !== "number" || !Number.isFinite(r.every) || r.every < MIN_EVERY_MINUTES) return `every must be a number of minutes ≥ ${MIN_EVERY_MINUTES}`;
		out.every = Math.round(r.every);
	}
	if (r.at !== undefined) {
		const at = Array.isArray(r.at) ? r.at : [r.at];
		const times: string[] = [];
		for (const v of at) {
			const m = typeof v === "string" ? /^(\d{1,2}):(\d{2})$/.exec(v.trim()) : null;
			if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return `"${String(v)}" is not a time of day (HH:MM)`;
			const hhmm = `${m[1].padStart(2, "0")}:${m[2]}`;
			if (!times.includes(hhmm)) times.push(hhmm);
		}
		if (times.length) out.at = times.sort();
	}
	if (r.days !== undefined) {
		if (!Array.isArray(r.days) || r.days.some(d => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) return "days must be weekday numbers 0 (Sunday) to 6";
		const days = [...new Set(r.days as number[])].sort();
		if (days.length && days.length < 7) out.days = days;
	}
	if (out.every !== undefined && out.at) return "give either every or at, not both";
	if (out.every === undefined && !out.at) return "a recurring rule needs `every` (minutes) or `at` (HH:MM times)";
	if (out.days && !out.at) return "days go with at";
	return out;
}

/**
 * The first occurrence of `rule` strictly after `after` (epoch ms, local time for `at`). `every`
 * counts from `anchor` (the schedule's creation), so occurrences don't drift with late ticks.
 */
export function nextOccurrence(rule: RecurRule, after: number, anchor = after): number {
	if (rule.every) {
		const step = rule.every * 60_000;
		if (anchor > after) return anchor;
		return anchor + (Math.floor((after - anchor) / step) + 1) * step;
	}
	const times = (rule.at ?? []).map(t => t.split(":").map(Number) as [number, number]);
	// Days ahead: today plus a week covers every weekday filter.
	for (let day = 0; day <= 8; day++) {
		const d = new Date(after);
		d.setDate(d.getDate() + day);
		if (rule.days && !rule.days.includes(d.getDay())) continue;
		for (const [h, m] of times) {
			d.setHours(h, m, 0, 0);
			if (d.getTime() > after) return d.getTime();
		}
	}
	// Unreachable with a valid rule; a day later keeps a broken one from spinning.
	return after + 86_400_000;
}
