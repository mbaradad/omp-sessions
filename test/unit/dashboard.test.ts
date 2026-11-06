// Transcript usage parsing/aggregation (dashboard, today's spend) and the history-search matcher.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	type MessageText,
	TranscriptCache,
	type UsageRecord,
	buildSnippet,
	dayKey,
	formatCost,
	formatTokens,
	listSubagentTranscripts,
	matchTerms,
	parseHead,
	parseQuery,
	parseTextLine,
	parseUsageLine,
	scanLines,
	searchMessages,
	startOfDay,
	summarize,
} from "../../src/ext/transcripts";

// Day bucketing must follow local time; pin a zone with DST and a non-zero UTC offset.
process.env.TZ = "America/New_York";

const assistant = (ts: number, model: string, cost: number, tokens: number, provider = "anthropic") =>
	JSON.stringify({
		type: "message",
		id: "a1",
		timestamp: new Date(ts).toISOString(),
		message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider, model, usage: { input: 1, output: 2, totalTokens: tokens, cost: { input: 0, output: 0, total: cost } }, timestamp: ts },
	});

test("parseUsageLine: assistant message with usage", () => {
	const r = parseUsageLine(assistant(1_793_988_454_199, "claude-opus-5-5", 0.0070172, 12837));
	assert.deepEqual(r, { ts: 1_793_988_454_199, model: "anthropic/claude-opus-5-5", cost: 0.0070172, tokens: 12837 });
});

test("parseUsageLine: model_usage side call uses the ISO entry timestamp", () => {
	const line = JSON.stringify({
		type: "model_usage",
		timestamp: "2026-11-06T20:08:24.800Z",
		purpose: "job-widget",
		provider: "anthropic",
		model: "claude-haiku-5-5",
		usage: { input: 3278, output: 103, cacheRead: 0, cacheWrite: 3551, totalTokens: 6932, cost: { total: 0.0010895 } },
	});
	assert.deepEqual(parseUsageLine(line), { ts: Date.parse("2026-11-06T20:08:24.800Z"), model: "anthropic/claude-haiku-5-5", cost: 0.0010895, tokens: 6932 });
});

test("parseUsageLine: ignores malformed lines, other roles, missing or empty usage", () => {
	assert.equal(parseUsageLine(""), undefined);
	assert.equal(parseUsageLine('{"type":"message","usage":'), undefined);
	assert.equal(parseUsageLine("[1,2,3]"), undefined);
	assert.equal(parseUsageLine('"usage"'), undefined);
	assert.equal(parseUsageLine(JSON.stringify({ type: "message", message: { role: "assistant", model: "m", timestamp: 1 } })), undefined);
	assert.equal(parseUsageLine(JSON.stringify({ type: "message", message: { role: "toolResult", usage: { totalTokens: 5, cost: { total: 1 } }, timestamp: 1 } })), undefined);
	assert.equal(parseUsageLine(JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 0, cost: { total: 0 } }, timestamp: 1 } })), undefined);
	assert.equal(parseUsageLine(JSON.stringify({ type: "message", message: { role: "assistant", usage: "lots", timestamp: 1 } })), undefined);
	// No timestamp anywhere: cannot be bucketed.
	assert.equal(parseUsageLine(JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 5 } } })), undefined);
});

test("parseUsageLine: tolerates missing cost, missing totalTokens, odd model fields", () => {
	const noCost = parseUsageLine(JSON.stringify({ type: "message", message: { role: "assistant", provider: "vllm", model: "qwen", usage: { totalTokens: 7990 }, timestamp: 5 } }));
	assert.deepEqual(noCost, { ts: 5, model: "vllm/qwen", cost: 0, tokens: 7990 });
	const summed = parseUsageLine(JSON.stringify({ type: "message", message: { role: "assistant", model: "openai/gpt", provider: "openai", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: "x" } }, timestamp: 5 } }));
	assert.deepEqual(summed, { ts: 5, model: "openai/gpt", cost: 0, tokens: 10 });
	const noModel = parseUsageLine(JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 1, cost: { total: 0.5 } }, timestamp: 5 } }));
	assert.equal(noModel?.model, "unknown");
});

test("dayKey/startOfDay: local calendar days, across DST", () => {
	// 03:30 UTC on Mar 1 is still Feb 28 in New York.
	assert.equal(dayKey(Date.parse("2026-03-01T03:30:00Z")), "2026-02-28");
	assert.equal(dayKey(Date.parse("2026-03-01T05:30:00Z")), "2026-03-01");
	// DST starts 2026-03-08 in the US: the day before has 24h, the day of has 23h.
	const afterDst = Date.parse("2026-03-09T15:00:00Z");
	assert.equal(dayKey(startOfDay(afterDst, 1)), "2026-03-08");
	assert.equal(dayKey(startOfDay(afterDst, 2)), "2026-03-07");
	assert.equal(new Date(startOfDay(afterDst, 2)).getHours(), 0);
});

test("summarize: periods, per-day chart, per model/project/session", () => {
	const now = Date.parse("2026-11-06T18:00:00Z"); // 13:00 in New York
	const h = 3600_000;
	const rec = (ts: number, model: string, cost: number, tokens: number): UsageRecord => ({ ts, model, cost, tokens });
	const a = {
		name: "a",
		project: "/p1",
		records: [
			rec(now - h, "anthropic/opus", 1, 100),
			rec(Date.parse("2026-11-06T04:30:00Z"), "anthropic/haiku", 0.5, 50), // Nov 5, 23:30 local: yesterday
			rec(now - 10 * 24 * h, "anthropic/opus", 2, 200),
		],
	};
	const b = { name: "b", project: "/p2", records: [rec(now - 2 * h, "openai/gpt", 0.25, 1000), rec(now - 40 * 24 * h, "openai/gpt", 4, 4000)] };
	const c = { name: "c", project: "/p1", records: [] };
	const s = summarize([a, b, c], now, 7);
	assert.deepEqual(s.periods.today, { cost: 1.25, tokens: 1100, turns: 2 });
	assert.deepEqual(s.periods.week, { cost: 1.75, tokens: 1150, turns: 3 });
	assert.deepEqual(s.periods.month, { cost: 3.75, tokens: 1350, turns: 4 });
	assert.deepEqual(s.periods.all, { cost: 7.75, tokens: 5350, turns: 5 });
	assert.equal(s.days.length, 7);
	assert.equal(s.days[6].day, "2026-11-06");
	assert.equal(s.days[0].day, "2026-10-31");
	assert.deepEqual({ ...s.days[6] }, { day: "2026-11-06", cost: 1.25, tokens: 1100, turns: 2 });
	assert.equal(s.days[5].cost, 0.5);
	assert.equal(s.days.reduce((n, d) => n + d.turns, 0), 3);
	assert.deepEqual(
		s.models.map(m => [m.model, m.cost, m.turns]),
		[
			["openai/gpt", 4.25, 2],
			["anthropic/opus", 3, 2],
			["anthropic/haiku", 0.5, 1],
		],
	);
	assert.deepEqual(
		s.projects.map(p => [p.project, p.cost, p.sessions]),
		[
			["/p2", 4.25, 1],
			["/p1", 3.5, 2],
		],
	);
	assert.deepEqual(
		s.sessions.map(x => [x.source.name, x.total.cost, x.today.cost, x.models]),
		[
			["a", 3.5, 1, ["anthropic/haiku", "anthropic/opus"]],
			["b", 4.25, 0.25, ["openai/gpt"]],
			["c", 0, 0, []],
		],
	);
	assert.equal(s.sessions[2].last, 0);
});

test("summarize: no data", () => {
	const s = summarize([], Date.now());
	assert.deepEqual(s.periods.all, { cost: 0, tokens: 0, turns: 0 });
	assert.equal(s.days.length, 30);
	assert.deepEqual(s.models, []);
	assert.deepEqual(s.sessions, []);
});

test("format helpers", () => {
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(0.004), "<$0.01");
	assert.equal(formatCost(12.345), "$12.35");
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(123_456), "123k");
	assert.equal(formatTokens(4_500_000), "4.5M");
	assert.equal(formatTokens(2_100_000_000), "2.1B");
});

test("parseHead: title record and session header", () => {
	const text = [
		JSON.stringify({ type: "title", v: 1, title: "Fix the bug", pad: "    " }),
		JSON.stringify({ type: "session", version: 3, id: "abc", cwd: "/w", parentSession: "/x.jsonl" }),
		'{"type":"message", "torn',
	].join("\n");
	assert.deepEqual(parseHead(text), { title: "Fix the bug", cwd: "/w", id: "abc", parentSession: "/x.jsonl" });
	assert.deepEqual(parseHead(JSON.stringify({ type: "session", id: "i", cwd: "/c", title: "From header" })), { title: "From header", cwd: "/c", id: "i", parentSession: "" });
	assert.deepEqual(parseHead("garbage"), { title: "", cwd: "", id: "", parentSession: "" });
});

test("parseTextLine: user/assistant text only", () => {
	const user = JSON.stringify({ type: "message", timestamp: "2026-11-06T18:07:34.189Z", message: { role: "user", content: [{ type: "text", text: "summarize\n\n  the   status" }], timestamp: 1793988454132 } });
	assert.deepEqual(parseTextLine(user), { role: "user", ts: 1793988454132, text: "summarize the status" });
	const str = JSON.stringify({ type: "message", timestamp: "2026-11-06T18:07:34.189Z", message: { role: "user", content: "plain string" } });
	assert.deepEqual(parseTextLine(str), { role: "user", ts: Date.parse("2026-11-06T18:07:34.189Z"), text: "plain string" });
	const asst = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "secret plan" },
				{ type: "toolCall", name: "bash" },
				{ type: "text", text: "Done." },
			],
			timestamp: 9,
		},
	});
	assert.deepEqual(parseTextLine(asst), { role: "assistant", ts: 9, text: "Done." });
	assert.equal(parseTextLine(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall" }], timestamp: 9 } })), undefined);
	assert.equal(parseTextLine(JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: '"role":"user"' }] } })), undefined);
	assert.equal(parseTextLine('{"type":"message","message":{"role":"user","content":[{"type":"te'), undefined);
});

test("parseQuery: lowercased terms, quoted phrases, dedupe", () => {
	assert.deepEqual(parseQuery('  Foo bar "Exact  Phrase" foo ""'), ["foo", "bar", "exact phrase"]);
	assert.deepEqual(parseQuery("   "), []);
});

test("matchTerms: all terms required, case-insensitive, earliest position", () => {
	assert.deepEqual(matchTerms("The Quick brown fox", ["fox", "quick"]), { index: 4, length: 5 });
	assert.equal(matchTerms("The quick brown fox", ["fox", "cat"]), undefined);
	assert.equal(matchTerms("anything", []), undefined);
});

test("buildSnippet: short text whole, long text windowed with ellipses at word boundaries", () => {
	assert.equal(buildSnippet("  short\ntext ", 0, 5), "short text");
	const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
	const at = words.indexOf("word30");
	const snip = buildSnippet(words, at, 6, 60);
	assert.ok(snip.startsWith("…") && snip.endsWith("…"), snip);
	assert.ok(snip.includes("word30"), snip);
	assert.ok(snip.length <= 62, snip);
	assert.match(snip, /^…word\d+ .* word\d+…$/);
	const startSnip = buildSnippet(words, 0, 5, 40);
	assert.ok(startSnip.startsWith("word0 ") && startSnip.endsWith("…"), startSnip);
	const endSnip = buildSnippet(words, words.length - 6, 6, 40);
	assert.ok(endSnip.startsWith("…") && endSnip.endsWith("word59"), endSnip);
	// Out-of-range index is clamped instead of throwing.
	assert.ok(buildSnippet(words, 10_000, 3, 40).endsWith("word59"));
});

test("searchMessages: newest match gives the snippet, counts all matches", () => {
	const msgs: MessageText[] = [
		{ role: "user", ts: 1, text: "please fix the login bug" },
		{ role: "assistant", ts: 2, text: "Fixed the LOGIN bug in auth.ts" },
		{ role: "user", ts: 3, text: "thanks" },
	];
	const hit = searchMessages(msgs, parseQuery("login bug"));
	assert.equal(hit?.count, 2);
	assert.equal(hit?.message.ts, 2);
	assert.equal(hit?.snippet, "Fixed the LOGIN bug in auth.ts");
	assert.equal(searchMessages(msgs, parseQuery("logout")), undefined);
});

test("scanLines + TranscriptCache: incremental tail parsing, torn lines, rewrites, subagents", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dash-"));
	try {
		const file = path.join(dir, "s.jsonl");
		const header = `${JSON.stringify({ type: "title", v: 1, title: "T", pad: "      " })}\n${JSON.stringify({ type: "session", id: "x", cwd: "/w" })}\n`;
		fs.writeFileSync(file, `${header}${assistant(1000, "m", 1, 10)}\nnot json\n${assistant(2000, "m", 2, 20).slice(0, 30)}`);
		const lines: string[] = [];
		const end = await scanLines(file, 0, l => lines.push(l));
		assert.equal(lines.length, 4, "torn last line is not delivered");
		assert.equal(end, fs.readFileSync(file).lastIndexOf(10) + 1);

		let parsedLines = 0;
		const cache = new TranscriptCache<UsageRecord[]>(
			() => [],
			(acc, line) => {
				parsedLines++;
				const r = parseUsageLine(line);
				if (r) acc.push(r);
			},
		);
		let e = await cache.get(file);
		assert.equal(e?.head.title, "T");
		assert.equal(e?.data.length, 1);
		const firstPass = parsedLines;
		// Same file again: no parsing.
		await cache.get(file);
		assert.equal(parsedLines, firstPass);
		// Finish the torn line and append another: only the tail is parsed.
		fs.writeFileSync(file, `${header}${assistant(1000, "m", 1, 10)}\nnot json\n${assistant(2000, "m", 2, 20)}\n${assistant(3000, "m", 3, 30)}\n`);
		e = await cache.get(file);
		assert.deepEqual(
			e?.data.map(r => r.cost),
			[1, 2, 3],
		);
		assert.equal(parsedLines, firstPass + 2);
		// Title rewritten in place (same size): no reparse, new title.
		const retitled = fs.readFileSync(file, "utf8").replace('"title":"T","pad":"      "', '"title":"Tx","pad":"     "');
		fs.writeFileSync(file, retitled);
		fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
		e = await cache.get(file);
		assert.equal(e?.head.title, "Tx");
		assert.equal(e?.data.length, 3);
		// Shrunk (rewritten) file: parsed from scratch.
		fs.writeFileSync(file, `${header}${assistant(4000, "m", 4, 40)}\n`);
		e = await cache.get(file);
		assert.deepEqual(
			e?.data.map(r => r.cost),
			[4],
		);
		// Concurrent gets share one parse.
		fs.appendFileSync(file, `${assistant(5000, "m", 5, 50)}\n`);
		const [x, y] = await Promise.all([cache.get(file), cache.get(file)]);
		assert.equal(x, y);
		assert.equal(x?.data.length, 2);
		// Missing file.
		assert.equal(await cache.get(path.join(dir, "nope.jsonl")), undefined);

		// Subagent transcripts live next to the parent, nested.
		fs.mkdirSync(path.join(dir, "s", "Worker", "Deep"), { recursive: true });
		fs.writeFileSync(path.join(dir, "s", "Scout.jsonl"), "");
		fs.writeFileSync(path.join(dir, "s", "Worker", "Deep", "Sub.jsonl"), "");
		fs.writeFileSync(path.join(dir, "s", "notes.txt"), "");
		const subs = (await listSubagentTranscripts(file)).map(f => path.relative(dir, f)).sort();
		assert.deepEqual(subs, [path.join("s", "Scout.jsonl"), path.join("s", "Worker", "Deep", "Sub.jsonl")]);
		assert.deepEqual(await listSubagentTranscripts(path.join(dir, "none.jsonl")), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("scanLines: lines spanning chunk boundaries and oversized lines", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dash-"));
	try {
		const file = path.join(dir, "big.jsonl");
		const long = "x".repeat(1024 * 1024 + 17); // crosses the 1 MiB chunk
		const huge = "y".repeat(9 * 1024 * 1024); // over the per-line cap: skipped
		fs.writeFileSync(file, `a\n${long}\n${huge}\nb\nü€\n`);
		const lines: string[] = [];
		await scanLines(file, 0, l => lines.push(l));
		assert.deepEqual(
			lines.map(l => (l.length > 20 ? `${l[0]}*${l.length}` : l)),
			["a", `x*${long.length}`, "b", "ü€"],
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
