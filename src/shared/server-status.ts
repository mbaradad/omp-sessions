// The machine overview behind `omp-sessions status` and `GET /api/status`: the server, its service,
// the omp it launches, sessions by state, queued work, the scheduler and remote access, plus the
// problems that keep it from working. Built by the server (`status` op) or, when none runs, by the CLI
// from the same files. Node-only.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findOmp, readLauncherSettings } from "./launch";
import { stateRoot } from "./protocol";
import { type RemoteConfig, type RemoteStatus, trustsProxy } from "./remote";
import { type ServiceKind, autoInstallBlocker, readServiceUnit, serviceKind, serviceServesHome } from "./server-client";
import { type SchedulerStatus, type SessionInfo, serverLogPath, serverSocketPath } from "./server-protocol";
import { agentState } from "./session-report";

export interface ServerState {
	running: boolean;
	pid?: number;
	version?: string;
	startedAt?: number;
	/** Absent on Windows while no server has recorded its pipe. */
	socket?: string;
	log: string;
}

export interface ServiceState {
	/** The kind `server install` sets up here (null: none on this platform, e.g. Windows). */
	kind: ServiceKind | null;
	installed: boolean;
	/** An on-demand start installs the service when none is (else `noAutoInstall` says why not). */
	autoInstall?: boolean;
	noAutoInstall?: string;
	file?: string;
	/** The data home the installed service serves. */
	home?: string;
	servesThisHome?: boolean;
	/** The node the service runs, and whether it still exists (VS Code's own runtime goes away with updates). */
	node?: string;
	nodeExists?: boolean;
	/** server.js the service runs, and whether it still exists. */
	script?: string;
	scriptExists?: boolean;
}

export interface OmpState {
	/** `omp.path` from launcher.json (`omp-sessions config set omp.path`, or VS Code's setting). */
	configured?: string;
	/** The executable sessions start with. */
	path?: string;
	extraArgs: string[];
	error?: string;
	/** The server's last failure to start a session (recent ones only). */
	launchError?: string;
	/** The omp Sessions default model of new sessions (`config set model`); unset: omp's own default. */
	defaultModel?: string;
}

export interface RemoteState extends RemoteStatus {
	/** The public URL is https: the pairing cookie is `Secure`. */
	https: boolean;
	/** Lockouts follow the proxy's X-Forwarded-For (public URL set and bound to loopback). */
	trustedProxy: boolean;
	tokenSet: boolean;
}

export interface MachineStatus {
	/** False when something keeps sessions from starting or remote access from working (`problems`). */
	ok: boolean;
	problems: string[];
	home: string;
	server: ServerState;
	service: ServiceState;
	omp: OmpState;
	/** Every session (archived ones too) by `show`'s state. */
	sessions: { total: number; archived: number; byState: Record<string, number> };
	/** Queued tasks over all sessions. */
	tasks: { pending: number; running: number };
	scheduler: SchedulerStatus;
	remote: RemoteState;
}

/** What `omp-sessions server install` set up here, and whether it serves this data home and can still run. */
export function serviceState(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): ServiceState {
	const kind = serviceKind();
	if (!kind) return { kind: null, installed: false };
	const unit = readServiceUnit(home);
	if (!unit) return { kind, installed: false };
	return {
		kind,
		installed: true,
		file: unit.file,
		home: unit.home ?? path.join(home, ".omp", "vscode"),
		servesThisHome: serviceServesHome(unit.text, kind, env.OMP_VSCODE_HOME),
		...(unit.node !== undefined ? { node: unit.node, nodeExists: fs.existsSync(unit.node) } : {}),
		...(unit.script !== undefined ? { script: unit.script, scriptExists: fs.existsSync(unit.script) } : {}),
	};
}

function executable(file: string): boolean {
	try {
		fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** The omp executable sessions start with (launcher.json, else PATH and the usual folders), or why there is none. */
export function ompState(): OmpState {
	const { ompPath, extraArgs = [] } = readLauncherSettings();
	const fix = "install omp, or run: omp-sessions config set omp.path <path to omp>";
	if (!ompPath) {
		const found = findOmp();
		return found ? { path: found, extraArgs } : { extraArgs, error: `omp is not on PATH or in the usual install folders (${fix})` };
	}
	const resolved = findOmp(ompPath) ?? ompPath;
	if (!/[\\/]/.test(resolved)) {
		const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
		const names = process.platform === "win32" ? [resolved, `${resolved}.exe`, `${resolved}.cmd`] : [resolved];
		const hit = dirs.flatMap(d => names.map(n => path.join(d, n))).find(executable);
		return hit ? { configured: ompPath, path: hit, extraArgs } : { configured: ompPath, extraArgs, error: `omp.path "${ompPath}" is not on PATH (${fix})` };
	}
	if (!path.isAbsolute(resolved)) return { configured: ompPath, extraArgs, error: `omp.path "${ompPath}" is relative; set an absolute path (omp-sessions config set omp.path <path>)` };
	return executable(resolved) ? { configured: ompPath, path: resolved, extraArgs } : { configured: ompPath, extraArgs, error: `omp.path ${resolved} is not an executable file (${fix})` };
}

export interface StatusInput {
	server: { pid: number; version: string; startedAt: number } | undefined;
	infos: readonly SessionInfo[];
	scheduler: SchedulerStatus;
	remote: RemoteStatus;
	remoteConfig: RemoteConfig;
	/** The server's last launcher error, when recent. */
	launchError?: string;
}

export function machineStatus(input: StatusInput): MachineStatus {
	const { server, infos, scheduler, remote, remoteConfig } = input;
	const byState: Record<string, number> = {};
	let pending = 0;
	let running = 0;
	for (const info of infos) {
		const state = agentState(info);
		byState[state] = (byState[state] ?? 0) + 1;
		pending += info.queue.pending;
		running += info.queue.running;
	}
	const settings = readLauncherSettings();
	const omp: OmpState = { ...ompState(), ...(input.launchError ? { launchError: input.launchError } : {}), ...(settings.model ? { defaultModel: settings.model } : {}) };
	const blocker = autoInstallBlocker();
	const service: ServiceState = { ...serviceState(), autoInstall: !blocker, ...(blocker ? { noAutoInstall: blocker } : {}) };
	const problems: string[] = [];
	if (!server) problems.push("the server is not running: queued and scheduled sessions won't start until a command starts it (omp-sessions server start)");
	if (omp.error) problems.push(omp.error);
	else if (omp.launchError) problems.push(`starting sessions failed: ${omp.launchError}`);
	if (server && remote.enabled && !remote.listening) problems.push(`remote access is on but not listening${remote.error ? `: ${remote.error}` : ""}`);
	if (service.installed && service.servesThisHome) {
		const gone = [service.nodeExists === false ? service.node : undefined, service.scriptExists === false ? service.script : undefined].filter(Boolean);
		if (gone.length) problems.push(`the installed service runs ${gone.join(" and ")}, which no longer exist${gone.length === 1 ? "s" : ""}: it won't start at login (the next omp-sessions command or VS Code window rewrites it; or omp-sessions server install)`);
	}
	const publicUrl = remoteConfig.publicUrl;
	return {
		ok: problems.length === 0,
		problems,
		home: stateRoot(),
		server: { running: !!server, ...(server ? { pid: server.pid, version: server.version, startedAt: server.startedAt } : {}), socket: serverSocketPath(), log: serverLogPath() },
		service,
		omp,
		sessions: { total: infos.length, archived: infos.filter(i => i.archived).length, byState },
		tasks: { pending, running },
		scheduler,
		remote: { ...remote, https: !!publicUrl?.startsWith("https:"), trustedProxy: trustsProxy(remoteConfig, remote.listening?.host), tokenSet: !!remoteConfig.token },
	};
}
