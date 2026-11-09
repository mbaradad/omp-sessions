// Isolated AO daemon for tests: `ao daemon` on a free loopback port with a private temp data dir,
// run file and HOME, pointed at test/fake-omp-acp.mjs as `omp` (first on its PATH), so nothing
// touches the dev daemon (port 3001, ~/.ao) or the real ~/.omp. See RUNTIME.md ("Second isolated
// instance") in the migration notes.
//
//   import { startAoFixture, aoAvailable } from "../ao-fixture.mjs";
//   const ao = await startAoFixture();            // throws if `ao` is missing; check aoAvailable() to skip
//   await fetch(`${ao.baseUrl}/api/v1/sessions`);  // loopback API: no auth (credentials.headers is {})
//   const projectId = await ao.createProject(ao.scratchRepo());
//   ...
//   await ao.stop();                              // daemon, its detached chat hosts and the temp dir
//
// Options: { aoBin, realOmp, env, fakeOmpEnv, readyTimeoutMs, keep }
//   aoBin        ao executable (default $OMP_TEST_AO_BIN, else `ao` on PATH)
//   realOmp      run the real omp from PATH with the real HOME instead of the fake (smoke tests)
//   env          extra daemon env (e.g. AO_* overrides)
//   fakeOmpEnv   extra env for the fake (FAKE_OMP_DELAY, FAKE_OMP_NO_STEERING, ...)
//   keep         leave the temp dir after stop (default $OMP_TEST_KEEP_AO=1), for post-mortems
//
// Env read here: OMP_TEST_AO_BIN, OMP_TEST_FAKE_OMP_ACP (path of the fake; test/run.mjs sets it),
// OMP_TEST_KEEP_AO=1.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** The ao executable the fixture runs, or undefined when there is none. */
export function aoBinary() {
	if (process.env.OMP_TEST_AO_BIN) return process.env.OMP_TEST_AO_BIN;
	const names = process.platform === "win32" ? ["ao.exe", "ao.cmd", "ao"] : ["ao"];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		for (const n of names) {
			const p = path.join(dir, n);
			try {
				fs.accessSync(p, fs.constants.X_OK);
				if (fs.statSync(p).isFile()) return p;
			} catch {}
		}
	}
	return undefined;
}

/** True when an ao binary is available: tests that need the daemon skip otherwise. */
export function aoAvailable() {
	return aoBinary() !== undefined;
}

/** test/fake-omp-acp.mjs: from the env test/run.mjs sets, beside this module (when not bundled), or from the cwd upwards. */
export function fakeOmpAcpPath() {
	if (process.env.OMP_TEST_FAKE_OMP_ACP) return process.env.OMP_TEST_FAKE_OMP_ACP;
	const beside = new URL("./fake-omp-acp.mjs", import.meta.url);
	if (beside.protocol === "file:" && fs.existsSync(beside)) return fileURLToPath(beside);
	for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
		const p = path.join(dir, "test", "fake-omp-acp.mjs");
		if (fs.existsSync(p)) return p;
		if (path.dirname(dir) === dir) throw new Error("test/fake-omp-acp.mjs not found: set OMP_TEST_FAKE_OMP_ACP");
	}
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/** Detached chat hosts (`ao chat-host <session> <dataDir> ...`, own process group) of one daemon, or of one of its sessions. */
function chatHostPids(dataDir, sessionId) {
	if (process.platform === "win32") return [];
	const r = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
	const marker = sessionId ? ` chat-host ${sessionId} ${dataDir} ` : ` ${dataDir} `;
	const pids = [];
	for (const line of (r.stdout ?? "").split("\n")) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (m && / chat-host /.test(m[2]) && m[2].includes(marker)) pids.push(Number(m[1]));
	}
	return pids;
}

function killGroup(pid, signal) {
	for (const target of [-pid, pid]) {
		try {
			process.kill(target, signal);
		} catch {}
	}
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const live = new Set();
let exitHookInstalled = false;
function installExitHook() {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	// Last resort when a test process dies without stop(): no daemon or chat host outlives it.
	process.on("exit", () => {
		for (const fx of live) fx.killNow();
	});
}

function gitIn(cwd, ...args) {
	const r = spawnSync("git", ["-c", "user.name=ao-fixture", "-c", "user.email=ao-fixture@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
	return r.stdout;
}

/**
 * Starts an isolated `ao daemon` and waits for /readyz.
 * @returns {Promise<AoFixture>}
 */
export async function startAoFixture(opts = {}) {
	const aoBin = opts.aoBin ?? aoBinary();
	if (!aoBin) throw new Error("ao not found: install it (see RUNTIME.md) or set OMP_TEST_AO_BIN");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-fixture-"));
	const dataDir = path.join(root, "data");
	const runFile = path.join(root, "running.json");
	const logFile = path.join(root, "daemon.log");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "omp-agent");
	const fakeOmpLog = path.join(root, "fake-omp.log");
	const usageFile = path.join(root, "omp-usage.json");
	const binDir = path.join(root, "bin");
	for (const d of [dataDir, home, agentDir, binDir]) fs.mkdirSync(d, { recursive: true });

	// The daemon inherits nothing AO-specific from a test run that itself happens to be an AO session.
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AO_")));
	if (!opts.realOmp) {
		const fake = fakeOmpAcpPath();
		if (process.platform === "win32") fs.writeFileSync(path.join(binDir, "omp.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
		else fs.writeFileSync(path.join(binDir, "omp"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
		fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = ao-fixture\n\temail = ao-fixture@localhost\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
		Object.assign(env, {
			PATH: [binDir, ...(env.PATH ?? "").split(path.delimiter)].join(path.delimiter),
			HOME: home,
			USERPROFILE: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_DATA_HOME: path.join(home, ".local", "share"),
			XDG_STATE_HOME: path.join(home, ".local", "state"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			PI_CODING_AGENT_DIR: agentDir,
			FAKE_OMP_LOG: fakeOmpLog,
			FAKE_OMP_USAGE: usageFile,
			...opts.fakeOmpEnv,
		});
	}
	Object.assign(env, {
		AO_DATA_DIR: dataDir,
		AO_RUN_FILE: runFile,
		AO_HARNESS_UPDATE_CHECKS: "off",
		AO_VERSION_REFRESH: "off",
		AO_TUI_VERSION_REFRESH: "off",
		AO_UPDATE_WHEN_IDLE: "off",
		AO_MANAGED_HARNESS_INSTALLS: "off",
		AO_TELEMETRY_EVENTS: "off",
		AO_TELEMETRY_METRICS: "off",
		AO_TELEMETRY_REMOTE: "off",
		AO_CLOUD_OFFERING: "off",
		...opts.env,
	});

	const keep = opts.keep ?? process.env.OMP_TEST_KEEP_AO === "1";
	const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
	/** Spawns `ao daemon` on `port`: the child once /readyz answers, else the reason and log tail. */
	async function launch(port) {
		const log = fs.openSync(logFile, "a");
		const proc = spawn(aoBin, ["daemon"], { cwd: root, env: { ...env, AO_PORT: String(port) }, stdio: ["ignore", log, log] });
		fs.closeSync(log);
		const exited = new Promise(r => proc.once("exit", (code, signal) => r({ code, signal })));
		proc.once("error", () => {});
		const ready = await waitReady(`http://127.0.0.1:${port}`, exited, readyTimeoutMs);
		if (ready === true) return { proc };
		killGroup(proc.pid, "SIGKILL");
		return { failed: ready, tail: fs.readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n") };
	}
	/** SIGTERM (SIGKILL after 10 s); detached chat hosts keep running, as with a real daemon stop. */
	async function stopDaemon(proc) {
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		const exited = new Promise(r => proc.once("exit", r));
		proc.kill("SIGTERM");
		if ((await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)])) === false) {
			proc.kill("SIGKILL");
			await exited;
		}
	}
	let child;
	let port;
	// A port free a moment ago can be taken before the daemon binds it: retry with another.
	for (let attempt = 1; ; attempt++) {
		port = opts.env?.AO_PORT ? Number(opts.env.AO_PORT) : await freePort();
		const r = await launch(port);
		if (r.proc) {
			child = r.proc;
			break;
		}
		if (r.failed === "exited" && attempt < 3 && /address already in use|bind/i.test(r.tail)) continue;
		if (!keep) fs.rmSync(root, { recursive: true, force: true });
		throw new Error(`ao daemon ${r.failed === "exited" ? "exited" : "not ready"} (${aoBin}, port ${port}); log tail:\n${r.tail}`);
	}
	const baseUrl = `http://127.0.0.1:${port}`;
	const clientEnv = { AO_PORT: String(port), AO_DATA_DIR: dataDir, AO_RUN_FILE: runFile };
	/** What a process needs to run the same omp AO runs (the fake, its store, log and usage file). */
	const ompEnv = opts.realOmp
		? {}
		: Object.fromEntries(["PATH", "PI_CODING_AGENT_DIR", "FAKE_OMP_LOG", "FAKE_OMP_USAGE", ...Object.keys(opts.fakeOmpEnv ?? {})].map(k => [k, env[k]]));

	const fx = {
		baseUrl,
		port,
		/** The loopback API has no auth; native clients must not send an Origin header. */
		credentials: { token: null, headers: {} },
		/** Env that makes `ao` and AO clients find this daemon instead of the dev one. */
		clientEnv,
		/** The omp AO runs: the fake's wrapper in the fixture's bin dir (or `omp` from PATH with realOmp). */
		ompBin: opts.realOmp ? "omp" : path.join(binDir, process.platform === "win32" ? "omp.cmd" : "omp"),
		ompEnv,
		/** clientEnv + ompEnv: hand it to a planner, CLI or Hermes process that should use this stack. */
		stackEnv: { ...ompEnv, ...clientEnv },
		root,
		dataDir,
		runFile,
		logFile,
		home: opts.realOmp ? os.homedir() : home,
		agentDir: opts.realOmp ? undefined : agentDir,
		fakeOmpLog: opts.realOmp ? undefined : fakeOmpLog,
		usageFile: opts.realOmp ? undefined : usageFile,
		get pid() {
			return child.pid;
		},
		/** What the fake's `omp usage --json` reports from now on: [{provider, id, label?, usedPercent, resetsAt?}]. */
		setUsage(windows) {
			if (opts.realOmp) throw new Error("setUsage needs the fake omp");
			const tmp = `${usageFile}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(windows));
			fs.renameSync(tmp, usageFile);
		},
		/** JSON request against the daemon; throws on non-2xx with the response body. */
		async api(method, urlPath, body) {
			const res = await fetch(`${baseUrl}${urlPath}`, {
				method,
				headers: body === undefined ? {} : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await res.text();
			if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status}: ${text}`);
			return text ? JSON.parse(text) : undefined;
		},
		/** A fresh git repo (one commit on main) under the fixture root. */
		scratchRepo(name = "repo") {
			const dir = path.join(root, "repos", name);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
			gitIn(dir, "init", "-q", "-b", "main");
			gitIn(dir, "add", "-A");
			gitIn(dir, "commit", "-q", "-m", "init");
			return dir;
		},
		/** Registers `dir` as an AO project whose workers default to omp; returns the project id. */
		async createProject(dir, projectId) {
			const { project } = await fx.api("POST", "/api/v1/projects", { path: dir, name: path.basename(dir), ...(projectId ? { projectId } : {}) });
			await fx.api("PUT", `/api/v1/projects/${encodeURIComponent(project.id)}/config`, { config: { defaultBranch: "main", worker: { agent: "omp" } } });
			return project.id;
		},
		/** Every frame the fake omp processes exchanged with AO so far ({mono,pid,dir:"in"|"out"|"argv",msg}). */
		fakeOmpFrames() {
			if (!fx.fakeOmpLog || !fs.existsSync(fx.fakeOmpLog)) return [];
			return fs
				.readFileSync(fx.fakeOmpLog, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(l => JSON.parse(l));
		},
		daemonLog() {
			return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
		},
		/** SIGKILLs the chat host(s) of one AO session and the omp they run (as a crash would); returns how many. */
		killChatHosts(sessionId) {
			const pids = chatHostPids(dataDir, sessionId);
			for (const pid of pids) killGroup(pid, "SIGKILL");
			return pids.length;
		},
		killNow() {
			killGroup(child.pid, "SIGKILL");
			for (const pid of chatHostPids(dataDir)) killGroup(pid, "SIGKILL");
		},
		/**
		 * Restarts the daemon on the same port and data dir, like `systemctl restart`: chat hosts (and
		 * running turns) survive and are reattached. `{ kill: true }` SIGKILLs it instead of a clean stop.
		 */
		async restart({ kill = false } = {}) {
			if (kill) {
				const exited = new Promise(r => child.once("exit", r));
				child.kill("SIGKILL");
				if (child.exitCode === null && child.signalCode === null) await exited;
			} else await stopDaemon(child);
			// The old daemon may hold the port a moment after it exits.
			for (let attempt = 1; ; attempt++) {
				const r = await launch(port);
				if (r.proc) {
					child = r.proc;
					return;
				}
				if (r.failed !== "exited" || attempt >= 20) throw new Error(`ao daemon restart failed (port ${port}); log tail:\n${r.tail}`);
				await sleep(250);
			}
		},
		/** Stops the daemon (SIGTERM, then SIGKILL after 10 s), its chat hosts and their omp, and removes the temp dir. */
		async stop() {
			if (!live.delete(fx)) return;
			await stopDaemon(child);
			// Chat hosts are setsid'd: their process group holds the omp they run.
			const hosts = chatHostPids(dataDir);
			for (const pid of hosts) killGroup(pid, "SIGTERM");
			const deadline = Date.now() + 5000;
			while (hosts.some(alive) && Date.now() < deadline) await sleep(50);
			for (const pid of hosts) killGroup(pid, "SIGKILL");
			if (!keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
		},
	};
	live.add(fx);
	installExitHook();
	return fx;
}

/** true when /readyz answers ready, "exited" when the daemon died, "timeout" otherwise. */
async function waitReady(baseUrl, exited, timeoutMs) {
	let dead = false;
	exited.then(() => (dead = true));
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (dead) return "exited";
		try {
			const res = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1000) });
			if (res.ok && (await res.json()).status === "ready") return true;
		} catch {}
		await sleep(100);
	}
	return dead ? "exited" : "timeout";
}

/**
 * node:test helper: one fixture for the calling test file (or describe block), started in
 * `before` and stopped in `after`. Read `.current` inside tests.
 *   const ao = useAoFixture({ before, after });
 *   test("...", async () => { await fetch(ao.current.baseUrl + "/readyz"); });
 */
export function useAoFixture({ before, after }, opts) {
	const handle = { current: undefined };
	before(async () => {
		handle.current = await startAoFixture(opts);
	});
	after(async () => {
		await handle.current?.stop();
	});
	return handle;
}
