// Autoscheduling by usage (PARKED §4) on the planner: provider limit errors as providers word them, rolling spend
// budgets, the hold reasons, omp's own usage windows, and the service holding work back and starting it again —
// against the in-memory AO. Ported from omp/autosched's test/unit/autosched.test.ts, which tested the old
// scheduler (limits.json, spend.json, Control).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Planner } from "../../src/planner/planner";
import { loadPlan } from "../../src/planner/store";
import type { UsageWindow } from "../../src/planner/types";
import { LIMIT_BACKOFF_BASE_MS, activeLimits, holdFor, isLimitError, normalizeBudget, parseResetAt, pruneSpend, recordLimit, replyIsLimitError, spendUse } from "../../src/planner/usage";
import { parseOmpUsage } from "../../src/planner/usage-source";
import { holdText } from "../../src/shared/task-text";
import { FakeAo, byTitle, tempPlan, until } from "./planner-fake-ao";

const MIN = 60_000;
const HOUR = 60 * MIN;

test("parseResetAt: reset times as providers and omp word them", () => {
	const now = Date.parse("2026-11-09T10:00:00Z");
	// Codex via omp.
	assert.equal(parseResetAt("You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.", now), now + 120 * MIN);
	// OpenAI per-minute rate limit.
	assert.equal(parseResetAt("Rate limit reached for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Used 28000, Requested 4000. Please try again in 4.8s.", now), now + 4800);
	// Gemini RESOURCE_EXHAUSTED with RetryInfo.
	const gemini = '{"error":{"code":429,"message":"You exceeded your current quota.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"34s"}]}}';
	assert.equal(parseResetAt(gemini, now), now + 34_000);
	// Claude Code's epoch-seconds suffix, and a JSON reset field.
	assert.equal(parseResetAt("Claude AI usage limit reached|1762700000", now), 1_762_700_000_000);
	assert.equal(parseResetAt('{"error":"usage_limit_reached","resets_at": 1762700000}', now), 1_762_700_000_000);
	for (const field of ["resets_at", "reset_at", "resetsAt", "resetAt", "resetsAtSec", "reset_at_sec", "resets"]) assert.equal(parseResetAt(`{"error":"usage_limit_reached","${field}": 1762700000}`, now), 1_762_700_000_000, field);
	assert.equal(parseResetAt('{"resetsAt": 1762700000000}', now), 1_762_700_000_000, "epoch ms");
	// GLM-style absolute time (no zone: local), and ISO with a zone.
	assert.equal(parseResetAt("Usage limit reached for 5 hour. Your limit will reset at 2026-11-09 13:47:12", now), Date.parse("2026-11-09T13:47:12"));
	assert.equal(parseResetAt("limit exceeded; resets at 2026-11-09T12:30:00Z", now), Date.parse("2026-11-09T12:30:00Z"));
	// Relative durations.
	assert.equal(parseResetAt("Usage limit reached. Resets in 3 hr 20 min.", now), now + 3 * HOUR + 20 * MIN);
	assert.equal(parseResetAt("Quota will reset after 1h2m3s", now), now + HOUR + 2 * MIN + 3000);
	assert.equal(parseResetAt("429 Too Many Requests (retry-after: 30)", now), now + 30_000);
	assert.equal(parseResetAt("429 rate limited. retry-after-ms=14400000", now), now + 4 * HOUR);
	// A clock time in a named zone: 3pm New York is 20:00Z in November (EST).
	assert.equal(parseResetAt("5-hour limit reached ∙ resets 3pm (America/New_York)", now), Date.parse("2026-11-09T20:00:00Z"));
	// Already past today: tomorrow.
	assert.equal(parseResetAt("Your limit will reset at 9am (UTC)", now), Date.parse("2026-11-10T09:00:00Z"));
	// Nothing stated: the caller backs off.
	assert.equal(parseResetAt('429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50,000 input tokens per minute."}}', now), undefined);
	assert.equal(parseResetAt("Too many requests", now), undefined);
});

test("isLimitError: 429s and limit wording, not overload, billing or context errors", () => {
	assert.equal(isLimitError({ message: "anything", httpStatus: 429 }), true);
	assert.equal(isLimitError({ message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}' }), true);
	assert.equal(isLimitError({ message: "Claude AI usage limit reached|1762700000" }), true);
	assert.equal(isLimitError({ message: "You have hit your ChatGPT usage limit (pro plan). Try again in ~30 min." }), true);
	assert.equal(isLimitError({ message: "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute'" }), true);
	assert.equal(isLimitError({ message: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }), false);
	assert.equal(isLimitError({ message: "prompt is too long: 210000 tokens > 200000 maximum" }), false);
	assert.equal(isLimitError({ message: "invalid x-api-key" }), false);
	// Out of credits is not a window that resets…
	assert.equal(isLimitError({ message: "You exceeded your current quota, please check your plan and billing details. (insufficient_quota)", httpStatus: 429 }), false);
	assert.equal(isLimitError({ message: "Your credit balance is too low to access the Anthropic API." }), false);
	// …unless the provider says when it does.
	assert.equal(isLimitError({ message: "You exceeded your current quota, please check your plan and billing details. Please retry in 20s.", httpStatus: 429 }), true);
});

test("replyIsLimitError: the same messages as omp's reply text count, prose about limits doesn't", () => {
	for (const reply of [
		"Claude AI usage limit reached|1762700000",
		"You have hit your ChatGPT usage limit (pro plan). Try again in ~30 min.",
		"RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute'",
		"429 Too Many Requests",
		'429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
	]) assert.equal(replyIsLimitError(reply), true, reply);
	for (const reply of ["Added a rate limiter to the proxy; it returns 429 after 100 requests.", "The usage limit is configurable in settings.", '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}']) assert.equal(replyIsLimitError(reply), false, reply);
});

test("recordLimit: the stated reset, else a backoff that doubles while limits recur", () => {
	const limits = {};
	const now = Date.now();
	const stated = recordLimit(limits, { message: "usage limit reached, try again in 90s" }, "openai-codex", "openai-codex/gpt-5", now);
	assert.equal(stated.until, now + 90_000);
	assert.equal(stated.guessed, undefined);
	const first = recordLimit(limits, { message: "429 Too Many Requests" }, "anthropic", "anthropic/claude-x", now);
	assert.equal(first.until, now + LIMIT_BACKOFF_BASE_MS);
	assert.equal(first.guessed, true);
	// Limited again right after the reset: twice the wait, same streak.
	const second = recordLimit(limits, { message: "429 Too Many Requests" }, "anthropic", "anthropic/claude-x", first.until + 1000);
	assert.equal(second.failures, 2);
	assert.equal(second.until, first.until + 1000 + 2 * LIMIT_BACKOFF_BASE_MS);
	assert.equal(second.since, now);
	assert.deepEqual(
		activeLimits(limits, now + 1000).map(l => l.provider),
		["openai-codex", "anthropic"],
	);
	assert.deepEqual(
		activeLimits(limits, now + 100_000).map(l => l.provider),
		["anthropic"],
	);
	// A stated reset far in the future (a garbled parse) is not trusted.
	const far = recordLimit({}, { message: "usage limit reached|9999999999" }, "x", undefined, now);
	assert.equal(far.guessed, true);
});

test("spendUse: rolling hour/day/week windows, the oldest spend leaves first", () => {
	const now = Date.parse("2026-11-09T12:00:00Z");
	const spend: Array<[number, number]> = [
		[now - 8 * 24 * HOUR, 100], // older than a week: dropped by pruneSpend
		[now - 3 * 24 * HOUR, 10],
		[now - 5 * HOUR, 4],
		[now - 50 * MIN, 3],
		[now - 10 * MIN, 3],
	];
	const kept = [...spend];
	assert.equal(pruneSpend(kept, now), true);
	assert.equal(kept.length, 4);
	const by = Object.fromEntries(spendUse(kept, { hour: 5, day: 20, week: 15 }, now).map(u => [u.window, u]));
	assert.deepEqual([by.hour.spent, by.day.spent, by.week.spent], [6, 10, 20]);
	assert.equal(by.hour.over, true);
	assert.equal(by.day.over, false);
	assert.equal(by.week.over, true);
	// Hour: dropping the 3 USD spent 50 min ago leaves 3 < 5: free once that spend is an hour old.
	assert.equal(by.hour.freesAt, now - 50 * MIN + HOUR);
	// Week: the 10 USD from 3 days ago must leave (20 - 10 < 15).
	assert.equal(by.week.freesAt, now - 3 * 24 * HOUR + 7 * 24 * HOUR);
	// Later, the same spend slides: the hour window is back under its cap.
	assert.equal(spendUse(kept, { hour: 5 }, now + 15 * MIN)[0].over, false);
	assert.deepEqual(spendUse(kept, undefined, now), []);
	assert.deepEqual(normalizeBudget({ hour: 2.499, day: "x", week: -1 }), { hour: 2.5 });
	assert.equal(normalizeBudget({}), undefined);
});

test("holdFor: reasons read like the old scheduler's; a limited provider holds only its own work, the budget holds everything", () => {
	const now = Date.parse("2026-11-09T12:00:00Z");
	const config = { holdAtPercent: 95, spareBelowPercent: 60 };
	const limit = { provider: "anthropic", until: now + HOUR, since: now, failures: 1, reason: "429" };
	const over = { window: "day" as const, cap: 20, spent: 21.5, over: true, freesAt: now + 2 * HOUR };
	const ctx = (extra: object) => ({ limits: [], windows: [], spend: [], config, ...extra });
	assert.equal(holdFor("anthropic", false, ctx({ limits: [limit] }), now)?.kind, "rate-limit");
	assert.match(holdFor("anthropic", false, ctx({ limits: [limit] }), now)?.reason ?? "", /^rate-limit anthropic until \d\d:\d\d$/);
	assert.equal(holdFor("openai", false, ctx({ limits: [limit] }), now), undefined);
	assert.equal(holdFor(undefined, false, ctx({ limits: [limit] }), now), undefined, "no known provider: only the budget applies");
	assert.equal(holdFor("anthropic", false, ctx({ limits: [limit] }), now + HOUR), undefined);
	assert.deepEqual(holdFor("openai", false, ctx({ spend: [over] }), now), { kind: "budget", reason: "budget day 21.50/20 USD", until: now + 2 * HOUR });
	assert.equal(holdFor(undefined, false, ctx({ spend: [{ ...over, over: false, spent: 3 }] }), now), undefined);
	// A usage window at the hold threshold holds its provider until the reset; below it only `spare` work waits.
	const win: UsageWindow = { provider: "anthropic", window: "5 Hour", usedPercent: 97, resetsAt: now + 30 * MIN };
	const full = holdFor("anthropic", false, ctx({ windows: [win] }), now);
	assert.equal(full?.kind, "usage");
	assert.match(full?.reason ?? "", /^usage anthropic 5 Hour 97% until \d\d:\d\d$/);
	assert.equal(full?.until, now + 30 * MIN);
	assert.equal(holdFor("anthropic", false, ctx({ windows: [{ ...win, usedPercent: 70 }] }), now), undefined);
	assert.match(holdFor("anthropic", true, ctx({ windows: [{ ...win, usedPercent: 70 }] }), now)?.reason ?? "", /^spare: usage anthropic 5 Hour 70%/);
});

test("holdText: the time a hold lifts is named once", () => {
	const now = new Date(2026, 10, 9, 12, 0);
	const at = new Date(2026, 10, 9, 14, 5).getTime();
	assert.equal(holdText("rate-limit anthropic until 14:05", at, now), "rate-limit anthropic until 14:05");
	assert.equal(holdText("budget day 21.50/20 USD", at, now), "budget day 21.50/20 USD until 14:05");
	assert.equal(holdText("retry backoff", undefined, now), "retry backoff");
	assert.equal(holdText(undefined, undefined, now), "held");
});

test("omp usage --json as omp prints it: the account with room counts, tier-scoped windows don't gate the provider", () => {
	// Shape and values of a real `omp usage --json` (omp 18.12.6, two anthropic accounts, one of them exhausted).
	const report = (accountPercent: number, resetsAt: number, status: string) => ({
		provider: "anthropic",
		limits: [
			{ id: "anthropic:5h", label: "Claude 5 Hour", scope: { provider: "anthropic", windowId: "5h", shared: true }, window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt }, amount: { used: accountPercent, limit: 100, remaining: 100 - accountPercent, usedFraction: accountPercent / 100, unit: "percent" }, status },
			{ id: "anthropic:7d:fable", label: "Claude 7 Day (Fable)", scope: { provider: "anthropic", windowId: "7d", tier: "fable" }, window: { id: "7d", label: "7 Day", durationMs: 604_800_000, resetsAt }, amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" }, status: "exhausted" },
		],
	});
	const windows = parseOmpUsage({ generatedAt: 1, reports: [report(5, 1_794_269_400_000, "ok"), report(100, 1_794_261_600_410, "exhausted")], capacity: {} });
	assert.deepEqual(windows, [{ provider: "anthropic", window: "Claude 5 Hour", usedPercent: 5, resetsAt: 1_794_269_400_000 }]);
	assert.deepEqual(parseOmpUsage({}), []);
	assert.deepEqual(parseOmpUsage({ reports: [{ provider: "x", limits: [{ id: "x:1", amount: { usedFraction: "a lot" } }] }] }), []);
});

function planner(t: Parameters<typeof tempPlan>[0], ao: FakeAo, extra: Partial<ConstructorParameters<typeof Planner>[0]> = {}): Planner {
	const file = tempPlan(t);
	const p = new Planner({ file, initial: loadPlan(file), connect: async () => ao, pollMs: 100, retryBaseMs: 50, livenessMs: 50, userDefaults: () => ({}), ...extra });
	p.start();
	t.after(() => p.stop());
	return p;
}

test("a task that names no model: the session's own provider is learned, so a limit holds it and the next such task waits too", async t => {
	const ao = new FakeAo();
	ao.ompDefaultModel = "anthropic/claude-opus-5-5";
	const p = planner(t, ao);
	p.setConfig({ maxConcurrent: 0 });
	p.edit([{ op: "add", task: { title: "first" } }]);
	const s1 = await until("first sent", () => byTitle(p, "first").run?.phase === "sent" && byTitle(p, "first").run?.session);
	ao.finishTurn(s1, "completed", `Claude AI usage limit reached|${Math.floor((Date.now() + 2 * HOUR) / 1000)}`);
	await until("held on the learned provider", () => p.state.limits.anthropic !== undefined && byTitle(p, "first").status === "pending");
	assert.equal(p.state.defaultProvider, "anthropic");
	assert.equal(byTitle(p, "first").attempts, undefined, "a limit costs no attempt");
	p.edit([{ op: "add", task: { title: "second" } }]);
	const view = await until("second held", () => p.view().tasks.find(x => x.title === "second")?.state === "held" && p.view().tasks.find(x => x.title === "second"));
	assert.match(view.waitReason ?? "", /^rate-limit anthropic until /);
	assert.equal(ao.created, 1, "nothing else was sent while the limit holds");
	assert.deepEqual(p.status().limits.map(l => l.provider), ["anthropic"]);
	assert.equal(p.status().defaultProvider, "anthropic");
	// Forgetting the limit (`sched limits clear`) lets both start.
	p.setConfig(undefined, true);
	await until("both running", () => byTitle(p, "first").status === "running" && byTitle(p, "second").status === "running");
});

test("a budget cap holds new tasks once the spend of finished turns reaches it; lifting the cap releases them; running work is untouched", async t => {
	const ao = new FakeAo();
	const p = planner(t, ao);
	p.setConfig({ budget: { day: 0.15 } });
	p.edit([{ op: "add", task: { title: "A" } }, { op: "add", task: { title: "B" } }]);
	const a = await until("A sent", () => byTitle(p, "A").run?.phase === "sent" && byTitle(p, "A").run?.session);
	const b = await until("B sent", () => byTitle(p, "B").run?.phase === "sent" && byTitle(p, "B").run?.session);
	// Both are running when the first finishes: 0.20 USD spent against a 0.15 cap.
	ao.finishTurn(a, "completed", "done A", 0.2);
	await until("A done", () => byTitle(p, "A").status === "done");
	assert.equal(byTitle(p, "B").status, "running", "a running task is not stopped by the budget");
	p.edit([{ op: "add", task: { title: "C" } }]);
	const held = await until("C held by the budget", () => p.view().tasks.find(x => x.title === "C")?.state === "held" && p.view().tasks.find(x => x.title === "C"));
	assert.match(held.waitReason ?? "", /^budget day 0\.20\/0\.15 USD$/);
	assert.ok(held.waitUntil && held.waitUntil > Date.now(), "it says when the spend leaves the window");
	assert.equal(ao.created, 2);
	const status = p.status();
	assert.deepEqual(status.spend.map(u => [u.window, u.over]), [["day", true]]);
	assert.equal(status.held, 1);
	// Raising the cap lifts the hold.
	p.setConfig({ budget: { day: 5 } });
	await until("C running", () => byTitle(p, "C").status === "running");
	assert.equal(ao.created, 3);
	ao.finishTurn(b, "completed", "done B", 0.1);
	await until("B done", () => byTitle(p, "B").status === "done");
});

test("the planner's windows come from omp usage: a window at the threshold holds its provider, `spare` waits for room, and a refresh releases", async t => {
	const ao = new FakeAo();
	let windows: UsageWindow[] = [{ provider: "anthropic", window: "5 Hour", usedPercent: 97, resetsAt: Date.now() + HOUR }];
	const p = planner(t, ao, { usage: async () => windows, usageEveryMs: 100 });
	p.edit([
		{ op: "add", task: { title: "normal", options: { model: "anthropic/claude-x" } } },
		{ op: "add", task: { title: "other provider", options: { model: "openai/gpt-5" } } },
	]);
	await until("windows read", () => p.status().usageWindows.length === 1);
	const normal = await until("held at 97%", () => p.view().tasks.find(x => x.title === "normal")?.state === "held" && p.view().tasks.find(x => x.title === "normal"));
	assert.match(normal.waitReason ?? "", /^usage anthropic 5 Hour 97% until /);
	await until("the other provider runs", () => byTitle(p, "other provider").status === "running");
	windows = [{ provider: "anthropic", window: "5 Hour", usedPercent: 40, resetsAt: Date.now() + HOUR }];
	await until("released after the refresh", () => byTitle(p, "normal").status === "running");
});
