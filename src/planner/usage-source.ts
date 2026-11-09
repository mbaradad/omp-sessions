// Provider usage windows as omp reports them (`omp usage --json`: every authenticated account's limit
// windows with used fraction and reset time). AO reports no usage limits for omp sessions (only
// Claude/Codex accounts), so this is the planner's usage-window source. Node-only.
import { execFile } from "node:child_process";
import type { UsageWindow } from "./types";

function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * `omp usage --json` → one window per provider limit. With several accounts on one provider omp uses
 * whichever has room, so a window's usage is the lowest across accounts (and its reset that account's).
 */
export function parseOmpUsage(raw: unknown): UsageWindow[] {
	const best = new Map<string, UsageWindow>();
	const reports = rec(raw)?.reports;
	for (const report of Array.isArray(reports) ? reports : []) {
		const r = rec(report);
		const provider = typeof r?.provider === "string" ? r.provider : undefined;
		if (!provider) continue;
		for (const limit of Array.isArray(r?.limits) ? r.limits : []) {
			const l = rec(limit);
			const amount = rec(l?.amount);
			const fraction = typeof amount?.usedFraction === "number" ? amount.usedFraction : undefined;
			if (!l || typeof l.id !== "string" || fraction === undefined || !Number.isFinite(fraction)) continue;
			// A tier-scoped window (one model family) doesn't gate the provider as a whole.
			if (rec(l.scope)?.tier !== undefined) continue;
			const resetsAt = rec(l.window)?.resetsAt;
			const window: UsageWindow = { provider, window: typeof l.label === "string" ? l.label : l.id, usedPercent: Math.round(fraction * 1000) / 10 };
			if (typeof resetsAt === "number" && resetsAt > 0) window.resetsAt = resetsAt;
			const prev = best.get(`${provider}\0${l.id}`);
			if (!prev || window.usedPercent < prev.usedPercent) best.set(`${provider}\0${l.id}`, window);
		}
	}
	return [...best.values()];
}

/** Runs `omp usage --json`; rejects when omp is missing or fails. */
export function readOmpUsage(omp = process.env.OMP_PLANNER_OMP || "omp", timeoutMs = 60_000): Promise<UsageWindow[]> {
	const { promise, resolve, reject } = Promise.withResolvers<UsageWindow[]>();
	execFile(omp, ["usage", "--json"], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
		if (err) {
			reject(err);
			return;
		}
		try {
			resolve(parseOmpUsage(JSON.parse(stdout)));
		} catch (e) {
			reject(e);
		}
	});
	return promise;
}
