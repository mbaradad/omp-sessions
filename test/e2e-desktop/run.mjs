#!/usr/bin/env node
// Desktop e2e of the AO-backed views (Sessions tree, board, status bar, notifications, session commands,
// organize, Connect Phone): a real local VS Code against an isolated AO daemon that runs the real omp.
//
//   npm run test:e2e:desktop
//
// Needs `ao` (AO_BIN, else PATH / ~/.local/bin) and a logged-in `omp`. Scratch state lives in
// /tmp/ao-smoke-views (SWITCHYARD_E2E_SCRATCH): `repo/` (the git project), `ao/` (the daemon's data dir and
// run file), `home/` (the isolated HOME and XDG_*; only .omp/agent links to the real one), `vscode/` (user data, extensions, OMP_VSCODE_HOME) and `shots/` (screenshots the
// suite takes). Env: OMP_E2E_VSCODE_VERSION (default "stable"), OMP_E2E_VERBOSE=1 echoes VS Code's log.
// The shared dev daemon is never touched: discovery goes through AO_RUN_FILE.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const repo = path.resolve(here, "..", "..");

if (process.platform === "linux" && !process.env.DISPLAY && !process.env.OMP_E2E_XVFB) {
	const r = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1600x1000x24", process.execPath, self, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: { ...process.env, OMP_E2E_XVFB: "1" },
	});
	if (r.error) console.error(`xvfb-run failed: ${r.error.message} (install xvfb or set DISPLAY)`);
	process.exit(r.status ?? 1);
}

const { downloadAndUnzipVSCode, runTests } = await import("@vscode/test-electron");
const esbuild = await import("esbuild");

// ---------- build extension + suite ----------
const build = spawnSync(process.execPath, ["build.mjs"], { cwd: repo, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const outDir = path.join(here, "out-views");
fs.rmSync(outDir, { recursive: true, force: true });
await esbuild.build({
	entryPoints: [path.join(here, "suite", "index.ts"), path.join(here, "suite", "desktop.test.ts")],
	outdir: outDir,
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "es2022",
	sourcemap: "inline",
	external: ["vscode", "mocha"],
	logLevel: "warning",
});

// ---------- scratch state ----------
const scratch = path.resolve(process.env.SWITCHYARD_E2E_SCRATCH || "/tmp/ao-smoke-views");
const dirs = {
	repo: path.join(scratch, "repo"),
	ao: path.join(scratch, "ao"),
	vscode: path.join(scratch, "vscode"),
	shots: path.join(scratch, "shots"),
};
fs.rmSync(scratch, { recursive: true, force: true });
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const userData = path.join(dirs.vscode, "user-data");
const extensions = path.join(dirs.vscode, "extensions");
// Isolated HOME (CONTRACT.md "Isolated HOME"): nothing of this run reaches the real home (launcher, skill, services,
// AO's and VS Code's dot-folders). Real omp needs its login and transcripts: only ~/.omp/agent is linked in.
const home = path.join(scratch, "home");
const xdg = { XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") };
const isolatedEnv = { HOME: home, ...xdg };
const ompHome = path.join(dirs.vscode, "omp-home");
const switchyardHome = path.join(dirs.vscode, "switchyard");
for (const d of [userData, extensions, home, ompHome, switchyardHome, ...Object.values(xdg)]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(home, ".omp"), { recursive: true });
fs.symlinkSync(path.join(os.homedir(), ".omp", "agent"), path.join(home, ".omp", "agent"), "dir");

// The project: a git repository with one commit (AO gives each session its own worktree of it).
fs.writeFileSync(path.join(dirs.repo, "README.md"), "# ao-smoke-views\n");
// Switchyard's omp extensions (gate, checkpoints) load from the project, committed so each session's worktree has them:
// nothing may be installed into the shared ~/.omp/agent/extensions (CONTRACT.md, Isolated HOME).
const ompExtensions = path.join(dirs.repo, ".omp", "extensions", "switchyard");
fs.mkdirSync(ompExtensions, { recursive: true });
const modules = fs.readdirSync(path.join(repo, "out", "omp-extension")).filter(f => f.endsWith(".js")).sort();
for (const f of modules) fs.copyFileSync(path.join(repo, "out", "omp-extension", f), path.join(ompExtensions, f));
fs.writeFileSync(path.join(ompExtensions, "package.json"), `${JSON.stringify({ name: "switchyard", private: true, type: "module", omp: { extensions: modules.map(f => `./${f}`) } }, null, "\t")}\n`);
// The spawn helper refuses a mode other than auto unless the gate is installed where `gateStatus()` looks (omp's agent folder,
// G46). The real agent folder is shared and must not get an install, so the extension host (only it: not the daemon, not omp)
// gets PI_CODING_AGENT_DIR pointing at a scratch agent folder holding the same package; omp itself loads the gate from the project.
const hostAgentDir = path.join(scratch, "host-agent");
const hostGate = path.join(hostAgentDir, "extensions", "switchyard");
fs.cpSync(ompExtensions, hostGate, { recursive: true });
for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]]) {
	const r = spawnSync("git", args, { cwd: dirs.repo, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

fs.mkdirSync(path.join(userData, "User"), { recursive: true });
fs.writeFileSync(
	path.join(userData, "User", "settings.json"),
	JSON.stringify(
		{
			"security.workspace.trust.enabled": false,
			"workbench.startupEditor": "none",
			"telemetry.telemetryLevel": "off",
			"extensions.autoCheckUpdates": false,
			"extensions.autoUpdate": false,
			"update.mode": "none",
			"window.restoreWindows": "none",
			"chat.disableAIFeatures": true,
			"window.zoomLevel": 0,
		},
		null,
		1,
	),
);

const vscodeLogPath = path.join(scratch, "vscode.log");
const vscodeLog = fs.createWriteStream(vscodeLogPath);
const NOISE =
	/^(\s+at .*(vscode-file:|\.vscode-test\/)|\[(main|AgentHost|CloudSandboxApi|AccountPolicyGate|ChatModelSelection|shared storage)\b|NativeExtensionHostFactory|filterEnabledExtensions|Via 'product\.json|Settings Sync:|workbench#open|Started local extension host|IExtensionHostStarter|(Started|Completed) initializing default profile)/;
function echo(out) {
	let partial = "";
	return new Writable({
		write(chunk, _enc, done) {
			vscodeLog.write(chunk);
			const lines = (partial + chunk.toString()).split("\n");
			partial = lines.pop() ?? "";
			for (const l of lines) if (process.env.OMP_E2E_VERBOSE || !NOISE.test(l)) out.write(`${l}\n`);
			done();
		},
	});
}

function freePort() {
	const { promise, resolve, reject } = Promise.withResolvers();
	const srv = net.createServer();
	srv.on("error", reject);
	srv.listen(0, "127.0.0.1", () => {
		const { port } = srv.address();
		srv.close(() => resolve(port));
	});
	return promise;
}

function findAo() {
	if (process.env.AO_BIN) return process.env.AO_BIN;
	for (const dir of [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")]) {
		const f = path.join(dir, "ao");
		if (dir && fs.existsSync(f)) return f;
	}
	throw new Error("no `ao` binary (set AO_BIN)");
}

let failed = false;
const results = [];
const check = (name, ok, detail = "") => {
	results.push(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed = true;
	return ok;
};

// ---------- isolated AO daemon (RUNTIME.md: all three variables, so nothing hijacks ~/.ao/running.json) ----------
const port = await freePort();
const aoEnv = {
	AO_PORT: String(port),
	AO_DATA_DIR: path.join(dirs.ao, "data"),
	AO_RUN_FILE: path.join(dirs.ao, "running.json"),
};
// The Switchyard omp shim goes first, as the unit `ao-daemon` of the extension would have it (G34).
const daemonPath = [path.join(repo, "src", "omp-shim"), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".npm-global", "bin"), process.env.PATH].join(path.delimiter);
const ao = findAo();
const daemonLog = fs.openSync(path.join(dirs.ao, "daemon.log"), "a");
const daemon = spawn(ao, ["daemon"], { cwd: dirs.ao, env: { ...process.env, ...aoEnv, ...isolatedEnv, SWITCHYARD_HOME: switchyardHome, PATH: daemonPath }, stdio: ["ignore", daemonLog, daemonLog], detached: true });
const baseUrl = `http://127.0.0.1:${port}`;

// Canary for CONTRACT.md "Isolated HOME": the real ~/.switchyard and the shared omp extensions dir must come out as they went in.
const realHome = fs.realpathSync(os.userInfo().homedir);
const watched = [".switchyard", ".omp/agent/extensions", ".local/bin/switchyard"].map(p => path.join(realHome, p));
const fingerprint = p => {
	try {
		const st = fs.lstatSync(p);
		return st.isDirectory() ? fs.readdirSync(p).sort().join(",") : `${st.size}:${st.mtimeMs}`;
	} catch {
		return "absent";
	}
};
const realBefore = new Map(watched.map(p => [p, fingerprint(p)]));

try {
	const deadline = Date.now() + 60_000;
	let ready = false;
	while (!ready && Date.now() < deadline) {
		ready = await fetch(`${baseUrl}/readyz`).then(r => r.ok, () => false);
		if (!ready) await sleep(250);
	}
	if (!check(`isolated AO daemon ready on :${port}`, ready)) throw new Error("AO daemon did not start");

	const version = process.env.OMP_E2E_VSCODE_VERSION || "stable";
	const vscodeExecutablePath = await downloadAndUnzipVSCode({ version, cachePath: path.join(repo, ".vscode-test") });
	try {
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: repo,
			extensionTestsPath: path.join(outDir, "index.js"),
			launchArgs: [
				dirs.repo,
				`--user-data-dir=${userData}`,
				`--extensions-dir=${extensions}`,
				"--disable-extensions",
				"--disable-gpu",
				"--new-window",
				...(process.platform === "darwin" ? ["--use-mock-keychain"] : process.platform === "linux" ? ["--password-store=basic"] : []),
			],
			extensionTestsEnv: {
				PI_CODING_AGENT_DIR: hostAgentDir,
				// The host never installs omp extensions or the shim, whatever its extension mode (CONTRACT.md, Isolated HOME).
				SWITCHYARD_INSTALL_OMP_EXTENSIONS: "0",
				...aoEnv,
				...isolatedEnv,
				OMP_VSCODE_HOME: ompHome,
				SWITCHYARD_HOME: switchyardHome,
				// Never start (or find) the user's own daemon: the run file above is the only one.
				SWITCHYARD_NO_SERVER: "1",
				SWITCHYARD_E2E_REPO: dirs.repo,
				SWITCHYARD_E2E_SHOTS: dirs.shots,
				SWITCHYARD_E2E_AO_URL: baseUrl,
			},
			stdout: echo(process.stdout),
			stderr: echo(process.stderr),
		});
		check("extension-host views suite passed (VS Code exited 0)", true);
	} catch (err) {
		check("extension-host views suite passed", false, String(err?.message ?? err));
	}
} catch (err) {
	check("runner", false, String(err?.stack ?? err));
} finally {
	// `ao stop` with the instance's env (POST /shutdown answers DAEMON_OWNER_CHANGED to a client that did not start it).
	const stop = spawnSync(ao, ["stop"], { env: { ...process.env, ...aoEnv, ...isolatedEnv }, encoding: "utf8", timeout: 30_000 });
	for (const p of watched) check(`real ${path.relative(realHome, p)} untouched`, fingerprint(p) === realBefore.get(p), `${realBefore.get(p)} → ${fingerprint(p)}`);
	check("isolated AO daemon stopped", stop.status === 0, (stop.stderr || stop.stdout || "").trim());
	if (spawnSync("kill", ["-0", String(daemon.pid)]).status === 0) process.kill(daemon.pid, "SIGKILL");
	// Chat hosts (and their omp) are detached by design and outlive the daemon: end this run's.
	const hosts = spawnSync("pgrep", ["-f", aoEnv.AO_DATA_DIR], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
	for (const pid of hosts) spawnSync("kill", [pid]);
	await sleep(1000);
	const left = spawnSync("pgrep", ["-f", aoEnv.AO_DATA_DIR], { encoding: "utf8" }).stdout.trim();
	check(`ended ${hosts.length} detached chat-host/omp process(es) of the scratch daemon`, !left, left);
	console.log("\n── views e2e summary ──");
	for (const r of results) console.log(r);
	console.log(`screenshots: ${dirs.shots}\nVS Code output: ${vscodeLogPath}\nAO log: ${path.join(dirs.ao, "daemon.log")}`);
	const closed = Promise.withResolvers();
	vscodeLog.end(closed.resolve);
	await closed.promise;
}
process.exit(failed ? 1 : 0);
