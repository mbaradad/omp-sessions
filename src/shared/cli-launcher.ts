// The `omp-sessions` launcher the extension installs (*omp: Install omp-sessions Command*): a shell
// script (a .cmd on Windows) that runs the runtime folder's cli.js with a Node 22+. Node-only.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The terminal command. */
export const COMMAND = "omp-sessions";

/** In every launcher we write: only launchers carrying it are rewritten or removed. */
export const LAUNCHER_MARK = "installed by the omp Sessions VS Code extension";

/** ~/.local/bin/omp-sessions; %LOCALAPPDATA%\omp-sessions\omp-sessions.cmd on Windows. */
export function launcherPath(platform: NodeJS.Platform = process.platform, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
	if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), COMMAND, `${COMMAND}.cmd`);
	return path.join(home, ".local", "bin", COMMAND);
}

/** The launcher running `cli` with `node` (Electron as Node when `electron`), keeping OMP_VSCODE_HOME when set. */
export function launcherText(node: { path: string; electron: boolean }, cli: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
	if (platform === "win32") {
		return `@echo off\r\nrem ${COMMAND}: ${LAUNCHER_MARK}\r\n${node.electron ? "set ELECTRON_RUN_AS_NODE=1\r\n" : ""}"${node.path}" "${cli}" %*\r\n`;
	}
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	const home = env.OMP_VSCODE_HOME ? `OMP_VSCODE_HOME=${q(env.OMP_VSCODE_HOME)} ` : "";
	return `#!/bin/sh\n# ${COMMAND}: ${LAUNCHER_MARK}\n${node.electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}${home}exec ${q(node.path)} ${q(cli)} "$@"\n`;
}

export function isOurLauncher(text: string): boolean {
	return text.includes(LAUNCHER_MARK);
}

/** Writes an executable launcher, creating its folder. */
export function writeLauncher(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, { mode: 0o755 });
}
