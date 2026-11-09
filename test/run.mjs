// Test runner: bundles the session host and the TypeScript tests with esbuild into .test-out/,
// then runs them with `node --test`. Usage: node test/run.mjs [unit|host|integration|ao]...
// No suite named: unit and host. `integration` runs test/integration/ against an isolated AO daemon
// started per test file by test/ao-fixture.mjs (skips when `ao` is missing; SWITCHYARD_TEST_AO_BIN picks one).
// TEST_OUT=<dir> bundles elsewhere (parallel runs); TEST_FILTER=<regex> keeps only matching test files.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.TEST_OUT ? path.resolve(process.env.TEST_OUT) : path.join(root, ".test-out");
const filter = process.env.TEST_FILTER ? new RegExp(process.env.TEST_FILTER) : undefined;
const suites = process.argv.slice(2).filter(a => !a.startsWith("-"));
// `ao`: live contract tests against a running AO daemon (AO_RUN_FILE/AO_PORT pick it); only when asked for.
const selected = suites.length ? suites : ["unit", "host"];
const SUITES = ["unit", "host", "integration", "ao"];
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
// Same options as build.mjs's host bundle, but into .test-out/ so a running `npm run watch` keeps out/.
const hostJs = path.join(outDir, "host.js");
const serverJs = path.join(outDir, "server.js");
const cliJs = path.join(outDir, "cli.js");
if (selected.includes("host")) {
	await esbuild.build({ ...common, entryPoints: [path.join(root, "src/host/main.ts")], outfile: hostJs, format: "cjs" });
	// Next to host.js: the server launches the host.js beside it, the CLI starts that server.
	await esbuild.build({ ...common, entryPoints: [path.join(root, "src/server/main.ts")], outfile: serverJs, format: "cjs" });
	await esbuild.build({ ...common, entryPoints: [path.join(root, "src/cli/main.ts")], outfile: cliJs, format: "cjs" });
}
// The planner process test/planner-fixture.mjs starts (any suite may; the integration suite does).
const plannerJs = path.join(outDir, "planner.js");
if (selected.includes("integration") && fs.existsSync(path.join(root, "src/planner/main.ts"))) {
	await esbuild.build({ ...common, entryPoints: [path.join(root, "src/planner/main.ts")], outfile: plannerJs, format: "cjs", define: { PLANNER_VERSION: '"test"' } });
}

// Windows can't start a script by its shebang: there omp is an npm `.cmd` shim, and so is the fake.
let fakeOmp = path.join(root, "test", "fake-omp.mjs");
if (process.platform === "win32") {
	const shim = path.join(outDir, "fake-omp.cmd");
	fs.writeFileSync(shim, `@"${process.execPath}" "${fakeOmp}" %*\r\n`);
	fakeOmp = shim;
}
const files = entryPoints.map(f => path.join(outDir, path.relative(path.join(root, "test"), f)).replace(/\.ts$/, ".mjs"));
// node:test applies --test-timeout to each test file as a whole, not only to its tests: it must cover the
// slowest file (cli.test, ~30 s of serial CLI runs) on a loaded machine. Hangs show up sooner through the
// harness's own waits, which time out after seconds.
const res = spawnSync(process.execPath, ["--enable-source-maps", "--test", "--test-reporter=spec", "--test-timeout=120000", ...files], {
	stdio: "inherit",
	env: {
		...process.env,
		OMP_TEST_HOST_JS: hostJs,
		OMP_TEST_SERVER_JS: serverJs,
		OMP_TEST_CLI_JS: cliJs,
		OMP_TEST_FAKE_OMP: fakeOmp,
		// test/ao-fixture.mjs puts this first on the AO daemon's PATH as `omp` (any suite may start the fixture).
		SWITCHYARD_TEST_FAKE_OMP_ACP: path.join(root, "test", "fake-omp-acp.mjs"),
		// Prebuilt for test/planner-fixture.mjs (it builds its own when this file is absent).
		...(fs.existsSync(plannerJs) ? { SWITCHYARD_TEST_PLANNER_JS: plannerJs } : {}),
	},
});
process.exit(res.status ?? 1);
