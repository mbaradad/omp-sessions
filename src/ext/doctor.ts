// Self-help for novices and experts: missing-omp and not-logged-in guidance, the omp Doctor
// report (with fixes), diagnostics for bug reports, host upgrades and crash recovery prompts.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { HOST_CRASHED, isOutdated, settleDeadHost } from "../shared/health";
import { PLUGIN_BUNDLE, findHermes, findOmpSessions, gatewayPath, hermesCommand, hermesLookup, hermesRoot, parseLaneStatus, pluginReport, resolveTargets } from "../shared/hermes-plugin";
import { canConnect, hostAlive as hostIsAlive, sendToHost } from "../shared/launch";
import { type SessionMeta, sessionDir, sessionsRoot } from "../shared/protocol";
import type { OmpApi } from "./api";
import type { HermesFacts } from "./doctor-hermes";
import {
	type DoctorFacts,
	type Report,
	type SessionFacts,
	abnormalStop,
	buildReport,
	cleanupCandidates,
	formatBytes,
	installCommand,
	issueUrl,
	reportCommands,
	reportToHtml,
	reportToMarkdown,
	tail,
} from "./doctor-report";
import { plain } from "./plain";
import type { ServerControl } from "./server";
import { resolveOmpPath } from "./sessions";

const HIDE_MISSING_KEY = "omp.doctor.hideOmpMissing";
const SEEN_VERSION_KEY = "omp.doctor.seenVersion";
const LEARN_MORE = "https://omp.sh";
const IS_WINDOWS = process.platform === "win32";

/** Folders GUI-launched editors often lack on PATH, where Bun/npm put omp and Bun itself. */
function extraBinDirs(): string[] {
	const home = os.homedir();
	const dirs = [path.join(home, ".bun", "bin"), path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin")];
	if (IS_WINDOWS && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
	else if (!IS_WINDOWS) dirs.push("/opt/homebrew/bin", "/usr/local/bin");
	return dirs;
}

function findExecutable(name: string): string | undefined {
	const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...extraBinDirs()];
	const names = IS_WINDOWS ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
	for (const d of dirs) {
		if (!d) continue;
		for (const n of names) {
			const candidate = path.join(d, n);
			try {
				fs.accessSync(candidate, IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK);
				return candidate;
			} catch {
				/* keep looking */
			}
		}
	}
	return undefined;
}

/** omp executable state: `exists` is false for an `omp.path` that points nowhere. */
function ompStatus(): { configured?: string; resolved?: string; exists: boolean } {
	const configured = vscode.workspace.getConfiguration("omp").get<string>("path")?.trim() || undefined;
	const resolved = resolveOmpPath();
	// A bare command name (`omp`) is looked up on PATH at spawn time.
	const exists = !!resolved && (!path.isAbsolute(resolved) || fs.existsSync(resolved));
	return { configured, resolved, exists };
}

/** `omp --version`, with the PATH additions the session host also uses (omp runs on Bun). */
function ompVersion(omp: string): Promise<{ version?: string; error?: string }> {
	const { promise, resolve } = Promise.withResolvers<{ version?: string; error?: string }>();
	const env = { ...process.env };
	const pathKey = Object.keys(env).find(k => k.toUpperCase() === "PATH") ?? "PATH";
	env[pathKey] = [...extraBinDirs(), env[pathKey] ?? ""].filter(Boolean).join(path.delimiter);
	delete env.ELECTRON_RUN_AS_NODE;
	execFile(omp, ["--version"], { env, timeout: 15_000, windowsHide: true, shell: IS_WINDOWS && /\.(cmd|bat)$/i.test(omp) }, (err, stdout, stderr) => {
		const out = stdout.trim();
		if (err && !out) resolve({ error: (stderr.trim() || err.message).slice(0, 500) });
		else resolve({ version: out.replace(/^omp\//, "").split(/\s+/)[0] || out });
	});
	return promise;
}

function readMetaFile(id: string): SessionMeta | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(sessionDir(id), "meta.json"), "utf8")) as SessionMeta;
	} catch {
		return undefined;
	}
}

async function dirBytes(dir: string): Promise<number> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	const sizes = await Promise.all(
		entries.map(async e => {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) return dirBytes(p);
			try {
				return (await fs.promises.stat(p)).size;
			} catch {
				return 0;
			}
		}),
	);
	return sizes.reduce((a, b) => a + b, 0);
}

/** Last lines of a session's host.log (only the final 64 KiB are read). */
function logTail(id: string, lines = 20): string | undefined {
	const file = path.join(sessionDir(id), "host.log");
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const size = fs.fstatSync(fd).size;
		const len = Math.min(size, 64 * 1024);
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, size - len);
		return tail(buf.toString("utf8"), lines) || undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

async function gatherSessions(): Promise<SessionFacts[]> {
	let ids: string[] = [];
	try {
		ids = fs.readdirSync(sessionsRoot());
	} catch {
		return [];
	}
	const facts = await Promise.all(
		ids.map(async (id): Promise<SessionFacts | undefined> => {
			const meta = readMetaFile(id);
			if (!meta) return undefined;
			const hostAlive = meta.status !== "stopped" && hostIsAlive(meta);
			const socketOk = hostAlive ? await canConnect(meta.socket) : undefined;
			const blobBytes = await dirBytes(path.join(sessionDir(id), "blobs"));
			const troubled = settleDeadHost(meta, hostAlive) !== meta || abnormalStop(meta) || socketOk === false;
			return { meta, hostAlive, socketOk, blobBytes, logTail: troubled ? logTail(id) : undefined };
		}),
	);
	return facts.filter((f): f is SessionFacts => !!f);
}

/** `hermes -p <profile> omp status --json`, parsed; `error` when it fails. */
function laneStatus(hermes: string, profile: string): Promise<NonNullable<HermesFacts["lane"]>> {
	const { promise, resolve } = Promise.withResolvers<NonNullable<HermesFacts["lane"]>>();
	const cmd = hermesCommand(hermes, ["-p", profile, "omp", "status", "--json"]);
	execFile(cmd.file, cmd.args, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 60_000, shell: cmd.shell, windowsHide: true }, (err, stdout, stderr) => {
		const status = parseLaneStatus(stdout);
		resolve(status ? { profile, status } : { profile, error: (`${stderr}`.trim() || err?.message || "no JSON in the output").slice(0, 400) });
	});
	return promise;
}

/** The Hermes section's facts; undefined when Hermes Agent isn't on this machine. */
async function gatherHermes(extensionPath: string): Promise<HermesFacts | undefined> {
	const hermes = findHermes();
	if (!hermes && !fs.existsSync(hermesRoot())) return undefined;
	const source = path.join(extensionPath, "out", PLUGIN_BUNDLE);
	const targets = resolveTargets({ all: true });
	const profiles = targets.map(t => pluginReport(source, t));
	const enabled = profiles.filter(r => r.status === "enabled");
	const ask = enabled.find(r => r.label === "default") ?? enabled[0];
	const lane = hermes && ask ? await laneStatus(hermes, ask.label) : undefined;
	// The plugin runs in a gateway: search the PATH of the first enabled profile's gateway with a readable
	// record (a per-profile gateway has its own), else the default home's (the multiplexed gateway).
	const homes = [...enabled.map(r => ({ setting: r.ompSessions, home: targets[profiles.indexOf(r)]?.home })), { setting: undefined, home: hermesRoot() }];
	const gateway = homes.map(h => ({ setting: h.setting, path: h.home ? gatewayPath(h.home) : undefined })).find(g => g.path !== undefined);
	const ompSessions = findOmpSessions(gateway?.setting ?? enabled.find(r => r.ompSessions)?.ompSessions, gateway?.path);
	return { hermes, lookup: hermesLookup(), profiles, lane, ompSessions, gatewayPath: gateway !== undefined, now: Date.now() };
}

function retentionDays(): number {
	const days = vscode.workspace.getConfiguration("omp").get<number>("snapshotRetentionDays", 14);
	return Number.isFinite(days) && days >= 0 ? days : 14;
}

function bugsUrl(api: OmpApi): string | undefined {
	const pkg: unknown = api.context.extension.packageJSON;
	if (!pkg || typeof pkg !== "object" || !("bugs" in pkg)) return undefined;
	const bugs = pkg.bugs;
	if (typeof bugs === "string") return bugs;
	return bugs && typeof bugs === "object" && "url" in bugs && typeof bugs.url === "string" ? bugs.url : undefined;
}

// `env.openExternal` also accepts the raw string, which keeps the query exactly as written; a Uri
// would be re-encoded (`&`/`=` escaped), dropping the prefilled issue title and body.
const openExternalString = vscode.env.openExternal as unknown as (target: string) => Thenable<boolean>;

export function registerDoctor(api: OmpApi, server: ServerControl): void {
	const { context, sessions } = api;
	const reg = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	let missingShown = false;
	let installWatch: NodeJS.Timeout | undefined;
	let doctorPanel: vscode.WebviewPanel | undefined;
	/** Busy sessions to restart on the current host as soon as they are idle. */
	const upgradeWhenIdle = new Set<string>();
	const authNotified = new Set<string>();
	context.subscriptions.push({ dispose: () => clearInterval(installWatch) });

	// ---------- omp missing ----------
	async function showOmpMissing(automatic: boolean): Promise<void> {
		if (automatic && (missingShown || context.globalState.get<boolean>(HIDE_MISSING_KEY))) return;
		missingShown = true;
		const st = ompStatus();
		const message =
			st.configured && !st.exists
				? `The omp executable set in omp.path does not exist: ${st.resolved}`
				: "omp is not installed (or not on PATH). omp Sessions runs the omp coding agent CLI in the background.";
		const actions = ["Install omp", "Set Path…", "Learn More"];
		if (automatic) actions.push("Don't Show Again");
		const pick = await vscode.window.showWarningMessage(plain(message), ...actions);
		if (pick === "Install omp") await vscode.commands.executeCommand("omp.installOmp");
		else if (pick === "Set Path…") await vscode.commands.executeCommand("omp.setOmpPath");
		else if (pick === "Learn More") await vscode.env.openExternal(vscode.Uri.parse(LEARN_MORE));
		else if (pick === "Don't Show Again") await context.globalState.update(HIDE_MISSING_KEY, true);
	}

	reg("omp.showOmpMissing", () => showOmpMissing(false));
	context.subscriptions.push(sessions.onOmpMissing(() => void showOmpMissing(false)));
	if (!ompStatus().exists) void showOmpMissing(true);

	/** Polls for the omp executable after an install was started, then suggests the next step. */
	function watchForInstall(): void {
		clearInterval(installWatch);
		const deadline = Date.now() + 20 * 60_000;
		installWatch = setInterval(() => {
			const st = ompStatus();
			if (!st.exists && Date.now() < deadline) return;
			clearInterval(installWatch);
			installWatch = undefined;
			if (!st.exists) return;
			void vscode.window.showInformationMessage(plain(`omp is installed (${st.resolved}). Next, log in to a model provider.`), "Log In", "New Session").then(a => {
				if (a === "Log In") void vscode.commands.executeCommand("omp.login");
				else if (a === "New Session") void vscode.commands.executeCommand("omp.newSession");
			});
		}, 3000);
	}

	reg("omp.installOmp", async () => {
		const command = installCommand(process.platform, findExecutable("bun"), findExecutable("npm"));
		const pick = await vscode.window.showInformationMessage(
			"Install omp",
			{ modal: true, detail: `This command runs in a new terminal${vscode.env.remoteName ? " on the remote machine" : ""}:\n\n${command}\n\nomp is the npm package @oh-my-pi/pi-coding-agent and runs on Bun.` },
			"Run in Terminal",
			"Copy Command",
		);
		if (pick === "Copy Command") {
			await vscode.env.clipboard.writeText(command);
			watchForInstall();
		} else if (pick === "Run in Terminal") {
			const terminal = vscode.window.createTerminal({ name: "Install omp", shellPath: IS_WINDOWS ? "powershell.exe" : undefined });
			terminal.show();
			terminal.sendText(command);
			watchForInstall();
		}
	});

	reg("omp.setOmpPath", async () => {
		const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: "Use this omp", title: "Select the omp executable", defaultUri: vscode.Uri.file(os.homedir()) });
		const file = picked?.[0]?.fsPath;
		if (!file) return;
		await vscode.workspace.getConfiguration("omp").update("path", file, vscode.ConfigurationTarget.Global);
		const v = await ompVersion(file);
		if (v.error) void vscode.window.showWarningMessage(plain(`omp.path is set, but \`omp --version\` failed: ${v.error}`), "Run Doctor").then(a => a && vscode.commands.executeCommand("omp.doctor"));
		else void vscode.window.showInformationMessage(plain(`Using omp ${v.version} at ${file}.`));
	});

	// ---------- not logged in ----------
	function checkAuth(): void {
		for (const m of sessions.all()) {
			if (m.status === "stopped" || !m.authProblem || authNotified.has(m.id) || !sessions.notifies(m)) continue;
			authNotified.add(m.id);
			void vscode.window.showWarningMessage(plain(`omp can't use a model in "${m.title}" (${m.authProblem}). Log in to a model provider?`), "Log In", "Open Chat", "Run Doctor").then(a => {
				if (a === "Log In") void vscode.commands.executeCommand("omp.login");
				else if (a === "Open Chat") api.openPanel(m.id);
				else if (a === "Run Doctor") void vscode.commands.executeCommand("omp.doctor");
			});
		}
	}
	context.subscriptions.push(sessions.onDidChange(checkAuth));
	checkAuth();

	// ---------- crash recovery ----------
	context.subscriptions.push(
		sessions.onDidTransition(({ meta, from }) => {
			if (upgradeWhenIdle.has(meta.id) && meta.status === "idle") {
				upgradeWhenIdle.delete(meta.id);
				void restartOnCurrentHost(meta);
			}
			if (meta.status !== "stopped" || from === "stopped" || meta.exitReason !== HOST_CRASHED || !sessions.notifies(meta)) return;
			void vscode.window.showWarningMessage(plain(`The omp session "${meta.title}" stopped unexpectedly mid-turn (its host process died).`), "Resume and Continue", "Show Log").then(a => {
				if (a === "Resume and Continue") void api.launchAndOpen({ cwd: meta.cwd, id: meta.id });
				else if (a === "Show Log") void vscode.commands.executeCommand("omp.showLog", meta.id);
			});
		}),
	);

	reg("omp.doctor.markStopped", async (arg?: unknown) => {
		const id = api.idFrom(arg);
		const raw = id ? readMetaFile(id) : undefined;
		if (!id || !raw || raw.status === "stopped") return;
		if (hostIsAlive(raw)) {
			void vscode.window.showWarningMessage("That session's host is running; stop it instead.");
			return;
		}
		const file = path.join(sessionDir(id), "meta.json");
		const tmp = `${file}.doctor.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify({ ...settleDeadHost(raw, false), updatedAt: Date.now() }, null, 1));
			fs.renameSync(tmp, file);
		} catch (err) {
			void vscode.window.showErrorMessage(plain(`Could not update ${file}: ${(err as Error).message}`));
		}
		sessions.refresh();
		if (doctorPanel) await runDoctor();
	});

	// ---------- host upgrades ----------
	/** Stops the session's host and resumes it on this extension's host. */
	async function restartOnCurrentHost(meta: SessionMeta): Promise<boolean> {
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `omp: restarting "${meta.title}" on host ${sessions.version}` }, async () => {
			if (!(await sendToHost(meta, { t: "stop" }))) {
				try {
					process.kill(meta.pid, "SIGTERM");
				} catch {
					/* already gone */
				}
			}
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				sessions.refresh();
				if (sessions.get(meta.id)?.status !== "stopped") await sleep(200);
				else break;
			}
			if (sessions.get(meta.id)?.status !== "stopped") {
				void vscode.window.showErrorMessage(plain(`"${meta.title}" did not stop within 15 s; it still runs on the old host.`), "Show Log").then(a => a && vscode.commands.executeCommand("omp.showLog", meta.id));
				return false;
			}
			try {
				sessions.launch({ cwd: meta.cwd, id: meta.id });
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`Could not restart "${meta.title}": ${(err as Error).message}`));
				return false;
			}
			const ok = await sessions.waitForSocket(meta.id);
			if (!ok) {
				const reason = sessions.get(meta.id)?.exitReason;
				void vscode.window.showErrorMessage(plain(`"${meta.title}" did not come back up${reason ? `: ${reason}` : ""}.`), "Show Log").then(a => a && vscode.commands.executeCommand("omp.showLog", meta.id));
			}
			return ok;
		});
	}

	reg("omp.upgradeSession", async (arg?: unknown) => {
		const id = api.idFrom(arg) ?? (await api.pickSession("Upgrade which session's host?", m => isOutdated(m, sessions.version)));
		const meta = id ? sessions.get(id) : undefined;
		if (!meta) {
			if (!id) void vscode.window.showInformationMessage(`All running sessions use the current host (${sessions.version}).`);
			return;
		}
		if (meta.status === "stopped") {
			void vscode.window.showInformationMessage(plain(`"${meta.title}" is stopped; resuming it starts the current host.`));
			return;
		}
		if (!isOutdated(meta, sessions.version)) {
			const again = await vscode.window.showInformationMessage(plain(`"${meta.title}" already runs the current host (${sessions.version}). Restart it anyway?`), "Restart");
			if (!again) return;
		}
		if (meta.status === "idle") {
			if (await restartOnCurrentHost(meta)) void vscode.window.showInformationMessage(plain(`"${meta.title}" now runs host ${sessions.version}.`));
			return;
		}
		const pick = await vscode.window.showWarningMessage(
			`"${meta.title}" is ${meta.status === "waiting" ? "waiting for input" : meta.status}.`,
			{ modal: true, detail: "Upgrading restarts its host. Wait until it is idle, or restart now: the current turn stops, and you continue it on the new host by sending a message." },
			"Upgrade When Idle",
			"Restart Now",
		);
		if (pick === "Upgrade When Idle") {
			upgradeWhenIdle.add(meta.id);
			void vscode.window.showInformationMessage(plain(`"${meta.title}" will restart on the current host when it is idle.`));
		} else if (pick === "Restart Now") await restartOnCurrentHost(meta);
	});

	async function upgradeAll(includeBusy: boolean): Promise<void> {
		const outdated = sessions.all().filter(m => isOutdated(m, sessions.version));
		if (outdated.length === 0) {
			void vscode.window.showInformationMessage(`All running sessions use the current host (${sessions.version}).`);
			return;
		}
		const idle = outdated.filter(m => m.status === "idle");
		const busy = outdated.filter(m => m.status !== "idle");
		if (includeBusy) for (const m of busy) upgradeWhenIdle.add(m.id);
		const results = await Promise.all(idle.map(m => restartOnCurrentHost(m)));
		const done = results.filter(Boolean).length;
		const parts = [`Upgraded ${done} of ${idle.length} idle session(s) to host ${sessions.version}.`];
		if (busy.length) parts.push(includeBusy ? `${busy.length} busy session(s) will restart when idle.` : `${busy.length} busy session(s) left as they are.`);
		void vscode.window.showInformationMessage(parts.join(" "));
		if (doctorPanel) await runDoctor();
	}
	reg("omp.upgradeAllSessions", () => upgradeAll(true));

	// One-time offer after the extension was updated while sessions kept running on the old host.
	const seen = context.globalState.get<string>(SEEN_VERSION_KEY);
	if (sessions.version !== "unknown" && seen !== sessions.version) {
		void context.globalState.update(SEEN_VERSION_KEY, sessions.version);
		const outdated = sessions.all().filter(m => isOutdated(m, sessions.version));
		if (outdated.length) {
			const names = outdated.slice(0, 3).map(m => `"${m.title}"`).join(", ") + (outdated.length > 3 ? ` and ${outdated.length - 3} more` : "");
			void vscode.window.showInformationMessage(plain(`omp Sessions was updated to ${sessions.version}. ${outdated.length} running session(s) still use the previous host: ${names}.`), "Upgrade Idle Sessions", "Later").then(a => {
				if (a === "Upgrade Idle Sessions") void upgradeAll(false);
			});
		}
	}

	// ---------- report ----------
	async function gatherFacts(): Promise<DoctorFacts> {
		const st = ompStatus();
		const version = st.exists && st.resolved ? await ompVersion(st.resolved) : {};
		const root = sessionsRoot();
		let writable = true;
		let writeError: string | undefined;
		try {
			fs.mkdirSync(root, { recursive: true, mode: 0o700 });
			const probe = path.join(root, `.doctor-${process.pid}`);
			fs.writeFileSync(probe, "");
			fs.unlinkSync(probe);
		} catch (err) {
			writable = false;
			writeError = (err as Error).message;
		}
		const [sessionFacts, serverStatus, hermes] = await Promise.all([gatherSessions(), server.status(), gatherHermes(context.extensionPath)]);
		const now = Date.now();
		return {
			now,
			extensionVersion: sessions.version,
			vscodeVersion: vscode.version,
			nodeVersion: process.versions.node,
			platform: process.platform,
			arch: process.arch,
			osRelease: os.release(),
			remoteName: vscode.env.remoteName,
			omp: { configured: st.configured, resolved: st.resolved, exists: st.exists, version: version.version, versionError: version.error },
			bun: findExecutable("bun"),
			stateDir: root,
			writable,
			writeError,
			socket: { platform: process.platform, sessionsRoot: root, tmpdir: os.tmpdir() },
			sessions: sessionFacts,
			cleanupDays: retentionDays(),
			server: { ...serverStatus, extensionVersion: sessions.version, now },
			hermes,
		};
	}

	async function makeReport(): Promise<Report> {
		return buildReport(await gatherFacts(), path.join);
	}

	async function runDoctor(): Promise<void> {
		const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "omp: running Doctor…" }, makeReport);
		if (!doctorPanel) {
			doctorPanel = vscode.window.createWebviewPanel("omp.doctor", "omp Doctor", vscode.ViewColumn.Active, { enableCommandUris: reportCommands(report), enableFindWidget: true });
			doctorPanel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "omp-color.svg");
			doctorPanel.onDidDispose(() => {
				doctorPanel = undefined;
			});
		} else {
			doctorPanel.webview.options = { enableCommandUris: reportCommands(report) };
			doctorPanel.reveal();
		}
		doctorPanel.webview.html = reportToHtml(report, os.homedir());
	}
	reg("omp.doctor", runDoctor);

	reg("omp.copyDiagnostics", async () => {
		const markdown = reportToMarkdown(await makeReport(), os.homedir());
		await vscode.env.clipboard.writeText(markdown);
		void vscode.window.showInformationMessage("omp diagnostics copied to the clipboard (secrets and your home folder are redacted).");
	});

	reg("omp.reportIssue", async () => {
		const markdown = reportToMarkdown(await makeReport(), os.homedir());
		const url = bugsUrl(api);
		if (!url) {
			await vscode.env.clipboard.writeText(markdown);
			void vscode.window.showInformationMessage("omp diagnostics copied to the clipboard; paste them into your bug report.");
			return;
		}
		const intro = "### What happened?\n\n<!-- Steps to reproduce, what you expected, what you saw. -->\n\n";
		const full = issueUrl(url, "", `${intro}<details><summary>omp Doctor report</summary>\n\n${markdown}\n</details>\n`);
		if (full) {
			await openExternalString(full);
			return;
		}
		// Too long for a URL: prefill the template and put the report on the clipboard.
		await vscode.env.clipboard.writeText(markdown);
		await openExternalString(issueUrl(url, "", `${intro}### Diagnostics\n\n<!-- The omp Doctor report is on your clipboard: paste it here. -->\n`) ?? `${url.replace(/\/+$/, "")}/new`);
		void vscode.window.showInformationMessage("The diagnostics are too long for a link: they are on your clipboard, paste them into the issue.");
	});

	// ---------- snapshot cleanup ----------
	reg("omp.cleanUpSnapshots", async () => {
		const input = await vscode.window.showInputBox({
			title: "Clean up file snapshots",
			prompt: "Delete snapshots of stopped sessions not used for this many days",
			value: String(retentionDays()),
			validateInput: v => (/^\d+$/.test(v.trim()) ? undefined : "Enter a whole number of days"),
		});
		if (input === undefined) return;
		const days = Number(input.trim());
		const candidates = cleanupCandidates(await gatherSessions(), days, Date.now());
		if (candidates.length === 0) {
			void vscode.window.showInformationMessage(`No stopped session older than ${days} day(s) has snapshots.`);
			return;
		}
		const bytes = candidates.reduce((n, s) => n + s.blobBytes, 0);
		const ok = await vscode.window.showWarningMessage(
			`Delete ${formatBytes(bytes)} of file snapshots from ${candidates.length} stopped session(s)?`,
			{ modal: true, detail: `${candidates.slice(0, 8).map(s => `• ${s.meta.title}`).join("\n")}${candidates.length > 8 ? `\n… and ${candidates.length - 8} more` : ""}\n\nTheir change diffs and reverts stop working; transcripts and session records stay.` },
			"Delete Snapshots",
		);
		if (ok !== "Delete Snapshots") return;
		let freed = 0;
		for (const s of candidates) {
			// Never pull blobs from under a session that was resumed meanwhile.
			const now = readMetaFile(s.meta.id);
			if (!now || (now.status !== "stopped" && hostIsAlive(now))) continue;
			try {
				fs.rmSync(path.join(sessionDir(s.meta.id), "blobs"), { recursive: true, force: true });
				freed += s.blobBytes;
			} catch {
				/* in use or permissions: leave it */
			}
		}
		void vscode.window.showInformationMessage(`Freed ${formatBytes(freed)}.`);
		if (doctorPanel) await runDoctor();
	});
}
