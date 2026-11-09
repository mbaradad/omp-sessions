// The shipped `omp` shim (src/omp-shim/omp, GAPS.md G34) in front of the fake omp on a stock AO daemon: the
// machine default applies on the first launch, the session's `omp-args` file after exit + resume, and the
// fake receives the argument list AO built plus the extra flags.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AoClient } from "../../src/ao/client";
import { installOmpShim } from "../../src/shared/omp-extension-install";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

let ao: AoFixture;
let client: AoClient;
let projectId: string;
let binDir: string;
let switchyardHome: string;

before(async () => {
	if (skip) return;
	binDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omp-shim-bin-"));
	assert.equal(installOmpShim(path.resolve(process.cwd(), "src/omp-shim/omp"), binDir), process.platform === "win32" ? "skipped" : "installed");
	ao = await startAoFixture({ pathPrepend: [binDir] });
	switchyardHome = path.join(ao.root, "switchyard");
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	projectId = await ao.createProject(ao.scratchRepo());
});

after(async () => {
	await ao?.stop();
	if (binDir) fs.rmSync(binDir, { recursive: true, force: true });
});

/** argv of every `omp acp` launch the fake saw, in order (background chats excluded). */
const launches = (): string[][] => ao.fakeOmpFrames().filter(f => f.dir === "argv" && f.argv?.[0] === "acp").map(f => f.argv as string[]);

async function launched(count: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (launches().length < count) {
		assert.ok(Date.now() < deadline, `omp launched ${count} times`);
		await sleep(100);
	}
}

test("the shipped shim adds machine flags at launch and the session's flags after resume; the fake sees the whole argv", { skip: skip || process.platform === "win32" }, async () => {
	const plain = launches().length;
	const { session } = await client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName: "shim", branch: "shim", approvalMode: "bypass-permissions", prompt: "echo first" });
	await launched(plain + 1);
	assert.ok(!launches().at(-1)?.includes("--advisor"), "no settings yet: a plain launch");

	fs.writeFileSync(path.join(switchyardHome, "config.json"), JSON.stringify({ omp: { extraArgs: ["--profile", "work"] } }));
	fs.mkdirSync(path.join(switchyardHome, "sessions", session.id), { recursive: true });
	fs.writeFileSync(path.join(switchyardHome, "sessions", session.id, "omp-args"), "--advisor --plan-yolo\n");
	await client.exitAgent(session.id);
	await client.resumeAgent(session.id);
	await launched(plain + 2);
	const again = launches().at(-1) as string[];
	assert.equal(again[0], "acp");
	assert.deepEqual(again.slice(-4), ["--profile", "work", "--advisor", "--plan-yolo"], "machine flags, then the session's");
	assert.equal(again.filter(a => a === "acp").length, 1);
});

test("a malformed machine config never stops omp from launching", { skip: skip || process.platform === "win32" }, async () => {
	const before = launches().length;
	fs.writeFileSync(path.join(switchyardHome, "config.json"), "{ broken");
	const { session } = await client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName: "broken", branch: "broken", approvalMode: "bypass-permissions", prompt: "echo second" });
	await launched(before + 1);
	const argv = launches().at(-1) as string[];
	assert.equal(argv[0], "acp");
	assert.ok(!argv.includes("--profile"));
	assert.ok(session.id);
});
