// The omp-sessions server and CLI from the extension's side: mirrors `omp.path`/`omp.extraArgs` into
// launcher.json, installs host/server/cli bundles into a stable runtime folder (the extension
// folder changes with every update), keeps the server running at this version, installs
// the `omp-sessions` command (`omp.installCli`) and moves what the old command name (0.5.0 and
// earlier) installed to the new one (shared/rename-migration.ts).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { COMMAND, isOurLauncher, launcherPath, launcherText, writeLauncher } from "../shared/cli-launcher";
import { ompPathProblem, readHostVersion, readLauncherSettings, writeLauncherSettings } from "../shared/launch";
import { stateRoot } from "../shared/protocol";
import { migrateLegacyLauncher, migrateLegacyService } from "../shared/rename-migration";
import { type EnsureServerOptions, LAUNCHD_LABEL, SYSTEMD_UNIT, ServerClient, type ServiceInstall, compareVersions, ensureServer, removeServiceUnit, stopServer } from "../shared/server-client";
import { serverLogPath } from "../shared/server-protocol";
import { PLUGIN_BUNDLE } from "../shared/hermes-plugin";
import type { OmpApi } from "./api";
import { plain } from "./plain";

/** Bundles the CLI and server run from, the phone app the server serves, the agent skill the CLI installs (plus the Hermes plugin folder). */
const RUNTIME_FILES = ["host.js", "server.js", "cli.js", "mobile.html", "mobile.js", "mobile.css", "manifest.webmanifest", "mobile-icon.png", "mobile-icon.svg", "omp-sessions.SKILL.md"];

/** What other extension modules need from the server side. */
export interface ServerControl {
	/** Starts the server (or restarts an older one); resolves with a status line, rejects when it does not come up. */
	ensureRunning(): Promise<string>;
}

export function runtimeDir(): string {
	return path.join(stateRoot(), "runtime");
}

function copyAtomic(from: string, to: string): void {
	const tmp = `${to}.${process.pid}.tmp`;
	fs.copyFileSync(from, tmp);
	fs.renameSync(tmp, to);
}

/**
 * Copies the bundles (+ a package.json carrying the version) into the runtime folder when its
 * version differs. Running hosts keep the code they loaded; renames never tear a file.
 */
export function installRuntime(outDir: string, version: string): string {
	const dir = runtimeDir();
	const current = readHostVersion(path.join(dir, "host.js"));
	const complete = RUNTIME_FILES.every(f => fs.existsSync(path.join(dir, f))) && fs.existsSync(path.join(dir, PLUGIN_BUNDLE, "plugin.yaml"));
	if (complete && current === version) return dir;
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const f of RUNTIME_FILES) copyAtomic(path.join(outDir, f), path.join(dir, f));
	// The Hermes plugin `omp-sessions hermes install` copies from (a folder: swapped in whole).
	const plugin = path.join(dir, PLUGIN_BUNDLE);
	const tmp = `${plugin}.${process.pid}.tmp`;
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.cpSync(path.join(outDir, PLUGIN_BUNDLE), tmp, { recursive: true });
	fs.rmSync(plugin, { recursive: true, force: true });
	fs.renameSync(tmp, plugin);
	const pkg = path.join(dir, "package.json");
	fs.writeFileSync(`${pkg}.tmp`, JSON.stringify({ name: "omp-sessions-runtime", version, private: true }));
	fs.renameSync(`${pkg}.tmp`, pkg);
	return dir;
}

/** A `node` on PATH that can run the bundles (Node 22+: Promise.withResolvers). */
function findSystemNode(): string | undefined {
	const r = spawnSync(process.platform === "win32" ? "where" : "which", ["node"], { encoding: "utf8" });
	const node = r.status === 0 ? r.stdout.split(/\r?\n/)[0]?.trim() : undefined;
	if (!node) return undefined;
	const v = spawnSync(node, ["-p", "process.versions.node"], { encoding: "utf8" });
	const major = Number.parseInt(v.stdout ?? "", 10);
	return v.status === 0 && major >= 22 ? node : undefined;
}

/**
 * Runtime for the server and CLI: a system Node 22+ survives VS Code updates; otherwise this
 * VS Code's own runtime (Electron/node as Node via ELECTRON_RUN_AS_NODE).
 */
function runtimeNode(): { path: string; electron: boolean } {
	const node = findSystemNode();
	return node ? { path: node, electron: false } : { path: process.execPath, electron: true };
}

function onPath(dir: string): boolean {
	const sep = process.platform === "win32" ? ";" : ":";
	return (process.env.PATH ?? "").split(sep).some(p => p && path.resolve(p) === path.resolve(dir));
}

export function registerServer(api: OmpApi): ServerControl {
	const { context } = api;
	const outDir = path.join(context.extensionPath, "out");
	const version = api.sessions.version;
	const log = vscode.window.createOutputChannel("omp Server", { log: true });
	context.subscriptions.push(log);

	/**
	 * Mirrors the user's own `omp.path`/`omp.extraArgs`/`omp.server.installService` (never a workspace's: they
	 * apply to every session on this machine) into launcher.json. A key the user hasn't set keeps launcher.json's
	 * value (`omp-sessions config set` may have set it), unless `cleared` lists it (the user just removed the
	 * setting). A relative omp.path would run a file from each session's folder: refused.
	 */
	const syncLauncher = (cleared: { path?: boolean; extraArgs?: boolean; service?: boolean } = {}) => {
		const cfg = vscode.workspace.getConfiguration("omp");
		const ompPath = cfg.inspect<string>("path")?.globalValue;
		const extraArgs = cfg.inspect<string[]>("extraArgs")?.globalValue;
		const service = cfg.inspect<boolean>("server.installService")?.globalValue;
		const problem = ompPath ? ompPathProblem(ompPath) : undefined;
		if (problem) void vscode.window.showWarningMessage(plain(`${problem}; omp Sessions keeps using the previous omp.`), "Open Settings").then(a => a && vscode.commands.executeCommand("workbench.action.openSettings", "omp.path"));
		const next = readLauncherSettings();
		if (ompPath !== undefined && !problem) next.ompPath = ompPath.trim() || undefined;
		else if (ompPath === undefined && cleared.path) next.ompPath = undefined;
		if (extraArgs !== undefined) next.extraArgs = extraArgs;
		else if (cleared.extraArgs) next.extraArgs = [];
		if (service !== undefined) next.service = service ? "on" : "off";
		else if (cleared.service) next.service = undefined;
		try {
			writeLauncherSettings(next);
		} catch (err) {
			log.warn(`could not write launcher settings: ${String(err)}`);
		}
	};
	syncLauncher();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			const changed = { path: e.affectsConfiguration("omp.path"), extraArgs: e.affectsConfiguration("omp.extraArgs"), service: e.affectsConfiguration("omp.server.installService") };
			if (changed.path || changed.extraArgs || changed.service) syncLauncher(changed);
		}),
	);

	let runtime: string | undefined;
	try {
		runtime = installRuntime(outDir, version);
	} catch (err) {
		log.error(`could not install the omp-sessions runtime: ${String(err)}`);
	}
	let node: { path: string; electron: boolean } | undefined;
	const getNode = () => {
		node ??= runtimeNode();
		return node;
	};

	/** Keeps an existing launcher pointing at a runtime that still exists (VS Code updates move its node). */
	const refreshShim = () => {
		if (!runtime) return;
		const file = launcherPath();
		let existing: string;
		try {
			existing = fs.readFileSync(file, "utf8");
		} catch {
			return;
		}
		if (!isOurLauncher(existing)) return;
		const text = launcherText(getNode(), path.join(runtime, "cli.js"));
		if (text !== existing) writeLauncher(file, text);
	};

	/** Moves the old command's launcher and service to the new name (a no-op once done). */
	const migrate = async () => {
		try {
			const moved = migrateLegacyLauncher();
			if (moved) {
				log.info(`replaced the launcher ${moved.from} with ${moved.to}`);
				const dir = path.dirname(moved.to);
				if (!onPath(dir)) void vscode.window.showInformationMessage(plain(`The terminal command is now \`${COMMAND}\`, installed at ${moved.to}. Add ${dir} to your PATH to run it.`));
			}
		} catch (err) {
			log.warn(`could not replace the old launcher: ${String(err)}`);
		}
		try {
			const service = await migrateLegacyService();
			if (service) log.info(`replaced the service ${service.from} with ${service.to}${service.started ? "" : " (it did not start; see systemctl/launchctl)"}`);
		} catch (err) {
			log.warn(`could not replace the old service: ${String(err)}`);
		}
	};

	let migration: Promise<void> | undefined;
	/**
	 * Tells the user once that the server now starts at login (ensureServer installed the user service).
	 * Turn Off does what `omp-sessions server uninstall && omp-sessions config set service off` does, and
	 * starts the server again without the service (removing the unit stopped the server it ran).
	 */
	const onServiceInstalled = (r: ServiceInstall) => {
		log.info(`installed the omp-sessions ${r.kind} user service ${r.file}${r.ok ? "" : " (it did not start)"}`);
		void vscode.window.showInformationMessage(plain(`The omp-sessions server is now a ${r.kind} user service (${r.file}): it restarts after a crash or reboot.`), "Turn Off").then(async a => {
			if (!a) return;
			try {
				removeServiceUnit(r.kind, r.file, r.kind === "systemd" ? SYSTEMD_UNIT : LAUNCHD_LABEL);
				writeLauncherSettings({ service: "off" });
				await vscode.workspace.getConfiguration("omp").update("server.installService", false, vscode.ConfigurationTarget.Global);
				log.info(`removed the omp-sessions user service ${r.file}; service off`);
				log.info(await startServer(false));
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`Could not remove the omp-sessions service: ${err instanceof Error ? err.message : String(err)}`));
			}
		});
	};
	/**
	 * VS Code's own runtime moves with VS Code updates (Remote-SSH: `~/.vscode-server/…/Stable-<commit>/…`):
	 * no new login service runs it. A unit whose node is gone is re-pointed at it, though, at every start.
	 */
	const serverStart = (): EnsureServerOptions => ({
		onServiceInstalled,
		onServiceRepaired: r => log.info(`the ${r.kind} user service ran a node or server.js that is gone; it now runs ${getNode().path} (${r.file})`),
		installService: !getNode().electron,
	});
	const startServer = async (restart: boolean): Promise<string> => {
		if (!runtime) throw new Error("the omp-sessions runtime is not installed");
		// The old command's service would hold the server socket, and must be gone before a new one is installed.
		await (migration ??= migrate());
		const script = path.join(runtime, "server.js");
		if (restart) await stopServer();
		let client = await ensureServer(script, getNode().path, undefined, serverStart());
		if (!client) throw new Error(`the omp-sessions server did not start (see ${serverLogPath()})`);
		let info = await client.request("ping", {}, 3000);
		if (compareVersions(info.version, version) < 0) {
			log.info(`restarting omp-sessions server ${info.version} → ${version}`);
			client.close();
			await stopServer();
			client = await ensureServer(script, getNode().path, undefined, serverStart());
			if (!client) throw new Error(`the omp-sessions server did not restart (see ${serverLogPath()})`);
			info = await client.request("ping", {}, 3000);
		}
		client.close();
		return `omp-sessions server ${info.version} running (pid ${info.pid})`;
	};

	// Off the activation path: finding node and starting the server take a moment. The migration
	// comes first: an old service would hold the server socket.
	setTimeout(async () => {
		await (migration ??= migrate());
		try {
			refreshShim();
		} catch (err) {
			log.warn(`could not refresh the omp-sessions command: ${String(err)}`);
		}
		if (process.env.OMP_SESSIONS_NO_SERVER || !vscode.workspace.getConfiguration("omp").get<boolean>("server.autoStart", true)) return;
		startServer(false).then(
			msg => log.info(msg),
			err => log.error(String(err instanceof Error ? err.message : err)),
		);
	}, 1500);

	context.subscriptions.push(
		vscode.commands.registerCommand("omp.installCli", async () => {
			if (!runtime) {
				void vscode.window.showErrorMessage("The omp-sessions runtime could not be installed; see the omp Server output.");
				return;
			}
			const file = launcherPath();
			try {
				migrateLegacyLauncher();
				writeLauncher(file, launcherText(getNode(), path.join(runtime, "cli.js")));
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`Could not install ${COMMAND}: ${String(err)}`));
				return;
			}
			const dir = path.dirname(file);
			const hint = onPath(dir) ? `Run \`${COMMAND} help\` in a terminal.` : `Add ${dir} to your PATH to run it as \`${COMMAND}\`.`;
			const pick = await vscode.window.showInformationMessage(plain(`Installed the ${COMMAND} command at ${file}. ${hint}`), "Open Terminal");
			if (pick === "Open Terminal") {
				const term = vscode.window.createTerminal({ name: COMMAND });
				term.show();
				term.sendText(onPath(dir) ? `${COMMAND} help` : `${JSON.stringify(file)} help`);
			}
		}),
		vscode.commands.registerCommand("omp.server.restart", async () => {
			try {
				void vscode.window.showInformationMessage(plain(await startServer(true)));
			} catch (err) {
				void vscode.window.showErrorMessage(plain(err instanceof Error ? err.message : String(err)));
			}
		}),
		vscode.commands.registerCommand("omp.server.showLog", async () => {
			const file = serverLogPath();
			if (!fs.existsSync(file)) {
				const running = await ServerClient.connect().catch(() => undefined);
				running?.close();
				void vscode.window.showInformationMessage(running ? "The omp-sessions server has not logged anything yet." : "The omp-sessions server has not run yet.");
				return;
			}
			await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
		}),
	);
	return { ensureRunning: () => startServer(false) };
}
