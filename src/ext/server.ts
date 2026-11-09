// The machine side from the extension: the AO daemon that runs every session (found through its run file,
// started as the `ao-daemon` systemd user unit or a detached process when none runs; src/ao/daemon.ts),
// the `omp-sessions` command (`omp.installCli`) and the runtime folder it runs from (the extension folder
// changes with every update), and the `omp.path`/`omp.extraArgs` mirror in launcher.json the CLI reads.
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { type AoClient, defaultRunFile, ensureDaemon, findDaemon, stopDaemon } from "../ao/client";
import { daemonUnitName } from "../ao/daemon";
import { COMMAND, isOurLauncher, launcherPath, launcherText, writeLauncher } from "../shared/cli-launcher";
import { PLUGIN_BUNDLE } from "../shared/hermes-plugin";
import { ompPathProblem, readLauncherSettings, writeLauncherSettings } from "../shared/launch";
import { stateRoot } from "../shared/protocol";
import { migrateLegacyLauncher } from "../shared/rename-migration";
import type { OmpApi } from "./api";
import { type ServerFacts, parseMachineStatus } from "./doctor-server";
import { plain } from "./plain";

/** What the CLI runs from: its bundle and the agent skill it installs (plus the Hermes plugin folder). */
const RUNTIME_FILES = ["cli.js", "omp-sessions.SKILL.md"];

/** What other extension modules need from the machine side. */
export interface ServerControl {
	/** Finds or starts the AO daemon; resolves with a status line, rejects when it does not come up. */
	ensureRunning(): Promise<string>;
	/** `omp-sessions status --json` from the installed runtime (never starts anything), or why it could not be read. */
	status(): Promise<Pick<ServerFacts, "status" | "error">>;
	/** A client for the AO daemon, starting it when none runs (an explicit user action asked for it). */
	client(): Promise<AoClient>;
}

export function runtimeDir(): string {
	return path.join(stateRoot(), "runtime");
}

function copyAtomic(from: string, to: string): void {
	const tmp = `${to}.${process.pid}.tmp`;
	fs.copyFileSync(from, tmp);
	fs.renameSync(tmp, to);
}

function runtimeVersion(dir: string): string | undefined {
	try {
		const pkg: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		return pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Copies the bundles (+ a package.json carrying the version) into the runtime folder when its
 * version differs. A running CLI keeps the code it loaded; renames never tear a file.
 */
export function installRuntime(outDir: string, version: string): string {
	const dir = runtimeDir();
	const complete = RUNTIME_FILES.every(f => fs.existsSync(path.join(dir, f))) && fs.existsSync(path.join(dir, PLUGIN_BUNDLE, "plugin.yaml"));
	if (complete && runtimeVersion(dir) === version) return dir;
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
 * Runtime for the CLI: a system Node 22+ survives VS Code updates; otherwise this
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

/** The systemd user unit that runs the default AO daemon, when one is installed. */
function installedUnit(): string | undefined {
	if (process.platform !== "linux") return undefined;
	const unit = daemonUnitName(defaultRunFile());
	return spawnSync("systemctl", ["--user", "cat", `${unit}.service`], { stdio: "ignore", timeout: 5_000 }).status === 0 ? unit : undefined;
}

function shellQuote(args: readonly string[]): string {
	return args.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
}

export function registerServer(api: OmpApi): ServerControl {
	const { context, ao } = api;
	const outDir = path.join(context.extensionPath, "out");
	const version = api.sessions.version;

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
			ao.log.warn(`could not write launcher settings: ${String(err)}`);
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
		ao.log.error(`could not install the omp-sessions runtime: ${String(err)}`);
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

	const ensureRunning = async (): Promise<string> => {
		const client = await ao.client(true);
		const daemon = await findDaemon();
		const unit = installedUnit();
		return `AO daemon running at ${client.baseUrl}${daemon ? ` (pid ${daemon.pid}${unit ? `, systemd unit ${unit}` : ""})` : ""}`;
	};

	/** Runs the runtime's CLI as the `omp-sessions` launcher would: this node (Electron as Node when it is VS Code's). */
	const cliEnv = (): NodeJS.ProcessEnv => (getNode().electron ? { ELECTRON_RUN_AS_NODE: "1" } : {});
	const status = (): Promise<Pick<ServerFacts, "status" | "error">> => {
		const { promise, resolve } = Promise.withResolvers<Pick<ServerFacts, "status" | "error">>();
		if (!runtime) {
			resolve({ error: "the omp-sessions runtime is not installed (see the AO output)" });
			return promise;
		}
		execFile(getNode().path, [path.join(runtime, "cli.js"), "status", "--json"], { encoding: "utf8", env: { ...process.env, ...cliEnv(), NO_COLOR: "1" }, timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
			const parsed = parseMachineStatus(stdout);
			resolve(parsed ? { status: parsed } : { error: (`${stderr}`.trim() || err?.message || "no JSON in the output").slice(0, 400) });
		});
		return promise;
	};

	const showError = (err: unknown) =>
		void vscode.window.showErrorMessage(plain(err instanceof Error ? err.message : String(err)), "Show Log").then(a => a && vscode.commands.executeCommand("omp.server.showLog"));

	// Off the activation path: finding node takes a moment.
	setTimeout(() => {
		try {
			migrateLegacyLauncher();
			refreshShim();
		} catch (err) {
			ao.log.warn(`could not refresh the omp-sessions command: ${String(err)}`);
		}
	}, 1500);

	context.subscriptions.push(
		vscode.commands.registerCommand("omp.installCli", async () => {
			if (!runtime) {
				void vscode.window.showErrorMessage("The omp-sessions runtime could not be installed; see the AO output.");
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
		vscode.commands.registerCommand("omp.server.start", async () => {
			try {
				void vscode.window.showInformationMessage(plain(await ensureRunning()));
				api.sessions.refresh();
			} catch (err) {
				showError(err);
			}
		}),
		vscode.commands.registerCommand("omp.server.install", async () => {
			// ensureDaemon installs and enables the `ao-daemon` user unit when it starts the default daemon under systemd.
			if (process.platform !== "linux") {
				void vscode.window.showInformationMessage("A login service for AO exists on Linux (systemd); elsewhere omp Sessions starts the AO daemon when it needs it.");
				return;
			}
			try {
				let unit = installedUnit();
				if (!unit) {
					const running = await findDaemon();
					if (running) {
						const ok = await vscode.window.showWarningMessage(
							"Restart the AO daemon as a systemd user service?",
							{ modal: true, detail: "It runs without one now. Sessions keep running across the restart (their hosts are separate processes); the service starts AO at login and after a crash." },
							"Restart as Service",
						);
						if (ok !== "Restart as Service") return;
						await stopDaemon(running);
					}
					await ensureDaemon({ supervisor: "systemd", log: m => ao.log.info(m) });
					unit = installedUnit();
				}
				if (unit) void vscode.window.showInformationMessage(plain(`The AO daemon runs as the systemd user service ${unit}.service: it starts at login and restarts after a crash.`));
				else void vscode.window.showWarningMessage("systemd did not take the AO service; see the AO output.");
				api.sessions.refresh();
			} catch (err) {
				showError(err);
			}
		}),
		vscode.commands.registerCommand("omp.server.statusInTerminal", () => {
			if (!runtime) {
				void vscode.window.showErrorMessage("The omp-sessions runtime could not be installed; see the AO output.");
				return;
			}
			const args = [getNode().path, path.join(runtime, "cli.js"), "status"];
			const windows = process.platform === "win32";
			const terminal = vscode.window.createTerminal({ name: COMMAND, env: cliEnv(), shellPath: windows ? "powershell.exe" : undefined });
			terminal.show();
			terminal.sendText(windows ? `& ${args.map(a => `"${a.replace(/[`"$]/g, "`$&")}"`).join(" ")}` : shellQuote(args));
		}),
		vscode.commands.registerCommand("omp.server.restart", async () => {
			const ok = await vscode.window.showWarningMessage(
				"Restart the AO daemon?",
				{ modal: true, detail: "Running sessions keep running (their hosts are separate processes) and reconnect when it is back." },
				"Restart",
			);
			if (ok !== "Restart") return;
			try {
				const running = await findDaemon();
				if (running) await stopDaemon(running);
				await ensureDaemon({ log: m => ao.log.info(m) });
				void vscode.window.showInformationMessage(plain(await ensureRunning()));
				api.sessions.refresh();
			} catch (err) {
				showError(err);
			}
		}),
		vscode.commands.registerCommand("omp.server.showLog", async () => {
			const unit = installedUnit();
			if (unit) {
				const terminal = vscode.window.createTerminal({ name: "AO daemon log" });
				terminal.show();
				terminal.sendText(shellQuote(["journalctl", "--user", "-u", `${unit}.service`, "-n", "300", "-f"]));
				return;
			}
			const file = path.join(path.dirname(defaultRunFile()), "daemon.log");
			if (fs.existsSync(file)) await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
			else ao.log.show();
		}),
	);
	return { ensureRunning, status, client: () => ao.client(true) };
}
