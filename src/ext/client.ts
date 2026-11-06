import * as net from "node:net";
import * as readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import type { ClientToHost, HostToClient, OmpFrame } from "../shared/protocol";

/** Socket connection to one session host; reconnects until disposed or the host is gone. */
export class HostClient implements vscode.Disposable {
	private sock: net.Socket | undefined;
	private disposed = false;
	private seq = 0;
	private readonly pending = new Map<string, (res: OmpFrame) => void>();
	private readonly messageEmitter = new vscode.EventEmitter<HostToClient>();
	readonly onMessage = this.messageEmitter.event;
	private readonly connEmitter = new vscode.EventEmitter<boolean>();
	readonly onConnection = this.connEmitter.event;
	connected = false;

	constructor(
		private readonly socketPath: string,
		private readonly clientName: string,
		private readonly canReconnect: () => boolean,
	) {
		void this.connectLoop();
	}

	private async connectLoop(): Promise<void> {
		let delay = 250;
		while (!this.disposed) {
			const ok = await this.connectOnce();
			if (this.disposed) return;
			if (ok) delay = 250;
			if (!this.canReconnect()) return;
			await sleep(delay);
			delay = Math.min(delay * 2, 3000);
		}
	}

	/** Resolves when the connection closes; true if it had connected. */
	private connectOnce(): Promise<boolean> {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let opened = false;
		const sock = net.createConnection(this.socketPath);
		sock.on("connect", () => {
			opened = true;
			this.sock = sock;
			this.connected = true;
			this.write({ t: "hello", client: this.clientName });
			this.connEmitter.fire(true);
		});
		readline.createInterface({ input: sock, crlfDelay: Infinity }).on("line", line => {
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
			this.messageEmitter.fire(msg);
		});
		const closed = () => {
			if (this.sock === sock) {
				this.sock = undefined;
				if (this.connected) {
					this.connected = false;
					this.connEmitter.fire(false);
				}
			}
			resolve(opened);
		};
		sock.on("error", closed);
		sock.on("close", closed);
		return promise;
	}

	write(msg: ClientToHost): boolean {
		if (!this.sock || this.sock.destroyed) return false;
		this.sock.write(`${JSON.stringify(msg)}\n`);
		return true;
	}

	/** Send an omp RPC command; resolves with its response frame. */
	rpc(cmd: { type: string; [k: string]: unknown }, timeoutMs = 60000): Promise<OmpFrame> {
		const id = `v${++this.seq}`;
		const { promise, resolve } = Promise.withResolvers<OmpFrame>();
		if (!this.write({ t: "rpc", cmd: { ...cmd, id } })) {
			resolve({ type: "response", command: cmd.type, success: false, error: "Not connected to session host" });
			return promise;
		}
		this.pending.set(id, resolve);
		setTimeout(() => {
			if (!this.pending.delete(id)) return;
			resolve({ type: "response", command: cmd.type, success: false, error: "Timed out waiting for omp" });
		}, timeoutMs);
		return promise;
	}

	dispose(): void {
		this.disposed = true;
		this.sock?.destroy();
		this.messageEmitter.dispose();
		this.connEmitter.dispose();
	}
}
