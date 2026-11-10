// `switchyard orchestrator …` (the bundled cli.js) against an isolated AO daemon with the scripted fake omp: a task
// starts the project's orchestrator, its chat is reachable by id like any session, its settings round-trip, and it
// can be replaced and stopped.
import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AoClient } from "../../src/ao/client";
import type { OrchestratorConfig, OrchestratorInfo } from "../../src/ao/orchestrator";
import { type AoFixture, aoAvailable, startAoFixture } from "../ao-fixture.mjs";

const skip = aoAvailable() ? false : "ao not installed (set SWITCHYARD_TEST_AO_BIN)";
const CLI_JS = process.env.OMP_TEST_CLI_JS ?? "";

let ao: AoFixture;
let client: AoClient;
let repo: string;
let home: string;
let env: NodeJS.ProcessEnv;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	repo = ao.scratchRepo("orch-cli");
	home = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cli-it-"));
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

function cliWithStdin(input: string, ...args: string[]): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [CLI_JS, ...args], { cwd: repo, env, encoding: "utf8", input, timeout: 120_000 });
}

/** The command's stdout parsed; an unreadable one fails with what it printed. */
function json<T>(...args: string[]): { status: number | null; data: T } {
	const r = cli(...args);
	try {
		return { status: r.status, data: JSON.parse(r.stdout) as T };
	} catch {
		return assert.fail(`${args.join(" ")} printed no JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
	}
}

interface Status {
	project: { id: string; name: string };
	orchestrator: OrchestratorInfo | null;
}

/** Re-reads `status` until `check` holds (the fake omp's reply streams in); a hang fails on the deadline (a real daemon, nothing to await). */
async function statusUntil(what: string, check: (o: OrchestratorInfo) => boolean): Promise<OrchestratorInfo> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const { data } = json<Status>("orchestrator", "status", "--json");
		if (data.orchestrator && check(data.orchestrator)) return data.orchestrator;
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(data.orchestrator?.state)} ${JSON.stringify(data.orchestrator?.reply)}`);
		await sleep(300);
	}
}

test("status of a repository AO has no project for says there is no orchestrator, and registers nothing", { skip }, async () => {
	const { status, data } = json<{ project: null; orchestrator: null; note: string }>("orchestrator", "status", "--json");
	assert.equal(status, 0);
	assert.equal(data.orchestrator, null);
	assert.equal(data.project, null);
	assert.match(data.note, /AO has no project for yet/);
	const text = cli("orchestrator");
	assert.equal(text.status, 0);
	assert.match(text.stdout, /no orchestrator yet/);
	assert.deepEqual(
		(await client.listProjects()).filter(p => p.path.endsWith("orch-cli")),
		[],
	);
});

test("submit starts the orchestrator in this folder's project; its chat answers show, tail and status", { skip }, async () => {
	const { status, data: sent } = json<{ orchestrator: string; started: boolean; turnId?: string; mode: string; project: string }>("orchestrator", "submit", "Split the billing rewrite into steps", "--json");
	assert.equal(status, 0);
	assert.equal(sent.started, true);
	assert.equal(sent.mode, "send");
	assert.ok(sent.turnId);

	const o = await statusUntil("the orchestrator's reply", x => x.state === "idle" && !!x.reply?.includes("billing rewrite"));
	assert.equal(o.id, sent.orchestrator);
	assert.equal(o.mode, "chat");

	// It is a session: the session commands take its id.
	const shown = json<{ id: string; state: string; reply: string }>("show", o.id, "--json");
	assert.equal(shown.data.id, o.id);
	assert.match(shown.data.reply, /billing rewrite/);
	assert.match(cli("tail", o.id, "-n", "5").stdout, /billing rewrite/);
	// …but not an entry of the worker lists.
	const listed = json<Array<{ meta: { id: string } }>>("ls", "--all", "--json").data;
	assert.ok(!listed.some(s => s.meta.id === o.id));

	const text = cli("orchestrator", "status").stdout;
	assert.match(text, new RegExp(`orchestrator ${o.id}`));
	assert.match(text, /workers 0/);
});

test("a task piped on stdin and --steer reach the same orchestrator", { skip }, async () => {
	const r = cliWithStdin("Also keep the old API for one release", "orchestrator", "submit", "-", "--steer", "--json");
	assert.equal(r.status, 0, r.stderr);
	const sent = JSON.parse(r.stdout) as { started: boolean; mode: string; orchestrator: string };
	assert.equal(sent.started, false);
	assert.equal(sent.mode, "steer");
	const o = await statusUntil("the steered reply", x => !!x.reply?.includes("old API for one release"));
	assert.equal(o.id, sent.orchestrator);
});

test("an empty task is a usage error, not a started orchestrator", { skip }, () => {
	const r = cli("orchestrator", "submit", "--json");
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /what should the orchestrator do/);
});

test("config round-trips through AO's project settings; rules come from stdin or a file; none clears; bad values are refused", { skip }, () => {
	const set = json<{ config: OrchestratorConfig }>("orchestrator", "config", "--model", "fake/model", "--review", "on", "--json");
	assert.equal(set.data.config.model, "fake/model");
	assert.equal(set.data.config.workersRequestReview, true);

	const piped = cliWithStdin("Always ask for a review.\nNever merge.", "orchestrator", "config", "--rules", "-", "--json");
	assert.equal(piped.status, 0, piped.stderr);
	assert.equal((JSON.parse(piped.stdout) as { config: OrchestratorConfig }).config.rules, "Always ask for a review.\nNever merge.");

	const file = path.join(home, "rules.md");
	fs.writeFileSync(file, "Prefer small PRs.\n");
	assert.equal(json<{ config: OrchestratorConfig }>("orchestrator", "config", "--rules", `@${file}`, "--json").data.config.rules, "Prefer small PRs.");

	const read = json<{ config: OrchestratorConfig }>("orchestrator", "config", "--json").data.config;
	assert.equal(read.model, "fake/model");
	const cleared = json<{ config: OrchestratorConfig }>("orchestrator", "config", "--model", "none", "--rules", "none", "--review", "none", "--json").data.config;
	assert.equal(cleared.model, undefined);
	assert.equal(cleared.rules, undefined);
	assert.equal(cleared.workersRequestReview, undefined);

	const bad = cli("orchestrator", "config", "--harness", "no-such-harness");
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /no-such-harness/);
	assert.notEqual(cli("orchestrator", "config", "--permissions", "yolo").status, 0);
	assert.notEqual(cli("orchestrator", "config", "--review", "maybe").status, 0);
});

test("restart replaces it; stop ends its agent once and then says there is nothing to stop", { skip }, async () => {
	const before = json<Status>("orchestrator", "status", "--json").data.orchestrator;
	assert.ok(before);
	const fresh = json<{ id: string; started: boolean }>("orchestrator", "restart", "--json");
	assert.equal(fresh.status, 0);
	assert.equal(fresh.data.started, true);
	assert.notEqual(fresh.data.id, before.id);

	const all = json<{ orchestrators: OrchestratorInfo[] }>("orchestrator", "--all", "--json").data.orchestrators;
	assert.deepEqual(
		all.map(x => x.id),
		[fresh.data.id],
	);

	const stopped = json<{ stopped: boolean }>("orchestrator", "stop", "--json");
	assert.equal(stopped.status, 0);
	assert.equal(stopped.data.stopped, true);
	await statusUntil("the agent to be down", x => x.state === "stopped");
	// A task to a stopped orchestrator brings it back instead of failing.
	const again = json<{ started: boolean; revived: boolean; orchestrator: string }>("orchestrator", "submit", "Carry on", "--json");
	assert.equal(again.status, 0);
	assert.equal(again.data.orchestrator, fresh.data.id);
	assert.equal(again.data.revived, true);
});
