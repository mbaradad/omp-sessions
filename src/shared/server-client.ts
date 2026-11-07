// Client side of the omp-vs server protocol (CLI and extension) and starting the server on
// demand. Node-only; no vscode import.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
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

/** Spawns the server detached (it exits by itself if another one already runs). */
export function spawnServer(serverScript: string, nodePath = process.execPath): void {
	fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
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

/** Connects to the server, starting it when none runs; undefined when it does not come up. */
export async function ensureServer(serverScript: string, nodePath = process.execPath, timeoutMs = 6000): Promise<ServerClient | undefined> {
	const existing = await ServerClient.connect();
	if (existing) return existing;
	spawnServer(serverScript, nodePath);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(150);
		const client = await ServerClient.connect(500);
		if (client) return client;
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
