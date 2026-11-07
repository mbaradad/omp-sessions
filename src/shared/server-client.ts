// Client side of the omp-vs server protocol (CLI and extension) and starting the server on
// demand. Node-only; no vscode import.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { stateRoot } from "./protocol";
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
			for (const [id, done] of this.pending) done({ id, ok: false, error: "the omp-vs server closed the connection" });
			this.pending.clear();
			for (const l of [...this.closeListeners]) l();
		};
		sock.on("close", onClose);
		sock.on("error", onClose);
	}

	/** Connects to the running server; undefined when none answers. */
	static connect(timeoutMs = 1500): Promise<ServerClient | undefined> {
		const { promise, resolve } = Promise.withResolvers<ServerClient | undefined>();
		const sock = net.createConnection(serverSocketPath());
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
			reject(new Error("not connected to the omp-vs server"));
			return promise;
		}
		const timer = setTimeout(() => {
			if (this.pending.delete(id)) reject(new Error(`the omp-vs server did not answer ${op}`));
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

/** Where `omp-vs server install` puts the per-user service (systemd user unit / launchd agent). */
export function serviceUnitPaths(home = os.homedir()): { systemd: string; launchd: string } {
	return {
		systemd: path.join(home, ".config", "systemd", "user", "omp-vs.service"),
		launchd: path.join(home, "Library", "LaunchAgents", "dev.omp.vs-server.plist"),
	};
}

export const LAUNCHD_LABEL = "dev.omp.vs-server";

const xmlText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The systemd user unit / launchd agent `omp-vs server install` writes; `env` entries are `NAME=value`. */
export function serviceUnitText(kind: "systemd" | "launchd", node: string, serverScript: string, env: string[]): string {
	if (kind === "systemd") {
		return [
			"[Unit]",
			"Description=omp-vs server (omp Sessions: queued session launcher)",
			"",
			"[Service]",
			// exec: `systemctl start` fails when the binary is missing, instead of reporting success.
			"Type=exec",
			`ExecStart=${JSON.stringify(node)} ${JSON.stringify(serverScript)}`,
			...env.map(e => `Environment=${JSON.stringify(e)}`),
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
 * Whether an installed unit serves this state folder: `omp-vs server install` records OMP_VSCODE_HOME
 * (`Environment="OMP_VSCODE_HOME=…"` for systemd, `<key>OMP_VSCODE_HOME</key><string>…</string>` for
 * launchd) only when it is set; a unit without it serves the default folder.
 */
export function serviceServesHome(unitText: string, kind: "systemd" | "launchd", home: string | undefined): boolean {
	const key = kind === "systemd" ? "OMP_VSCODE_HOME=" : "<key>OMP_VSCODE_HOME</key>";
	if (!home) return !unitText.includes(key);
	return unitText.includes(kind === "systemd" ? `${key}${home}"` : `${key}<string>${xmlText(home)}</string>`);
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
			return spawnSync("systemctl", ["--user", "start", "omp-vs.service"], quiet).status === 0;
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

/**
 * Connects to the server, starting it when none runs (through its service when one is installed, else
 * detached); undefined when it does not come up. A service that "started" but doesn't listen (its unit
 * points at a node that moved) falls back to a direct spawn, so a stale unit never keeps the server down.
 */
export async function ensureServer(serverScript: string, nodePath = process.execPath, timeoutMs = 6000): Promise<ServerClient | undefined> {
	const existing = await ServerClient.connect();
	if (existing) return existing;
	fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
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
