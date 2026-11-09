// Isolated AO daemon for tests: `ao daemon` on a free loopback port with a private temp data dir,
// run file and HOME, pointed at test/fake-omp-acp.mjs as `omp` (first on its PATH), so nothing
// touches the dev daemon (port 3001, ~/.ao) or the real ~/.omp. See RUNTIME.md ("Second isolated
// instance") in the migration notes.
//
//   import { skipWithoutAo, startAoFixture } from "../ao-fixture.mjs";
//   test("...", { skip: skipWithoutAo }, ...)      // skips when no `ao` binary is installed
//   const ao = await startAoFixture();            // throws if `ao` is missing
//   await fetch(`${ao.baseUrl}/api/v1/sessions`);  // loopback API: no auth (credentials.headers is {})
//   const projectId = await ao.createProject(ao.scratchRepo());
//   ...
//   await ao.stop();                              // daemon, its detached chat hosts and the temp dir
//
// ISOLATION (CONTRACT.md "Isolated HOME"), always, no switch: the daemon, its chat hosts and omp run with
// HOME, XDG_*, SWITCHYARD_HOME and OMP_VSCODE_HOME under the fixture root, and the fixture refuses to start
// if an override (opts.env) points any of them elsewhere. `ao.stackEnv` carries the same variables, so a
// CLI, planner or Hermes process started with it stays isolated too. THIS process gets the same variables
// while the fixture lives (client-side code reads HOME / SWITCHYARD_HOME from process.env: src/ao/spawn.ts,
// os.homedir()), restored by stop(): nothing depends on a slice remembering to set them.
// Never run `install CLI/skill/service` outside such an env.
//
// Options: { aoBin, realOmp, env, fakeOmpEnv, pathPrepend, switchyardHome, readyTimeoutMs, keep }
//   aoBin        ao executable (default $SWITCHYARD_TEST_AO_BIN, else `ao` on PATH)
//   switchyardHome  SWITCHYARD_HOME (any temp dir; default <root>/switchyard): lets a test VS Code, the daemon and
//                a planner share one
//   realOmp      run the real omp (from PATH) instead of the fake, for smoke tests. Still isolated: HOME is
//                the fixture's, with home/.omp/agent linked to the real agent dir (the login lives there)
//   env          extra daemon env (e.g. AO_* overrides)
//   fakeOmpEnv   extra env for the fake (FAKE_OMP_DELAY, FAKE_OMP_NO_STEERING, ...)
//   pathPrepend  dirs put first on the daemon's PATH (in front of the fake `omp`): an `omp` shim goes here
//   keep         leave the temp dir after stop (default $SWITCHYARD_TEST_KEEP_AO=1), for post-mortems
//
// Env read here: SWITCHYARD_TEST_AO_BIN, SWITCHYARD_TEST_FAKE_OMP_ACP (path of the fake; test/run.mjs
// sets it), SWITCHYARD_TEST_KEEP_AO=1.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** The ao executable the fixture runs, or undefined when there is none. */
export function aoBinary() {
	if (process.env.SWITCHYARD_TEST_AO_BIN) return process.env.SWITCHYARD_TEST_AO_BIN;
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

/** node:test `skip` value for tests that need the daemon: false, or why they skip. */
export const skipWithoutAo = aoAvailable() ? false : "ao not installed (set SWITCHYARD_TEST_AO_BIN)";

/** test/fake-omp-acp.mjs: from the env test/run.mjs sets, beside this module (when not bundled), or from the cwd upwards. */
export function fakeOmpAcpPath() {
	if (process.env.SWITCHYARD_TEST_FAKE_OMP_ACP) return process.env.SWITCHYARD_TEST_FAKE_OMP_ACP;
	const beside = new URL("./fake-omp-acp.mjs", import.meta.url);
	if (beside.protocol === "file:" && fs.existsSync(beside)) return fileURLToPath(beside);
	for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
		const p = path.join(dir, "test", "fake-omp-acp.mjs");
		if (fs.existsSync(p)) return p;
		if (path.dirname(dir) === dir) throw new Error("test/fake-omp-acp.mjs not found: set SWITCHYARD_TEST_FAKE_OMP_ACP");
	}
}

/**
 * Removes a temp tree. A process that was just stopped (or a child of AO's cleanup) can still write into it
 * for a moment ("ENOTEMPTY"), so it retries; a tree that stays busy is left in /tmp, never failing a test.
 */
export async function removeTree(dir) {
	for (let attempt = 1; ; attempt++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (err) {
			if (attempt >= 20) {
				console.warn(`ao-fixture: could not remove ${dir}: ${err.message}`);
				return;
			}
			await sleep(100);
		}
	}
}

/** Set by a parent omp session for its tools; must not reach the omp processes of a test daemon. */
export const PARENT_OMP_ENV = new Set(["PI_SESSION_FILE", "PI_SESSION_ID", "PI_NO_TITLE", "PI_NO_PTY", "PI_NOTIFICATIONS", "OMPCODE"]);

/** The user's real home (from the password database: HOME may already be an isolated one). */
function realHome() {
	return fs.realpathSync(os.userInfo().homedir);
}

/**
 * Refuses to start a daemon that could touch the user's real state: HOME, the XDG dirs and the
 * Switchyard state dirs must all lie under the fixture root (opts.env could have overridden them).
 */
function assertIsolated(env, root, real) {
	const within = (p, dir) => {
		const rel = path.relative(fs.realpathSync(dir), path.resolve(p));
		return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	};
	const resolved = p => (fs.existsSync(p) ? fs.realpathSync(p) : p);
	for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "SWITCHYARD_HOME", "OMP_VSCODE_HOME"]) {
		const value = env[key];
		// SWITCHYARD_HOME may live in any temp dir (a test VS Code, the planner and the daemon share one); the rest under the root.
		const ok = value && (within(resolved(value), root) || (key === "SWITCHYARD_HOME" && within(resolved(value), os.tmpdir())));
		if (!ok) throw new Error(`ao-fixture: ${key}=${value} is not under the fixture root ${root}: tests never run against the real HOME (${real})`);
	}
	if (path.resolve(env.HOME) === real) throw new Error(`ao-fixture: HOME is the real home ${real}`);
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

/**
 * Processes belonging to a fixture (Linux): chat hosts whose command line names its data dir (they are
 * detached with setsid, so they outlive the daemon), and anything whose working directory is inside its
 * root (omp runs in the session worktrees under it). Never this process.
 */
function fixtureProcesses(root, dataDir) {
	if (process.platform !== "linux") return chatHostPids(dataDir);
	const under = (p, dir) => p === dir || p.startsWith(dir + path.sep);
	const pids = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
		let hit = false;
		try {
			const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
			hit = argv.includes("chat-host") && argv.some(a => under(a, dataDir));
			if (!hit) hit = under(fs.readlinkSync(`/proc/${entry}/cwd`), root);
		} catch {
			continue;
		}
		if (hit) pids.push(Number(entry));
	}
	return pids;
}

/** Kills (SIGTERM, then SIGKILL) every process of the fixture until none is left; the pids that survived. */
async function reapFixtureProcesses(root, dataDir) {
	for (const signal of ["SIGTERM", "SIGKILL", "SIGKILL"]) {
		const pids = fixtureProcesses(root, dataDir);
		if (pids.length === 0) return [];
		for (const pid of pids) killGroup(pid, signal);
		const deadline = Date.now() + (signal === "SIGTERM" ? 5000 : 3000);
		while (fixtureProcesses(root, dataDir).length > 0 && Date.now() < deadline) await sleep(50);
	}
	return fixtureProcesses(root, dataDir);
}

/** Kills every session the daemon knows, through its API (best effort, bounded): the hosts then end their omp themselves. */
async function killSessions(baseUrl, proc) {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	try {
		const res = await fetch(`${baseUrl}/api/v1/sessions`, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return;
		const { sessions = [] } = await res.json();
		await Promise.allSettled(sessions.map(s => fetch(`${baseUrl}/api/v1/sessions/${encodeURIComponent(s.id)}/kill`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) })));
	} catch {}
}

/** Detached chat hosts (`ao chat-host <session> <dataDir> ...`, own process group) of one daemon, or of one of its sessions. */
function chatHostPids(dataDir, sessionId) {
	if (process.platform === "win32") return [];
	const matches = argv => {
		const i = argv.indexOf("chat-host");
		return i >= 0 && argv[i + 2] === dataDir && (!sessionId || argv[i + 1] === sessionId);
	};
	const pids = [];
	if (fs.existsSync("/proc/self/cmdline")) {
		// /proc, not `ps`: chat host command lines carry whole system prompts, and a few dozen of them
		// overflow spawnSync's output buffer (ENOBUFS → a truncated list → hosts left behind).
		for (const entry of fs.readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			let argv;
			try {
				argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
			} catch {
				continue;
			}
			if (matches(argv)) pids.push(Number(entry));
		}
		return pids;
	}
	const r = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	for (const line of (r.stdout ?? "").split("\n")) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (m && matches(m[2].split(" "))) pids.push(Number(m[1]));
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

/** Waits (at most `timeoutMs`; a timeout is not an error) until AO's catalog of omp models has entries. */
async function waitModelCatalog(baseUrl, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/api/v1/agents/omp/models`, { signal: AbortSignal.timeout(2000) });
			if (res.ok && ((await res.json()).models ?? []).length > 0) return;
		} catch {}
		await sleep(100);
	}
}

/** Puts back what `startAoFixture` replaced in process.env, key by key, unless another fixture has taken the key over since. */
function restoreProcessEnv(isolation, previous) {
	for (const [key, ours] of Object.entries(isolation)) {
		if (process.env[key] !== ours) continue;
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
}

/**
 * Starts an isolated `ao daemon` and waits for /readyz. While the fixture lives, THIS process's HOME, USERPROFILE,
 * XDG_*, SWITCHYARD_HOME and OMP_VSCODE_HOME are the fixture's too (restored by stop()).
 * @returns {Promise<AoFixture>}
 */
export async function startAoFixture(opts = {}) {
	const aoBin = opts.aoBin ?? aoBinary();
	if (!aoBin) throw new Error("ao not found: install it (see RUNTIME.md) or set SWITCHYARD_TEST_AO_BIN");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-fixture-"));
	const dataDir = path.join(root, "data");
	const runFile = path.join(root, "running.json");
	const logFile = path.join(root, "daemon.log");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "omp-agent");
	const fakeOmpLog = path.join(root, "fake-omp.log");
	const usageFile = path.join(root, "omp-usage.json");
	const rulesFile = path.join(root, "omp-rules.json");
	const binDir = path.join(root, "bin");
	for (const d of [dataDir, home, agentDir, binDir]) fs.mkdirSync(d, { recursive: true });

	// The daemon inherits nothing AO-specific, and nothing of an omp session the test itself may be running in:
	// the daemon hands its whole env to every `omp acp` it spawns, so PI_SESSION_FILE & co would point them at the
	// caller's session (same list as validate's IsolatedDaemon). HOME and XDG_* below are for the daemon process
	// itself: its readiness probes for other harnesses (claude, codex, kiro…) write into $HOME.
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AO_") && !PARENT_OMP_ENV.has(k)));
	// CONTRACT.md "Isolated HOME": every run, fake or real omp, gets its own HOME, XDG dirs and Switchyard
	// state dirs under the fixture root (SWITCHYARD_HOME may be any other temp dir: opts.switchyardHome).
	const switchyardHome = opts.switchyardHome ? path.resolve(opts.switchyardHome) : path.join(root, "switchyard");
	const isolation = {
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_DATA_HOME: path.join(home, ".local", "share"),
		XDG_STATE_HOME: path.join(home, ".local", "state"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
		SWITCHYARD_HOME: switchyardHome,
		OMP_VSCODE_HOME: path.join(root, "omp-vscode"),
		// With real omp the fixture's ~/.omp/agent is the REAL agent dir (linked, for the login): nothing may install
		// Switchyard's omp gate or shim into it (CONTRACT.md; G46: the planner and the extension install at start).
		// Part of the isolation, so the daemon, ao.stackEnv (planner, CLI…) and this process all carry it.
		...(opts.realOmp ? { SWITCHYARD_INSTALL_OMP_EXTENSIONS: "0" } : {}),
	};
	/** The in-process values the isolation will replace (undefined = unset), to put back on stop(). */
	const previousProcessEnv = Object.fromEntries(Object.keys(isolation).map(k => [k, process.env[k]]));
	for (const d of [isolation.XDG_CONFIG_HOME, isolation.XDG_DATA_HOME, isolation.XDG_STATE_HOME, isolation.XDG_CACHE_HOME, isolation.SWITCHYARD_HOME, isolation.OMP_VSCODE_HOME]) fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = ao-fixture\n\temail = ao-fixture@localhost\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
	Object.assign(env, isolation);
	if (opts.realOmp) {
		// Real omp needs the real login, which lives in ~/.omp/agent/agent.db (SQLite): share the whole
		// agent dir through a link. Nothing of ours may install into it during the migration.
		if (!env.PI_CODING_AGENT_DIR) {
			fs.mkdirSync(path.join(home, ".omp"), { recursive: true });
			fs.symlinkSync(path.join(realHome(), ".omp", "agent"), path.join(home, ".omp", "agent"), "dir");
		}
	} else {
		const fake = fakeOmpAcpPath();
		if (process.platform === "win32") fs.writeFileSync(path.join(binDir, "omp.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
		else fs.writeFileSync(path.join(binDir, "omp"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
		Object.assign(env, {
			PATH: [binDir, ...(env.PATH ?? "").split(path.delimiter)].join(path.delimiter),
			PI_CODING_AGENT_DIR: agentDir,
			FAKE_OMP_LOG: fakeOmpLog,
			FAKE_OMP_USAGE: usageFile,
			FAKE_OMP_RULES: rulesFile,
			...opts.fakeOmpEnv,
		});
	}
	// Dirs first on the daemon's PATH, before the fake: how an `omp` shim (G34) is put in front of the omp it wraps.
	if (opts.pathPrepend?.length) env.PATH = [...opts.pathPrepend, env.PATH ?? ""].join(path.delimiter);
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
	try {
		assertIsolated(env, root, realHome());
	} catch (err) {
		await removeTree(root);
		throw err;
	}

	const keep = opts.keep ?? process.env.SWITCHYARD_TEST_KEEP_AO === "1";
	const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
	/** Spawns `ao daemon` on `port`: the child once /readyz answers, else the reason and log tail. */
	async function launch(port) {
		const log = fs.openSync(logFile, "a");
		const proc = spawn(aoBin, ["daemon"], { cwd: root, env: { ...env, AO_PORT: String(port) }, stdio: ["ignore", log, log] });
		fs.closeSync(log);
		const exited = new Promise(r => proc.once("exit", (code, signal) => r({ code, signal })));
		proc.once("error", () => {});
		const ready = await waitReady(`http://127.0.0.1:${port}`, exited, readyTimeoutMs, { pid: proc.pid, dataDir });
		if (ready === true) {
			// AO fills its omp model catalog (`omp models --json`) in the background after start; a client that validates a
			// model against it (src/ao/spawn.ts) would fail "Unknown omp model" until then. Hand out a daemon that has it.
			if (!opts.realOmp && opts.fakeOmpEnv?.FAKE_OMP_NO_MODELS !== "1") await waitModelCatalog(`http://127.0.0.1:${port}`);
			return { proc };
		}
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
		if (!keep) await removeTree(root);
		throw new Error(`ao daemon ${r.failed === "exited" ? "exited" : "not ready"} (${aoBin}, port ${port}); log tail:\n${r.tail}`);
	}
	const baseUrl = `http://127.0.0.1:${port}`;
	const clientEnv = { AO_PORT: String(port), AO_DATA_DIR: dataDir, AO_RUN_FILE: runFile };
	/** What a process needs to run the same omp AO runs: the isolated HOME/XDG/state dirs, and the fake with its store, log and usage file. */
	const ompEnv = {
		...isolation,
		...(opts.realOmp ? (opts.pathPrepend?.length ? { PATH: env.PATH } : {}) : Object.fromEntries(["PATH", "PI_CODING_AGENT_DIR", "FAKE_OMP_LOG", "FAKE_OMP_USAGE", "FAKE_OMP_RULES", ...Object.keys(opts.fakeOmpEnv ?? {})].map(k => [k, env[k]]))),
	};

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
		/** clientEnv + ompEnv: hand it to a planner, CLI or Hermes process that should use this stack (isolated HOME included). */
		stackEnv: { ...ompEnv, ...clientEnv },
		root,
		/** True when this fixture runs the real omp (its home/.omp/agent is the REAL agent dir, linked). */
		realOmp: !!opts.realOmp,
		/** SWITCHYARD_HOME of the daemon, its omp extensions, this process's own client code and (by default) a planner. */
		switchyardHome,
		dataDir,
		runFile,
		logFile,
		home,
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
		/**
		 * Scripts for prompts the test doesn't write (a planner's follow-ups, resolve tasks): the first rule
		 * whose `match` regex matches a prompt runs its `script` instead, `$1`… = the groups.
		 */
		setFakeRules(rules) {
			if (opts.realOmp) throw new Error("setFakeRules needs the fake omp");
			const tmp = `${rulesFile}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(rules));
			fs.renameSync(tmp, rulesFile);
		},
		/**
		 * Installs a stand-in Switchyard permission gate (a package listing and shipping `mode.js`, what gateStatus()
		 * looks for) into the fixture's OWN omp agent dir, and returns the `gate` option for src/ao's
		 * spawnSwitchyard / spawnSwitchyardSession, which refuse a mode other than `auto` without it (G46). Fake omp
		 * only: with realOmp the agent dir is the real one, which nothing of ours may write into.
		 */
		standInGate() {
			if (opts.realOmp) throw new Error("standInGate needs the fake omp: with realOmp the agent dir is the real one");
			const dir = path.join(agentDir, "extensions", "switchyard");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "switchyard", omp: { extensions: ["./mode.js"] } }));
			fs.writeFileSync(path.join(dir, "mode.js"), "export default () => {};\n");
			return { omp: { home, env: { PI_CODING_AGENT_DIR: agentDir } } };
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
		/**
		 * A fresh git repo (one commit on main) under the fixture root. `extensions` ({ "name.ts": "/path/to/source" })
		 * are copied into the repo's `.omp/extensions/` and committed, so every AO worktree of it has them: how a smoke
		 * with real omp loads Switchyard's omp extensions (CONTRACT.md: nothing installs into the shared ~/.omp/agent).
		 */
		scratchRepo(name = "repo", { extensions = {} } = {}) {
			const dir = path.join(root, "repos", name);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
			for (const [file, source] of Object.entries(extensions)) {
				fs.mkdirSync(path.join(dir, ".omp", "extensions"), { recursive: true });
				fs.copyFileSync(source, path.join(dir, ".omp", "extensions", file));
			}
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
		/**
		 * Every frame the fake omp processes exchanged so far ({mono,pid,dir:"in"|"out"|"argv",msg}).
		 * Leaves out AO's own background chats (title generation, run in `<data>/background-tasks/`)
		 * unless `includeBackground`.
		 */
		fakeOmpFrames({ includeBackground = false } = {}) {
			if (!fx.fakeOmpLog || !fs.existsSync(fx.fakeOmpLog)) return [];
			const frames = fs
				.readFileSync(fx.fakeOmpLog, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(l => JSON.parse(l));
			if (includeBackground) return frames;
			const background = new Set(frames.filter(f => f.msg?.method === "session/new" && /[/\\]background-tasks[/\\]/.test(f.msg.params?.cwd ?? "")).map(f => f.pid));
			return frames.filter(f => !background.has(f.pid));
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
			for (const pid of fixtureProcesses(root, dataDir)) killGroup(pid, "SIGKILL");
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
		/**
		 * Tears everything down and asserts nothing of the fixture survives: (1) kills every session through the
		 * API while the daemon is up, (2) stops the daemon (SIGTERM, SIGKILL after 10 s), (3) kills every process
		 * still referencing the fixture (detached chat hosts and the omp in their groups, anything running in its
		 * tree), (4) removes the temp dir, (5) throws if a process of the fixture is still alive.
		 */
		async stop() {
			if (!live.delete(fx)) return;
			// This process's environment goes back to what it was. A variable a later fixture has taken over stays.
			restoreProcessEnv(isolation, previousProcessEnv);
			await killSessions(baseUrl, child);
			await stopDaemon(child);
			const survivors = await reapFixtureProcesses(root, dataDir);
			if (!keep) await removeTree(root);
			if (survivors.length > 0) throw new Error(`ao-fixture: ${survivors.length} process(es) of ${root} survived teardown: ${survivors.join(", ")}`);
		},
	};
	live.add(fx);
	installExitHook();
	// Client-side code that runs in THIS process resolves the user's directories from process.env (src/ao/spawn.ts
	// writes sessions/<id>/mode under SWITCHYARD_HOME; os.homedir() reads HOME; XDG_* for the rest): point all of
	// them at the fixture's, the same ones the daemon and its omp extensions run with, never the real home
	// (~/.switchyard is locked: EACCES).
	Object.assign(process.env, isolation);
	return fx;
}

/**
 * true when /readyz answers ready *from the daemon we spawned* (its pid and `workingDirectory` = our data
 * dir; another daemon on a busy port would also answer ready, and a test would silently run against it),
 * "exited" when ours died, "timeout" otherwise.
 */
async function waitReady(baseUrl, exited, timeoutMs, expect) {
	let dead = false;
	exited.then(() => (dead = true));
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (dead) return "exited";
		try {
			const res = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1000) });
			if (res.ok) {
				const body = await res.json();
				if (body.status === "ready" && body.pid === expect.pid && sameDir(body.workingDirectory, expect.dataDir)) return true;
			}
		} catch {}
		await sleep(100);
	}
	return dead ? "exited" : "timeout";
}

const sameDir = (a, b) => typeof a === "string" && path.resolve(a) === path.resolve(b);

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
