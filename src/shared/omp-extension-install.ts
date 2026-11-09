// Installs the omp extensions Switchyard ships (`out/omp-extension/*.js`, built from
// src/omp-extension) into omp's agent folder as one package, `<agent dir>/extensions/switchyard/`
// with a `package.json` listing the modules, which omp's native discovery loads in every omp
// process (MAPPING.md D6). Each module does nothing unless AO runs that omp (`AO_SESSION_ID`). The
// folder is ours: modules no longer shipped are removed. Node-only.
import * as fs from "node:fs";
import * as path from "node:path";
import { shimDir, switchyardHome } from "../ao/native";
import { type OmpPathOptions, ompPaths } from "./omp-paths";

export const OMP_EXTENSION_PACKAGE = "switchyard";
/** The package's name before the Switchyard rename; a copy left beside it would load every module twice. */
const LEGACY_PACKAGE = "omp-sessions";
/** Folders the VS Code bridge's stand-alone omp extension was installed into before it became a module of the package. */
const LEGACY_BRIDGE_DIRS = ["omp-vscode-bridge", "switchyard-bridge"];

/**
 * Whether the VS Code extension may write the global install (`~/.omp/agent/extensions/switchyard/` and
 * `~/.switchyard/bin/omp`): only when it runs as an installed extension, so a development host or an
 * e2e instance never changes the machine's real omp. `SWITCHYARD_INSTALL_OMP_EXTENSIONS=1` overrides.
 */
export function globalInstallAllowed(production: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
	return production || env.SWITCHYARD_INSTALL_OMP_EXTENSIONS === "1";
}

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
 * the pre-rename package (when its package.json says it is ours) and the bridge's own extension
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

// ---------- the `omp` shim (GAPS.md G34) ----------

/** First line after the shebang that marks the shim as ours; a file of that name without it is never replaced. */
const SHIM_MARKER = "switchyard-omp-shim";

/** Where the shim lives; the AO daemon's PATH must list this folder before the real omp's (src/ao/daemon.ts). */
export function ompShimDir(home = switchyardHome()): string {
	return shimDir(home);
}

export type ShimInstall = "installed" | "updated" | "unchanged" | "skipped";

/**
 * Installs `sourceFile` (out/omp-shim/omp) as `<binDir>/omp`, executable. A file there that is not the
 * shim is left alone ("skipped"). The shim is a POSIX shell script: on Windows nothing is installed.
 */
export function installOmpShim(sourceFile: string, binDir = ompShimDir()): ShimInstall {
	if (process.platform === "win32") return "skipped";
	const content = fs.readFileSync(sourceFile);
	const target = path.join(binDir, "omp");
	let current: Buffer | undefined;
	try {
		current = fs.readFileSync(target);
	} catch {
		current = undefined;
	}
	if (current && !current.toString("utf8", 0, 400).includes(SHIM_MARKER)) return "skipped";
	if (current?.equals(content)) {
		fs.chmodSync(target, 0o755);
		return "unchanged";
	}
	fs.mkdirSync(binDir, { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, content, { mode: 0o755 });
	fs.renameSync(tmp, target);
	return current ? "updated" : "installed";
}

/** Removes the shim when it is ours; true when removed. */
export function removeOmpShim(binDir = ompShimDir()): boolean {
	const target = path.join(binDir, "omp");
	try {
		if (!fs.readFileSync(target, "utf8").slice(0, 400).includes(SHIM_MARKER)) return false;
		fs.rmSync(target);
		return true;
	} catch {
		return false;
	}
}
