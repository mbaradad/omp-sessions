import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type DiffLine, diffTexts, parseOmpDiff } from "../../src/shared/diff";

const lines = (n: number, prefix = "l"): string => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}\n`).join("");
const ops = (ls: DiffLine[]): string => ls.map(l => l.t).join("");

describe("diffTexts", () => {
	test("identical texts produce no hunks; every line is trailing", () => {
		const d = diffTexts("a\nb\nc\n", "a\nb\nc\n");
		assert.deepEqual(d, { hunks: [], added: 0, removed: 0, trailing: 3, coarse: undefined });
	});

	test("both empty", () => {
		assert.deepEqual(diffTexts("", ""), { hunks: [], added: 0, removed: 0, trailing: 0, coarse: undefined });
	});

	test("a missing final newline is not a change", () => {
		const d = diffTexts("a\nb", "a\nb\n");
		assert.equal(d.hunks.length, 0);
		assert.equal(d.trailing, 2);
	});

	test("insert in the middle keeps old/new line numbers", () => {
		const d = diffTexts("a\nb\nc\n", "a\nb\nX\nc\n");
		assert.equal(d.added, 1);
		assert.equal(d.removed, 0);
		assert.equal(d.trailing, 0);
		assert.equal(d.hunks.length, 1);
		assert.deepEqual(d.hunks[0], {
			oldStart: 1,
			newStart: 1,
			skipped: 0,
			lines: [
				{ t: " ", o: 1, n: 1, s: "a" },
				{ t: " ", o: 2, n: 2, s: "b" },
				{ t: "+", n: 3, s: "X" },
				{ t: " ", o: 3, n: 4, s: "c" },
			],
		});
	});

	test("delete with context: skipped before, trailing after", () => {
		const before = lines(10);
		const after = before.replace("l5\n", "");
		const d = diffTexts(before, after);
		assert.equal(d.removed, 1);
		assert.equal(d.added, 0);
		assert.equal(d.hunks.length, 1);
		const h = d.hunks[0];
		assert.equal(h.skipped, 1);
		assert.equal(h.oldStart, 2);
		assert.equal(h.newStart, 2);
		assert.equal(ops(h.lines), "   -   ");
		assert.deepEqual(h.lines[3], { t: "-", o: 5, s: "l5" });
		assert.deepEqual(h.lines[4], { t: " ", o: 6, n: 5, s: "l6" });
		assert.equal(d.trailing, 2);
	});

	test("single-line replace", () => {
		const d = diffTexts("x\n", "y\n");
		assert.deepEqual(d.hunks, [
			{
				oldStart: 1,
				newStart: 1,
				skipped: 0,
				lines: [
					{ t: "-", o: 1, s: "x" },
					{ t: "+", n: 1, s: "y" },
				],
			},
		]);
		assert.equal(d.added, 1);
		assert.equal(d.removed, 1);
	});

	test("empty old file: whole file added", () => {
		const d = diffTexts("", "a\nb\n");
		assert.equal(d.added, 2);
		assert.equal(d.removed, 0);
		assert.equal(d.hunks.length, 1);
		assert.equal(d.hunks[0].oldStart, 1);
		assert.equal(d.hunks[0].newStart, 1);
		assert.equal(ops(d.hunks[0].lines), "++");
		assert.equal(d.trailing, 0);
	});

	test("empty new file: whole file removed", () => {
		const d = diffTexts("a\nb\n", "");
		assert.equal(d.removed, 2);
		assert.equal(d.added, 0);
		assert.equal(ops(d.hunks[0].lines), "--");
		assert.equal(d.hunks[0].newStart, 1);
	});

	test("distant changes split into hunks with skipped/trailing counts", () => {
		const before = lines(30);
		const after = before.replace("l2\n", "L2\n").replace("l25\n", "L25\n");
		const d = diffTexts(before, after);
		assert.equal(d.hunks.length, 2);
		const [h1, h2] = d.hunks;
		assert.equal(h1.skipped, 0);
		assert.equal(ops(h1.lines), " -+   ");
		assert.equal(h2.skipped, 16);
		assert.equal(h2.oldStart, 22);
		assert.equal(h2.newStart, 22);
		assert.equal(ops(h2.lines), "   -+   ");
		assert.equal(d.trailing, 2);
		assert.equal(d.added + d.removed, 4);
	});

	test("nearby changes merge into one hunk", () => {
		const before = lines(20);
		const after = before.replace("l5\n", "L5\n").replace("l11\n", "L11\n");
		const d = diffTexts(before, after);
		assert.equal(d.hunks.length, 1);
		assert.equal(ops(d.hunks[0].lines), "   -+     -+   ");
	});

	test("custom context size", () => {
		const d = diffTexts(lines(10), lines(10).replace("l5\n", "X\n"), 0);
		assert.equal(d.hunks.length, 1);
		assert.equal(d.hunks[0].skipped, 4);
		assert.equal(ops(d.hunks[0].lines), "-+");
		assert.equal(d.trailing, 5);
	});

	test("coarse fallback when the edit distance is too large", () => {
		const d = diffTexts(lines(2001, "a"), lines(2001, "b"));
		assert.equal(d.coarse, true);
		assert.equal(d.removed, 2001);
		assert.equal(d.added, 2001);
		assert.equal(d.hunks.length, 1);
		assert.equal(d.hunks[0].lines.length, 4002);
		assert.ok(d.hunks[0].lines.slice(0, 2001).every(l => l.t === "-"));
	});
});

describe("parseOmpDiff", () => {
	test("context/remove/add rows", () => {
		const d = parseOmpDiff(" 1|ctx\n-2|old\n+2|new\n 3|after");
		assert.equal(d.added, 1);
		assert.equal(d.removed, 1);
		assert.equal(d.trailing, 0);
		assert.deepEqual(d.hunks, [
			{
				oldStart: 1,
				newStart: 1,
				skipped: 0,
				lines: [
					{ t: " ", n: 1, o: 1, s: "ctx" },
					{ t: "-", o: 2, s: "old" },
					{ t: "+", n: 2, s: "new" },
					{ t: " ", n: 3, o: 3, s: "after" },
				],
			},
		]);
	});

	test("context rows after an insertion map back to old line numbers", () => {
		const d = parseOmpDiff(" 1|a\n+2|ins\n 3|b");
		assert.deepEqual(
			d.hunks[0].lines.map(l => [l.t, l.o, l.n]),
			[
				[" ", 1, 1],
				["+", undefined, 2],
				[" ", 2, 3],
			],
		);
	});

	test("padded numbers and separator rows start new hunks", () => {
		const d = parseOmpDiff("  9|a\n- 10|b\n+ 10|B\n…\n 40|c\n-41|d");
		assert.equal(d.hunks.length, 2);
		assert.equal(d.hunks[0].skipped, 0);
		assert.equal(d.hunks[0].oldStart, 9);
		assert.equal(d.hunks[1].skipped, 1);
		assert.equal(d.hunks[1].newStart, 40);
		assert.equal(d.removed, 2);
		assert.equal(d.added, 1);
	});

	test("empty diff", () => {
		assert.deepEqual(parseOmpDiff(""), { hunks: [], added: 0, removed: 0, trailing: 0 });
	});
});
