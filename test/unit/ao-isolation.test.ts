import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AoClient } from "../../src/ao/client";
import { ensureDaemon } from "../../src/ao/daemon";
import { refuseRealStateInTests } from "../../src/ao/native";
import { spawnSwitchyardSession } from "../../src/ao/spawn";

/** A client that records every call and fails it: what a refused spawn must never reach. */
function tripwire() {
	const calls: string[] = [];
	const client = new Proxy({}, { get: (_t, name) => () => (calls.push(String(name)), Promise.reject(new Error("client used"))) });
	return { client: client as unknown as AoClient, calls };
}

async function withEnv<T>(over: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(over).map(k => [k, process.env[k]]));
	for (const [k, v] of Object.entries(over)) v === undefined ? delete process.env[k] : (process.env[k] = v);
	try {
		return await run();
	} finally {
		for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
	}
}

test("a test run that forgot SWITCHYARD_HOME cannot write the real ~/.switchyard: spawn refuses before it touches AO", async () => {
	assert.ok(process.env.NODE_TEST_CONTEXT, "this runs under node --test");
	const realHome = os.userInfo().homedir;
	await withEnv({ HOME: realHome, SWITCHYARD_HOME: undefined }, async () => {
		const { client, calls } = tripwire();
		await assert.rejects(spawnSwitchyardSession(client), /refusing to use .*\.switchyard from a test run/);
		await assert.rejects(spawnSwitchyardSession(client, { home: path.join(realHome, ".switchyard") }), /refusing to use/);
		assert.deepEqual(calls, [], "nothing was created in AO either");
	});
});

test("a temp SWITCHYARD_HOME (or an explicit home) is not refused", async () => {
	const tmp = path.join(os.tmpdir(), "ao-isolation-test");
	await withEnv({ SWITCHYARD_HOME: tmp }, async () => {
		const { client, calls } = tripwire();
		await assert.rejects(spawnSwitchyardSession(client), /client used/, "got past the guard to AO");
		assert.ok(calls.length > 0);
	});
	assert.doesNotThrow(() => refuseRealStateInTests(tmp));
	assert.doesNotThrow(() => refuseRealStateInTests(path.join(os.userInfo().homedir, ".switchyard-other")));
});

test("ensureDaemon does not start a daemon (or install its unit) from a test run with the real HOME", async () => {
	const env = { ...process.env, HOME: os.userInfo().homedir, AO_RUN_FILE: path.join(os.tmpdir(), "ao-isolation-none", "running.json") };
	// No daemon answers (the shared dev daemon on :3001 must not be found): ensureDaemon is about to start one.
	const noDaemon = async (): Promise<Response> => Promise.reject(new Error("connection refused"));
	await assert.rejects(ensureDaemon({ env, runFile: env.AO_RUN_FILE, aoPath: process.execPath, supervisor: "detached", fetch: noDaemon }), /refusing to start an AO daemon from a test run/);
});
