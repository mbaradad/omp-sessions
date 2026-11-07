import * as esbuild from "esbuild";
import * as fs from "node:fs";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");
const common = { bundle: true, sourcemap: !production, minify: production, logLevel: "info", target: "es2022" };
const builds = [
	{ ...common, entryPoints: ["src/host/main.ts"], outfile: "out/host.js", platform: "node", format: "cjs" },
	{ ...common, entryPoints: ["src/ext/extension.ts"], outfile: "out/extension.js", platform: "node", format: "cjs", external: ["vscode"] },
	{ ...common, entryPoints: ["src/webview/main.ts"], outfile: "out/webview.js", platform: "browser", format: "iife" },
	{ ...common, entryPoints: ["src/webview/style.css"], outfile: "out/webview.css" },
	{ ...common, entryPoints: ["src/bridge/mcp.ts"], outfile: "out/mcp.js", platform: "node", format: "cjs" },
	{ ...common, entryPoints: ["src/kanban/main.ts"], outfile: "out/kanban.js", platform: "browser", format: "iife" },
	{ ...common, entryPoints: ["src/kanban/style.css"], outfile: "out/kanban.css" },
	{ ...common, entryPoints: ["src/server/main.ts"], outfile: "out/server.js", platform: "node", format: "cjs" },
	{ ...common, entryPoints: ["src/cli/main.ts"], outfile: "out/cli.js", platform: "node", format: "cjs", banner: { js: "#!/usr/bin/env node" } },
	{ ...common, entryPoints: ["src/mobile/main.ts"], outfile: "out/mobile.js", platform: "browser", format: "iife" },
	{ ...common, entryPoints: ["src/mobile/style.css"], outfile: "out/mobile.css" },
];
/** Files used next to the bundles as they are: the phone app the server serves, the agent skill. */
const copies = [
	["src/mobile/index.html", "out/mobile.html"],
	["src/mobile/manifest.webmanifest", "out/manifest.webmanifest"],
	["media/icon.png", "out/mobile-icon.png"],
	["media/icon.svg", "out/mobile-icon.svg"],
	["skills/omp-sessions/SKILL.md", "out/omp-sessions.SKILL.md"],
];

fs.rmSync("out", { recursive: true, force: true });
fs.mkdirSync("out", { recursive: true });
for (const [from, to] of copies) fs.copyFileSync(from, to);
// The Hermes plugin (`omp-vs hermes install` copies it into Hermes) with the skill it registers.
fs.cpSync("integrations/hermes/omp-sessions", "out/hermes-plugin/omp-sessions", { recursive: true, filter: f => !f.includes("__pycache__") });
fs.mkdirSync("out/hermes-plugin/omp-sessions/skills/omp-sessions", { recursive: true });
fs.copyFileSync("skills/omp-sessions/SKILL.md", "out/hermes-plugin/omp-sessions/skills/omp-sessions/SKILL.md");
if (watch) {
	for (const b of builds) await (await esbuild.context(b)).watch();
} else {
	await Promise.all(builds.map(b => esbuild.build(b)));
}
