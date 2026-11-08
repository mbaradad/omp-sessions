// One socket connection to a session host, without reconnects: used by the omp-sessions server and
// CLI (the extension has its own reconnecting HostClient). Node-only; no vscode import.
import * as net from "node:net";
import * as readline from "node:readline";
import type { ClientToHost, HostToClient, OmpFrame, SessionMeta } from "./protocol";

export type Snapshot = Extract<HostToClient, { t: "snapshot" }>;

export class HostConnection {
	private seq = 0;
	private readonly pending = new Map<string, (res: OmpFrame) => void>();
	private readonly listeners = new Set<(msg: HostToClient) => void>();
	private readonly closeListeners = new Set<() => void>();
	closed = false;

	private constructor(private readonly sock: net.Socket) {
		const rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
		rl.on("error", () => {});
		rl.on("line", line => {
			if (!line) return;
			let msg: HostToClient;
			try {
				msg = JSON.parse(line) as HostToClient;
			} catch {
				return;
			}
			if (msg.t === "response" && typeof msg.res.id === "string") {
				const done = this.pending.get(msg.res.id);
				if (done) {
					this.pending.delete(msg.res.id);
					done(msg.res);
				}
			}
			for (const l of [...this.listeners]) l(msg);
		});
		const onClose = () => {
			if (this.closed) return;
			this.closed = true;
			for (const [id, done] of this.pending) done({ type: "response", id, success: false, error: "The session host closed the connection" });
			this.pending.clear();
			for (const l of [...this.closeListeners]) l();
		};
		sock.on("close", onClose);
		sock.on("error", onClose);
	}

	/**
	 * Connects, says hello as `client` and resolves with the host's snapshot. Clients named
	 * `omp-sessions-server…` don't count as people viewing the session (`meta.viewers`).
	 */
	static open(socket: string, client: string, timeoutMs = 5000): Promise<{ conn: HostConnection; snapshot: Snapshot }> {
		const { promise, resolve, reject } = Promise.withResolvers<{ conn: HostConnection; snapshot: Snapshot }>();
		const sock = net.createConnection(socket);
		const conn = new HostConnection(sock);
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("timed out connecting to the session host"));
		}, timeoutMs);
		const off = conn.onMessage(msg => {
			if (msg.t !== "snapshot") return;
			off();
			clearTimeout(timer);
			resolve({ conn, snapshot: msg });
		});
		sock.on("connect", () => conn.write({ t: "hello", client }));
		conn.onClose(() => {
			clearTimeout(timer);
			reject(new Error("could not connect to the session host"));
		});
		return promise;
	}

	onMessage(listener: (msg: HostToClient) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	write(msg: ClientToHost): boolean {
		if (this.closed || this.sock.destroyed) return false;
		this.sock.write(`${JSON.stringify(msg)}\n`);
		return true;
	}

	/** Sends an omp RPC command; resolves with its response frame (failure frame on timeout/close). */
	rpc(cmd: { type: string; [k: string]: unknown }, timeoutMs = 30000): Promise<OmpFrame> {
		const id = `s${++this.seq}`;
		const { promise, resolve } = Promise.withResolvers<OmpFrame>();
		if (!this.write({ t: "rpc", cmd: { ...cmd, id } })) {
			resolve({ type: "response", command: cmd.type, success: false, error: "Not connected to the session host" });
			return promise;
		}
		this.pending.set(id, resolve);
		setTimeout(() => {
			if (!this.pending.delete(id)) return;
			resolve({ type: "response", command: cmd.type, success: false, error: "Timed out waiting for omp" });
		}, timeoutMs).unref();
		return promise;
	}

	close(): void {
		this.sock.end();
		setTimeout(() => this.sock.destroy(), 500).unref();
	}
}

/** Whether omp is mid-turn according to a snapshot/meta (prompts then need a streaming behavior). */
export function isBusy(meta: SessionMeta, state: unknown): boolean {
	if (meta.status === "working" || meta.status === "waiting") return true;
	return !!state && typeof state === "object" && "isStreaming" in state && state.isStreaming === true;
}
