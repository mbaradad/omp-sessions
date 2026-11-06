// Starting session hosts, shared by the VS Code extension, the `omp-vs` server and the `omp-vs`
// CLI so that every launcher spawns hosts with the same argv, environment and launch.json
// semantics. Also the small socket/process probes all of them need. Node-only (no vscode).
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { needsRestore, settleDeadHost } from "./health";
import { type ClientToHost, type SessionMeta, sessionDir, sessionsRoot, stateRoot } from "./protocol";
import { type SessionToggles, newSessionLaunch, readLaunchArgs, writeSessionToggles } from "./session-config";

/** Options for starting (or resuming, with `id`) a background session. */
export interface LaunchOptions {
	cwd: string;
	/** Resume this existing session id instead of creating a new one. */
	id?: string;
	/** omp transcript (.jsonl) to resume. */
	resumeFile?: string;
	/** Resume with `omp --restore` (continue the interrupted turn and its subagents). Default: only after a host crash mid-turn. */
	restore?: boolean;
	title?: string;
	goal?: string;
	ompArgs?: string[];
	/** Per-session skill/tool/MCP toggles (new sessions default to the project's saved defaults). */
	toggles?: SessionToggles;
	/** Who started the host (recorded as `meta.launchedBy`), e.g. "scheduler". */
	launchedBy?: string;
}

/** How hosts get started: the same for every launcher apart from where omp/host.js live. */
export interface HostLauncher {
	/** host.js to run. */
	hostScript: string;
	/** omp executable. */
	omp: string;
	/** Version recorded by the host (`meta.hostVersion`), for upgrade checks. */
	hostVersion: string;
	/** omp arguments for new sessions (the `omp.extraArgs` setting). */
	extraArgs: string[];
	/** Runtime for host.js; default this process's (node, or Electron with ELECTRON_RUN_AS_NODE). */
	nodePath?: string;
	/** The launcher process could not be spawned. */
	onError?: (err: Error) => void;
}

export function newSessionId(): string {
	return `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A session's meta.json as it really is (a dead host means stopped); undefined when unreadable. */
export function readMeta(id: string): SessionMeta | undefined {
	let meta: SessionMeta;
	try {
		meta = JSON.parse(fs.readFileSync(path.join(sessionDir(id), "meta.json"), "utf8")) as SessionMeta;
	} catch {
		return undefined;
	}
	return meta.status === "stopped" ? meta : settleDeadHost(meta, pidAlive(meta.pid));
}

/** Every session on disk (dead hosts settled to stopped). */
export function listMetas(): SessionMeta[] {
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(sessionsRoot());
	} catch {
		return [];
	}
	const out: SessionMeta[] = [];
	for (const id of entries) {
		const meta = readMeta(id);
		if (meta) out.push(meta);
	}
	return out;
}

/** Version from the package.json next to host.js (installed copies) or one level up (the extension's out/). */
export function readHostVersion(hostScript: string): string {
	const dir = path.dirname(hostScript);
	for (const file of [path.join(dir, "package.json"), path.join(dir, "..", "package.json")]) {
		try {
			const pkg: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
			if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") return pkg.version;
		} catch {
			/* not packaged here */
		}
	}
	return "unknown";
}

// ---------- launcher settings (mirrored by the extension for the CLI/server) ----------

/** `omp.path` / `omp.extraArgs` as last seen by the extension, so terminal launches match VS Code's. */
export interface LauncherSettings {
	ompPath?: string;
	extraArgs?: string[];
}

export function launcherSettingsPath(): string {
	return path.join(stateRoot(), "launcher.json");
}

export function readLauncherSettings(): LauncherSettings {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(launcherSettingsPath(), "utf8"));
		if (!raw || typeof raw !== "object") return {};
		const out: LauncherSettings = {};
		if ("ompPath" in raw && typeof raw.ompPath === "string" && raw.ompPath.trim()) out.ompPath = raw.ompPath.trim();
		if ("extraArgs" in raw && Array.isArray(raw.extraArgs)) out.extraArgs = raw.extraArgs.filter((a): a is string => typeof a === "string");
		return out;
	} catch {
		return {};
	}
}

export function writeLauncherSettings(settings: LauncherSettings): void {
	const file = launcherSettingsPath();
	const text = JSON.stringify(settings, null, 1);
	try {
		if (fs.readFileSync(file, "utf8") === text) return;
	} catch {
		/* first write */
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}

/** Finds the omp executable: explicit path, PATH, then common install locations. */
export function findOmp(configured?: string): string | undefined {
	const explicit = configured?.trim();
	if (explicit) return explicit.startsWith("~/") ? path.join(os.homedir(), explicit.slice(2)) : explicit;
	const dirs = (process.env.PATH ?? "").split(path.delimiter);
	dirs.push(path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
	if (process.platform === "win32" && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
	const names = process.platform === "win32" ? ["omp.exe", "omp.cmd", "omp.bat", "omp"] : ["omp"];
	for (const d of dirs) {
		if (!d) continue;
		for (const name of names) {
			const candidate = path.join(d, name);
			try {
				fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
				return candidate;
			} catch {
				/* keep looking */
			}
		}
	}
	return undefined;
}

// ---------- launching ----------

/**
 * Launches a detached host and returns the session id. Reusing an existing id resumes that
 * session's omp transcript with the omp arguments it was created with (persisted in `launch.json`).
 */
export function launchHost(launcher: HostLauncher, opts: LaunchOptions): string {
	const id = opts.id ?? newSessionId();
	const launchFile = path.join(sessionDir(id), "launch.json");
	let ompArgs = opts.ompArgs ?? (opts.id ? readLaunchArgs(opts.id) : undefined);
	let toggles = opts.toggles;
	if (!ompArgs) {
		if (!opts.id) {
			// New sessions start from the project's saved defaults (flags and toggles).
			const defaults = newSessionLaunch(opts.cwd, launcher.extraArgs);
			ompArgs = defaults.ompArgs;
			toggles ??= defaults.toggles;
		} else ompArgs = launcher.extraArgs;
	}
	const argv = [launcher.hostScript, "--daemonize", "--id", id, "--cwd", opts.cwd, "--omp", launcher.omp, "--host-version", launcher.hostVersion];
	const previous = opts.id ? readMeta(opts.id) : undefined;
	// After a host crash mid-turn, resuming also continues that turn and its subagents.
	const restore = opts.restore ?? (previous ? needsRestore(previous) : false);
	if (opts.resumeFile) argv.push(opts.restore ? "--restore" : "--resume", opts.resumeFile);
	else if (restore && previous?.ompSessionFile) argv.push("--restore", previous.ompSessionFile);
	if (opts.title) argv.push("--title", opts.title);
	if (opts.goal) argv.push("--goal", opts.goal);
	if (opts.launchedBy) argv.push("--launched-by", opts.launchedBy);
	for (const a of ompArgs) argv.push("--omp-arg", a);
	fs.mkdirSync(sessionDir(id), { recursive: true, mode: 0o700 });
	fs.writeFileSync(launchFile, JSON.stringify({ ompArgs }));
	if (toggles) writeSessionToggles(id, toggles);
	// The launcher's cwd is irrelevant (the host chdirs omp itself) and must exist.
	const child = spawn(launcher.nodePath ?? process.execPath, argv, {
		cwd: os.homedir(),
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	child.on("error", err => launcher.onError?.(err));
	child.unref();
	return id;
}

// ---------- host sockets ----------

/** Fire-and-forget control message to a running host; false when it is unreachable. */
export function sendToHost(meta: SessionMeta, msg: ClientToHost): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const sock = net.createConnection(meta.socket, () => {
		sock.end(`${JSON.stringify(msg)}\n`);
		resolve(true);
	});
	sock.setTimeout(3000, () => {
		sock.destroy();
		resolve(false);
	});
	sock.on("error", () => resolve(false));
	return promise;
}

export function canConnect(socket: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const sock = net.createConnection(socket, () => {
		sock.destroy();
		resolve(true);
	});
	sock.setTimeout(1000, () => {
		sock.destroy();
		resolve(false);
	});
	sock.on("error", () => resolve(false));
	return promise;
}
