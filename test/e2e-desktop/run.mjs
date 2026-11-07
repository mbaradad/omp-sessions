#!/usr/bin/env node
// Desktop e2e: runs the extension in a real local VS Code (Electron extension host) against
// test/fake-omp.mjs, then checks that the session host outlived VS Code and stops it.
//
//   npm run test:e2e:desktop
//
// Env: OMP_E2E_VSCODE_VERSION (default "stable"), OMP_E2E_KEEP=1 keeps the temp dir,
// OMP_E2E_VERBOSE=1 echoes VS Code's own log lines (always saved to <tmp>/vscode.log),
// OMP_E2E_ARTIFACTS=<dir> copies the logs (VS Code, fake omp, session hosts) there on failure (CI).
//
// VS Code is downloaded once into .vscode-test/. Without a DISPLAY the run is re-executed
// under `xvfb-run`. All state (user data, extensions, OMP_VSCODE_HOME, HOME, workspace) lives
// in a fresh temp dir.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const repo = path.resolve(here, "..", "..");

if (process.platform === "linux" && !process.env.DISPLAY && !process.env.OMP_E2E_XVFB) {
	const r = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1280x1024x24", process.execPath, self, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: { ...process.env, OMP_E2E_XVFB: "1" },
	});
	if (r.error) console.error(`xvfb-run failed: ${r.error.message} (install xvfb or set DISPLAY)`);
	process.exit(r.status ?? 1);
}

const { downloadAndUnzipVSCode, runTests } = await import("@vscode/test-electron");
const esbuild = await import("esbuild");

const fakeOmp = path.join(repo, "test", "fake-omp.mjs");
if (!fs.existsSync(fakeOmp)) {
	console.error(`missing ${fakeOmp}`);
	process.exit(1);
}

// ---------- build extension + suite ----------
const build = spawnSync(process.execPath, ["build.mjs"], { cwd: repo, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const outDir = path.join(here, "out");
fs.rmSync(outDir, { recursive: true, force: true });
await esbuild.build({
	entryPoints: [path.join(here, "suite", "index.ts"), path.join(here, "suite", "session.test.ts")],
	outdir: outDir,
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "es2022",
	sourcemap: "inline",
	external: ["vscode", "mocha"],
	logLevel: "warning",
});

// ---------- isolated state ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-e2e-"));
const dirs = {
	userData: path.join(tmp, "user-data"),
	extensions: path.join(tmp, "extensions"),
	ompHome: path.join(tmp, "omp-home"),
	home: path.join(tmp, "home"),
	workspace: path.join(tmp, "workspace"),
	fakeSessions: path.join(tmp, "fake-omp-sessions"),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const stateFile = path.join(tmp, "e2e-state.json");
const fakeLog = path.join(tmp, "fake-omp.log");
fs.mkdirSync(path.join(dirs.workspace, ".vscode"));
fs.writeFileSync(path.join(dirs.workspace, ".vscode", "settings.json"), JSON.stringify({ "omp.path": fakeOmp }, null, 1));
fs.writeFileSync(path.join(dirs.workspace, "existing.txt"), "original line\n");
// A git repository (one commit) for the Source Control commands.
for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]]) {
	const r = spawnSync("git", args, { cwd: dirs.workspace, stdio: "inherit", env: { ...process.env, HOME: dirs.home, GIT_CONFIG_NOSYSTEM: "1" } });
	if (r.status !== 0) {
		console.error(`git ${args.join(" ")} failed in ${dirs.workspace}`);
		process.exit(1);
	}
}
fs.mkdirSync(path.join(dirs.userData, "User"), { recursive: true });
fs.writeFileSync(
	path.join(dirs.userData, "User", "settings.json"),
	JSON.stringify(
		{
			"security.workspace.trust.enabled": false,
			"workbench.startupEditor": "none",
			"telemetry.telemetryLevel": "off",
			"extensions.autoCheckUpdates": false,
			"extensions.autoUpdate": false,
			"update.mode": "none",
			"files.simpleDialog.enable": true,
			"window.restoreWindows": "none",
			"chat.disableAIFeatures": true,
		},
		null,
		1,
	),
);

const sessionsRoot = path.join(dirs.ompHome, "sessions");

// VS Code's own chatter (workbench logs, its internal stack traces) goes only to vscode.log
// unless OMP_E2E_VERBOSE is set; mocha output and anything unrecognised is echoed.
const vscodeLogPath = path.join(tmp, "vscode.log");
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

let failed = false;
const results = [];
const check = (name, ok, detail = "") => {
	results.push(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed = true;
	return ok;
};

try {
	const version = process.env.OMP_E2E_VSCODE_VERSION || "stable";
	const vscodeExecutablePath = await downloadAndUnzipVSCode({ version, cachePath: path.join(repo, ".vscode-test") });
	try {
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: repo,
			extensionTestsPath: path.join(outDir, "index.js"),
			launchArgs: [
				dirs.workspace,
				`--user-data-dir=${dirs.userData}`,
				`--extensions-dir=${dirs.extensions}`,
				"--disable-extensions",
				"--disable-gpu",
				"--new-window",
			],
			extensionTestsEnv: {
				HOME: dirs.home,
				OMP_VSCODE_HOME: dirs.ompHome,
				FAKE_OMP_SESSIONS: dirs.fakeSessions,
				FAKE_OMP_LOG: fakeLog,
				OMP_E2E_WORKSPACE: dirs.workspace,
				OMP_E2E_STATE: stateFile,
				FAKE_OMP_DELAY: "5",
				// The omp-vs server would outlive the test VS Code; the server has its own host tests.
				OMP_VS_NO_SERVER: "1",
			},
			stdout: echo(process.stdout),
			stderr: echo(process.stderr),
		});
		check("extension-host suite passed (VS Code exited 0)", true);
	} catch (err) {
		check("extension-host suite passed", false, String(err?.message ?? err));
	}

	// ---------- host outlives VS Code ----------
	const state = readJson(stateFile);
	if (check("suite recorded the surviving session", !!state, stateFile)) await checkSurvivor(state);
} catch (err) {
	check("runner", false, String(err?.stack ?? err));
} finally {
	const leftovers = killLeftovers();
	check("no leftover host/omp processes", leftovers.length === 0, leftovers.length ? `killed ${leftovers.join(", ")}` : "");
	console.log("\n── desktop e2e summary ──");
	for (const r of results) console.log(r);
	const logClosed = Promise.withResolvers();
	vscodeLog.end(logClosed.resolve);
	await logClosed.promise;
	if (failed && process.env.OMP_E2E_ARTIFACTS) saveArtifacts(path.resolve(process.env.OMP_E2E_ARTIFACTS));
	if (failed || process.env.OMP_E2E_KEEP) console.log(`state kept in ${tmp} (full VS Code output: ${vscodeLogPath})`);
	else fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

/** Copies the run's logs and session state (not the VS Code install or user-data caches) to `dest`. */
function saveArtifacts(dest) {
	const keep = /(\.log|\.json|\.jsonl)$/;
	const sources = [vscodeLogPath, fakeLog, stateFile, path.join(dirs.userData, "logs"), sessionsRoot];
	for (const src of sources) {
		if (!fs.existsSync(src)) continue;
		try {
			fs.cpSync(src, path.join(dest, path.relative(tmp, src)), {
				recursive: true,
				filter: f => fs.lstatSync(f).isDirectory() || keep.test(f),
			});
		} catch (err) {
			console.error(`could not copy ${src}: ${err?.message ?? err}`);
		}
	}
	console.log(`logs copied to ${dest}`);
}

// ---------- helpers ----------
async function checkSurvivor(state) {
	const metaPath = path.join(sessionsRoot, state.id, "meta.json");
	check("session host alive after VS Code exited", pidAlive(state.pid), `pid ${state.pid}`);
	check("omp alive after VS Code exited", pidAlive(state.ompPid), `pid ${state.ompPid}`);
	const meta = readJson(metaPath);
	check("meta.json still running", !!meta && meta.status !== "stopped" && meta.pid === state.pid, meta ? `status ${meta.status}` : "missing");

	const conn = await connect(state.socket).catch(err => {
		check("socket accepts a new client", false, String(err.message));
		return undefined;
	});
	if (!conn) return;
	conn.send({ t: "hello", client: "e2e-runner" });
	const snap = await conn.next(m => m.t === "snapshot", 5000);
	check("snapshot after reattach", snap?.meta?.id === state.id && Array.isArray(snap.messages), snap ? `${snap.messages.length} messages` : "timeout");
	const texts = JSON.stringify(snap?.messages ?? []);
	check("transcript retained across VS Code exit", texts.includes("write hello.txt hi"));

	conn.send({ t: "stop" });
	const stoppedMeta = await conn.next(m => m.t === "meta" && m.meta.status === "stopped", 15000);
	check("host reports stopped over socket", !!stoppedMeta);
	conn.close();
	check("host exited after stop", await waitUntil(() => !pidAlive(state.pid), 15000), `pid ${state.pid}`);
	check("omp exited after stop", await waitUntil(() => !pidAlive(state.ompPid), 15000), `pid ${state.ompPid}`);
	check("socket removed", await waitUntil(() => !fs.existsSync(state.socket), 5000), state.socket);
	const finalMeta = readJson(metaPath);
	check("meta.json stopped", finalMeta?.status === "stopped" && finalMeta?.exitReason === "stopped", JSON.stringify({ status: finalMeta?.status, exitReason: finalMeta?.exitReason }));
}

function killLeftovers() {
	const killed = [];
	let ids = [];
	try {
		ids = fs.readdirSync(sessionsRoot);
	} catch {
		return killed;
	}
	for (const id of ids) {
		const meta = readJson(path.join(sessionsRoot, id, "meta.json"));
		for (const pid of [meta?.pid, meta?.ompPid]) {
			if (typeof pid === "number" && pidAlive(pid) && isOurs(pid)) {
				try {
					process.kill(pid, "SIGKILL");
					killed.push(`${id}:${pid}`);
				} catch {
					/* raced */
				}
			}
		}
	}
	return killed;
}

/** Guards against pid reuse: only kill processes whose command line points into this run. */
function isOurs(pid) {
	try {
		const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
		return cmd.includes(sessionsRoot) || cmd.includes(dirs.workspace) || cmd.includes(fakeOmp);
	} catch {
		return true;
	}
}

function pidAlive(pid) {
	if (typeof pid !== "number") return false;
	try {
		process.kill(pid, 0);
	} catch (err) {
		return err.code === "EPERM";
	}
	// Zombies (exited, not yet reaped by init) count as dead.
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
	} catch {
		return true;
	}
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

async function waitUntil(fn, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return true;
		await sleep(100);
	}
	return fn();
}

function connect(socket) {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(socket);
		const backlog = [];
		const waiters = [];
		const rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
		rl.on("error", () => {}); // socket errors surface via the connect promise / timeouts
		rl.on("line", line => {
			if (!line.trim()) return;
			const msg = JSON.parse(line);
			const w = waiters.findIndex(x => x.pred(msg));
			if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
			else backlog.push(msg);
		});
		sock.once("error", reject);
		sock.once("connect", () =>
			resolve({
				send: msg => sock.write(`${JSON.stringify(msg)}\n`),
				close: () => sock.end(),
				next: (pred, timeoutMs) => {
					const i = backlog.findIndex(pred);
					if (i >= 0) return Promise.resolve(backlog.splice(i, 1)[0]);
					return new Promise(res => {
						const waiter = { pred, resolve: res };
						waiters.push(waiter);
						setTimeout(() => {
							const j = waiters.indexOf(waiter);
							if (j >= 0) {
								waiters.splice(j, 1);
								res(undefined);
							}
						}, timeoutMs).unref();
					});
				},
			}),
		);
	});
}
