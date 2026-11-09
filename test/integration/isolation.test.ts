// CONTRACT.md "Isolated HOME": the AO fixture never runs against the user's real HOME. These tests pin the
// enforcement itself: the daemon's real environment, the refusal of an override, and real omp's shared login.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";
import { startPlannerFixture } from "../planner-fixture.mjs";

const realHome = fs.realpathSync(os.userInfo().homedir);
const under = (child: string, parent: string) => !path.relative(fs.realpathSync(parent), fs.realpathSync(child)).startsWith("..");

/** The environment a running process was started with (Linux). */
function environOf(pid: number): Record<string, string> {
	return Object.fromEntries(
		fs
			.readFileSync(`/proc/${pid}/environ`, "utf8")
			.split("\0")
			.filter(Boolean)
			.map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
	);
}

test("the daemon runs with HOME, XDG and state dirs under the fixture root, and stackEnv carries them", { skip: skip || process.platform !== "linux" }, async () => {
	const ao = await startAoFixture();
	try {
		const env = environOf(ao.pid);
		for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "SWITCHYARD_HOME", "OMP_VSCODE_HOME"]) {
			assert.ok(env[key] && under(env[key], ao.root), `${key}=${env[key]} is under ${ao.root}`);
			assert.equal(ao.stackEnv[key], env[key], `stackEnv.${key} matches the daemon's`);
		}
		assert.notEqual(path.resolve(env.HOME), realHome);
		assert.equal(ao.home, env.HOME);
		// A planner on this stack inherits the isolation, and cannot be pointed at a real state dir.
		const planner = await startPlannerFixture({ ao });
		try {
			assert.equal(environOf(planner.pid).HOME, env.HOME);
		} finally {
			await planner.stop();
		}
		await assert.rejects(startPlannerFixture({ ao, stateRoot: path.join(realHome, ".switchyard") }), /not under/);
	} finally {
		await ao.stop();
	}
});

test("env of an enclosing omp session never reaches the daemon or the omp it spawns; the daemon's own HOME/XDG are isolated", { skip: skip || process.platform !== "linux" }, async () => {
	const planted = { PI_SESSION_FILE: "/nonexistent/parent-session.jsonl", PI_SESSION_ID: "parent-session-id", PI_NO_TITLE: "1", OMPCODE: "1" };
	Object.assign(process.env, planted);
	let ao: Awaited<ReturnType<typeof startAoFixture>> | undefined;
	try {
		ao = await startAoFixture();
		const env = environOf(ao.pid);
		for (const key of Object.keys(planted)) assert.equal(env[key], undefined, `${key} must not reach the daemon`);
		// The daemon process itself (not only its clients) runs on the isolated HOME: its readiness probes of
		// other harnesses write there, never into the real home.
		assert.equal(env.HOME, ao.home);
		assert.equal(env.XDG_CONFIG_HOME, path.join(ao.home, ".config"));
		const planner = await startPlannerFixture({ ao });
		try {
			for (const key of Object.keys(planted)) assert.equal(environOf(planner.pid)[key], undefined, `${key} must not reach the planner`);
		} finally {
			await planner.stop();
		}
	} finally {
		for (const key of Object.keys(planted)) delete process.env[key];
		await ao?.stop();
	}
});

test("overriding HOME (or a state dir) to a real location is refused, and nothing is left behind", { skip }, async () => {
	const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("ao-fixture-"));
	await assert.rejects(startAoFixture({ env: { HOME: realHome } }), /not under the fixture root/);
	await assert.rejects(startAoFixture({ env: { SWITCHYARD_HOME: path.join(realHome, ".switchyard") } }), /SWITCHYARD_HOME=.* is not under/);
	const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("ao-fixture-"));
	assert.deepEqual(after.filter(n => !before.includes(n)), [], "no temp dir leaked by a refused start");
});

/** What is in a real shared path, for before/after comparison (names and mtimes of its entries; "absent" when missing). */
function listing(p: string): string {
	try {
		return fs
			.readdirSync(p)
			.sort()
			.map(n => `${n}:${fs.lstatSync(path.join(p, n)).mtimeMs}`)
			.join(",");
	} catch {
		return "absent";
	}
}

test("real omp stays isolated: only the agent dir is shared, extensions come from the scratch repo, ~/.switchyard and ~/.omp/agent/extensions stay as they were", { skip: skip || !fs.existsSync(path.join(realHome, ".omp", "agent")) || process.env.PI_CODING_AGENT_DIR !== undefined }, async () => {
	const watched = [path.join(realHome, ".switchyard"), path.join(realHome, ".omp", "agent", "extensions")];
	const before = watched.map(listing);
	const ao = await startAoFixture({ realOmp: true });
	try {
		assert.ok(under(ao.home, ao.root));
		const link = path.join(ao.home, ".omp", "agent");
		assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(realHome, ".omp", "agent")), "the login lives in the shared agent dir");
		assert.deepEqual(fs.readdirSync(path.join(ao.home, ".omp")), ["agent"], "nothing else of ~/.omp is shared");
		assert.ok(!fs.existsSync(path.join(ao.home, ".local", "bin")), "no launcher in the isolated home");
		// A project-level omp extension is committed into the scratch repo, so the session worktree has it.
		const ext = path.join(ao.root, "probe-extension.ts");
		fs.writeFileSync(ext, "export default function probe() {}\n");
		const repo = ao.scratchRepo("ext", { extensions: { "probe.ts": ext } });
		assert.equal(spawnSync("git", ["ls-files", ".omp/extensions/probe.ts"], { cwd: repo, encoding: "utf8" }).stdout.trim(), ".omp/extensions/probe.ts");
	} finally {
		await ao.stop();
	}
	assert.deepEqual(watched.map(listing), before, "the real ~/.switchyard and ~/.omp/agent/extensions are untouched");
});

test("a busy port never makes the fixture adopt another daemon: it fails instead", { skip }, async () => {
	const first = await startAoFixture();
	try {
		await assert.rejects(startAoFixture({ env: { AO_PORT: String(first.port) }, readyTimeoutMs: 6_000 }), /ao daemon (exited|not ready)/);
		// The first daemon is untouched and still ours.
		const ready = (await (await fetch(`${first.baseUrl}/readyz`)).json()) as { pid: number; workingDirectory: string };
		assert.equal(ready.pid, first.pid);
		assert.equal(path.resolve(ready.workingDirectory), path.resolve(first.dataDir));
	} finally {
		await first.stop();
	}
});
