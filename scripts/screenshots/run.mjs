#!/usr/bin/env node
// Retakes the README and website screenshots (docs/PUBLISHING.md §5) in a real VS Code with the packaged
// extension, against an isolated AO daemon and planner, with demo projects and scripted omp sessions:
//
//   node scripts/screenshots/run.mjs   # docs/images/{sessions,chat,board,tasks,dashboard,review,checkpoints,hermes-dashboard,hermes-detail}.png
//
// Everything runs under /tmp/switchyard-shots (SWITCHYARD_SHOTS_DIR) with HOME, XDG_*, SWITCHYARD_HOME, HERMES_HOME
// and OMP_VSCODE_HOME there; only home/.omp/agent links to the real ~/.omp/agent, for the one real omp session.
// The sessions run test/fake-omp-acp.mjs (FAKE_OMP_DEMO=1) with scripted replies (scenario.mjs), except the
// review/checkpoint session: checkpoints come from Switchyard's omp extension, which only real omp loads, so that
// session runs the real omp (one short turn on your default model; `--no-real` skips it and those two shots).
// Then the same sessions in the Hermes dashboard's Switchyard page (when Hermes Agent is installed; hermes.mjs).
// Needs `ao` (AO_BIN, else PATH or ~/.local/bin), a logged-in `omp`, Xvfb, python3 with Pillow, and VS Code from
// @vscode/test-electron (SWITCHYARD_VSCODE_VERSION, SWITCHYARD_VSCODE_CACHE). `--keep` leaves the scratch folder.
// Then shrink the PNGs with pngquant and copy them to site/assets/shots/ (docs/images/src/README.md).

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { demoRepos, fakeRules, historyTranscripts } from "./scenario.mjs";

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const repo = path.resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
/** Skips the real omp session (and so review.png and checkpoints.png). */
const skipReal = process.argv.includes("--no-real");

if (process.platform === "linux" && !process.env.SWITCHYARD_SHOTS_XVFB) {
	const r = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1600x1000x24", process.execPath, self, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: { ...process.env, SWITCHYARD_SHOTS_XVFB: "1" },
	});
	if (r.error) console.error(`xvfb-run failed: ${r.error.message} (install xvfb)`);
	process.exit(r.status ?? 1);
}

const run = (cmd, args, opts = {}) => {
	const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.error?.message})`);
};

// ---------- the extension (production VSIX) and the driver extension ----------
run("npm", ["run", "-s", "package"], { cwd: repo });
const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
const vsix = path.join(repo, "dist", `switchyard-${version}.vsix`);
const driverVsix = path.join(os.tmpdir(), "switchyard-shots-driver.vsix");
run(path.join(repo, "node_modules", ".bin", "vsce"), ["package", "--allow-missing-repository", "--skip-license", "-o", driverVsix], { cwd: path.join(here, "driver") });

// ---------- scratch state ----------
const root = path.resolve(process.env.SWITCHYARD_SHOTS_DIR || "/tmp/switchyard-shots");
fs.rmSync(root, { recursive: true, force: true });
const dirs = {
	home: path.join(root, "home"),
	projects: path.join(root, "projects"),
	ao: path.join(root, "ao"),
	agent: path.join(root, "agent"),
	bin: path.join(root, "bin"),
	switchyard: path.join(root, "switchyard"),
	userData: path.join(root, "vscode", "user-data"),
	extensions: path.join(root, "vscode", "extensions"),
	ompHome: path.join(root, "vscode", "omp-home"),
	shots: path.join(root, "shots"),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const xdg = { XDG_CONFIG_HOME: path.join(dirs.home, ".config"), XDG_DATA_HOME: path.join(dirs.home, ".local", "share"), XDG_STATE_HOME: path.join(dirs.home, ".local", "state"), XDG_CACHE_HOME: path.join(dirs.home, ".cache") };
for (const d of Object.values(xdg)) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(dirs.home, ".omp"), { recursive: true });
fs.symlinkSync(path.join(os.homedir(), ".omp", "agent"), path.join(dirs.home, ".omp", "agent"), "dir");

// Switchyard's omp extension: committed into each project (the real omp session loads it from there; nothing is
// installed into the shared ~/.omp/agent), and copied into the extension host's agent folder, where gateStatus() looks.
const ompModules = fs.readdirSync(path.join(repo, "out", "omp-extension")).filter(f => f.endsWith(".js")).sort();
const writeOmpExtension = dir => {
	fs.mkdirSync(dir, { recursive: true });
	for (const f of ompModules) fs.copyFileSync(path.join(repo, "out", "omp-extension", f), path.join(dir, f));
	fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "switchyard", private: true, type: "module", omp: { extensions: ompModules.map(f => `./${f}`) } }, null, "\t")}\n`);
};
writeOmpExtension(path.join(dirs.agent, "extensions", "switchyard"));

const git = (cwd, ...args) => run("git", ["-c", "user.name=Dana Reyes", "-c", "user.email=dana@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
const projects = {};
for (const [name, files] of Object.entries(demoRepos)) {
	const dir = path.join(dirs.projects, name);
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	}
	writeOmpExtension(path.join(dir, ".omp", "extensions", "switchyard"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "Initial commit");
	projects[name] = dir;
}

// Usage history for the dashboard: earlier omp sessions in these projects, as omp's transcripts.
for (const t of historyTranscripts(projects)) {
	const dir = path.join(dirs.agent, "sessions", t.cwd.replace(/^\//, "-").replace(/\//g, "-"));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, t.name), `${t.lines.map(l => JSON.stringify(l)).join("\n")}\n`);
}

// `omp` for the daemon: the fake (demo mode, never asking unless a script says `approval always-ask`), or the real omp
// while the driver has written "real" to bin/next-omp. Demo `npx`/`npm` print plausible output.
const fakeOmp = path.join(repo, "test", "fake-omp-acp.mjs");
const realOmp = spawnSync("sh", ["-c", "command -v omp"], { encoding: "utf8", env: { ...process.env, PATH: [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".npm-global", "bin"), process.env.PATH].join(path.delimiter) } }).stdout.trim();
if (!realOmp) throw new Error("no omp on PATH");
const rulesFile = path.join(root, "fake-rules.json");
fs.writeFileSync(rulesFile, JSON.stringify(fakeRules, null, "\t"));
const nextOmp = path.join(dirs.bin, "next-omp");
fs.writeFileSync(
	path.join(dirs.bin, "omp"),
	`#!/bin/sh
if [ "$1" = acp ] && [ "$(cat "${nextOmp}" 2>/dev/null)" = real ]; then exec "${realOmp}" "$@"; fi
export PI_CODING_AGENT_DIR="${dirs.agent}" FAKE_OMP_DEMO=1 FAKE_OMP_DELAY=15 FAKE_OMP_RULES="${rulesFile}" FAKE_OMP_APPROVAL_MODE=yolo
exec "${process.execPath}" "${fakeOmp}" "$@"
`,
	{ mode: 0o755 },
);
fs.writeFileSync(
	path.join(dirs.bin, "npx"),
	`#!/bin/sh
case "$*" in
*vitest*) printf ' RUN  v3.2.4 %s\\n\\n ✓ test/rate-limit.test.ts (4 tests) 38ms\\n ✓ test/checkout.test.ts (6 tests) 112ms\\n\\n Test Files  2 passed (2)\\n      Tests  10 passed (10)\\n' "$PWD" ;;
*) echo "npx $*" ;;
esac
`,
	{ mode: 0o755 },
);
fs.writeFileSync(
	path.join(dirs.bin, "npm"),
	`#!/bin/sh
case "$*" in
"install express@5"*) echo "added 3 packages, changed 14 packages in 4s"; sleep 3600 ;;
*) echo "npm $*" ;;
esac
`,
	{ mode: 0o755 },
);

// ---------- isolated AO daemon and planner ----------
const freePort = () =>
	new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
const findAo = () => {
	if (process.env.AO_BIN) return process.env.AO_BIN;
	for (const dir of [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")]) if (dir && fs.existsSync(path.join(dir, "ao"))) return path.join(dir, "ao");
	throw new Error("no `ao` binary (set AO_BIN)");
};
const port = await freePort();
const aoEnv = { AO_PORT: String(port), AO_DATA_DIR: path.join(dirs.ao, "data"), AO_RUN_FILE: path.join(dirs.ao, "running.json") };
const isolatedEnv = { HOME: dirs.home, ...xdg, SWITCHYARD_HOME: dirs.switchyard, OMP_VSCODE_HOME: dirs.ompHome };
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PI_|OMPCODE|SWITCHYARD_(HOME|NO_SERVER))/.test(k)));
const stackPath = [dirs.bin, path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".npm-global", "bin"), process.env.PATH].join(path.delimiter);
const stackEnv = { ...cleanEnv, ...aoEnv, ...isolatedEnv, PATH: stackPath };
const ao = findAo();
const daemonLog = fs.openSync(path.join(dirs.ao, "daemon.log"), "a");
const daemon = spawn(ao, ["daemon"], { cwd: dirs.ao, env: stackEnv, stdio: ["ignore", daemonLog, daemonLog], detached: true });
const baseUrl = `http://127.0.0.1:${port}`;

let vscodeProc;
let hermesProc;
let failed = false;
try {
	const deadline = Date.now() + 60_000;
	while (!(await fetch(`${baseUrl}/readyz`).then(r => r.ok, () => false))) {
		if (Date.now() > deadline) throw new Error("AO daemon did not start");
		await sleep(250);
	}
	const ready = await fetch(`${baseUrl}/readyz`).then(r => r.text());
	if (!ready.includes(aoEnv.AO_DATA_DIR)) throw new Error(`the daemon on :${port} is not this run's: ${ready}`);

	// The planner, as the login service would run it (never installed as one here).
	const plannerLog = fs.openSync(path.join(root, "planner.log"), "a");
	spawn(process.execPath, [path.join(repo, "out", "planner.js")], { cwd: dirs.home, env: stackEnv, stdio: ["ignore", plannerLog, plannerLog], detached: true }).unref();

	// ---------- VS Code ----------
	const { downloadAndUnzipVSCode } = await import("@vscode/test-electron");
	const cachePath = process.env.SWITCHYARD_VSCODE_CACHE || path.join(repo, ".vscode-test");
	const vscodeExe = await downloadAndUnzipVSCode({ version: process.env.SWITCHYARD_VSCODE_VERSION || "stable", cachePath });
	const cli = path.join(path.dirname(vscodeExe), "bin", "code");
	const vscodeArgs = [`--user-data-dir=${dirs.userData}`, `--extensions-dir=${dirs.extensions}`];
	run(cli, [...vscodeArgs, "--install-extension", vsix, "--install-extension", driverVsix], { env: { ...stackEnv, DONT_PROMPT_WSL_INSTALL: "1" } });
	fs.mkdirSync(path.join(dirs.userData, "User"), { recursive: true });
	fs.writeFileSync(
		path.join(dirs.userData, "User", "settings.json"),
		JSON.stringify(
			{
				"workbench.colorTheme": "Default Dark Modern",
				"window.zoomLevel": 0,
				"window.titleBarStyle": "custom",
				"window.controlsStyle": "hidden",
				"window.dialogStyle": "custom",
				"window.newWindowDimensions": "maximized",
				"window.restoreWindows": "none",
				"workbench.startupEditor": "none",
				"workbench.tips.enabled": false,
				"workbench.secondarySideBar.defaultVisibility": "hidden",
				"workbench.layoutControl.enabled": true,
				"security.workspace.trust.enabled": false,
				"telemetry.telemetryLevel": "off",
				"update.mode": "none",
				"update.showReleaseNotes": false,
				"extensions.autoCheckUpdates": false,
				"extensions.autoUpdate": false,
				"chat.disableAIFeatures": true,
				"git.openRepositoryInParentFolders": "never",
				"files.exclude": { "**/.omp": true, "**/.git": true },
				"switchyard.sessionScope": "all",
				"switchyard.dashboard.includeTerminalSessions": true,
				"switchyard.server.installService": false,
				"switchyard.terminalHints": false,
			},
			null,
			1,
		),
	);
	const done = path.join(root, "driver-done.json");
	vscodeProc = spawn(vscodeExe, [projects["acme-api"], ...vscodeArgs, "--disable-gpu", "--new-window", "--password-store=basic", "--disable-workspace-trust"], {
		env: {
			...stackEnv,
			PI_CODING_AGENT_DIR: dirs.agent,
			SWITCHYARD_INSTALL_OMP_EXTENSIONS: "0",
			SWITCHYARD_NO_SERVER: "1",
			SWITCHYARD_SHOTS: JSON.stringify({ root, shots: dirs.shots, projects, nextOmp, done, skipReal }),
		},
		stdio: ["ignore", fs.openSync(path.join(root, "vscode.log"), "a"), fs.openSync(path.join(root, "vscode.log"), "a")],
	});
	const until = Date.now() + 15 * 60_000;
	while (!fs.existsSync(done)) {
		if (Date.now() > until) throw new Error("the driver did not finish in 15 minutes (see driver.log)");
		if (vscodeProc.exitCode !== null) throw new Error(`VS Code exited (${vscodeProc.exitCode}) before the driver finished`);
		await sleep(1000);
	}
	const result = JSON.parse(fs.readFileSync(done, "utf8"));
	if (!result.ok) throw new Error(`driver: ${result.error}`);
	for (const name of result.shots) fs.copyFileSync(path.join(dirs.shots, `${name}.png`), path.join(repo, "docs", "images", `${name}.png`));
	console.log(`wrote docs/images/{${result.shots.join(",")}}.png`);
	vscodeProc.kill("SIGTERM");
	await hermesShots();
} catch (err) {
	failed = true;
	console.error(err?.stack ?? err);
} finally {
	if (hermesProc && hermesProc.exitCode === null) process.kill(-hermesProc.pid, "SIGTERM");
	if (vscodeProc && vscodeProc.exitCode === null) vscodeProc.kill("SIGTERM");
	spawnSync(process.execPath, [path.join(repo, "out", "cli.js"), "server", "stop"], { env: stackEnv, stdio: "ignore", timeout: 30_000 });
	spawnSync(ao, ["stop"], { env: stackEnv, stdio: "ignore", timeout: 30_000 });
	if (spawnSync("kill", ["-0", String(daemon.pid)]).status === 0) process.kill(daemon.pid, "SIGKILL");
	// Chat hosts (and their omp, and what its tools started) outlive the daemon by design: end this run's.
	for (const pid of spawnSync("pgrep", ["-f", root], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean)) spawnSync("kill", [pid]);
	// The real omp session keeps its transcript in the real ~/.omp/agent/sessions (the folder is linked in for the login).
	const realSessions = path.join(os.homedir(), ".omp", "agent", "sessions");
	for (const d of fs.existsSync(realSessions) ? fs.readdirSync(realSessions) : []) if (d.startsWith(`${root.replace(/\//g, "-")}-`)) fs.rmSync(path.join(realSessions, d), { recursive: true, force: true });
	await sleep(500);
	if (!keep && !failed) fs.rmSync(root, { recursive: true, force: true });
	else console.log(`scratch: ${root} (driver.log, vscode.log, planner.log, ao/daemon.log)`);
}

/**
 * The Switchyard page in the Hermes dashboard, over the same sessions: Hermes Agent's own Python (the venv its
 * installer recorded) runs `hermes dashboard` with a HERMES_HOME in the scratch HOME and the built plugin enabled.
 * Skipped (with a note) when Hermes isn't installed.
 */
async function hermesShots() {
	const installs = path.join(os.homedir(), ".hermes", "installs");
	let python;
	for (const id of fs.existsSync(installs) ? fs.readdirSync(installs) : []) {
		try {
			const env = JSON.parse(fs.readFileSync(path.join(installs, id, "facts.json"), "utf8"))?.packages?.venv?.environment;
			if (env && fs.existsSync(path.join(env, "bin", "python"))) python = path.join(env, "bin", "python");
		} catch {
			/* not an install */
		}
	}
	if (process.env.HERMES_PYTHON) python = process.env.HERMES_PYTHON;
	if (!python) {
		console.log("Hermes Agent is not installed: hermes-dashboard.png and hermes-detail.png not retaken");
		return;
	}
	const hermesHome = path.join(dirs.home, ".hermes");
	fs.mkdirSync(path.join(hermesHome, "plugins"), { recursive: true });
	fs.cpSync(path.join(repo, "out", "hermes-plugin", "switchyard"), path.join(hermesHome, "plugins", "switchyard"), { recursive: true });
	fs.writeFileSync(
		path.join(hermesHome, "config.yaml"),
		`plugins:\n  enabled: [switchyard]\n  entries:\n    switchyard:\n      settings:\n        switchyard: ${path.join(repo, "out", "cli.js")}\n        lane:\n          enabled: true\n          boards:\n            acme:\n              folder: ${projects["acme-api"]}\n`,
	);
	const env = { ...stackEnv, HERMES_HOME: hermesHome, NO_COLOR: "1" };
	const hermes = (...args) => run(python, ["-m", "hermes_cli.main", ...args], { cwd: dirs.home, env, stdio: "ignore" });
	// A kanban board for the lane, and one pass of Hermes's dispatcher (the gateway's job), so the page shows the lane as working.
	hermes("kanban", "boards", "create", "acme");
	hermes("kanban", "--board", "acme", "dispatch");
	const hermesPort = await freePort();
	const log = fs.openSync(path.join(root, "hermes.log"), "a");
	hermesProc = spawn(python, ["-m", "hermes_cli.main", "dashboard", "--port", String(hermesPort), "--host", "127.0.0.1", "--no-open", "--skip-build"], { cwd: dirs.home, env, stdio: ["ignore", log, log], detached: true });
	const url = `http://127.0.0.1:${hermesPort}/`;
	const deadline = Date.now() + 120_000;
	while (!(await fetch(url).then(r => r.ok, () => false))) {
		if (Date.now() > deadline) throw new Error("hermes dashboard did not start (see hermes.log)");
		if (hermesProc.exitCode !== null) throw new Error(`hermes dashboard exited (${hermesProc.exitCode}); see hermes.log`);
		await sleep(500);
	}
	run("npx", ["-y", "-p", "playwright@1.65.0", "node", path.join(here, "hermes.mjs"), url, dirs.shots], { env: { ...process.env, HOME: os.homedir() } });
	for (const name of ["hermes-dashboard", "hermes-detail"]) fs.copyFileSync(path.join(dirs.shots, `${name}.png`), path.join(repo, "docs", "images", `${name}.png`));
	console.log("wrote docs/images/{hermes-dashboard,hermes-detail}.png");
}
process.exit(failed ? 1 : 0);
