// The machine side from the extension (MAPPING: the server commands and settings now mean the planner, plus
// the AO daemon it and every client need): the planner (`out/planner.js`, a user service; src/planner) that
// holds queues and schedules, the AO daemon that runs every session (found through its run file, started as
// the `ao-daemon` systemd user unit or a detached process when none runs; src/ao/daemon.ts), the
// `omp-sessions` command (`omp.installCli`) and the runtime folder the planner and CLI run from (the
// extension folder changes with every update), and the `omp.extraArgs` mirror the CLI reads.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { type AoClient, defaultRunFile, ensureDaemon, findDaemon, stopDaemon } from "../ao/client";
import { daemonUnitName } from "../ao/daemon";
import { COMMAND, isOurLauncher, launcherPath, launcherText, writeLauncher } from "../shared/cli-launcher";
import { PLUGIN_BUNDLE } from "../shared/hermes-plugin";
import { migrationPending } from "./migration-offer";
import { type SwitchyardConfig, readSwitchyardConfig, writeSwitchyardConfig } from "../shared/switchyard-config";
import { switchyardHome } from "../ao/native";
import { stateRoot } from "../shared/protocol";
import { migrateLegacyLauncher } from "../shared/rename-migration";
import { ensurePlanner, stopPlanner } from "../planner/client";
import { logPath as plannerLogPath } from "../planner/paths";
import { installService as installPlannerService, serviceKind, serviceUnitPath } from "../planner/service";
import type { OmpApi } from "./api";
import { plain } from "./plain";

/** What the planner and CLI run from: their bundles and the agent skill the CLI installs (plus the Hermes plugin folder). */
const RUNTIME_FILES = ["cli.js", "planner.js", "omp-sessions.SKILL.md"];

/** What other extension modules need from the machine side. */
export interface ServerControl {
	/** A client for the AO daemon, starting it when none runs (an explicit user action asked for it). */
	client(): Promise<AoClient>;
}

export function runtimeDir(): string {
	return path.join(switchyardHome(), "runtime");
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
export function installedUnit(): string | undefined {
	if (process.platform !== "linux") return undefined;
	const unit = daemonUnitName(defaultRunFile());
	return spawnSync("systemctl", ["--user", "cat", `${unit}.service`], { stdio: "ignore", timeout: 5_000 }).status === 0 ? unit : undefined;
}

function readIfExists(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function shellQuote(args: readonly string[]): string {
	return args.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
}

export function registerServer(api: OmpApi): ServerControl {
	const { context, ao } = api;
	const outDir = path.join(context.extensionPath, "out");
	const version = api.sessions.version;

	/**
	 * Mirrors the user's own `omp.extraArgs`/`omp.server.installService` (never a workspace's: they apply to every
	 * session on this machine) into ~/.switchyard/config.json (`omp.extraArgs`, which the omp shim reads, and `service`). A key the user hasn't set keeps config.json's value (the CLI's
	 * `config set` may have set it), unless `cleared` lists it (the user just removed the setting).
	 */
	const syncLauncher = (cleared: { extraArgs?: boolean; service?: boolean } = {}) => {
		const cfg = vscode.workspace.getConfiguration("omp");
		const extraArgs = cfg.inspect<string[]>("extraArgs")?.globalValue;
		const service = cfg.inspect<boolean>("server.installService")?.globalValue;
		const next: SwitchyardConfig = {};
		if (extraArgs !== undefined) next.omp = extraArgs.length ? { extraArgs } : undefined;
		else if (cleared.extraArgs) next.omp = undefined;
		if (service !== undefined) next.service = service ? "on" : "off";
		else if (cleared.service) next.service = undefined;
		if (!Object.keys(next).length) return;
		try {
			writeSwitchyardConfig(next);
		} catch (err) {
			ao.log.warn(`could not write ~/.switchyard/config.json: ${String(err)}`);
		}
	};
	syncLauncher();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			const changed = { extraArgs: e.affectsConfiguration("omp.extraArgs"), service: e.affectsConfiguration("omp.server.installService") };
			if (changed.extraArgs || changed.service) syncLauncher(changed);
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

	const plannerScript = () => {
		if (!runtime) throw new Error("the omp-sessions runtime is not installed (see the AO output)");
		return path.join(runtime, "planner.js");
	};
	/**
	 * Starts the planner: through its user service, installed the first time when `omp.server.installService`
	 * allows and a system Node runs it (VS Code's own runtime moves with every VS Code update), else detached.
	 */
	const startPlanner = async (): Promise<string> => {
		const script = plannerScript();
		const kind = serviceKind();
		// Auto-install policy (the planner never installs itself): once per machine, only for the default SWITCHYARD_HOME (a
		// test or scratch home must never create a user unit), and never when the person said `service off` (setting or CLI).
		const wantService =
			vscode.workspace.getConfiguration("omp").get<boolean>("server.installService", true) && readSwitchyardConfig().service !== "off" && !process.env.SWITCHYARD_HOME && !getNode().electron;
		// A unit that pins another script (the runtime copy moved, e.g. from ~/.omp/vscode/runtime to ~/.switchyard/runtime) is
		// installed again: the service would keep running the old planner.
		const unitText = kind ? readIfExists(serviceUnitPath(kind)) : undefined;
		if (wantService && kind && (unitText === undefined || !unitText.includes(script))) {
			const r = installPlannerService(script, getNode().path);
			if (r) ao.log.info(`installed the planner ${r.kind} user service ${r.file}${r.ok ? "" : " (it did not start)"}`);
		}
		const planner = await ensurePlanner(script, getNode().path);
		if (!planner) throw new Error(`the planner did not start (see ${plannerLogPath()})`);
		const info = await planner.request("ping", {}, 3000).finally(() => planner.close());
		return `planner ${info.version} running (pid ${info.pid})`;
	};

	const ensureRunning = async (): Promise<string> => {
		const client = await ao.client(true);
		const daemon = await findDaemon();
		const unit = installedUnit();
		const aoLine = `AO daemon running at ${client.baseUrl}${daemon ? ` (pid ${daemon.pid}${unit ? `, systemd unit ${unit}` : ""})` : ""}`;
		return `${aoLine}; ${await startPlanner()}`;
	};

	/** Runs the runtime's CLI as the `omp-sessions` launcher would: this node (Electron as Node when it is VS Code's). */
	const cliEnv = (): NodeJS.ProcessEnv => (getNode().electron ? { ELECTRON_RUN_AS_NODE: "1" } : {});

	const showError = (err: unknown) =>
		void vscode.window.showErrorMessage(plain(err instanceof Error ? err.message : String(err)), "Show Log").then(a => a && vscode.commands.executeCommand("omp.server.showLog"));

	/** Runs the runtime's CLI in a terminal (the launcher may not be on this terminal's PATH). */
	const runCliInTerminal = (cliArgs: string[]) => {
		const args = [getNode().path, path.join(runtime ?? "", "cli.js"), ...cliArgs];
		const windows = process.platform === "win32";
		const terminal = vscode.window.createTerminal({ name: COMMAND, env: cliEnv(), shellPath: windows ? "powershell.exe" : undefined });
		terminal.show();
		terminal.sendText(windows ? `& ${args.map(a => `"${a.replace(/[`"$]/g, "`$&")}"`).join(" ")}` : shellQuote(args));
	};

	/** Once per machine: omp Sessions data exists and `migrate` never ran: offer its dry run (it writes nothing). */
	const offerMigration = async () => {
		if (!runtime || context.globalState.get<boolean>("switchyard.migrateOffered") || !migrationPending(stateRoot(), switchyardHome())) return;
		const pick = await vscode.window.showInformationMessage(
			plain("Switchyard found data from omp Sessions (groups, board lanes, defaults). See what it would copy over?"),
			"Preview (dry run)",
			"Don't ask again",
		);
		if (!pick) return;
		await context.globalState.update("switchyard.migrateOffered", true);
		if (pick === "Preview (dry run)") runCliInTerminal(["migrate"]);
	};

	// Off the activation path: finding node and starting the planner take a moment.
	setTimeout(() => {
		try {
			migrateLegacyLauncher();
			refreshShim();
		} catch (err) {
			ao.log.warn(`could not refresh the omp-sessions command: ${String(err)}`);
		}
		void offerMigration();
		if (!ao.mayStart()) return;
		startPlanner().then(
			msg => ao.log.info(msg),
			err => ao.log.error(`planner: ${err instanceof Error ? err.message : String(err)}`),
		);
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
			try {
				const kind = serviceKind();
				if (!kind) {
					void vscode.window.showInformationMessage("Login services exist on Linux (systemd) and macOS (launchd); on Windows the planner and AO start when a client needs them.");
					return;
				}
				const lines: string[] = [];
				const planner = installPlannerService(plannerScript(), getNode().path);
				if (planner) lines.push(`the planner runs as the ${planner.kind} user service ${planner.file}${planner.ok ? "" : " (it did not start)"}${getNode().electron ? "; it uses VS Code's own Node, which VS Code updates replace: the next start re-points it" : ""}`);
				// ensureDaemon installs and enables the `ao-daemon` user unit when it starts the default daemon under systemd.
				let unit = installedUnit();
				if (!unit && kind === "systemd") {
					const running = await findDaemon();
					const ok =
						!running ||
						(await vscode.window.showWarningMessage(
							"Restart the AO daemon as a systemd user service?",
							{ modal: true, detail: "It runs without one now. Sessions keep running across the restart (their hosts are separate processes); the service starts AO at login and after a crash." },
							"Restart as Service",
						)) === "Restart as Service";
					if (ok) {
						if (running) await stopDaemon(running);
						await ensureDaemon({ supervisor: "systemd", log: m => ao.log.info(m) });
						unit = installedUnit();
					}
				}
				if (unit) lines.push(`the AO daemon runs as the systemd user service ${unit}.service`);
				void vscode.window.showInformationMessage(plain(`${lines.join("; ")}. They start at login and restart after a crash.`));
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
			try {
				await stopPlanner();
				void vscode.window.showInformationMessage(plain(`Restarted: ${await startPlanner()}. The AO daemon keeps running (its sessions too).`));
			} catch (err) {
				showError(err);
			}
		}),
		vscode.commands.registerCommand("omp.server.showLog", async () => {
			const unit = installedUnit();
			const aoFile = path.join(path.dirname(defaultRunFile()), "daemon.log");
			const pick = await vscode.window.showQuickPick(
				[
					{ label: "Planner", description: plannerLogPath(), which: "planner" },
					{ label: "AO daemon", description: unit ? `journalctl --user -u ${unit}` : fs.existsSync(aoFile) ? aoFile : "this window's AO output", which: "ao" },
				],
				{ placeHolder: "Show which log?" },
			);
			if (pick?.which === "planner") {
				if (fs.existsSync(plannerLogPath())) await vscode.window.showTextDocument(vscode.Uri.file(plannerLogPath()), { preview: true });
				else void vscode.window.showInformationMessage("The planner has not logged anything yet.");
			} else if (pick?.which === "ao") {
				if (unit) {
					const terminal = vscode.window.createTerminal({ name: "AO daemon log" });
					terminal.show();
					terminal.sendText(shellQuote(["journalctl", "--user", "-u", `${unit}.service`, "-n", "300", "-f"]));
				} else if (fs.existsSync(aoFile)) await vscode.window.showTextDocument(vscode.Uri.file(aoFile), { preview: true });
				else ao.log.show();
			}
		}),
	);
	return { client: () => ao.client(true) };
}
