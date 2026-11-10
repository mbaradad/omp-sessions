import assert from "node:assert/strict";
import { test } from "node:test";
import { type PrFacts, lineCounts, parsePrRevision, prRevisionParts, prSummaryLine } from "../../src/shared/pr-review";

const facts = (f: Partial<PrFacts> = {}): PrFacts => ({ number: 12, url: "https://github.com/o/r/pull/12", state: "open", ci: "passing", review: "approved", mergeability: "mergeable", reviewComments: false, updatedAt: "2026-01-01T00:00:00Z", ...f });

test("prSummaryLine: says only what is known, and nothing about finished PRs", () => {
	assert.equal(prSummaryLine(facts()), "#12 open · CI passing · approved · mergeable");
	assert.equal(prSummaryLine(facts({ ci: "unknown", review: "none", mergeability: "unknown" })), "#12 open");
	assert.equal(prSummaryLine(facts({ ci: "failing", review: "changes_requested", mergeability: "conflicting" }), { unresolvedThreads: 3 }), "#12 open · CI failing · changes requested · 3 unresolved · conflicts");
	assert.equal(prSummaryLine(facts({ reviewComments: true })), "#12 open · CI passing · approved · unresolved comments · mergeable");
	assert.equal(prSummaryLine(facts({ state: "merged", ci: "failing" })), "#12 merged");
});

test("lineCounts", () => {
	assert.equal(lineCounts(12, 3), "+12 −3");
});

test("revision URIs round-trip, keep odd paths, and refuse anything that is not ours", () => {
	const ref = { session: "repo-3", number: 12, url: "https://github.com/o/r/pull/12", side: "before" as const, path: "src/a b/#c.ts", commit: "deadbeef", head: "abc123" };
	const parts = prRevisionParts(ref);
	assert.equal(parts.scheme, "switchyard-pr");
	assert.equal(parts.authority, "repo-3");
	assert.deepEqual(parsePrRevision(parts), ref);
	// Only what is needed is in the URI: a plain after-side revision of the whole PR.
	const plain = prRevisionParts({ session: "s-1", number: 3, side: "after", path: "x.ts" });
	assert.deepEqual(parsePrRevision(plain), { session: "s-1", number: 3, side: "after", path: "x.ts" });
	assert.equal(parsePrRevision({ ...parts, scheme: "file" }), undefined);
	assert.equal(parsePrRevision({ ...parts, query: "n=0&s=after" }), undefined);
	assert.equal(parsePrRevision({ ...parts, query: "n=3&s=sideways" }), undefined);
	assert.equal(parsePrRevision({ ...parts, path: "/" }), undefined);
});
