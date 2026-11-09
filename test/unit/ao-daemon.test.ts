import assert from "node:assert/strict";
import * as os from "node:os";
import { test } from "node:test";
import { daemonUnitName, isolatedHome } from "../../src/ao/daemon";

// An isolated HOME (CONTRACT.md "Isolated HOME") must never reach the user's real `ao-daemon.service`:
// systemctl --user talks to the one real user manager whatever HOME says.
test("daemonUnitName: an isolated HOME never gets the shared ao-daemon unit, even with the default run file", () => {
	const env = { HOME: "/tmp/ao-smoke-x/home" };
	assert.equal(isolatedHome(env), true);
	const unit = daemonUnitName("/tmp/ao-smoke-x/home/.ao/running.json", env);
	assert.match(unit, /^ao-daemon-[0-9a-f]{8}$/);
	// Stable per run file, different between instances.
	assert.equal(daemonUnitName("/tmp/ao-smoke-x/home/.ao/running.json", env), unit);
	assert.notEqual(daemonUnitName("/tmp/ao-smoke-y/home/.ao/running.json", { HOME: "/tmp/ao-smoke-y/home" }), unit);
});

test("isolatedHome: the user's real home is not isolated", () => {
	assert.equal(isolatedHome({ HOME: os.userInfo().homedir }), false);
});
