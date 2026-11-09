// Packs the standalone `switchyard` command: the CLI with everything it runs or installs next to it
// (the planner, agent skill, omp extensions and shim, Hermes plugin), the same layout as the extension's
// runtime folder, as an npm tarball. Install it without VS Code:
//   npm install -g https://github.com/mbaradad/omp-sessions/releases/download/v<version>/switchyard-<version>.tgz
// Usage: node build.mjs [--production] && node packaging/cli/pack.mjs [out dir] [--dest <dir>]
// Writes <dest>/switchyard-<version>.tgz (default dest: dist/) and prints its path.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const destAt = argv.indexOf("--dest");
const dest = path.resolve(destAt >= 0 ? argv[destAt + 1] : path.join(root, "dist"));
const positional = argv.filter((a, i) => !a.startsWith("--") && !(destAt >= 0 && i === destAt + 1));
const out = path.resolve(positional[0] ?? path.join(root, "out"));

/** What cli.js uses next to itself; the same files the extension copies into its runtime folder (RUNTIME_FILES in src/ext/server.ts). */
const FILES = ["cli.js", "planner.js", "switchyard.SKILL.md"];
/** Folders `switchyard omp-extension install` copies from next to cli.js (G38): the omp extension modules and the `omp` shim. */
const BUNDLE_DIRS = ["omp-extension", "omp-shim"];
/** The Hermes plugin `switchyard hermes install` copies (PLUGIN_BUNDLE). */
const PLUGIN = path.join("hermes-plugin", "switchyard");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const missing = [...FILES, ...BUNDLE_DIRS, path.join(PLUGIN, "plugin.yaml")].filter(f => !fs.existsSync(path.join(out, f)));
if (missing.length) throw new Error(`missing in ${out}: ${missing.join(", ")} (run node build.mjs first)`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-pack-"));
try {
	for (const f of FILES) fs.copyFileSync(path.join(out, f), path.join(stage, f));
	fs.chmodSync(path.join(stage, "cli.js"), 0o755);
	fs.cpSync(path.join(out, PLUGIN), path.join(stage, PLUGIN), { recursive: true, filter: f => !f.includes("__pycache__") });
	for (const dir of BUNDLE_DIRS) fs.cpSync(path.join(out, dir), path.join(stage, dir), { recursive: true });
	fs.copyFileSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
	// cli.js reads its version from the package.json next to it (src/cli/main.ts).
	const manifest = {
		name: "switchyard",
		version: pkg.version,
		description: "Switchyard without VS Code: the switchyard command, its planner (task queues and scheduled starts), the agent skill and the Hermes Agent plugin.",
		license: pkg.license,
		repository: pkg.repository,
		homepage: pkg.homepage,
		bin: { "switchyard": "cli.js" },
		engines: { node: ">=22" },
	};
	fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	fs.mkdirSync(dest, { recursive: true });
	const res = spawnSync("npm", ["pack", "--json", "--pack-destination", dest], { cwd: stage, encoding: "utf8", shell: process.platform === "win32" });
	if (res.status !== 0) throw new Error(`npm pack failed: ${res.stderr || res.stdout}`);
	const [packed] = JSON.parse(res.stdout);
	process.stdout.write(`${path.join(dest, packed.filename)}\n`);
} finally {
	fs.rmSync(stage, { recursive: true, force: true });
}
