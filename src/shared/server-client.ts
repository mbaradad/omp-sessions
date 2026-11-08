// Client side of the omp-sessions server protocol (CLI and extension) and starting the server on
// demand (installing the per-user service the first time, so the server survives reboots).
// Node-only; no vscode import.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { readLauncherSettings } from "./launch";
import { claimLock, releaseLock } from "./process-lock";
import { stateRoot } from "./protocol";
import { migrateLegacyService } from "./rename-migration";
import { type OpName, type ServerEvent, type ServerOps, type ServerResponse, type SubscribeArgs, serverLogPath, serverSocketPath } from "./server-protocol";

export class ServerClient {
	private seq = 0;
	private readonly pending = new Map<number, (res: ServerResponse) => void>();
	private readonly subscriptions = new Map<number, (ev: ServerEvent) => void>();
	private readonly closeListeners = new Set<() => void>();
	closed = false;

	private constructor(private readonly sock: net.Socket) {
		const rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
		rl.on("error", () => {});
		rl.on("line", line => {
			if (!line) return;
			let msg: ServerResponse | ServerEvent;
			try {
				msg = JSON.parse(line) as ServerResponse | ServerEvent;
			} catch {
				return;
			}
			if ("event" in msg) {
				this.subscriptions.get(msg.id)?.(msg);
				return;
			}
			const done = this.pending.get(msg.id);
			if (done) {
				this.pending.delete(msg.id);
				done(msg);
			}
		});
		const onClose = () => {
			if (this.closed) return;
			this.closed = true;
			for (const [id, done] of this.pending) done({ id, ok: false, error: "the omp-sessions server closed the connection" });
			this.pending.clear();
			for (const l of [...this.closeListeners]) l();
		};
		sock.on("close", onClose);
		sock.on("error", onClose);
	}

	/** Connects to the running server; undefined when none answers (rejects when the socket path is unusable). */
	static connect(timeoutMs = 1500): Promise<ServerClient | undefined> {
		const { promise, resolve, reject } = Promise.withResolvers<ServerClient | undefined>();
		let socket: string | undefined;
		try {
			socket = serverSocketPath();
		} catch (err) {
			reject(err);
			return promise;
		}
		// Windows with no recorded pipe: no server runs.
		if (socket === undefined) {
			resolve(undefined);
			return promise;
		}
		const sock = net.createConnection(socket);
		const timer = setTimeout(() => {
			sock.destroy();
			resolve(undefined);
		}, timeoutMs);
		sock.once("connect", () => {
			clearTimeout(timer);
			resolve(new ServerClient(sock));
		});
		sock.once("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		return promise;
	}

	request<K extends OpName>(op: K, args: ServerOps[K]["args"], timeoutMs = 120_000): Promise<ServerOps[K]["result"]> {
		const { promise, resolve, reject } = Promise.withResolvers<ServerOps[K]["result"]>();
		const id = ++this.seq;
		if (this.closed) {
			reject(new Error("not connected to the omp-sessions server"));
			return promise;
		}
		const timer = setTimeout(() => {
			if (this.pending.delete(id)) reject(new Error(`the omp-sessions server did not answer ${op}`));
		}, timeoutMs);
		timer.unref();
		this.pending.set(id, res => {
			clearTimeout(timer);
			if (res.ok) resolve(res.result as ServerOps[K]["result"]);
			else reject(new Error(res.error));
		});
		this.sock.write(`${JSON.stringify({ id, op, args })}\n`);
		return promise;
	}

	/** Starts a subscription; events arrive until the connection closes. */
	subscribe(args: SubscribeArgs, onEvent: (ev: ServerEvent) => void): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const id = ++this.seq;
		this.subscriptions.set(id, onEvent);
		this.pending.set(id, res => {
			if (res.ok) resolve();
			else {
				this.subscriptions.delete(id);
				reject(new Error(res.error));
			}
		});
		this.sock.write(`${JSON.stringify({ id, op: "subscribe", args })}\n`);
		return promise;
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		this.sock.end();
		this.sock.destroy();
	}
}

/** The per-user service `omp-sessions server install` sets up: systemd user unit / launchd agent label. */
export const SYSTEMD_UNIT = "omp-sessions.service";
export const LAUNCHD_LABEL = "dev.omp.sessions-server";
export const SERVICE_DESCRIPTION = "omp-sessions server (omp Sessions: queued session launcher)";

/** Where `omp-sessions server install` puts the per-user service (systemd user unit / launchd agent). */
export function serviceUnitPaths(home = os.homedir()): { systemd: string; launchd: string } {
	return {
		systemd: path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT),
		launchd: path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
	};
}

export type ServiceKind = "systemd" | "launchd";

/** The kind of per-user service `server install` sets up here; undefined where there is none (Windows). */
export function serviceKind(platform: NodeJS.Platform = process.platform): ServiceKind | undefined {
	return platform === "linux" ? "systemd" : platform === "darwin" ? "launchd" : undefined;
}

const xmlText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The systemd user unit / launchd agent `omp-sessions server install` writes; `env` entries are `NAME=value`. */
export function serviceUnitText(kind: "systemd" | "launchd", node: string, serverScript: string, env: string[]): string {
	if (kind === "systemd") {
		return [
			"[Unit]",
			`Description=${SERVICE_DESCRIPTION}`,
			// A unit that keeps failing (its node moved) gives up instead of looping; the next client starts the server directly.
			"StartLimitIntervalSec=300",
			"StartLimitBurst=5",
			"",
			"[Service]",
			// exec: `systemctl start` fails when the binary is missing, instead of reporting success.
			"Type=exec",
			`ExecStart=${JSON.stringify(node)} ${JSON.stringify(serverScript)}`,
			...env.map(e => `Environment=${JSON.stringify(e)}`),
			// Crashes and fatal errors restart it; a clean exit is deliberate (`server stop`, or another server owns the socket).
			"Restart=on-failure",
			"RestartSec=5",
			"",
			"[Install]",
			"WantedBy=default.target",
			"",
		].join("\n");
	}
	const envXml = env.map(e => {
		const i = e.indexOf("=");
		return `\t\t<key>${xmlText(e.slice(0, i))}</key><string>${xmlText(e.slice(i + 1))}</string>`;
	});
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key><array><string>${xmlText(node)}</string><string>${xmlText(serverScript)}</string></array>
	<key>EnvironmentVariables</key><dict>
${envXml.join("\n")}
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`;
}

/**
 * Whether an installed unit serves this state folder: `omp-sessions server install` records OMP_VSCODE_HOME
 * (`Environment="OMP_VSCODE_HOME=…"` for systemd, `<key>OMP_VSCODE_HOME</key><string>…</string>` for
 * launchd) only when it is set; a unit without it serves the default folder.
 */
export function serviceServesHome(unitText: string, kind: "systemd" | "launchd", home: string | undefined): boolean {
	const key = kind === "systemd" ? "OMP_VSCODE_HOME=" : "<key>OMP_VSCODE_HOME</key>";
	if (!home) return !unitText.includes(key);
	return unitText.includes(kind === "systemd" ? `${key}${home}"` : `${key}<string>${xmlText(home)}</string>`);
}

/** An installed service unit and what it runs (as serviceUnitText wrote it). */
export interface ServiceUnit {
	kind: ServiceKind;
	file: string;
	text: string;
	node?: string;
	script?: string;
	/** OMP_VSCODE_HOME it sets (none: the default data home). */
	home?: string;
}

function unescapeXml(s: string): string {
	return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function jsonString(s: string | undefined): string | undefined {
	if (s === undefined) return undefined;
	try {
		const v: unknown = JSON.parse(s);
		return typeof v === "string" ? v : undefined;
	} catch {
		return undefined;
	}
}

/** The service unit installed on this platform, undefined when there is none. */
export function readServiceUnit(home = os.homedir()): ServiceUnit | undefined {
	const kind = serviceKind();
	if (!kind) return undefined;
	const file = serviceUnitPaths(home)[kind];
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const unit: ServiceUnit = { kind, file, text };
	if (kind === "systemd") {
		// serviceUnitText JSON-quotes every value.
		for (const line of text.split("\n")) {
			const exec = /^ExecStart=("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(line);
			if (exec) Object.assign(unit, { node: jsonString(exec[1]), script: jsonString(exec[2]) });
			const env = line.startsWith("Environment=") ? jsonString(line.slice("Environment=".length)) : undefined;
			if (env?.startsWith("OMP_VSCODE_HOME=")) unit.home = env.slice("OMP_VSCODE_HOME=".length);
		}
	} else {
		const served = /<key>OMP_VSCODE_HOME<\/key><string>([^<]*)<\/string>/.exec(text)?.[1];
		const program = /<key>ProgramArguments<\/key><array><string>([^<]*)<\/string><string>([^<]*)<\/string>/.exec(text);
		if (served !== undefined) unit.home = unescapeXml(served);
		if (program) Object.assign(unit, { node: unescapeXml(program[1]), script: unescapeXml(program[2]) });
	}
	return unit;
}

/** Runs systemctl/launchctl; true when it exited 0. */
export type ServiceExec = (cmd: string, argv: string[]) => boolean;

const quietExec: ServiceExec = (cmd, argv) => spawnSync(cmd, argv, { stdio: "ignore", timeout: 60_000 }).status === 0;

/**
 * Writes our service unit and enables + starts it. A running server is stopped first (the service's
 * server would find it on the socket and exit; sessions keep running). False when systemctl/launchctl
 * failed: the unit is written, the caller says how to load it.
 */
export async function installServiceUnit(kind: "systemd" | "launchd", text: string, home = os.homedir(), exec: ServiceExec = quietExec): Promise<boolean> {
	const file = serviceUnitPaths(home)[kind];
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	await stopServer();
	if (kind === "systemd") return exec("systemctl", ["--user", "daemon-reload"]) && exec("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
	// Reinstalling: a loaded agent refuses a second load and would keep the old plist, so unload it first.
	const domain = `gui/${os.userInfo().uid}`;
	quietExec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
	return exec("launchctl", ["bootstrap", domain, file]);
}

/** Stops, disables and deletes a service unit (`name`: the systemd unit or launchd label). */
export function removeServiceUnit(kind: "systemd" | "launchd", file: string, name: string, exec: ServiceExec = quietExec): void {
	if (kind === "systemd") exec("systemctl", ["--user", "disable", "--now", name]);
	else quietExec("launchctl", ["bootout", `gui/${os.userInfo().uid}/${name}`]);
	fs.rmSync(file, { force: true });
	if (kind === "systemd") exec("systemctl", ["--user", "daemon-reload"]);
}

/** What installing the per-user service did: `ok` false when systemctl/launchctl failed (the unit is written). */
export interface ServiceInstall {
	kind: ServiceKind;
	file: string;
	ok: boolean;
}

/**
 * Installs (or rewrites) the per-user service that runs `serverScript` with `nodePath` for this
 * state folder, and starts it. Undefined where there is no per-user service (Windows).
 */
export async function installUserService(serverScript: string, nodePath = process.execPath, exec: ServiceExec = quietExec): Promise<ServiceInstall | undefined> {
	const kind = serviceKind();
	if (!kind) return undefined;
	const env = ["ELECTRON_RUN_AS_NODE=1", ...(process.env.OMP_VSCODE_HOME ? [`OMP_VSCODE_HOME=${process.env.OMP_VSCODE_HOME}`] : []), `PATH=${uniquePath(process.env.PATH ?? "")}`];
	const ok = await installServiceUnit(kind, serviceUnitText(kind, nodePath, serverScript, env), undefined, exec);
	return { kind, file: serviceUnitPaths()[kind], ok };
}

/** PATH without repeated or empty entries (shells that re-export it pile up duplicates). */
export function uniquePath(value: string): string {
	return [...new Set(value.split(path.delimiter).filter(Boolean))].join(path.delimiter);
}

/** Why an on-demand start won't install the service by itself (undefined: it does when none is installed). */
export function autoInstallBlocker(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (!serviceKind()) return "no per-user service on this platform";
	if (env.OMP_SESSIONS_NO_SERVICE) return "OMP_SESSIONS_NO_SERVICE is set";
	// The unit name is per user: tests and other data homes never take it.
	if (path.resolve(stateRoot()) !== path.join(os.homedir(), ".omp", "vscode")) return "not the default data home";
	if (readLauncherSettings().service === "off") return "service off";
	return undefined;
}

/** Runs `fn` holding the service-install lock; undefined when another process holds it. */
async function withInstallLock<T>(fn: () => Promise<T | undefined>): Promise<T | undefined> {
	const lock = path.join(stateRoot(), "service-install.lock");
	if (!claimLock(lock)) return undefined;
	try {
		return await fn();
	} finally {
		releaseLock(lock);
	}
}

/**
 * The first on-demand start installs the per-user service, so the server comes back after reboots
 * and crashes. Never when: a unit exists already (never replaced; an old `omp-vs` one is migrated
 * instead), autoInstallBlocker says no, or another process is installing it right now. Undefined
 * when nothing was installed.
 */
async function autoInstallService(serverScript: string, nodePath: string, newUnit: boolean): Promise<ServiceInstall | undefined> {
	const kind = serviceKind();
	if (!kind || autoInstallBlocker()) return undefined;
	return withInstallLock(async () => {
		// What 0.5.0 and earlier installed goes first: the old unit is moved over to the new name.
		const migrated = await migrateLegacyService();
		if (migrated) return { kind, file: migrated.to, ok: migrated.started };
		if (!newUnit || fs.existsSync(serviceUnitPaths()[kind])) return undefined;
		return installUserService(serverScript, nodePath);
	});
}

/**
 * A unit serving this data home whose node or server.js is gone (VS Code's versioned runtime after an
 * update, a moved install) is rewritten to run `serverScript` with `nodePath`, so the server comes
 * back at the next login and after crashes. Undefined when nothing needed it.
 */
async function repairServiceUnit(serverScript: string, nodePath: string): Promise<ServiceInstall | undefined> {
	if (process.env.OMP_SESSIONS_NO_SERVICE) return undefined;
	const unit = readServiceUnit();
	if (!unit?.node || !unit.script || !serviceServesHome(unit.text, unit.kind, process.env.OMP_VSCODE_HOME)) return undefined;
	if (fs.existsSync(unit.node) && fs.existsSync(unit.script)) return undefined;
	return withInstallLock(() => installUserService(serverScript, nodePath));
}

/**
 * Starts the installed service instead of a detached process, so the server stays supervised (restarted
 * on failure, started at login) after the CLI or the extension stopped it for an upgrade. False when no
 * service is installed or starting it failed (the caller then spawns the server itself).
 */
function startService(): boolean {
	const { systemd, launchd } = serviceUnitPaths();
	const quiet = { stdio: "ignore" as const, timeout: 10_000 };
	try {
		if (process.platform === "linux" && fs.existsSync(systemd) && serviceServesHome(fs.readFileSync(systemd, "utf8"), "systemd", process.env.OMP_VSCODE_HOME)) {
			return spawnSync("systemctl", ["--user", "start", SYSTEMD_UNIT], quiet).status === 0;
		}
		if (process.platform === "darwin" && fs.existsSync(launchd) && serviceServesHome(fs.readFileSync(launchd, "utf8"), "launchd", process.env.OMP_VSCODE_HOME)) {
			return spawnSync("launchctl", ["kickstart", `gui/${os.userInfo().uid}/${LAUNCHD_LABEL}`], quiet).status === 0;
		}
	} catch {
		/* unreadable unit: spawn instead */
	}
	return false;
}

/** Spawns the server detached (it exits by itself if another one already runs). */
function spawnDetached(serverScript: string, nodePath: string): void {
	const child = spawn(nodePath, [serverScript], {
		cwd: os.homedir(),
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	child.on("error", () => {});
	child.unref();
}

/** How long a started service may take to listen before the server is spawned directly instead. */
const SERVICE_GRACE_MS = 2000;

export interface EnsureServerOptions {
	/** This start installed the per-user service (once per machine, see autoInstallService): tell the user. */
	onServiceInstalled?: (install: ServiceInstall) => void;
	/** This start rewrote a unit whose node or server.js was gone (repairServiceUnit). */
	onServiceRepaired?: (install: ServiceInstall) => void;
	/**
	 * False: `nodePath` may vanish (VS Code's own versioned runtime), so no new unit is written for it.
	 * A broken unit is still re-pointed at it (it works at least until the next update).
	 */
	installService?: boolean;
}

/**
 * Connects to the server, starting it when none runs (through its service when one is installed, else
 * detached); undefined when it does not come up. A service that "started" but doesn't listen (its unit
 * points at a node that moved) falls back to a direct spawn, so a stale unit never keeps the server down;
 * such a unit is rewritten first, even while a server runs (it wouldn't come back after a reboot).
 */
export async function ensureServer(serverScript: string, nodePath = process.execPath, timeoutMs = 6000, opts: EnsureServerOptions = {}): Promise<ServerClient | undefined> {
	fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
	let repaired: ServiceInstall | undefined;
	try {
		repaired = await repairServiceUnit(serverScript, nodePath);
	} catch {
		/* unit not rewritable: the server below still runs */
	}
	if (repaired) opts.onServiceRepaired?.(repaired);
	const existing = await ServerClient.connect();
	if (existing) return existing;
	try {
		const installed = repaired ? undefined : await autoInstallService(serverScript, nodePath, opts.installService !== false);
		if (installed) opts.onServiceInstalled?.(installed);
	} catch {
		/* no service: the detached server below still runs */
	}
	const start = Date.now();
	let direct = !startService();
	if (direct) spawnDetached(serverScript, nodePath);
	while (Date.now() - start < timeoutMs) {
		await sleep(150);
		const client = await ServerClient.connect(500);
		if (client) return client;
		if (!direct && Date.now() - start > SERVICE_GRACE_MS) {
			direct = true;
			spawnDetached(serverScript, nodePath);
		}
	}
	return undefined;
}

/** Asks the running server to exit and waits until its socket is gone. */
export async function stopServer(timeoutMs = 5000): Promise<boolean> {
	const client = await ServerClient.connect();
	if (!client) return false;
	try {
		await client.request("shutdown", {}, 3000);
	} catch {
		/* closed while answering */
	}
	client.close();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const again = await ServerClient.connect(300);
		if (!again) return true;
		again.close();
		await sleep(100);
	}
	return false;
}

/** -1 / 0 / 1 for dotted numeric versions (pre-release suffixes ignored). */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.+-]/).map(n => Number.parseInt(n, 10) || 0);
	const pb = b.split(/[.+-]/).map(n => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d < 0 ? -1 : 1;
	}
	return 0;
}

export function readServerLog(maxBytes = 64 * 1024): string {
	try {
		const fd = fs.openSync(serverLogPath(), "r");
		try {
			const size = fs.fstatSync(fd).size;
			const len = Math.min(size, maxBytes);
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, size - len);
			return buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}
