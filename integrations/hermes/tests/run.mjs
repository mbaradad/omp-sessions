// `npm run test:hermes`: the omp-sessions Hermes plugin tests (integrations/hermes/tests) with
// Hermes Agent's own Python, against real Hermes code in a temp HERMES_HOME and the built omp-sessions
// (out/cli.js) with the fake omp. Skips when Hermes isn't installed. Not part of `npm test`.
// HERMES_PYTHON=<python> picks the interpreter (default: the venv of the installed Hermes).
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The Python of the installed Hermes: <hermes root>/installs/<id>/facts.json names its venv (read only). */
function hermesPython() {
	if (process.env.HERMES_PYTHON) return process.env.HERMES_PYTHON;
	const installs = path.join(os.homedir(), ".hermes", "installs");
	let best;
	for (const id of fs.existsSync(installs) ? fs.readdirSync(installs) : []) {
		try {
			const facts = JSON.parse(fs.readFileSync(path.join(installs, id, "facts.json"), "utf8"));
			const env = facts?.packages?.venv?.environment;
			const py = env && path.join(env, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
			if (py && fs.existsSync(py)) {
				const mtime = fs.statSync(path.join(installs, id, "facts.json")).mtimeMs;
				if (!best || mtime > best.mtime) best = { py, mtime };
			}
		} catch {
			/* not an install */
		}
	}
	return best?.py;
}

const python = hermesPython();
if (!python) {
	console.log("test:hermes skipped: Hermes Agent is not installed (no ~/.hermes/installs/*/facts.json; set HERMES_PYTHON to its Python)");
	process.exit(0);
}
const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hermes-probe-"));
const probe = spawnSync(python, ["-I", "-B", "-c", "import hermes_cli.kanban_db, hermes_cli.plugins"], { encoding: "utf8", env: { ...process.env, HERMES_HOME: probeHome } });
fs.rmSync(probeHome, { recursive: true, force: true });
if (probe.status !== 0) {
	console.log(`test:hermes skipped: ${python} cannot import Hermes (${(probe.stderr || "").trim().split("\n").pop()})`);
	process.exit(0);
}

const build = spawnSync(process.execPath, ["build.mjs"], { cwd: root, encoding: "utf8" });
if (build.status !== 0) {
	process.stderr.write(build.stderr);
	process.exit(build.status ?? 1);
}

// The plugin drives the real omp-sessions CLI, which runs on AO: an isolated `ao daemon` with the
// scripted fake omp (test/ao-fixture.mjs), never the dev daemon or the real ~/.omp.
const { aoAvailable, startAoFixture } = await import(path.join(root, "test/ao-fixture.mjs"));
if (!aoAvailable()) {
	console.log("test:hermes skipped: ao is not installed (set SWITCHYARD_TEST_AO_BIN)");
	process.exit(0);
}
const ao = await startAoFixture();
let status = 1;
try {
	console.log(`Hermes Python: ${python} · AO ${ao.baseUrl}`);
	// -I: ignore the user's PYTHONPATH/site; -B: never write bytecode into the Hermes install. TEST_FILTER=<pattern>: unittest -k.
	const filter = process.env.TEST_FILTER ? ["-k", process.env.TEST_FILTER] : [];
	const child = spawn(python, ["-I", "-B", "-m", "unittest", "discover", "-s", path.join(root, "integrations/hermes/tests"), "-p", "test_*.py", "-v", ...filter], {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, ...ao.stackEnv, OMP_TEST_ROOT: root, OMP_TEST_NODE: process.execPath, OMP_TEST_REPO: ao.scratchRepo("work") },
	});
	status = await new Promise(resolve => child.on("exit", code => resolve(code ?? 1)));
} finally {
	await ao.stop();
}
process.exit(status);
