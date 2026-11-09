// Test runner: bundles the TypeScript tests with esbuild into .test-out/,
// then runs them with `node --test`. Usage: node test/run.mjs [unit|integration|ao]...
// No suite named: unit. `integration` runs test/integration/ against an isolated AO daemon
// started per test file by test/ao-fixture.mjs (skips when `ao` is missing; SWITCHYARD_TEST_AO_BIN picks one).
// TEST_OUT=<dir> bundles elsewhere (parallel runs); TEST_FILTER=<regex> keeps only matching test files.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const switchyardHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-test-home-"));
const outDir = process.env.TEST_OUT ? path.resolve(process.env.TEST_OUT) : path.join(root, ".test-out");
const filter = process.env.TEST_FILTER ? new RegExp(process.env.TEST_FILTER) : undefined;
const suites = process.argv.slice(2).filter(a => !a.startsWith("-"));
// `ao`: live contract tests against a running AO daemon (AO_RUN_FILE/AO_PORT pick it); only when asked for.
const selected = suites.length ? suites : ["unit"];
const SUITES = ["unit", "integration", "ao"];
for (const s of selected) if (!SUITES.includes(s)) throw new Error(`unknown suite ${s}`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const entryPoints = selected.flatMap(s =>
	fs
		.readdirSync(path.join(root, "test", s))
		.filter(f => f.endsWith(".test.ts") && (!filter || filter.test(f)))
		.map(f => path.join(root, "test", s, f)),
);
const common = { bundle: true, platform: "node", target: "es2022", sourcemap: "inline", logLevel: "warning", absWorkingDir: root };
await esbuild.build({ ...common, entryPoints, outdir: outDir, outbase: path.join(root, "test"), format: "esm", outExtension: { ".js": ".mjs" }, entryNames: "[dir]/[name]" });
const cliJs = path.join(outDir, "cli.js");
const plannerJs = path.join(outDir, "planner.js");
if (selected.includes("integration")) {
	// The CLI starts the planner.js beside it; test/planner-fixture.mjs starts the same file.
	await esbuild.build({ ...common, entryPoints: [path.join(root, "src/cli/main.ts")], outfile: cliJs, format: "cjs" });
	await esbuild.build({ ...common, entryPoints: [path.join(root, "src/planner/main.ts")], outfile: plannerJs, format: "cjs", define: { PLANNER_VERSION: JSON.stringify("test") } });
}
const files = entryPoints.map(f => path.join(outDir, path.relative(path.join(root, "test"), f)).replace(/\.ts$/, ".mjs"));
// node:test applies --test-timeout to each test file as a whole, not only to its tests: it must cover the
// slowest file (cli.test, ~30 s of serial CLI runs) on a loaded machine. Hangs show up sooner through the
// fixtures' own waits, which time out after seconds.
const res = spawnSync(process.execPath, ["--enable-source-maps", "--test", "--test-reporter=spec", "--test-timeout=120000", ...files], {
	stdio: "inherit",
	env: {
		...process.env,
		OMP_TEST_CLI_JS: cliJs,
		// test/ao-fixture.mjs puts this first on the AO daemon's PATH as `omp` (any suite may start the fixture).
		SWITCHYARD_TEST_FAKE_OMP_ACP: path.join(root, "test", "fake-omp-acp.mjs"),
		// Prebuilt for test/planner-fixture.mjs (it builds its own when this file is absent).
		...(fs.existsSync(plannerJs) ? { SWITCHYARD_TEST_PLANNER_JS: plannerJs } : {}),
		// CONTRACT.md "Isolated HOME": nothing in a test run may reach the real ~/.switchyard (locked). Every suite
		// gets a throwaway one; the AO fixture points its own, per fixture, at <fixture root>/switchyard.
		SWITCHYARD_HOME: switchyardHome,
		// Planners the tests start (through the CLI too) leave the machine's AO dashboard port alone (src/ao/dashboard.ts).
		SWITCHYARD_PLANNER_DASHBOARD: "off",
	},
});
fs.rmSync(switchyardHome, { recursive: true, force: true });
process.exit(res.status ?? 1);
