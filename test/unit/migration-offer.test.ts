import assert from "node:assert/strict";
import { test } from "node:test";
import { migrationPending } from "../../src/ext/migration-offer";

const has = (...files: string[]) => (p: string) => files.includes(p);

test("migrationPending: old omp Sessions data and no migrate marker; the runtime copy alone is not data", () => {
	assert.equal(migrationPending("/old", "/new", has("/old/organize.json")), true);
	assert.equal(migrationPending("/old", "/new", has("/old/sessions")), true);
	assert.equal(migrationPending("/old", "/new", has("/old", "/old/runtime")), false);
	assert.equal(migrationPending("/old", "/new", has("/old/organize.json", "/new/migration.json")), false);
	assert.equal(migrationPending("/old", "/new", has()), false);
});
