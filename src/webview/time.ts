// Message times: hover titles and day separators ("Today", "Yesterday", …). No DOM.

/** Milliseconds from a message `timestamp` (number ms or ISO string); undefined when absent. */
export function messageTime(v: unknown): number | undefined {
	const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : Number.NaN;
	return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Local calendar day, e.g. `2026-11-06`; separators are inserted where it changes. */
export function dayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Today", "Yesterday", a weekday within the last week, else a date (with year when not this year). */
export function dayLabel(ms: number, now: number = Date.now()): string {
	const day = new Date(ms);
	day.setHours(0, 0, 0, 0);
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	// Calendar days apart; rounding absorbs DST shifts.
	const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
	if (diff === 0) return "Today";
	if (diff === 1) return "Yesterday";
	if (diff > 1 && diff < 7) return day.toLocaleDateString(undefined, { weekday: "long" });
	const sameYear = day.getFullYear() === today.getFullYear();
	return day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}
