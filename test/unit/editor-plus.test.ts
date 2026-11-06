import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
	CappedOutput,
	type DiagnosticInfo,
	type FileDiagnostics,
	MAX_EDIT_SYMBOL_LINES,
	type SymbolNode,
	SymbolKinds,
	addDocsPrompt,
	addedTexts,
	attributeLine,
	changedLines,
	displayPath,
	editPrompt,
	excerpt,
	failedCommandPrompt,
	fence,
	fixFilePrompt,
	fixWorkspacePrompt,
	formatDiagnostic,
	isFailure,
	promptsByToolCall,
	relativeTime,
	selectFileDiagnostics,
	stripAnsi,
	symbolForAction,
	writeTestsPrompt,
} from "../../src/ext/editor-plus-core";

const ref = { path: "src/a.ts", startLine: 10, endLine: 12, code: "const a = 1;\nconst b = 2;\nconst c = 3;\n", languageId: "typescript" };

// ---------- prompts ----------

test("editPrompt: names the exact range and fences the code", () => {
	const p = editPrompt({ ...ref, symbol: "compute" }, "  rename a to alpha  ");
	assert.ok(p.startsWith("Edit src/a.ts:10-12 (compute): rename a to alpha\n"));
	assert.match(p, /Change only lines 10-12 of src\/a\.ts/);
	assert.ok(p.endsWith("```typescript\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```"));
});

test("editPrompt: single line uses a bare line number", () => {
	const p = editPrompt({ path: "x.py", startLine: 7, endLine: 7, code: "x = 1" }, "use a constant");
	assert.match(p, /^Edit x\.py:7: use a constant/);
	assert.match(p, /Change only lines 7 of x\.py/);
});

test("fence: longer fence when the code contains backticks", () => {
	assert.equal(fence("a ``` b", "md"), "````md\na ``` b\n````");
	assert.equal(fence("x\n"), "```\nx\n```");
});

test("writeTestsPrompt / addDocsPrompt reference the unit and its code", () => {
	const t = writeTestsPrompt({ ...ref, symbol: "Foo" });
	assert.match(t, /^Write tests for src\/a\.ts:10-12 \(Foo\)\./);
	assert.match(t, /conventions/);
	assert.match(t, /const b = 2;/);
	const d = addDocsPrompt(ref);
	assert.match(d, /^Add documentation comments to src\/a\.ts:10-12\./);
	assert.match(d, /no code changes/);
});

test("displayPath: relative inside the session folder, absolute outside", () => {
	const root = path.resolve("/work/proj");
	assert.equal(displayPath(path.join(root, "src", "a.ts"), root), path.join("src", "a.ts"));
	assert.equal(displayPath(root, root), ".");
	const outside = path.resolve("/work/other/b.ts");
	assert.equal(displayPath(outside, root), outside);
	assert.equal(displayPath(outside, undefined), outside);
});

test("excerpt / relativeTime", () => {
	assert.equal(excerpt("\n\n  fix   the\tbug  \nsecond line"), "fix the bug");
	assert.equal(excerpt("x".repeat(100), 10), `${"x".repeat(9)}…`);
	assert.equal(excerpt("   \n "), "");
	const now = 1_000_000_000;
	assert.equal(relativeTime(now - 10_000, now), "just now");
	assert.equal(relativeTime(now - 5 * 60_000, now), "5 min ago");
	assert.equal(relativeTime(now - 3 * 3600_000, now), "3 h ago");
	assert.equal(relativeTime(now - 2 * 86400_000, now), "2 d ago");
	assert.equal(relativeTime(now + 5000, now), "just now");
});

// ---------- enclosing symbol ----------

const tree: SymbolNode[] = [
	{ name: "imports", kind: SymbolKinds.Module, startLine: 0, endLine: 2 },
	{
		name: "Service",
		kind: SymbolKinds.Class,
		startLine: 4,
		endLine: 40,
		children: [
			{ name: "count", kind: SymbolKinds.Property, startLine: 5, endLine: 5 },
			{ name: "options", kind: SymbolKinds.Property, startLine: 6, endLine: 9 },
			{
				name: "run",
				kind: SymbolKinds.Method,
				startLine: 11,
				endLine: 30,
				children: [
					{ name: "tmp", kind: SymbolKinds.Variable, startLine: 12, endLine: 12 },
					{ name: "handler", kind: SymbolKinds.Variable, startLine: 14, endLine: 18 },
				],
			},
		],
	},
	{ name: "helper", kind: SymbolKinds.Function, startLine: 42, endLine: 50 },
];

test("symbolForAction: innermost function/method around the cursor", () => {
	assert.equal(symbolForAction(tree, 20, "edit")?.name, "run");
	assert.equal(symbolForAction(tree, 45, "edit")?.name, "helper");
	// A one-line variable is not a unit: its enclosing method is.
	assert.equal(symbolForAction(tree, 12, "edit")?.name, "run");
	// A multi-line variable (arrow function, object literal) is.
	assert.equal(symbolForAction(tree, 16, "edit")?.name, "handler");
	assert.equal(symbolForAction(tree, 7, "edit")?.name, "options");
});

test("symbolForAction: classes count for tests/docs only", () => {
	assert.equal(symbolForAction(tree, 5, "edit"), undefined);
	assert.equal(symbolForAction(tree, 5, "unit")?.name, "Service");
	assert.equal(symbolForAction(tree, 35, "unit")?.name, "Service");
	assert.equal(symbolForAction(tree, 20, "unit")?.name, "run");
	assert.equal(symbolForAction(tree, 1, "unit"), undefined);
	assert.equal(symbolForAction(tree, 41, "unit"), undefined);
	assert.equal(symbolForAction([], 3, "unit"), undefined);
});

test("symbolForAction: flat symbol lists pick the smallest containing span", () => {
	const flat: SymbolNode[] = [
		{ name: "outer", kind: SymbolKinds.Function, startLine: 0, endLine: 30 },
		{ name: "inner", kind: SymbolKinds.Function, startLine: 10, endLine: 20 },
		{ name: "Klass", kind: SymbolKinds.Class, startLine: 0, endLine: 40 },
	];
	assert.equal(symbolForAction(flat, 15, "edit")?.name, "inner");
	assert.equal(symbolForAction(flat, 25, "unit")?.name, "outer");
	assert.equal(symbolForAction(flat, 35, "unit")?.name, "Klass");
});

test("symbolForAction: huge functions are skipped for edits", () => {
	const big: SymbolNode[] = [{ name: "giant", kind: SymbolKinds.Function, startLine: 0, endLine: MAX_EDIT_SYMBOL_LINES + 10 }];
	assert.equal(symbolForAction(big, 100, "edit"), undefined);
	assert.equal(symbolForAction(big, 100, "unit")?.name, "giant");
});

// ---------- diagnostics ----------

const d = (line: number, severity: DiagnosticInfo["severity"], message: string, extra: Partial<DiagnosticInfo> = {}): DiagnosticInfo => ({ line, character: 0, severity, message, ...extra });

test("formatDiagnostic: position, origin, flattened message, source line", () => {
	assert.equal(formatDiagnostic(d(4, "error", "Cannot find\n  name 'x'.", { character: 2, source: "ts", code: "2304" }), "  return x;  "), "- L5:3 error (ts 2304): Cannot find name 'x'.\n  `return x;`");
	assert.equal(formatDiagnostic(d(0, "warning", "unused")), "- L1:1 warning: unused");
	assert.match(formatDiagnostic(d(0, "error", "m"), "a `b` c"), /`a 'b' c`$/);
	const long = formatDiagnostic(d(0, "error", "y".repeat(1000)));
	assert.ok(long.length < 450 && long.endsWith("…"));
});

test("selectFileDiagnostics: errors first, infos dropped, duplicates merged, capped", () => {
	const diags = [d(9, "warning", "w1"), d(3, "info", "i"), d(7, "error", "e2"), d(2, "error", "e1"), d(7, "error", "e2"), d(1, "hint", "h"), d(5, "warning", "w0")];
	const { kept, omitted } = selectFileDiagnostics(diags, 3);
	assert.deepEqual(
		kept.map(x => x.message),
		["e1", "e2", "w0"],
	);
	assert.equal(omitted, 1);
});

const file = (p: string, diagnostics: DiagnosticInfo[], lines: string[] = []): FileDiagnostics => ({ path: p, diagnostics, lineText: n => lines[n] });

test("fixFilePrompt: counts, snippets, cap note; undefined when clean", () => {
	const p = fixFilePrompt(file("src/a.ts", [d(0, "error", "bad"), d(1, "warning", "meh"), d(2, "warning", "meh2")], ["let x: number = 'a';", "var y;", ""]), 2);
	assert.ok(p);
	assert.match(p, /^Fix the problems VS Code reports in src\/a\.ts \(1 error and 1 warning; 1 more not listed\):/);
	assert.match(p, /- L1:1 error: bad\n {2}`let x: number = 'a';`/);
	assert.match(p, /- L2:1 warning: meh\n {2}`var y;`/);
	assert.doesNotMatch(p, /meh2/);
	assert.equal(fixFilePrompt(file("a", [d(0, "info", "fyi")])), undefined);
	assert.equal(fixFilePrompt(file("a", [])), undefined);
});

test("fixWorkspacePrompt: errors only, grouped by file, capped across files", () => {
	const files = [
		file("a.ts", [d(0, "error", "a1"), d(1, "warning", "aw"), d(2, "error", "a2")]),
		file("clean.ts", [d(0, "warning", "only warning")]),
		file("b.ts", [d(0, "error", "b1"), d(1, "error", "b2"), d(2, "error", "b3")]),
		file("c.ts", [d(0, "error", "c1")]),
	];
	const p = fixWorkspacePrompt(files, 4);
	assert.ok(p);
	assert.match(p, /^Fix the 6 errors VS Code reports across 3 files \(first 4 listed\):/);
	assert.match(p, /### a\.ts\n- L1:1 error: a1\n- L3:1 error: a2/);
	assert.match(p, /### b\.ts\n- L1:1 error: b1\n- L2:1 error: b2\n- … 1 more in this file/);
	assert.doesNotMatch(p, /aw|only warning|clean\.ts|### c\.ts/);
	assert.equal(fixWorkspacePrompt([file("x", [d(0, "warning", "w")])]), undefined);
	assert.match(fixWorkspacePrompt([file("x", [d(0, "error", "e")])]) ?? "", /^Fix the 1 error VS Code reports across 1 file:/);
});

// ---------- terminal ----------

test("stripAnsi: colors, cursor moves, OSC 633/8, carriage returns, backspaces", () => {
	assert.equal(stripAnsi("\x1b[31merror\x1b[0m: \x1b[1mbad\x1b[22m"), "error: bad");
	assert.equal(stripAnsi("\x1b]633;C\x07out\x1b]633;D;1\x07"), "out");
	assert.equal(stripAnsi("\x1b]8;;https://x.y\x1b\\link\x1b]8;;\x1b\\"), "link");
	assert.equal(stripAnsi("10%\r50%\r100% done\r\nnext"), "100% done\nnext");
	assert.equal(stripAnsi("abc\b\bX\tY\x07"), "aX\tY");
	assert.equal(stripAnsi("\x1b[?25l\x1b[2K\x1b[1Gline  \x1b(B"), "line");
});

test("CappedOutput: keeps everything when small", () => {
	const out = new CappedOutput(10, 20);
	out.append("\x1b[32mok\x1b[0m\n");
	out.append("second\n");
	assert.equal(out.truncated, false);
	assert.equal(out.text(), "ok\nsecond");
});

test("CappedOutput: keeps head and tail with an omission marker", () => {
	const out = new CappedOutput(12, 16);
	out.append("first line\n");
	for (let i = 0; i < 200; i++) out.append(`noise ${i}\n`);
	out.append("FAILED: x\n");
	assert.equal(out.truncated, true);
	const text = out.text();
	assert.ok(text.startsWith("first line\n"));
	assert.match(text, /… \(\d+ characters of output omitted\) …/);
	assert.ok(text.endsWith("FAILED: x"));
	assert.ok(text.length < 100);
});

test("isFailure: non-zero exit, but not Ctrl+C or unknown", () => {
	assert.equal(isFailure(1), true);
	assert.equal(isFailure(127), true);
	assert.equal(isFailure(0), false);
	assert.equal(isFailure(130), false);
	assert.equal(isFailure(undefined), false);
});

test("failedCommandPrompt: command, cwd, exit code, output", () => {
	const p = failedCommandPrompt({ commandLine: "npm test\n", cwd: "packages/api", exitCode: 2, output: "boom\n" });
	assert.match(p, /^This command failed with exit code 2 in packages\/api:\n```sh\nnpm test\n```\nOutput:\n```text\nboom\n```/);
	assert.match(failedCommandPrompt({ commandLine: "make", cwd: ".", exitCode: 1, output: "  " }), /produced no output/);
});

// ---------- change attribution ----------

test("changedLines: added and modified lines of the current text", () => {
	assert.deepEqual([...changedLines("a\nb\nc\n", "a\nB\nc\nd\n")].sort(), [2, 4]);
	assert.deepEqual([...changedLines("", "x\ny")], [1, 2]);
	assert.equal(changedLines("same\n", "same\n").size, 0);
});

test("attributeLine: newest edit that added the text, else the newest edit", () => {
	const edits = [{ added: addedTexts("", "one\ntwo\n") }, { added: addedTexts("one\ntwo\n", "one\n  TWO\nthree\n") }, { added: addedTexts("one\n  TWO\nthree\n", "one\n  TWO\nthree\nfour\n") }];
	assert.equal(attributeLine("one", edits), 0);
	assert.equal(attributeLine("TWO", edits), 1);
	assert.equal(attributeLine("four", edits), 2);
	assert.equal(attributeLine("unknown (user typed)", edits), 2);
	assert.equal(attributeLine("", edits), 2);
});

test("promptsByToolCall: tool calls map to the user prompt of their turn", () => {
	const lines = [
		{ type: "session", cwd: "/p" },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Fix the parser" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit" }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "edit", content: [{ type: "text", text: 'says "role":"user"' }] } },
		{ type: "message", message: { role: "user", content: "Now add tests" } },
		{ type: "message", message: { role: "toolResult", toolCallId: "t2", toolName: "write", content: [] } },
		{ type: "message", message: { role: "user", content: [{ type: "image", data: "…" }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "t3", toolName: "edit", content: [] } },
	];
	const map = promptsByToolCall(`${lines.map(l => JSON.stringify(l)).join("\n")}\n{"torn`);
	assert.equal(map.get("t1"), "Fix the parser");
	assert.equal(map.get("t2"), "Now add tests");
	// Image-only prompt has no text: keep the previous prompt.
	assert.equal(map.get("t3"), "Now add tests");
	assert.equal(map.get("nope"), undefined);
});
