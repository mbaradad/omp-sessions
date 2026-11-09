// Self-help for novices and experts: missing-omp and not-logged-in guidance, the omp Doctor report (omp,
// the AO daemon and its view of omp, the planner, sessions; with fixes) and diagnostics for bug reports.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type AoClient, findDaemon } from "../ao/client";
import { PlannerClient } from "../planner/client";
import { PLUGIN_BUNDLE, findHermes, findOmpSessions, gatewayPath, hermesCommand, hermesLookup, hermesRoot, parseLaneStatus, pluginReport, resolveTargets } from "../shared/hermes-plugin";
import { hostAlive as hostIsAlive } from "../shared/launch";
import { type SessionMeta, sessionDir, sessionsRoot } from "../shared/protocol";
import type { OmpApi } from "./api";
import type { AoFacts, PlannerFacts } from "./doctor-ao";
import type { HermesFacts } from "./doctor-hermes";
import { type DoctorFacts, type Report, type SessionFacts, buildReport, cleanupCandidates, formatBytes, installCommand, issueUrl, reportCommands, reportToHtml, reportToMarkdown } from "./doctor-report";
import { plain } from "./plain";
import { installedUnit } from "./server";
import { resolveOmpPath } from "./sessions";

const HIDE_MISSING_KEY = "omp.doctor.hideOmpMissing";
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

/** omp executable state, as AO finds it: on the daemon's PATH or in the usual install folders. */
function ompStatus(): { resolved?: string; exists: boolean } {
	const resolved = resolveOmpPath();
	// A bare command name (`omp`) is looked up on PATH at spawn time.
	const exists = !!resolved && (!path.isAbsolute(resolved) || fs.existsSync(resolved));
	return { resolved, exists };
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

/** Session folders of the old session host that still hold file snapshots (Disk section, Clean Up File Snapshots). */
async function gatherSnapshots(): Promise<SessionFacts[]> {
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
			return { meta, hostAlive: meta.status !== "stopped" && hostIsAlive(meta), blobBytes: await dirBytes(path.join(sessionDir(id), "blobs")) };
		}),
	);
	return facts.filter((f): f is SessionFacts => !!f);
}

/** The AO daemon as this window reaches it (never starts it), and its readiness report on omp. */
async function gatherAo(api: OmpApi): Promise<AoFacts> {
	const serviceAvailable = process.platform === "linux";
	let client: AoClient;
	try {
		client = await api.ao.client(false);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err), serviceAvailable };
	}
	const [daemon, readiness, list] = await Promise.all([
		findDaemon().catch(() => undefined),
		client.api.GET("/api/v1/agents/readiness").then(r => r.data, () => undefined),
		client.listSessions().catch(() => undefined),
	]);
	const omp = readiness?.agents.find(a => a.id === "omp");
	const unit = installedUnit();
	return {
		url: client.baseUrl,
		...(daemon && { pid: daemon.pid }),
		...(unit && { unit }),
		...(omp && { omp: { installation: omp.installation.state, installationReason: omp.installation.reason, authentication: omp.authentication.state, authenticationReason: omp.authentication.reason } }),
		...(list && { sessions: list.sessions.length }),
		serviceAvailable,
	};
}

async function gatherPlanner(): Promise<PlannerFacts> {
	const planner = await PlannerClient.connect();
	if (!planner) return { error: "No planner answers on its socket." };
	try {
		const info = await planner.request("ping", {}, 3000);
		return { version: info.version, pid: info.pid };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	} finally {
		planner.close();
	}
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

export function registerDoctor(api: OmpApi): void {
	const { context, sessions } = api;
	const reg = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	let missingShown = false;
	let installWatch: NodeJS.Timeout | undefined;
	let doctorPanel: vscode.WebviewPanel | undefined;
	const authNotified = new Set<string>();
	context.subscriptions.push({ dispose: () => clearInterval(installWatch) });

	// ---------- omp missing ----------
	async function showOmpMissing(automatic: boolean): Promise<void> {
		if (automatic && (missingShown || context.globalState.get<boolean>(HIDE_MISSING_KEY))) return;
		missingShown = true;
		const message = "omp is not installed (or not on PATH). Switchyard runs the omp coding agent CLI in the background, through Agent Orchestrator.";
		const actions = ["Install omp", "Learn More"];
		if (automatic) actions.push("Don't Show Again");
		const pick = await vscode.window.showWarningMessage(plain(message), ...actions);
		if (pick === "Install omp") await vscode.commands.executeCommand("omp.installOmp");
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
		const [snapshots, aoFacts, planner, hermes] = await Promise.all([gatherSnapshots(), gatherAo(api), gatherPlanner(), gatherHermes(context.extensionPath)]);
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
			omp: { resolved: st.resolved, exists: st.exists, version: version.version, versionError: version.error },
			bun: findExecutable("bun"),
			stateDir: root,
			writable,
			writeError,
			ao: aoFacts,
			planner,
			sessions: sessions.all(),
			snapshots,
			cleanupDays: retentionDays(),
			hermes,
		};
	}

	async function makeReport(): Promise<Report> {
		return buildReport(await gatherFacts());
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
		const candidates = cleanupCandidates(await gatherSnapshots(), days, Date.now());
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
