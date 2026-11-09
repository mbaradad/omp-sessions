// The harness a session runs comes from AO (src/ao/harness.ts), through the bundled CLI against an isolated AO daemon.
// AO's `kimi` chat driver speaks plain ACP, so the scripted fake (test/fake-omp-acp.mjs) stands in for `kimi` as well
// as for `omp`: a second harness, without any real agent. In the fixture no harness is authorized (no logins), so AO's
// default is chosen among the installed chat harnesses: omp, the fake.
import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AoClient } from "../../src/ao/client";
import { type AoFixture, fakeOmpAcpPath, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

const CLI_JS = process.env.OMP_TEST_CLI_JS ?? "";

let ao: AoFixture;
let client: AoClient;
let home: string;
let binDir: string;
let repo: string;
let env: NodeJS.ProcessEnv;

before(async () => {
	if (skip) return;
	home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-it-"));
	binDir = path.join(home, "bin");
	fs.mkdirSync(binDir);
	fs.writeFileSync(path.join(binDir, "kimi"), `#!/bin/sh\nexec "${process.execPath}" "${fakeOmpAcpPath()}" "$@"\n`, { mode: 0o755 });
	ao = await startAoFixture({ pathPrepend: [binDir] });
	repo = ao.scratchRepo("harness-repo");
	const fakeHome = path.join(home, "home");
	fs.mkdirSync(fakeHome, { recursive: true });
	const xdg = { XDG_CONFIG_HOME: path.join(fakeHome, ".config"), XDG_DATA_HOME: path.join(fakeHome, ".local", "share"), XDG_STATE_HOME: path.join(fakeHome, ".local", "state"), XDG_CACHE_HOME: path.join(fakeHome, ".cache") };
	env = { ...process.env, ...ao.stackEnv, HOME: fakeHome, ...xdg, OMP_VSCODE_HOME: path.join(home, "state"), SWITCHYARD_HOME: path.join(home, "switchyard"), NO_COLOR: "1" };
	assert.equal(cli("config", "set", "service", "off").status, 0);
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
});

after(async () => {
	if (skip) return;
	cli("server", "stop");
	const { sessions } = await client.listSessions({}).catch(() => ({ sessions: [] }));
	await Promise.all(sessions.map(s => client.killSession(s.id).catch(() => undefined)));
	await ao?.stop();
	fs.rmSync(home, { recursive: true, force: true });
});

function cli(...args: string[]): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [CLI_JS, ...args], { cwd: repo, env, encoding: "utf8", input: "", timeout: 120_000 });
}

function json<T>(...args: string[]): { status: number | null; data: T; stderr: string } {
	const r = cli(...args);
	try {
		return { status: r.status, data: JSON.parse(r.stdout) as T, stderr: r.stderr };
	} catch {
		assert.fail(`${args.join(" ")} printed no JSON (exit ${r.status}): ${r.stdout}\nstderr: ${r.stderr}`);
	}
}

interface Started {
	id: string;
	harness: string;
	harnessSource: string;
}

/** `wait --json` until the reply is in; the fake echoes `echo <text>`. */
async function replyOf(id: string): Promise<{ state: string; reply?: string; harness?: string }> {
	for (let i = 0; i < 5; i++) {
		const r = json<{ state: string; reply?: string; harness?: string }>("wait", id, "--timeout", "60s", "--json");
		if (r.data.reply !== undefined) return r.data;
		await sleep(500);
	}
	return json<{ state: string; reply?: string; harness?: string }>("show", id, "--json").data;
}

test("harnesses --json: AO's chat harnesses, and the default when none is authorized: omp among the installed ones", { skip }, () => {
	const r = json<{ harnesses: Array<{ id: string; installed: boolean; default: boolean }>; default: { harness: string; source: string; reason: string } }>("harnesses", "--json");
	assert.equal(r.status, 0, r.stderr);
	const ids = r.data.harnesses.map(h => h.id);
	assert.ok(ids.includes("kimi") && ids.includes("omp") && ids.includes("claude-code"), ids.join(", "));
	assert.ok(r.data.harnesses.find(h => h.id === "kimi")?.installed, "the fake kimi is installed");
	assert.deepEqual([r.data.default.harness, r.data.default.source], ["omp", "omp"]);
	assert.match(r.data.default.reason, /installed \(none is authorized\)/);
	assert.ok(r.data.harnesses.find(h => h.id === "omp")?.default);
});

test("new --harness kimi runs that harness: AO spawns it, the reply comes back, ls and show carry the harness", { skip }, async () => {
	const r = json<Started>("new", repo, "-p", "echo PONG", "--harness", "kimi", "--json");
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual([r.data.harness, r.data.harnessSource], ["kimi", "explicit"]);
	assert.equal((await client.getSession(r.data.id)).harness, "kimi");
	const done = await replyOf(r.data.id);
	assert.equal(done.reply, "PONG");
	assert.equal(done.harness, "kimi");
	// Kimi runs only in AO's `default`: the default mode (auto) gives way to it rather than failing.
	assert.equal((await client.getConversation(r.data.id)).settings.approvalMode, "default");
	assert.equal(json<{ mode?: string }>("show", r.data.id, "--json").data.mode, "ask");
	assert.equal(fs.existsSync(path.join(home, "switchyard", "sessions", r.data.id, "mode")), false, "no mode file: the gate is omp's");
	const listed = json<Array<{ meta: { id: string }; harness?: string }>>("ls", "--json").data.find(s => s.meta.id === r.data.id);
	assert.equal(listed?.harness, "kimi");
});

test("without --harness: Switchyard's default, then the project's worker harness, then AO's default", { skip }, async () => {
	const plain = json<Started>("new", repo, "-p", "echo DEFAULT", "--json");
	assert.equal(plain.status, 0, plain.stderr);
	assert.deepEqual([plain.data.harness, plain.data.harnessSource], ["omp", "omp"]);
	assert.match(plain.stderr, /harness omp \(omp: the default when several chat harnesses are installed/);
	assert.equal((await replyOf(plain.data.id)).reply, "DEFAULT");

	// The AO project's worker harness.
	const project = await client.projectForFolder(repo, { create: false });
	assert.ok(project);
	await client.setProjectConfig(project.id, { defaultBranch: "main", worker: { agent: "kimi" } });
	const worker = json<Started>("new", repo, "-p", "echo WORKER", "--json");
	assert.deepEqual([worker.data.harness, worker.data.harnessSource], ["kimi", "project"], worker.stderr);

	// Switchyard's default wins over the project's.
	assert.equal(cli("config", "set", "harness", "omp").status, 0);
	const configured = json<Started>("new", repo, "-p", "echo CONFIG", "--json");
	assert.deepEqual([configured.data.harness, configured.data.harnessSource], ["omp", "config"], configured.stderr);
	assert.equal(cli("config", "set", "harness", "none").status, 0);
	await client.setProjectConfig(project.id, { defaultBranch: "main" });
});

test("refusals: a harness AO can't chat with (listing the available ones), and omp-only plan mode and omp flags for another harness", { skip }, () => {
	const before = cli("ls", "--all", "--json").stdout;
	const unknown = cli("new", repo, "-p", "echo x", "--harness", "aider");
	assert.notEqual(unknown.status, 0);
	assert.match(unknown.stderr, /"aider" is not one of AO's chat harnesses; available: .*kimi.*omp/);
	const plan = cli("new", repo, "-p", "echo x", "--harness", "kimi", "--mode", "plan");
	assert.notEqual(plan.status, 0);
	assert.match(plan.stderr, /--mode plan is omp-only; this session would run kimi/);
	const auto = cli("new", repo, "-p", "echo x", "--harness", "kimi", "--mode", "auto");
	assert.notEqual(auto.status, 0);
	assert.match(auto.stderr, /Permission mode "auto" \(AO bypass-permissions\) is not available for kimi; AO runs it in: ask \(AO default\)/);
	const flags = cli("new", repo, "-p", "echo x", "--harness", "kimi", "--", "--profile", "work");
	assert.notEqual(flags.status, 0);
	assert.match(flags.stderr, /omp flags after -- are omp-only/);
	const config = cli("config", "set", "harness", "aider");
	assert.notEqual(config.status, 0);
	assert.match(config.stderr, /not one of AO's chat harnesses/);
	assert.equal(cli("ls", "--all", "--json").stdout, before, "nothing was created");
});
