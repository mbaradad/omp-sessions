// CONTRACT.md "Isolated HOME": the AO fixture never runs against the user's real HOME. These tests pin the
// enforcement itself: the daemon's real environment, the refusal of an override, and real omp's shared login.
import assert from "node:assert/strict";
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

test("overriding HOME (or a state dir) to a real location is refused, and nothing is left behind", { skip }, async () => {
	const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("ao-fixture-"));
	await assert.rejects(startAoFixture({ env: { HOME: realHome } }), /not under the fixture root/);
	await assert.rejects(startAoFixture({ env: { SWITCHYARD_HOME: path.join(realHome, ".switchyard") } }), /SWITCHYARD_HOME=.* is not under/);
	const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("ao-fixture-"));
	assert.deepEqual(after.filter(n => !before.includes(n)), [], "no temp dir leaked by a refused start");
});

test("real omp stays isolated: the fixture HOME links only the shared agent dir", { skip: skip || !fs.existsSync(path.join(realHome, ".omp", "agent")) || process.env.PI_CODING_AGENT_DIR !== undefined }, async () => {
	const ao = await startAoFixture({ realOmp: true });
	try {
		assert.ok(under(ao.home, ao.root));
		const link = path.join(ao.home, ".omp", "agent");
		assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(realHome, ".omp", "agent")), "the login lives in the shared agent dir");
		assert.deepEqual(fs.readdirSync(path.join(ao.home, ".omp")), ["agent"], "nothing else of ~/.omp is shared");
		assert.ok(!fs.existsSync(path.join(ao.home, ".local", "bin")), "no launcher in the isolated home");
	} finally {
		await ao.stop();
	}
});
