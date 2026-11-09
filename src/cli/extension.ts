// Switchyard's omp extension and the `omp` shim on a machine without VS Code (GAPS.md G38). The VS Code
// extension installs them at activation; `omp-sessions omp-extension install|status|uninstall` does it for a
// machine that only has the command (a headless server, Hermes), and `new`/`status` refresh them when they
// are missing or older (off with `config set omp-extension off`). The bundles ship next to cli.js:
//   omp-extension/*.js   the modules of omp's `switchyard` package (mode gate, checkpoints, todo mirror, bridge)
//   omp-shim/omp         the shim that appends a session's extra arguments to `omp acp` (G34)
import * as fs from "node:fs";
import * as path from "node:path";
import { readSwitchyardConfig } from "../ao/config";
import { gateStatus } from "../ao/gate";
import { type ShimInstall, installOmpExtensions, installOmpShim, ompExtensionDir, ompShimDir, removeLegacyOmpExtensions, removeOmpShim } from "../shared/omp-extension-install";

export interface Bundles {
	/** Folder of the extension modules, or undefined when this build ships none. */
	extensions?: string;
	/** The shim script, or undefined when this build ships none. */
	shim?: string;
}

/** What this build ships: `omp-extension/` and `omp-shim/omp` beside cli.js (`base` is for tests). */
export function bundlesAt(base: string): Bundles {
	const extensions = path.join(base, "omp-extension");
	const shim = path.join(base, "omp-shim", "omp");
	return { ...(isDirectory(extensions) && { extensions }), ...(fs.existsSync(shim) && { shim }) };
}

export function shippedBundles(): Bundles {
	return bundlesAt(typeof __dirname === "string" ? __dirname : path.dirname(process.argv[1] ?? ""));
}

function isDirectory(dir: string): boolean {
	return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function modulesIn(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter(f => f.endsWith(".js"))
			.sort();
	} catch {
		return [];
	}
}

/** Whether every shipped module is installed byte for byte (the package's own package.json is not compared). */
function modulesCurrent(source: string, target: string): boolean {
	const shipped = modulesIn(source);
	if (!shipped.length) return true;
	return shipped.every(f => {
		try {
			return fs.readFileSync(path.join(source, f)).equals(fs.readFileSync(path.join(target, f)));
		} catch {
			return false;
		}
	});
}

function shimCurrent(source: string, binDir: string): boolean {
	try {
		return fs.readFileSync(source).equals(fs.readFileSync(path.join(binDir, "omp")));
	} catch {
		return false;
	}
}

/** The first folder of the AO daemon's PATH (Linux: /proc; undefined where it can't be read). */
function daemonPathFirst(pid: number | undefined): string | undefined {
	if (!pid) return undefined;
	try {
		const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
		return env.find(v => v.startsWith("PATH="))?.slice(5).split(path.delimiter)[0];
	} catch {
		return undefined;
	}
}

export interface ExtensionReport {
	/** The permission gate is installed: ask, edits and plan are enforced. */
	installed: boolean;
	/** The modules installed in omp's `switchyard` package. */
	modules: string[];
	/** Installed modules equal to the shipped ones (true when this build ships none). */
	current: boolean;
	dir: string;
	shim: {
		installed: boolean;
		current: boolean;
		path: string;
		/** The AO daemon's PATH lists the shim's folder first (so its flags reach omp); undefined when it can't be told. */
		onDaemonPath?: boolean;
	};
	/** This build ships the bundles `install` copies. */
	shipped: boolean;
	/** `config set omp-extension off` turns the automatic install off. */
	auto: "on" | "off";
}

export function extensionReport(daemonPid?: number, bundles: Bundles = shippedBundles()): ExtensionReport {
	const status = gateStatus();
	const binDir = ompShimDir();
	const first = daemonPathFirst(daemonPid);
	return {
		installed: status.gate,
		modules: modulesIn(status.extensionDir),
		current: bundles.extensions ? modulesCurrent(bundles.extensions, status.extensionDir) : true,
		dir: status.extensionDir,
		shim: {
			installed: status.shim,
			current: bundles.shim ? shimCurrent(bundles.shim, binDir) : true,
			path: status.shimFile,
			...(first !== undefined && { onDaemonPath: path.resolve(first) === path.resolve(binDir) }),
		},
		shipped: !!(bundles.extensions || bundles.shim),
		auto: readSwitchyardConfig().ompExtension ?? "on",
	};
}

export interface InstallResult {
	/** The package's modules were written (or changed). */
	extensions: boolean;
	/** What happened to the shim; `skipped`: a file of that name is not ours, or this platform has no shim. */
	shim: ShimInstall | "not shipped";
	/** The pre-rename package or the old stand-alone bridge was removed. */
	legacyRemoved: boolean;
}

/** Copies what this build ships into omp's agent folder and the Switchyard `bin` folder. */
export function installBundles(bundles: Bundles = shippedBundles()): InstallResult {
	if (!bundles.extensions && !bundles.shim) throw new Error("this build ships neither the omp extension nor the shim (no omp-extension/ or omp-shim/ next to cli.js)");
	const dir = ompExtensionDir();
	const legacyRemoved = removeLegacyOmpExtensions(dir);
	const extensions = bundles.extensions ? installOmpExtensions(bundles.extensions, dir) : false;
	const shim = bundles.shim ? installOmpShim(bundles.shim) : "not shipped";
	return { extensions, shim, legacyRemoved };
}

/** Removes Switchyard's package from omp's agent folder and the shim; true for each that was there. */
export function uninstallBundles(): { extensions: boolean; shim: boolean } {
	const dir = ompExtensionDir();
	const extensions = fs.existsSync(path.join(dir, "package.json"));
	if (extensions) fs.rmSync(dir, { recursive: true, force: true });
	return { extensions, shim: removeOmpShim() };
}

/**
 * `new` and `status`: installs or refreshes the extension and the shim when they are missing or older than
 * what this build ships, unless `config set omp-extension off`. Returns what it did, for a one-time notice
 * (only a first install is worth one; a refresh is silent).
 */
export function ensureBundles(bundles: Bundles = shippedBundles()): { firstInstall: boolean; dir: string } | undefined {
	if (!bundles.extensions && !bundles.shim) return undefined;
	// `=0` is what test and dev runs pin (checkpoints' globalInstallAllowed): never touch the shared omp agent folder by itself.
	if (process.env.SWITCHYARD_INSTALL_OMP_EXTENSIONS === "0" || readSwitchyardConfig().ompExtension === "off") return undefined;
	const report = extensionReport(undefined, bundles);
	if (report.installed && report.current && (!bundles.shim || (report.shim.installed && report.shim.current))) return undefined;
	const result = installBundles(bundles);
	return result.extensions || result.shim === "installed" ? { firstInstall: !report.installed, dir: report.dir } : undefined;
}
