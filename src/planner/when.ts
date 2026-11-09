// Times for plans: the one start-time parser every client shares (the CLI, the VS Code board and Tasks view,
// the Hermes plugin through the CLI) and the next occurrence of a recurring rule. Pure; no Node or DOM APIs.
import type { RecurRule } from "./types";

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The forms parseStartTime reads, for prompts and error messages. */
export const START_TIME_HELP = "+30m, in 2h, 14:30, 9pm, tomorrow 9:00 or an ISO time like 2025-01-31T08:00";

/**
 * Relative ("+30m", "30m", "in 2h", "1h30m", "in 90 minutes"), a time of day (the next occurrence, local
 * time: "14:30", "9pm", "9:30 am", "at 14:30"; "today 18:00" and "tomorrow 9:00" name the day), or an
 * ISO date/time ("2025-01-31T08:00", "2025-01-31 08:00", with or without a zone) → epoch ms. Throws an
 * Error that says what is wrong for anything else or a time in the past.
 */
export function parseStartTime(input: string, now = Date.now()): number {
	const t = input.trim().toLowerCase().replace(/\s+/g, " ");
	const rel = /^(?:in )?\+?((?:\d+(?:\.\d+)? ?(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?) ?)+)$/.exec(t);
	if (rel) {
		let ms = 0;
		for (const part of rel[1].matchAll(/(\d+(?:\.\d+)?) ?([a-z]+)/g)) ms += Number(part[1]) * UNIT_MS[part[2][0]];
		if (ms <= 0) throw new Error(`${input.trim()} is not a time in the future`);
		return now + ms;
	}
	const clock = /^(today |tomorrow |at )?(\d{1,2})(?::(\d{2}))? ?(am|pm)?$/.exec(t);
	// A bare number ("22", "3") is too ambiguous: it needs minutes, am/pm or a day word.
	if (clock && (clock[3] || clock[4] || clock[1])) {
		let hours = Number(clock[2]);
		const minutes = clock[3] ? Number(clock[3]) : 0;
		if (clock[4]) {
			if (hours < 1 || hours > 12) throw new Error(`${input.trim()} is not a time of day (1am-12pm)`);
			hours = (hours % 12) + (clock[4] === "pm" ? 12 : 0);
		}
		if (hours > 23 || minutes > 59) throw new Error(`${input.trim()} is not a time of day (00:00-23:59)`);
		const d = new Date(now);
		d.setHours(hours, minutes, 0, 0);
		const day = clock[1]?.trim();
		if (day === "tomorrow") d.setDate(d.getDate() + 1);
		else if (day === "today") {
			if (d.getTime() <= now) throw new Error(`${input.trim()} is in the past`);
		} else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
		return d.getTime();
	}
	const at = /^\d{4}-\d{2}-\d{2}/.test(t) ? Date.parse(input.trim()) : Number.NaN;
	if (!Number.isFinite(at)) throw new Error(`can't read "${input.trim()}" as a time: use ${START_TIME_HELP}`);
	if (at <= now) throw new Error(`${input.trim()} is in the past`);
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
