// Test runner: bundles the session host and the TypeScript tests with esbuild into .test-out/,
// then runs them with `node --test`. Usage: node test/run.mjs [unit|host]...
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
const selected = suites.length ? suites : ["unit", "host"];
for (const s of selected) if (s !== "unit" && s !== "host") throw new Error(`unknown suite ${s}`);

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

// Windows can't start a script by its shebang: there omp is an npm `.cmd` shim, and so is the fake.
let fakeOmp = path.join(root, "test", "fake-omp.mjs");
if (process.platform === "win32") {
	const shim = path.join(outDir, "fake-omp.cmd");
	fs.writeFileSync(shim, `@"${process.execPath}" "${fakeOmp}" %*\r\n`);
	fakeOmp = shim;
}
const files = entryPoints.map(f => path.join(outDir, path.relative(path.join(root, "test"), f)).replace(/\.ts$/, ".mjs"));
const res = spawnSync(process.execPath, ["--enable-source-maps", "--test", "--test-reporter=spec", "--test-timeout=30000", ...files], {
	stdio: "inherit",
	env: { ...process.env, OMP_TEST_HOST_JS: hostJs, OMP_TEST_SERVER_JS: serverJs, OMP_TEST_CLI_JS: cliJs, OMP_TEST_FAKE_OMP: fakeOmp },
});
process.exit(res.status ?? 1);
