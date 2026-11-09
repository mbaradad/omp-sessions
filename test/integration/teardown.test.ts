// Teardown of the AO fixture. AO's chat hosts are detached on purpose (setsid): they survive the daemon, so a
// fixture that only stops the daemon leaves `ao chat-host … fake-omp-acp` processes behind. stop() must kill
// every session through the API, stop the daemon, reap whatever still references the fixture, and fail if
// anything survives. The scan below is independent of the fixture's own bookkeeping (it reads /proc itself).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AoClient } from "../../src/ao/client";
import { skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";
import { startPlannerFixture } from "../planner-fixture.mjs";

/** Every process that names `root` (as an argument or by its working directory): hosts, omp, the planner. */
function processesOf(root: string): { pid: number; what: string }[] {
	const found: { pid: number; what: string }[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
		try {
			const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
			const cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
			if (argv.some(a => a === root || a.startsWith(root + path.sep)) || cwd === root || cwd.startsWith(root + path.sep)) found.push({ pid: Number(entry), what: argv.slice(0, 3).join(" ") });
		} catch {
			// gone, or not ours to read
		}
	}
	return found;
}

/** Alive and not a zombie (a killed child stays a zombie until its parent reaps it, and `kill(pid, 0)` still succeeds). */
function isRunning(pid: number): boolean {
	try {
		return !fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^\d+ \(.*\) /s, "").startsWith("Z");
	} catch {
		return false;
	}
}

async function waitForHosts(root: string, count: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (processesOf(root).filter(p => p.what.includes("chat-host")).length < count) {
		assert.ok(Date.now() < deadline, `${count} chat host(s) started`);
		await sleep(100);
	}
}

test("stop() leaves no chat host, omp or planner behind: idle, running and approval-blocked sessions, planner still up", { skip: skip || process.platform !== "linux" }, async () => {
	const ao = await startAoFixture();
	const root = fs.realpathSync(ao.root);
	const client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	const projectId = await ao.createProject(ao.scratchRepo());
	const planner = await startPlannerFixture({ ao }); // deliberately not stopped: ao.stop() must take it with it
	const spawn = (displayName: string, prompt: string) => client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName, branch: displayName, approvalMode: "default", prompt });
	await spawn("idle", "echo done");
	await spawn("running", "slow 120000");
	await spawn("blocked", "bash true");
	await waitForHosts(root, 3);
	assert.ok(processesOf(root).length >= 4, "hosts, their omp and the planner are running");

	await ao.stop();

	assert.deepEqual(processesOf(root), [], "nothing of the fixture survives stop()");
	assert.ok(!fs.existsSync(root), "the temp dir is gone");
	assert.ok(!isRunning(planner.pid), "the planner process is gone");
});

test("stop() after the daemon died: the detached hosts it left behind are still reaped", { skip: skip || process.platform !== "linux" }, async () => {
	const ao = await startAoFixture();
	const root = fs.realpathSync(ao.root);
	const client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	const projectId = await ao.createProject(ao.scratchRepo());
	await client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName: "orphan", branch: "orphan", approvalMode: "default", prompt: "slow 120000" });
	await waitForHosts(root, 1);

	// A crash of the daemon (or a test process killed before it could stop it): the hosts outlive it by design.
	process.kill(ao.pid, "SIGKILL");
	await sleep(500);
	assert.ok(processesOf(root).some(p => p.what.includes("chat-host")), "the host survives its daemon");

	await ao.stop();
	assert.deepEqual(processesOf(root), []);
	assert.ok(!fs.existsSync(root));
});

test("stop() reaps a SIGTERM-proof process left in the fixture tree", { skip: skip || process.platform !== "linux" }, async () => {
	const ao = await startAoFixture();
	const root = fs.realpathSync(ao.root);
	// Stands in for a survivor: ignores SIGTERM (SIGKILL cannot be ignored), so teardown must escalate.
	const stubborn = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { cwd: root, stdio: "ignore", detached: true });
	stubborn.unref();
	await sleep(200);
	assert.ok(isRunning(stubborn.pid as number), "the stand-in runs");
	await ao.stop();
	assert.deepEqual(processesOf(root), [], "a SIGTERM-proof process in the fixture tree is killed too");
	assert.ok(!isRunning(stubborn.pid as number));
});
