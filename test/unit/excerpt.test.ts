import assert from "node:assert/strict";
import { test } from "node:test";
import { plainExcerpt } from "../../src/shared/excerpt";

test("plainExcerpt drops Markdown markup and keeps the words", () => {
	const reply = "## Done\n\nPublic routes are now limited to **100 requests** per minute.\n\n- `src/rate-limit.ts:9`: token bucket\n1. see [the docs](https://example.com)\n> quoted";
	assert.equal(plainExcerpt(reply), "Done Public routes are now limited to 100 requests per minute. src/rate-limit.ts:9: token bucket see the docs quoted");
});

test("plainExcerpt skips code blocks, including an unterminated one", () => {
	assert.equal(plainExcerpt("Run this:\n```sh\nnpm test\n```\nthen commit."), "Run this: then commit.");
	assert.equal(plainExcerpt("Started:\n```ts\nconst x = 1;"), "Started:");
});

test("plainExcerpt keeps inline symbols that are not markup and cuts at the limit", () => {
	assert.equal(plainExcerpt("a - b * c = 3 > 2"), "a - b * c = 3 > 2");
	assert.equal(plainExcerpt("x".repeat(300)).length, 240);
	assert.equal(plainExcerpt("hello world", 5), "hello");
});
