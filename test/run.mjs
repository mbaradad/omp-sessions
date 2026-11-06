// Test runner: bundles the session host and the TypeScript tests with esbuild into .test-out/,
// then runs them with `node --test`. Usage: node test/run.mjs [unit|host]...
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".test-out");
const suites = process.argv.slice(2).filter(a => !a.startsWith("-"));
const selected = suites.length ? suites : ["unit", "host"];
for (const s of selected) if (s !== "unit" && s !== "host") throw new Error(`unknown suite ${s}`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const entryPoints = selected.flatMap(s =>
	fs
		.readdirSync(path.join(root, "test", s))
		.filter(f => f.endsWith(".test.ts"))
		.map(f => path.join(root, "test", s, f)),
);
const common = { bundle: true, platform: "node", target: "es2022", sourcemap: "inline", logLevel: "warning", absWorkingDir: root };
await esbuild.build({ ...common, entryPoints, outdir: outDir, outbase: path.join(root, "test"), format: "esm", outExtension: { ".js": ".mjs" }, entryNames: "[dir]/[name]" });
// Same options as build.mjs's host bundle, but into .test-out/ so a running `npm run watch` keeps out/.
const hostJs = path.join(outDir, "host.js");
if (selected.includes("host")) await esbuild.build({ ...common, entryPoints: [path.join(root, "src/host/main.ts")], outfile: hostJs, format: "cjs" });

const files = entryPoints.map(f => path.join(outDir, path.relative(path.join(root, "test"), f)).replace(/\.ts$/, ".mjs"));
const res = spawnSync(process.execPath, ["--enable-source-maps", "--test", "--test-reporter=spec", "--test-timeout=30000", ...files], {
	stdio: "inherit",
	env: { ...process.env, OMP_TEST_HOST_JS: hostJs, OMP_TEST_FAKE_OMP: path.join(root, "test", "fake-omp.mjs") },
});
process.exit(res.status ?? 1);
