// Socket client for one VS Code window's bridge (used by the MCP server).
import * as net from "node:net";
import { type BridgeEntry, type BridgeRequest, type BridgeResponse, parseResponse, type ToolArgs, type ToolName, type ToolResult } from "../shared/bridge";

export class BridgeConnection {
	private seq = 0;
	private buf = "";
	private readonly pending = new Map<number, { resolve: (r: BridgeResponse) => void; reject: (e: Error) => void }>();
	closed = false;

	private constructor(
		readonly entry: BridgeEntry,
		private readonly sock: net.Socket,
	) {
		sock.setEncoding("utf8");
		sock.on("data", (d: string) => this.onData(d));
		const fail = () => this.close(new Error("VS Code window disconnected"));
		sock.on("close", fail);
		sock.on("error", fail);
	}

	/** Connects and authenticates; rejects within `timeoutMs`. */
	static async open(entry: BridgeEntry, timeoutMs = 2000): Promise<BridgeConnection> {
		const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
		const sock = net.connect(entry.socket);
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("connect timeout"));
		}, timeoutMs);
		sock.once("connect", () => resolve(sock));
		sock.once("error", reject);
		try {
			await promise;
		} finally {
			clearTimeout(timer);
		}
		sock.removeListener("error", reject);
		const conn = new BridgeConnection(entry, sock);
		await conn.request({ id: 0, method: "hello", params: { token: entry.token } }, timeoutMs);
		return conn;
	}

	private onData(d: string): void {
		this.buf += d;
		for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
			const line = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + 1);
			let res: BridgeResponse | undefined;
			try {
				res = parseResponse(JSON.parse(line));
			} catch {
				res = undefined;
			}
			if (!res) continue;
			const p = this.pending.get(res.id);
			this.pending.delete(res.id);
			p?.resolve(res);
		}
	}

	private async request(req: BridgeRequest, timeoutMs: number): Promise<unknown> {
		if (this.closed) throw new Error("VS Code window disconnected");
		const id = ++this.seq;
		const { promise, resolve, reject } = Promise.withResolvers<BridgeResponse>();
		this.pending.set(id, { resolve, reject });
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new Error(`VS Code did not answer within ${Math.round(timeoutMs / 1000)}s (language server busy?)`));
		}, timeoutMs);
		this.sock.write(`${JSON.stringify({ ...req, id })}\n`);
		try {
			const res = await promise;
			if ("error" in res) throw new Error(res.error);
			return res.result;
		} finally {
			clearTimeout(timer);
		}
	}

	async call(tool: ToolName, args: ToolArgs, cwd: string, timeoutMs = 25_000): Promise<ToolResult> {
		// The extension builds ToolResult values; the socket is same-user and token-authenticated.
		return (await this.request({ id: 0, method: "call", params: { tool, args, cwd } }, timeoutMs)) as ToolResult;
	}

	close(err = new Error("closed")): void {
		if (this.closed) return;
		this.closed = true;
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
		this.sock.destroy();
	}
}
