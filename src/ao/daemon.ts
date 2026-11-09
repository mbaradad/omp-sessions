// Finding, starting and stopping the local AO daemon (`ao daemon`).
//
// The daemon writes `running.json` (AO_RUN_FILE, default ~/.ao/running.json: pid, port) once its
// listener is bound, answers `GET /healthz` with its service name and pid, and `GET /readyz` once it
// serves. It may bind an ephemeral port when its configured one (AO_PORT, default 3001) is taken,
// so the port always comes from the run file. On loopback it has no authentication: requests must
// only not carry an `Origin` (or `Sec-Fetch-Site`) header, which Node's fetch never sends.
// See backend/internal/{config,runfile,httpd/router.go} in the AO repo.
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shimDir, switchyardHome } from "./native";

export const AO_SERVICE = "agent-orchestrator-daemon";
export const AO_DEFAULT_PORT = 3001;
const HOST = "127.0.0.1";

/** `running.json` (backend/internal/runfile/runfile.go). */
export interface AoRunFile {
	pid: number;
	port: number;
	startedAt?: string;
	/** "app" (the desktop app owns it), "persistent", or absent (headless). */
	owner?: string;
	appRunId?: string;
}

/** `/healthz` and `/readyz`. */
export interface AoHealth {
	status: string;
	service: string;
	pid: number;
	ipv6Loopback?: boolean;
	executablePath?: string;
	workingDirectory?: string;
}

/** A daemon that answered as ready. */
export interface AoDaemon {
	baseUrl: string;
	port: number;
	pid: number;
	/** The binary it runs from, when it says. */
	executablePath?: string;
	/** The run file it was found through; absent when found by probing the port. */
	runFile?: string;
	owner?: string;
}

export interface AoDaemonOptions {
	/** Overrides AO_RUN_FILE / ~/.ao/running.json. */
	runFile?: string;
	/** Port probed when the run file names no live daemon. Overrides AO_PORT / 3001. */
	port?: number;
	/** Environment the defaults come from (and that a started daemon inherits). Default `process.env`. */
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	/** Per-probe timeout. Default 2 s. */
	probeTimeoutMs?: number;
}

export interface AoStartOptions extends AoDaemonOptions {
	/** The `ao` binary. Default: AO_BIN, then `ao` on PATH, then ~/.local/bin/ao, ~/go/bin/ao. */
	aoPath?: string;
	/** How long to wait for the started daemon to answer ready. Default 60 s (it may wait on a predecessor's data-dir lock). */
	startTimeoutMs?: number;
	/** How to run it. `auto` (default): a systemd user unit where systemd runs, else a detached process. */
	supervisor?: "auto" | "systemd" | "detached";
	log?: (message: string) => void;
}

export function defaultRunFile(env: NodeJS.ProcessEnv = process.env): string {
	return env.AO_RUN_FILE ? path.resolve(env.AO_RUN_FILE) : path.join(os.homedir(), ".ao", "running.json");
}

export function defaultPort(env: NodeJS.ProcessEnv = process.env): number {
	const port = Number(env.AO_PORT);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : AO_DEFAULT_PORT;
}

export function baseUrlFor(port: number): string {
	return `http://${HOST}:${port}`;
}

export function readRunFile(file: string): AoRunFile | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (!Number.isInteger(r.pid) || !Number.isInteger(r.port)) return undefined;
	return {
		pid: r.pid as number,
		port: r.port as number,
		...(typeof r.startedAt === "string" && { startedAt: r.startedAt }),
		...(typeof r.owner === "string" && { owner: r.owner }),
		...(typeof r.appRunId === "string" && { appRunId: r.appRunId }),
	};
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists, owned by someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function getJson(doFetch: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
	try {
		const response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	}
}

function asHealth(body: unknown): AoHealth | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const b = body as Record<string, unknown>;
	if (b.service !== AO_SERVICE || typeof b.status !== "string" || !Number.isInteger(b.pid)) return undefined;
	return body as AoHealth;
}

/** Asks `baseUrl` whether an AO daemon is there and ready (and, with `pid`, that it is that process). */
export async function probeDaemon(baseUrl: string, options: { pid?: number; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<AoHealth | undefined> {
	const doFetch = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? 2_000;
	const base = baseUrl.replace(/\/+$/, "");
	const health = asHealth(await getJson(doFetch, `${base}/healthz`, timeoutMs));
	if (!health || health.status !== "ok" || (options.pid !== undefined && health.pid !== options.pid)) return undefined;
	const ready = asHealth(await getJson(doFetch, `${base}/readyz`, timeoutMs));
	return ready?.status === "ready" ? ready : undefined;
}

/** The running daemon, from its run file, else by probing the expected port; undefined when none answers ready. */
export async function findDaemon(options: AoDaemonOptions = {}): Promise<AoDaemon | undefined> {
	const env = options.env ?? process.env;
	const runFile = options.runFile ?? defaultRunFile(env);
	const probe = { fetch: options.fetch, timeoutMs: options.probeTimeoutMs };
	const run = readRunFile(runFile);
	if (run && pidAlive(run.pid)) {
		const baseUrl = baseUrlFor(run.port);
		const health = await probeDaemon(baseUrl, { ...probe, pid: run.pid });
		if (health) return { baseUrl, port: run.port, pid: run.pid, runFile, ...(health.executablePath && { executablePath: health.executablePath }), ...(run.owner && { owner: run.owner }) };
	}
	// The run file can be missing or stale while a daemon still serves the configured port
	// (another data dir, a crash that left the file behind): the desktop app probes it too.
	const port = options.port ?? defaultPort(env);
	if (run?.port === port && run && pidAlive(run.pid)) return undefined;
	const baseUrl = baseUrlFor(port);
	const health = await probeDaemon(baseUrl, probe);
	return health ? { baseUrl, port, pid: health.pid, ...(health.executablePath && { executablePath: health.executablePath }) } : undefined;
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** The `ao` binary to start: AO_BIN, `ao` on PATH, then the usual install folders (the extension host's PATH may lack them). */
export function findAoBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.AO_BIN) return env.AO_BIN;
	const exe = process.platform === "win32" ? "ao.exe" : "ao";
	const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
	dirs.push(path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), "go", "bin"));
	for (const dir of dirs) {
		const candidate = path.join(dir, exe);
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

function systemdUserAvailable(): boolean {
	if (process.platform !== "linux") return false;
	const r = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5_000 });
	return r.status === 0;
}

/** True when HOME is not the user's real home (a smoke or e2e run with an isolated HOME). */
export function isolatedHome(env: NodeJS.ProcessEnv = process.env): boolean {
	return path.resolve(env.HOME || os.homedir()) !== path.resolve(os.userInfo().homedir);
}

/**
 * systemd unit name: `ao-daemon` only for the default instance of the user's real home. Anything else
 * gets a unit named after its run file: `systemctl --user` talks to the one real user manager whatever
 * HOME says, so an isolated run must never touch the real `ao-daemon.service`.
 */
export function daemonUnitName(runFile: string, env: NodeJS.ProcessEnv = process.env): string {
	if (!isolatedHome(env) && path.resolve(runFile) === path.join(os.homedir(), ".ao", "running.json") && !env.AO_DATA_DIR) return "ao-daemon";
	return `ao-daemon-${crypto.createHash("sha256").update(path.resolve(runFile)).digest("hex").slice(0, 8)}`;
}

/**
 * The variables a started daemon needs: AO's own, and PATH/HOME so it finds `omp` and the user's config.
 * When the Switchyard `omp` shim is installed (`<switchyard home>/bin/omp`, G34) its folder comes first
 * on PATH, so AO launches `omp acp` through it and extra arguments reach the agent. A daemon this
 * module does not start (AO's desktop app, an installed unit) needs that folder on its PATH by hand.
 */
export function daemonEnv(env: NodeJS.ProcessEnv, runFile: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (key.startsWith("AO_") || key.startsWith("OMP_") || key.startsWith("PI_") || ["PATH", "HOME", "USER", "LANG", "SHELL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].includes(key)) out[key] = value;
	}
	out.AO_RUN_FILE = runFile;
	// The supervisor's own client env (AO_BIN is ours, not the daemon's).
	delete out.AO_BIN;
	const shim = shimDir(switchyardHome(env));
	if (isFile(path.join(shim, "omp")) && !(out.PATH ?? "").split(path.delimiter).includes(shim)) out.PATH = [shim, out.PATH].filter(Boolean).join(path.delimiter);
	return out;
}

/** Settings every unit we run the daemon in needs. KillMode=process: the per-session chat hosts are the daemon's children in its cgroup, and must outlive a restart of it. */
const UNIT_PROPERTIES = ["KillMode=process", "Restart=on-failure", "RestartSec=5"];

const systemctl = (...args: string[]) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 15_000 });

/** A value inside a double-quoted unit-file setting: escape quotes and backslashes, and `%` (specifiers). */
const unitQuote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** The default instance's persistent unit, as RUNTIME.md runs it: enabled, so it also starts at login. */
export function daemonUnitFile(ao: string, env: Record<string, string>): string {
	return [
		"[Unit]",
		"Description=Agent Orchestrator daemon",
		"",
		"[Service]",
		`ExecStart=${unitQuote(ao)} daemon`,
		...Object.entries(env).map(([key, value]) => `Environment=${unitQuote(`${key}=${value}`)}`),
		...UNIT_PROPERTIES,
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

/**
 * Starts the daemon under systemd: an installed unit of that name as it is; for the default instance,
 * a persistent unit written to ~/.config/systemd/user and enabled; for an isolated instance, a
 * transient unit. False when systemd refuses, so the caller starts a detached process instead.
 */
function startSystemd(ao: string, env: Record<string, string>, unit: string, log: (m: string) => void): boolean {
	if (systemctl("cat", `${unit}.service`).status === 0) {
		const r = systemctl("start", `${unit}.service`);
		if (r.status === 0) log(`started ${unit}.service`);
		else log(`systemctl --user start ${unit} failed: ${(r.stderr ?? "").trim() || r.status}`);
		return r.status === 0;
	}
	if (unit === "ao-daemon") {
		const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${unit}.service`), daemonUnitFile(ao, env));
		systemctl("daemon-reload");
		const r = systemctl("enable", "--now", `${unit}.service`);
		if (r.status === 0) {
			log(`installed and started ${path.join(dir, `${unit}.service`)}`);
			return true;
		}
		log(`systemctl --user enable --now ${unit} failed: ${(r.stderr ?? "").trim() || r.status}`);
		return false;
	}
	const args = ["--user", `--unit=${unit}`, "--collect", "--description=Agent Orchestrator daemon (isolated)", ...UNIT_PROPERTIES.map(p => `--property=${p}`)];
	for (const [key, value] of Object.entries(env)) args.push(`--setenv=${key}=${value}`);
	args.push(ao, "daemon");
	const r = spawnSync("systemd-run", args, { encoding: "utf8", timeout: 15_000 });
	if (r.status === 0) {
		log(`started transient ${unit}.service (${ao} daemon)`);
		return true;
	}
	log(`systemd-run failed (${(r.stderr ?? "").trim() || r.status})`);
	return false;
}

function startDetached(ao: string, env: Record<string, string>, runFile: string, log: (m: string) => void): void {
	const dir = path.dirname(runFile);
	fs.mkdirSync(dir, { recursive: true });
	const logFile = path.join(dir, "daemon.log");
	const out = fs.openSync(logFile, "a");
	try {
		const child = spawn(ao, ["daemon"], { cwd: dir, env, detached: true, stdio: ["ignore", out, out], windowsHide: true });
		child.on("error", error => log(`${ao} daemon: ${error.message}`));
		child.unref();
		log(`started ${ao} daemon (pid ${child.pid}), log ${logFile}`);
	} finally {
		fs.closeSync(out);
	}
}

/** The running daemon, or a newly started one: a systemd user unit (restarted on failure) where available, else a detached process. */
export async function ensureDaemon(options: AoStartOptions = {}): Promise<AoDaemon> {
	const running = await findDaemon(options);
	if (running) return running;
	const env = options.env ?? process.env;
	const runFile = options.runFile ?? defaultRunFile(env);
	const log = options.log ?? (() => undefined);
	const ao = options.aoPath ?? findAoBinary(env);
	if (!ao) throw new Error("No AO daemon is running and the `ao` binary was not found (set AO_BIN or put ao on PATH).");
	const childEnv = daemonEnv(env, runFile);
	if (options.port !== undefined) childEnv.AO_PORT = String(options.port);
	const supervisor = options.supervisor ?? "auto";
	const viaSystemd = supervisor !== "detached" && (supervisor === "systemd" || systemdUserAvailable()) && startSystemd(ao, childEnv, daemonUnitName(runFile, env), log);
	if (!viaSystemd) startDetached(ao, childEnv, runFile, log);
	const deadline = Date.now() + (options.startTimeoutMs ?? 60_000);
	while (Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 250));
		const daemon = await findDaemon(options);
		if (daemon) return daemon;
	}
	throw new Error(`The AO daemon did not become ready within ${Math.round((options.startTimeoutMs ?? 60_000) / 1000)} s (run file ${runFile}).`);
}

/** Asks the daemon to shut down (`POST /shutdown`); `stopAgents` also stops its agent hosts. Resolves once its pid is gone. */
export async function stopDaemon(daemon: AoDaemon, options: { stopAgents?: boolean; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<void> {
	const doFetch = options.fetch ?? globalThis.fetch;
	const response = await doFetch(`${daemon.baseUrl}/shutdown`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(options.stopAgents ? { stopAgents: true } : {}),
	});
	if (response.status !== 202) throw new Error(`POST /shutdown: HTTP ${response.status}`);
	const deadline = Date.now() + (options.timeoutMs ?? 15_000);
	while (pidAlive(daemon.pid)) {
		if (Date.now() > deadline) throw new Error(`AO daemon pid ${daemon.pid} still runs after shutdown`);
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}
