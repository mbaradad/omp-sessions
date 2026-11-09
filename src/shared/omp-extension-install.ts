// Installs the omp extensions Switchyard ships (`out/omp-extension/*.js`, built from
// src/omp-extension) into omp's agent folder as one package, `<agent dir>/extensions/switchyard/`
// with a `package.json` listing the modules, which omp's native discovery loads in every omp
// process (MAPPING.md D6). Each module does nothing unless AO runs that omp (`AO_SESSION_ID`). The
// folder is ours: modules no longer shipped are removed. Node-only.
import * as fs from "node:fs";
import * as path from "node:path";
import { type OmpPathOptions, ompPaths } from "./omp-paths";

export const OMP_EXTENSION_PACKAGE = "switchyard";
/** The package's name before the Switchyard rename; a copy left beside it would load every module twice. */
const LEGACY_PACKAGE = "omp-sessions";
/** The VS Code bridge's pre-rename folder. Its current one, `switchyard-bridge`, is the bridge's own live extension (hermes-mcp): not ours to touch. */
const LEGACY_BRIDGE_DIRS = ["omp-vscode-bridge"];

export function ompExtensionDir(opts?: OmpPathOptions): string {
	return path.join(ompPaths(opts).agentDir, "extensions", OMP_EXTENSION_PACKAGE);
}

/** A stand-alone bridge extension we installed: a lone `index.js` that registers the `mcp__vscode_*` tools. */
function isLegacyBridge(dir: string): boolean {
	try {
		if (fs.readdirSync(dir).join() !== "index.js") return false;
		const code = fs.readFileSync(path.join(dir, "index.js"), "utf8");
		return code.includes("mcp__") && code.includes("mcpServerName") && code.includes("bridge");
	} catch {
		return false;
	}
}

/**
 * Removes what an earlier layout installed next to `targetDir` and would load every module twice:
 * the pre-rename package (when its package.json says it is ours) and the bridge's pre-rename
 * folder. True when something was removed.
 */
export function removeLegacyOmpExtensions(targetDir: string): boolean {
	const parent = path.dirname(targetDir);
	let removed = false;
	const legacy = path.join(parent, LEGACY_PACKAGE);
	try {
		if (JSON.parse(fs.readFileSync(path.join(legacy, "package.json"), "utf8"))?.name === LEGACY_PACKAGE) {
			fs.rmSync(legacy, { recursive: true, force: true });
			removed = true;
		}
	} catch {
		/* not there, or not ours */
	}
	for (const name of LEGACY_BRIDGE_DIRS) {
		const dir = path.join(parent, name);
		if (!isLegacyBridge(dir)) continue;
		fs.rmSync(dir, { recursive: true, force: true });
		removed = true;
	}
	return removed;
}

/** Copies the modules in `sourceDir` into `targetDir` when they differ; true when anything changed. */
export function installOmpExtensions(sourceDir: string, targetDir: string): boolean {
	const modules = fs
		.readdirSync(sourceDir)
		.filter(f => f.endsWith(".js"))
		.sort();
	const files = new Map<string, Buffer>(modules.map(f => [f, fs.readFileSync(path.join(sourceDir, f))]));
	files.set("package.json", Buffer.from(`${JSON.stringify({ name: OMP_EXTENSION_PACKAGE, private: true, type: "module", omp: { extensions: modules.map(f => `./${f}`) } }, null, "\t")}\n`));
	fs.mkdirSync(targetDir, { recursive: true });
	let changed = false;
	for (const [name, content] of files) {
		const target = path.join(targetDir, name);
		let current: Buffer | undefined;
		try {
			current = fs.readFileSync(target);
		} catch {
			current = undefined;
		}
		if (current?.equals(content)) continue;
		// Temp file + rename: an omp starting right now never imports a half-written module.
		const tmp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, content);
		fs.renameSync(tmp, target);
		changed = true;
	}
	for (const name of fs.readdirSync(targetDir)) {
		if (files.has(name)) continue;
		fs.rmSync(path.join(targetDir, name), { recursive: true, force: true });
		changed = true;
	}
	return changed;
}
