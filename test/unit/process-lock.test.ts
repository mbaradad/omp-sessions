// Process stamps and lock files (server pid file, session host lock, slot leases): a reused pid or
// a dead owner never holds a lock; a live owner always does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { claimLock, holdsLock, lockOwner, processStamp, releaseLock, stampAlive } from "../../src/shared/process-lock";
import { spawnTarget } from "../../src/shared/win-spawn";

function tempFile(t: { after(fn: () => void): void }): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lock-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, "x.lock");
}

test("stampAlive: this process yes; a dead pid, another boot, or a reused pid no", () => {
	assert.equal(stampAlive(processStamp()), true);
	assert.equal(stampAlive({ pid: process.pid }), true, "older plain records: pid only");
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	assert.equal(stampAlive({ pid: dead }), false);
	// The same pid in another boot (after a reboot) is someone else.
	assert.equal(stampAlive({ ...processStamp(), bootId: "another-boot", bootAt: 0 }), false);
});

test("claimLock: exclusive between live owners; dead, reused or abandoned owners are taken over", t => {
	const file = tempFile(t);
	assert.equal(claimLock(file), true);
	assert.equal(claimLock(file), true, "already ours");
	assert.equal(holdsLock(file), true);
	releaseLock(file);
	assert.equal(fs.existsSync(file), false);

	// A live owner (our parent) keeps it, unless the caller declares it abandoned.
	fs.writeFileSync(file, JSON.stringify(processStamp(process.ppid)));
	assert.equal(claimLock(file), false);
	assert.equal(claimLock(file, {}, () => true), true);
	assert.equal(lockOwner(file)?.pid, process.pid);

	// A pid file of an older version naming a dead process, and a reused pid from another boot.
	fs.writeFileSync(file, String(spawnSync(process.execPath, ["-e", ""]).pid));
	assert.equal(claimLock(file), true);
	fs.writeFileSync(file, JSON.stringify({ ...processStamp(), bootId: "another-boot", bootAt: 0 }));
	assert.equal(claimLock(file), true);
	assert.equal(holdsLock(file), true);
});

test("spawnTarget: .cmd shims on Windows go through cmd.exe with every metacharacter escaped", () => {
	assert.deepEqual(spawnTarget("/usr/bin/omp", ["--cwd", "a b&c"], "linux"), { file: "/usr/bin/omp", args: ["--cwd", "a b&c"], windowsVerbatimArguments: false });
	assert.equal(spawnTarget("C:\\bin\\omp.exe", ["x&y"], "win32").windowsVerbatimArguments, false);
	const target = spawnTarget("C:\\npm\\omp.cmd", ["--cwd", "C:\\John Doe\\a&calc", "%PATH%", 'say "hi"'], "win32");
	assert.equal(target.windowsVerbatimArguments, true);
	assert.deepEqual(target.args.slice(0, 3), ["/d", "/s", "/c"]);
	const line = target.args[3];
	// Inside the outer quotes, every metacharacter carries a caret (cmd /c and the shim's %* line each strip one); spaces between arguments separate them.
	const inner = line.slice(1, -1);
	for (const ch of ["&", "%", '"']) {
		for (let i = inner.indexOf(ch); i >= 0; i = inner.indexOf(ch, i + 1)) assert.equal(inner[i - 1], "^", `unescaped ${ch} at ${i}: ${inner}`);
	}
});
