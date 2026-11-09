// Usage gating for the planner (auto-scheduling): provider rate/usage-limit holds learned from failed
// turns, AO-reported usage windows, and the spend budget of planner-dispatched work. The limit-error
// parsing is ported from omp/autosched `src/shared/limits.ts`; state lives in PlanState (plan.json),
// so this module is pure.
import type { BudgetCaps, BudgetWindow, ProviderLimit, SpendUse, UsageConfig, UsageWindow } from "./types";

/** What a failed turn reports. */
export interface TurnError {
	message: string;
	httpStatus?: number;
	provider?: string;
	model?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Backoff when the error gives no reset time: 5 min, doubling per limit error in a row, at most 2 h. */
export const LIMIT_BACKOFF_BASE_MS = 5 * MINUTE;
const LIMIT_BACKOFF_MAX_MS = 2 * HOUR;
/** A stated reset further out than this is not trusted (garbled parse): the backoff applies instead. */
const MAX_RESET_MS = 8 * 24 * HOUR;
/** Expired limits are kept this long so a new error right after a reset backs off further. */
const KEEP_EXPIRED_MS = 6 * HOUR;

const LIMIT_RE =
	/\b(?:rate[ _-]?limit(?:s|ed|ing)?|usage[ _-]?limits?|too[ _-]many[ _-]requests|quota[ _]exceeded|exceeded (?:your |the )?(?:current )?quota|resource[_ ]exhausted|limit (?:reached|exceeded)|usage_limit_reached|rate_limit_error|throttl(?:ed|ing))\b/i;
/** Out of money rather than out of a window: no reset will fix it (unless the error names one). */
const BILLING_RE = /\b(?:insufficient_quota|credit balance|billing|out of budget|payment required|add (?:more )?credits)\b/i;

const UNIT_MS: Array<[RegExp, number]> = [
	[/^ms$/, 1],
	[/^(?:s|sec|secs|seconds?)$/, 1000],
	[/^(?:m|min|mins|minutes?)$/, MINUTE],
	[/^(?:h|hr|hrs|hours?)$/, HOUR],
	[/^(?:d|days?)$/, 24 * HOUR],
];

/** "1h 30m", "4 hours 30 minutes", "1.5s", "120 min", "2h3m4s" → ms. */
function durationMs(text: string): number | undefined {
	let total = 0;
	let any = false;
	for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d)(?![a-z])/gi)) {
		const unit = m[2].toLowerCase();
		const ms = UNIT_MS.find(([re]) => re.test(unit))?.[1];
		if (ms === undefined) continue;
		total += Number(m[1]) * ms;
		any = true;
	}
	return any ? total : undefined;
}

/** Wall-clock time of day in `timeZone` (default local) for `now`, as minutes since midnight. */
function minutesOfDay(now: number, timeZone?: string): number {
	if (!timeZone) {
		const d = new Date(now);
		return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
	}
	const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(now));
	const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
	return (get("hour") % 24) * 60 + get("minute") + get("second") / 60;
}

function validZone(zone: string | undefined): string | undefined {
	if (!zone) return undefined;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return zone;
	} catch {
		return undefined;
	}
}

/** Next occurrence of `hour:minute` (in `timeZone`, default local) after `now`. */
function nextClock(now: number, hour: number, minute: number, timeZone?: string): number {
	const delta = (((hour * 60 + minute - minutesOfDay(now, timeZone)) % 1440) + 1440) % 1440;
	return now + Math.round(delta * MINUTE);
}

/**
 * When the limit in a provider's error text resets, as epoch ms; undefined when it doesn't say.
 * Shapes: `…limit reached|1760000000` (epoch s), `resets_at: 1760000000`, `reset at 2026-11-09 14:05:00`
 * (ISO, local without a zone), `resets 3pm (Europe/Madrid)`, `reset at 14:05`, `try again in ~120 min`,
 * `Please try again in 4.8s`, `retry in 34s`, `"retryDelay": "34s"`, `resets in 3 hr 20 min`,
 * `reset after 1h2m3s`, `retry-after: 30`.
 */
export function parseResetAt(message: string, now = Date.now()): number | undefined {
	const text = message.replace(/\s+/g, " ");
	// Epoch seconds/ms: Claude Code's "Claude AI usage limit reached|1760000000", JSON reset fields.
	const epoch = /\|\s*(\d{10}(?:\d{3})?)\b/.exec(text) ?? /reset(?:s|_at|sAt|At|sAtSec|_at_sec)?["']?\s*[:=]\s*["']?(\d{10}(?:\d{3})?)\b/i.exec(text);
	if (epoch) {
		const n = Number(epoch[1]);
		return epoch[1].length > 10 ? n : n * 1000;
	}
	const iso = /(?:reset|until|after|retry|try again|available)[^0-9]{0,40}(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
	if (iso) {
		const t = Date.parse(iso[1].replace(" ", "T"));
		if (Number.isFinite(t)) return t;
	}
	const retryDelay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)(ms|s)"/i.exec(text);
	if (retryDelay) return now + Number(retryDelay[1]) * (retryDelay[2].toLowerCase() === "ms" ? 1 : 1000);
	const retryAfter = /retry[- ]after(?:-ms)?\s*[:=]\s*(\d+(?:\.\d+)?)\b/i.exec(text);
	if (retryAfter) return now + Number(retryAfter[1]) * (/retry[- ]after-ms/i.test(retryAfter[0]) ? 1 : 1000);
	// A relative wait: "try again in …", "retry in …", "resets in …", "reset after …", "available in …".
	const rel = /(?:try again|retry|resets?|available again|wait)\s+(?:in|after)\s+(?:about\s+|~\s*)?((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
	if (rel) {
		const ms = durationMs(rel[1]);
		if (ms !== undefined) return now + ms;
	}
	// A clock time: "resets 3pm", "reset at 2:30 pm (America/New_York)", "resets at 14:05".
	const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:\s*\(([A-Za-z_]+\/[A-Za-z_/+-]+|UTC)\))?/i.exec(text);
	if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
		let hour = Number(clock[1]);
		const minute = Number(clock[2] ?? 0);
		const ampm = clock[3]?.toLowerCase();
		if (ampm === "pm" && hour < 12) hour += 12;
		if (ampm === "am" && hour === 12) hour = 0;
		if (hour < 24 && minute < 60) return nextClock(now, hour, minute, validZone(clock[4]));
	}
	return undefined;
}

/**
 * The turn failed because the provider's rate or usage limit is reached (omp gave up retrying):
 * HTTP 429 or limit wording. Billing problems (out of credits) are not limits unless the error
 * states a reset time.
 */
export function isLimitError(err: TurnError, now = Date.now()): boolean {
	const msg = err.message ?? "";
	if (err.httpStatus !== 429 && !LIMIT_RE.test(msg) && !/\b429\b/.test(msg)) return false;
	if (BILLING_RE.test(msg) && parseResetAt(msg, now) === undefined) return false;
	return true;
}

export function limitBackoffMs(failures: number, base = LIMIT_BACKOFF_BASE_MS): number {
	return Math.min(LIMIT_BACKOFF_MAX_MS, base * 2 ** Math.max(0, failures - 1));
}

/** `anthropic/claude-x` → `anthropic`. */
export function providerOf(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const i = model.indexOf("/");
	return i > 0 ? model.slice(0, i) : undefined;
}

/**
 * Records that `provider` hit its limit (mutates `limits`): until the reset the error states, else a
 * backoff that doubles while errors keep coming right after resets. Returns the limit now in force.
 */
export function recordLimit(limits: Record<string, ProviderLimit>, err: TurnError, provider: string, model: string | undefined, now = Date.now()): ProviderLimit {
	const prev = limits[provider];
	const streak = prev && now - prev.until < KEEP_EXPIRED_MS ? prev : undefined;
	const failures = (streak?.failures ?? 0) + 1;
	const stated = parseResetAt(err.message, now);
	const trusted = stated !== undefined && stated - now <= MAX_RESET_MS ? Math.max(stated, now + 1000) : undefined;
	const limit: ProviderLimit = {
		provider,
		until: trusted ?? now + limitBackoffMs(failures),
		since: streak?.since ?? now,
		failures,
		reason: err.message.replace(/\s+/g, " ").trim().slice(0, 300),
	};
	if (model) limit.model = model;
	if (trusted === undefined) limit.guessed = true;
	pruneLimits(limits, now);
	limits[provider] = limit;
	return limit;
}

/** Drops limits that ran out long ago (mutates). True when something was removed. */
export function pruneLimits(limits: Record<string, ProviderLimit>, now = Date.now()): boolean {
	let changed = false;
	for (const [k, l] of Object.entries(limits)) {
		if (now - l.until > KEEP_EXPIRED_MS) {
			delete limits[k];
			changed = true;
		}
	}
	return changed;
}

/** Limits still in force, soonest reset first. */
export function activeLimits(limits: Record<string, ProviderLimit>, now = Date.now()): ProviderLimit[] {
	return Object.values(limits)
		.filter(l => l.until > now)
		.sort((a, b) => a.until - b.until);
}

// ---------- spend budget ----------

export const BUDGET_WINDOWS: Readonly<Record<BudgetWindow, number>> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };

export function normalizeBudget(raw: unknown): BudgetCaps | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const out: BudgetCaps = {};
	for (const w of Object.keys(BUDGET_WINDOWS) as BudgetWindow[]) {
		const v = r[w];
		if (typeof v === "number" && Number.isFinite(v) && v > 0) out[w] = Math.round(v * 100) / 100;
	}
	return Object.keys(out).length ? out : undefined;
}

/** Spend entries ([epoch ms, USD]) older than a week are dropped (mutates). */
export function pruneSpend(spend: Array<[number, number]>, now = Date.now()): boolean {
	const from = now - BUDGET_WINDOWS.week;
	const keep = spend.filter(([at]) => at > from);
	if (keep.length === spend.length) return false;
	spend.splice(0, spend.length, ...keep);
	return true;
}

/** Spend per capped window at `now`; an exhausted window says when enough spend leaves it. */
export function spendUse(spend: ReadonlyArray<[number, number]>, caps: BudgetCaps | undefined, now = Date.now()): SpendUse[] {
	const out: SpendUse[] = [];
	const sorted = [...spend].sort((a, b) => a[0] - b[0]);
	for (const window of Object.keys(BUDGET_WINDOWS) as BudgetWindow[]) {
		const cap = caps?.[window];
		if (!cap) continue;
		const from = now - BUDGET_WINDOWS[window];
		const inWindow = sorted.filter(([at]) => at > from && at <= now);
		const spent = inWindow.reduce((n, [, usd]) => n + usd, 0);
		const use: SpendUse = { window, cap, spent, over: spent >= cap };
		if (use.over) {
			let left = spent;
			for (const [at, usd] of inWindow) {
				left -= usd;
				if (left < cap) {
					use.freesAt = at + BUDGET_WINDOWS[window];
					break;
				}
			}
		}
		out.push(use);
	}
	return out;
}

// ---------- holds ----------

export interface Hold {
	kind: "rate-limit" | "usage" | "budget";
	/** e.g. `rate-limit anthropic until 14:05`, `usage anthropic 5h 97%`, `budget day 20.00/20 USD`. */
	reason: string;
	until?: number;
}

export interface UsageContext {
	limits: ProviderLimit[];
	windows: UsageWindow[];
	spend: SpendUse[];
	config: UsageConfig;
}

/** `14:05` today, else `Nov 10 14:05`. */
export function clockTime(at: number, now = Date.now()): string {
	const d = new Date(at);
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toLocaleString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

function usd(n: number): string {
	return n >= 100 ? n.toFixed(0) : n.toFixed(2);
}

/**
 * What keeps a task on `provider` (undefined: unknown, only the budget and provider-less windows
 * apply) from starting now. `spare` work also waits while any of its windows is at or above
 * `spareBelowPercent`.
 */
export function holdFor(provider: string | undefined, spare: boolean, ctx: UsageContext, now = Date.now()): Hold | undefined {
	const limit = provider ? ctx.limits.find(l => l.provider === provider && l.until > now) : undefined;
	if (limit) return { kind: "rate-limit", reason: `rate-limit ${limit.provider} until ${clockTime(limit.until, now)}`, until: limit.until };
	const mine = ctx.windows.filter(w => (provider ? w.provider === provider : false) || w.provider === "*");
	const threshold = spare ? Math.min(ctx.config.spareBelowPercent, ctx.config.holdAtPercent) : ctx.config.holdAtPercent;
	const full = mine.filter(w => w.usedPercent >= threshold && !(w.resetsAt !== undefined && w.resetsAt <= now));
	if (full.length) {
		const worst = full.reduce((a, b) => ((b.resetsAt ?? Number.POSITIVE_INFINITY) > (a.resetsAt ?? Number.POSITIVE_INFINITY) ? b : a));
		const until = worst.resetsAt;
		return { kind: "usage", reason: `${spare ? "spare: " : ""}usage ${worst.provider === "*" ? "" : `${worst.provider} `}${worst.window} ${Math.round(worst.usedPercent)}%${until ? ` until ${clockTime(until, now)}` : ""}`, ...(until ? { until } : {}) };
	}
	const over = ctx.spend.filter(b => b.over);
	if (!over.length) return undefined;
	const worst = over.reduce((a, b) => ((b.freesAt ?? Number.POSITIVE_INFINITY) > (a.freesAt ?? Number.POSITIVE_INFINITY) ? b : a));
	return { kind: "budget", reason: `budget ${worst.window} ${usd(worst.spent)}/${worst.cap} USD`, ...(worst.freesAt ? { until: worst.freesAt } : {}) };
}
