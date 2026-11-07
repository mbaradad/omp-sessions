// The omp-vs server and CLI from the extension's side: mirrors `omp.path`/`omp.extraArgs` into
// launcher.json, installs host/server/cli bundles into a stable runtime folder (the extension
// folder changes with every update), keeps the server running at this version, and installs
// the `omp-vs` command (`omp.installCli`).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { readHostVersion, writeLauncherSettings } from "../shared/launch";
import { stateRoot } from "../shared/protocol";
import { ServerClient, compareVersions, ensureServer, stopServer } from "../shared/server-client";
import { serverLogPath } from "../shared/server-protocol";
import type { OmpApi } from "./api";

/** Bundles the CLI and server run from, plus the phone app the server serves (next to server.js). */
const RUNTIME_FILES = ["host.js", "server.js", "cli.js", "mobile.html", "mobile.js", "mobile.css", "manifest.webmanifest", "mobile-icon.png", "mobile-icon.svg"];

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
	const complete = RUNTIME_FILES.every(f => fs.existsSync(path.join(dir, f)));
	if (complete && current === version) return dir;
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const f of RUNTIME_FILES) copyAtomic(path.join(outDir, f), path.join(dir, f));
	const pkg = path.join(dir, "package.json");
	fs.writeFileSync(`${pkg}.tmp`, JSON.stringify({ name: "omp-vs-runtime", version, private: true }));
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

export function cliShimPath(): string {
	return process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "omp-vs", "omp-vs.cmd") : path.join(os.homedir(), ".local", "bin", "omp-vs");
}

const SHIM_MARK = "installed by the omp Sessions VS Code extension";

function shimText(node: { path: string; electron: boolean }, cli: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nrem omp-vs: ${SHIM_MARK}\r\n${node.electron ? "set ELECTRON_RUN_AS_NODE=1\r\n" : ""}"${node.path}" "${cli}" %*\r\n`;
	}
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	const home = process.env.OMP_VSCODE_HOME ? `OMP_VSCODE_HOME=${q(process.env.OMP_VSCODE_HOME)} ` : "";
	return `#!/bin/sh\n# omp-vs: ${SHIM_MARK}\n${node.electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}${home}exec ${q(node.path)} ${q(cli)} "$@"\n`;
}

function writeShim(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, { mode: 0o755 });
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

	const syncLauncher = () => {
		const cfg = vscode.workspace.getConfiguration("omp");
		try {
			writeLauncherSettings({ ompPath: cfg.get<string>("path") || undefined, extraArgs: cfg.get<string[]>("extraArgs") ?? [] });
		} catch (err) {
			log.warn(`could not write launcher settings: ${String(err)}`);
		}
	};
	syncLauncher();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("omp.path") || e.affectsConfiguration("omp.extraArgs")) syncLauncher();
		}),
	);

	let runtime: string | undefined;
	try {
		runtime = installRuntime(outDir, version);
	} catch (err) {
		log.error(`could not install the omp-vs runtime: ${String(err)}`);
	}
	let node: { path: string; electron: boolean } | undefined;
	const getNode = () => {
		node ??= runtimeNode();
		return node;
	};

	/** Keeps an existing shim pointing at a runtime that still exists (VS Code updates move its node). */
	const refreshShim = () => {
		if (!runtime) return;
		const file = cliShimPath();
		let existing: string;
		try {
			existing = fs.readFileSync(file, "utf8");
		} catch {
			return;
		}
		if (!existing.includes(SHIM_MARK)) return;
		const text = shimText(getNode(), path.join(runtime, "cli.js"));
		if (text !== existing) writeShim(file, text);
	};

	const startServer = async (restart: boolean): Promise<string> => {
		if (!runtime) throw new Error("the omp-vs runtime is not installed");
		const script = path.join(runtime, "server.js");
		if (restart) await stopServer();
		let client = await ensureServer(script, getNode().path);
		if (!client) throw new Error(`the omp-vs server did not start (see ${serverLogPath()})`);
		let info = await client.request("ping", {}, 3000);
		if (compareVersions(info.version, version) < 0) {
			log.info(`restarting omp-vs server ${info.version} → ${version}`);
			client.close();
			await stopServer();
			client = await ensureServer(script, getNode().path);
			if (!client) throw new Error(`the omp-vs server did not restart (see ${serverLogPath()})`);
			info = await client.request("ping", {}, 3000);
		}
		client.close();
		return `omp-vs server ${info.version} running (pid ${info.pid})`;
	};

	// Off the activation path: finding node and starting the server take a moment.
	setTimeout(() => {
		try {
			refreshShim();
		} catch (err) {
			log.warn(`could not refresh the omp-vs command: ${String(err)}`);
		}
		if (process.env.OMP_VS_NO_SERVER || !vscode.workspace.getConfiguration("omp").get<boolean>("server.autoStart", true)) return;
		startServer(false).then(
			msg => log.info(msg),
			err => log.error(String(err instanceof Error ? err.message : err)),
		);
	}, 1500);

	context.subscriptions.push(
		vscode.commands.registerCommand("omp.installCli", async () => {
			if (!runtime) {
				void vscode.window.showErrorMessage("The omp-vs runtime could not be installed; see the omp Server output.");
				return;
			}
			const file = cliShimPath();
			try {
				writeShim(file, shimText(getNode(), path.join(runtime, "cli.js")));
			} catch (err) {
				void vscode.window.showErrorMessage(`Could not install omp-vs: ${String(err)}`);
				return;
			}
			const dir = path.dirname(file);
			const hint = onPath(dir) ? "Run `omp-vs help` in a terminal." : `Add ${dir} to your PATH to run it as \`omp-vs\`.`;
			const pick = await vscode.window.showInformationMessage(`Installed the omp-vs command at ${file}. ${hint}`, "Open Terminal");
			if (pick === "Open Terminal") {
				const term = vscode.window.createTerminal({ name: "omp-vs" });
				term.show();
				term.sendText(onPath(dir) ? "omp-vs help" : `${JSON.stringify(file)} help`);
			}
		}),
		vscode.commands.registerCommand("omp.server.restart", async () => {
			try {
				void vscode.window.showInformationMessage(await startServer(true));
			} catch (err) {
				void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
			}
		}),
		vscode.commands.registerCommand("omp.server.showLog", async () => {
			const file = serverLogPath();
			if (!fs.existsSync(file)) {
				const running = await ServerClient.connect();
				running?.close();
				void vscode.window.showInformationMessage(running ? "The omp-vs server has not logged anything yet." : "The omp-vs server has not run yet.");
				return;
			}
			await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
		}),
	);
	return { ensureRunning: () => startServer(false) };
}
