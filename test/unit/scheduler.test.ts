// Global concurrency slots (src/shared/scheduler.ts) in a temp OMP_VSCODE_HOME.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { listWaiting, tryAcquireSlot, writeScheduler } from "../../src/shared/scheduler";

test("waiters are served first come, first served, even when the wall clock stepped back between arrivals", t => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-slots-"));
	const prev = process.env.OMP_VSCODE_HOME;
	process.env.OMP_VSCODE_HOME = home;
	t.after(() => {
		if (prev === undefined) delete process.env.OMP_VSCODE_HOME;
		else process.env.OMP_VSCODE_HOME = prev;
		fs.rmSync(home, { recursive: true, force: true });
	});
	writeScheduler({ maxConcurrent: 1 });
	assert.deepEqual(tryAcquireSlot("running", "t0"), { acquired: true });
	// Mocked near the real clock: lease liveness compares against boot time, which a 1970 "now" would break.
	const base = Date.now();
	let now = base;
	t.mock.method(Date, "now", () => now);
	assert.deepEqual(tryAcquireSlot("first", "t1"), { acquired: false, position: 1, since: base });
	// The clock steps back (WSL2 does, ~3 s at a time): the later arrival still queues behind.
	now = base - 3000;
	assert.deepEqual(tryAcquireSlot("second", "t2"), { acquired: false, position: 2, since: base - 3000 });
	assert.deepEqual(tryAcquireSlot("first", "t1"), { acquired: false, position: 1, since: base });
	assert.deepEqual(listWaiting().map(w => w.sessionId), ["first", "second"]);
});
