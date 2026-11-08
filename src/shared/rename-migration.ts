// One-time migration from `omp-vs`, the terminal command of 0.5.0 and earlier, to `omp-sessions`:
// the launcher the extension installed and the per-user service `omp-vs server install` set up.
// Run by the extension on activation and by `omp-sessions server install`. Idempotent; nothing
// happens when nothing old is there. The data home (~/.omp/vscode) keeps its name and files, so
// running sessions and their hosts are untouched. Node-only; no vscode import.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMMAND, LAUNCHER_MARK, isOurLauncher, launcherPath, writeLauncher } from "./cli-launcher";
import { stateRoot } from "./protocol";
import { LAUNCHD_LABEL, SERVICE_DESCRIPTION, type ServiceExec, type ServiceKind, installServiceUnit, removeServiceUnit, serviceKind, serviceUnitPaths } from "./server-client";

const LEGACY_COMMAND = "omp-vs";
const LEGACY_SYSTEMD_UNIT = "omp-vs.service";
const LEGACY_LAUNCHD_LABEL = "dev.omp.vs-server";

/** Ownership marks older versions wrote into what they installed: agent skill frontmatter, Hermes plugin folder. */
export const LEGACY_SKILL_MARKER = "managed-by: omp-vs";
export const LEGACY_PLUGIN_MARKER = ".managed-by-omp-vs";

/** ~/.local/bin/omp-vs; %LOCALAPPDATA%\omp-vs\omp-vs.cmd on Windows. */
export function legacyLauncherPath(platform: NodeJS.Platform = process.platform, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
	if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), LEGACY_COMMAND, `${LEGACY_COMMAND}.cmd`);
	return path.join(home, ".local", "bin", LEGACY_COMMAND);
}

export function legacyServicePaths(home = os.homedir()): { systemd: string; launchd: string } {
	return {
		systemd: path.join(home, ".config", "systemd", "user", LEGACY_SYSTEMD_UNIT),
		launchd: path.join(home, "Library", "LaunchAgents", `${LEGACY_LAUNCHD_LABEL}.plist`),
	};
}

/** An old launcher under the new name: same node and runtime cli.js, the comment renamed. */
export function renamedLauncherText(text: string): string {
	return text.replace(`${LEGACY_COMMAND}: ${LAUNCHER_MARK}`, `${COMMAND}: ${LAUNCHER_MARK}`);
}

/** An old service unit for the new service: same node, script and environment; the new description / label. */
export function renamedServiceText(kind: ServiceKind, text: string): string {
	if (kind === "systemd") return text.replace(/^Description=.*$/m, `Description=${SERVICE_DESCRIPTION}`);
	return text.replace(`<string>${LEGACY_LAUNCHD_LABEL}</string>`, `<string>${LAUNCHD_LABEL}</string>`);
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Replaces a launcher we installed at the old path with one at the new path (an `omp-sessions`
 * launcher of ours already there stays) and deletes the old one, on Windows with its folder once
 * empty. Launchers without our mark are never touched, nor is the old one when the new path holds
 * someone else's file. The paths when it moved one.
 */
export function migrateLegacyLauncher(platform: NodeJS.Platform = process.platform, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): { from: string; to: string } | undefined {
	const from = legacyLauncherPath(platform, home, env);
	const old = readText(from);
	if (old === undefined || !isOurLauncher(old)) return undefined;
	const to = launcherPath(platform, home, env);
	const current = readText(to);
	if (current !== undefined && !isOurLauncher(current)) return undefined;
	if (current === undefined) writeLauncher(to, renamedLauncherText(old));
	fs.rmSync(from, { force: true });
	if (platform === "win32") {
		try {
			fs.rmdirSync(path.dirname(from));
		} catch {
			/* something else lives there: leave the folder */
		}
	}
	return { from, to };
}

/** Stops, disables and deletes the old service; its kind and unit text, undefined when none is installed. */
export function removeLegacyService(platform: NodeJS.Platform = process.platform, home = os.homedir(), exec?: ServiceExec): { kind: ServiceKind; text: string } | undefined {
	const kind = serviceKind(platform);
	if (!kind) return undefined;
	const file = legacyServicePaths(home)[kind];
	const text = readText(file);
	if (text === undefined) return undefined;
	removeServiceUnit(kind, file, kind === "systemd" ? LEGACY_SYSTEMD_UNIT : LEGACY_LAUNCHD_LABEL, exec);
	return { kind, text };
}

/** A lock older than this is from a crashed run. */
const LOCK_STALE_MS = 120_000;

/** One migrating process at a time (every VS Code window activates the extension); undefined when another one holds it. */
function lock(): (() => void) | undefined {
	const file = path.join(stateRoot(), "rename-migration.lock");
	fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.closeSync(fs.openSync(file, "wx"));
			return () => fs.rmSync(file, { force: true });
		} catch {
			try {
				if (Date.now() - fs.statSync(file).mtimeMs < LOCK_STALE_MS) return undefined;
				fs.rmSync(file, { force: true });
			} catch {
				/* released meanwhile: try again */
			}
		}
	}
	return undefined;
}

/**
 * Replaces an installed old service with the new one: stops and removes the old one, then installs
 * and starts the new one (an `omp-sessions` unit already installed is kept) once the old server has
 * exited (`systemctl stop` / `launchctl bootout` wait for it; installServiceUnit also stops a server
 * on our socket and waits for it to go). Sessions keep running: hosts are detached. What it did, or
 * undefined when there was nothing to migrate.
 */
export async function migrateLegacyService(platform: NodeJS.Platform = process.platform, home = os.homedir(), exec?: ServiceExec): Promise<{ from: string; to: string; started: boolean } | undefined> {
	const kind = serviceKind(platform);
	if (!kind || !fs.existsSync(legacyServicePaths(home)[kind])) return undefined;
	const unlock = lock();
	if (!unlock) return undefined;
	try {
		const old = removeLegacyService(platform, home, exec);
		if (!old) return undefined;
		const to = serviceUnitPaths(home)[old.kind];
		const text = readText(to) ?? renamedServiceText(old.kind, old.text);
		return { from: legacyServicePaths(home)[old.kind], to, started: await installServiceUnit(old.kind, text, home, exec) };
	} finally {
		unlock();
	}
}
