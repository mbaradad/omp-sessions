// links.ts pulls in dom.ts, which calls the webview global `acquireVsCodeApi()` at load; the shim
// must be imported first. splitLine itself needs no DOM.
import "./webview-shim";
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitLine } from "../../src/webview/links";

test("splitLine: bare path", () => {
	assert.deepEqual(splitLine("src/a.ts"), { file: "src/a.ts", line: undefined, col: undefined });
});

test("splitLine: :line and :line:col", () => {
	assert.deepEqual(splitLine("src/a.ts:12"), { file: "src/a.ts", line: 12, col: undefined });
	assert.deepEqual(splitLine("/abs/b.py:3:7"), { file: "/abs/b.py", line: 3, col: 7 });
});

test("splitLine: :start-end range keeps only the start line", () => {
	assert.deepEqual(splitLine("a.ts:12-20"), { file: "a.ts", line: 12, col: undefined });
});

test("splitLine: #L anchor", () => {
	assert.deepEqual(splitLine("docs/x.md#L7"), { file: "docs/x.md", line: 7, col: undefined });
});
