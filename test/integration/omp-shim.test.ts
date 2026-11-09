// G34: extra omp launch arguments on stock AO through an `omp` shim earlier on the daemon's PATH. This pins the
// fixture side of that route (`pathPrepend`, AO resolving omp from PATH, the fake receiving the extra argv,
// resume re-running the shim); the shipped shim (checkpoints) is tested by its own owner. The stand-in below
// behaves as mapping's: for `omp acp` inside an AO session it appends the flags of the session's `omp-args`
// file, and otherwise passes everything through to the next `omp` on PATH.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AoClient } from "../../src/ao/client";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

let ao: AoFixture;
let client: AoClient;
let projectId: string;
let shimDir: string;
let argsDir: string;

before(async () => {
	if (skip) return;
	shimDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "omp-shim-"));
	argsDir = path.join(shimDir, "sessions");
	fs.writeFileSync(
		path.join(shimDir, "omp"),
		`#!/bin/sh
# Stand-in omp shim: next omp on PATH, with the session's extra args appended for \`omp acp\` under AO.
self="$(cd "$(dirname "$0")" && pwd)"
PATH="$(printf %s "$PATH" | tr ':' '\\n' | grep -vxF "$self" | paste -sd:)"
if [ "$1" = acp ] && [ -n "$AO_SESSION_ID" ] && [ -f "${argsDir}/$AO_SESSION_ID/omp-args" ]; then
  exec omp "$@" $(cat "${argsDir}/$AO_SESSION_ID/omp-args")
fi
exec omp "$@"
`,
		{ mode: 0o755 },
	);
	ao = await startAoFixture({ pathPrepend: [shimDir] });
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	projectId = await ao.createProject(ao.scratchRepo());
});

after(async () => {
	await ao?.stop();
	if (shimDir) fs.rmSync(shimDir, { recursive: true, force: true });
});

/** argv of every `omp acp` launch of the session's omp, in order (background chats excluded). */
const launches = (): string[][] => ao.fakeOmpFrames().filter(f => f.dir === "argv" && f.argv?.[0] === "acp").map(f => f.argv as string[]);

test("a shim in front of omp adds the session's extra args on launch and again after resume", { skip }, async () => {
	const { session } = await client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName: "shim", branch: "shim", approvalMode: "bypass-permissions", prompt: "echo first" });
	// Without a file the shim passes everything through.
	const plain = launches();
	assert.equal(plain.length, 1);
	assert.ok(!plain[0].includes("--advisor"));
	// The session id exists only after spawn: the flags are written then and applied by exit + resume (D11).
	fs.mkdirSync(path.join(argsDir, session.id), { recursive: true });
	fs.writeFileSync(path.join(argsDir, session.id, "omp-args"), "--advisor --plan-yolo\n");
	await client.exitAgent(session.id);
	await client.resumeAgent(session.id);
	const deadline = Date.now() + 30_000;
	while (launches().length < 2) {
		assert.ok(Date.now() < deadline, "omp launched again after resume");
		await sleep(100);
	}
	const again = launches().at(-1) as string[];
	assert.deepEqual(again.slice(-2), ["--advisor", "--plan-yolo"]);
	assert.equal(again[0], "acp");
});
