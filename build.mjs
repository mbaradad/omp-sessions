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
];

fs.rmSync("out", { recursive: true, force: true });
fs.mkdirSync("out", { recursive: true });
if (watch) {
	for (const b of builds) await (await esbuild.context(b)).watch();
} else {
	await Promise.all(builds.map(b => esbuild.build(b)));
}
