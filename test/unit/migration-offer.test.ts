import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { migrationPending } from "../../src/ext/migration-offer";

/** The files that exist, written POSIX-style; migrationPending asks with native separators (path.join). */
const has = (...files: string[]) => (p: string) => files.map(f => path.normalize(f)).includes(p);
const marker = (content: string) => () => content;

test("migrationPending: old data and no completedAt marker; the runtime copy alone is not data", () => {
	assert.equal(migrationPending("/old", "/new", has("/old/organize.json")), true);
	assert.equal(migrationPending("/old", "/new", has("/old/sessions")), true);
	assert.equal(migrationPending("/old", "/new", has("/old", "/old/runtime")), false);
	assert.equal(migrationPending("/old", "/new", has()), false);
});

test("migrationPending: only a completedAt marks it done; a migration.json from a partial run or a dry run does not", () => {
	const files = has("/old/organize.json", "/new/migration.json");
	assert.equal(migrationPending("/old", "/new", files, marker('{"version":1,"completedAt":"2026-11-10T10:00:00.000Z"}')), false);
	assert.equal(migrationPending("/old", "/new", files, marker('{"version":1,"backups":[]}')), true);
	assert.equal(migrationPending("/old", "/new", files, marker("not json")), true);
});
