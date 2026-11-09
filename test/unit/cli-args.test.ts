// `omp-sessions` argument parsing: value flags, per-command flag checks, start times.
import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageError, checkFlags, parseArgs, parseWhen } from "../../src/cli/args";

test("parseArgs: value flags, repeated --sub, short aliases, --x=y, -- passthrough", () => {
	const a = parseArgs(["new", "dir", "--task", "Do it", "--sub", "one", "--sub", "two", "-p", "hi", "--all", "--priority=high", "--", "--literal"]);
	assert.deepEqual(a._, ["new", "dir", "--literal"]);
	assert.deepEqual(a.dashes, ["--literal"], "what followed -- stays identifiable (new passes it to omp)");
	assert.deepEqual(parseArgs(["new", "dir", "--json"]).dashes, []);
	assert.equal(a.flags.get("task"), "Do it");
	assert.deepEqual(a.multi.get("sub"), ["one", "two"]);
	assert.equal(a.flags.get("prompt"), "hi");
	assert.equal(a.flags.get("all"), true);
	assert.equal(a.flags.get("priority"), "high");
	assert.throws(() => parseArgs(["--title"]), UsageError);
});

test("parseArgs: a value flag followed by another flag is a missing value; --x=--y passes one on purpose", () => {
	assert.throws(() => parseArgs(["new", "--title", "--json"]), UsageError);
	assert.equal(parseArgs(["new", "--title=--json"]).flags.get("title"), "--json");
	assert.equal(parseArgs(["new", "-p", "-"]).flags.get("prompt"), "-");
});

test("checkFlags: a command refuses flags it doesn't take", () => {
	checkFlags(parseArgs(["ls", "--json", "--tag", "x", "-h"]), "ls", ["json", "tag"]);
	assert.throws(() => checkFlags(parseArgs(["ls", "--group", "g", "--bogus"]), "ls", ["group"]), (err: unknown) => err instanceof UsageError && /--bogus/.test(err.message));
});

test("parseWhen: relative, next clock time, ISO; invalid or past times are usage errors", () => {
	const now = new Date(2025, 0, 15, 15, 0, 0).getTime();
	assert.equal(parseWhen("+30m", now), now + 30 * 60_000);
	assert.equal(parseWhen("16:30", now), new Date(2025, 0, 15, 16, 30).getTime());
	// Already past today → tomorrow.
	assert.equal(parseWhen("09:00", now), new Date(2025, 0, 16, 9, 0).getTime());
	assert.equal(parseWhen("2025-02-01T08:00:00Z", now), Date.UTC(2025, 1, 1, 8));
	for (const bad of ["soonish", "25:99", "12:60", "2024-01-01T08:00:00Z", "3"]) assert.throws(() => parseWhen(bad, now), UsageError, bad);
});

