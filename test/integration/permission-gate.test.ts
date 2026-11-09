// G46: spawnSwitchyardSession fails closed. A permission mode other than `auto` (ask, edits, plan) is enforced by the
// Switchyard omp extension's gate, so without that gate installed in omp's agent dir the spawn is refused before any AO
// call or file write; `auto` never needs it. The fixture's `standInGate()` is how tests install one (fake omp only).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { AoClient } from "../../src/ao/client";
import { spawnSwitchyardSession } from "../../src/ao/spawn";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

let ao: AoFixture;
let client: AoClient;
let repo: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	repo = ao.scratchRepo();
});

after(async () => {
	await ao?.stop();
});

const sessionCount = async (): Promise<number> => (await client.listSessions()).sessions.length;

test("a mode other than auto is refused without the gate: no AO session, no mode file", { skip }, async () => {
	const before = await sessionCount();
	for (const mode of ["ask", "edits", "plan"] as const) {
		await assert.rejects(spawnSwitchyardSession(client, { dir: repo, mode, prompt: "echo never" }), /needs the Switchyard permission gate, which is not installed/);
	}
	assert.equal(await sessionCount(), before, "refused before any AO call: not even a terminated row is left");
	assert.ok(!fs.existsSync(path.join(ao.switchyardHome, "sessions")), "and before any file write");
});

test("auto never needs the gate", { skip }, async () => {
	const spawned = await spawnSwitchyardSession(client, { dir: repo, prompt: "echo auto-ok" });
	assert.ok(spawned.session.id);
	assert.equal(fs.readFileSync(path.join(ao.switchyardHome, "sessions", spawned.session.id, "mode"), "utf8").trim(), "auto");
});

test("with the stand-in gate installed the same modes spawn, and the mode is written", { skip }, async () => {
	const gate = ao.standInGate();
	assert.ok(fs.existsSync(path.join(ao.agentDir as string, "extensions", "switchyard", "mode.js")), "installed into the fixture's own agent dir");
	const spawned = await spawnSwitchyardSession(client, { dir: repo, mode: "edits", gate, prompt: "echo gated" });
	assert.equal(fs.readFileSync(path.join(ao.switchyardHome, "sessions", spawned.session.id, "mode"), "utf8").trim(), "edits");
});

test("standInGate refuses to write into the real agent dir", { skip }, async () => {
	const real = await startAoFixture({ realOmp: true });
	try {
		assert.throws(() => real.standInGate(), /needs the fake omp/);
	} finally {
		await real.stop();
	}
});
