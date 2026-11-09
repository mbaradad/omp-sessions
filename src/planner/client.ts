// Client side of the planner API (PLANNER-API.md) for the CLI, the VS Code extension, the MCP bridge and
// Hermes: connect (or start the planner), typed requests, and the `plan` subscription. Node-only.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { plannerDir, socketPath } from "./paths";
import { startService } from "./service";
import type { PlannerEvent, PlannerOpName, PlannerOps, PlannerResponse } from "./types";

export class PlannerClient {
	private seq = 0;
	private readonly pending = new Map<number, (res: PlannerResponse) => void>();
	private readonly subscriptions = new Map<number, (ev: PlannerEvent) => void>();
	private readonly closeListeners = new Set<() => void>();
	closed = false;

	private constructor(private readonly sock: net.Socket) {
		const rl = readline.createInterface({ input: sock, crlfDelay: Number.POSITIVE_INFINITY });
		rl.on("error", () => {});
		rl.on("line", line => {
			if (!line) return;
			let msg: PlannerResponse | PlannerEvent;
			try {
				msg = JSON.parse(line) as PlannerResponse | PlannerEvent;
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
			for (const [id, done] of this.pending) done({ id, ok: false, error: "the planner closed the connection" });
			this.pending.clear();
			for (const l of [...this.closeListeners]) l();
		};
		sock.on("close", onClose);
		sock.on("error", onClose);
	}

	/** Connects to the running planner; undefined when none answers. */
	static connect(timeoutMs = 1500): Promise<PlannerClient | undefined> {
		const { promise, resolve } = Promise.withResolvers<PlannerClient | undefined>();
		const target = socketPath();
		if (!target) {
			resolve(undefined);
			return promise;
		}
		const sock = net.createConnection(target);
		const timer = setTimeout(() => {
			sock.destroy();
			resolve(undefined);
		}, timeoutMs);
		sock.once("connect", () => {
			clearTimeout(timer);
			resolve(new PlannerClient(sock));
		});
		sock.once("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		return promise;
	}

	request<K extends PlannerOpName>(op: K, args: PlannerOps[K]["args"], timeoutMs = 120_000): Promise<PlannerOps[K]["result"]> {
		const { promise, resolve, reject } = Promise.withResolvers<PlannerOps[K]["result"]>();
		const id = ++this.seq;
		if (this.closed) {
			reject(new Error("not connected to the planner"));
			return promise;
		}
		const timer = setTimeout(() => {
			if (this.pending.delete(id)) reject(new Error(`the planner did not answer ${op}`));
		}, timeoutMs);
		timer.unref();
		this.pending.set(id, res => {
			clearTimeout(timer);
			if (res.ok) resolve(res.result as PlannerOps[K]["result"]);
			else reject(new Error(res.error));
		});
		this.sock.write(`${JSON.stringify({ id, op, args })}\n`);
		return promise;
	}

	/** Streams `plan` snapshots (first one right away) and `task` transitions until the connection closes. */
	subscribe(onEvent: (ev: PlannerEvent) => void): Promise<void> {
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
		this.sock.write(`${JSON.stringify({ id, op: "subscribe", args: { topic: "plan" } })}\n`);
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

/**
 * Connects to the planner, starting it when none runs: through its installed service, else (or when
 * the service doesn't answer within 2 s, e.g. its unit points at a moved script) as a detached
 * `node <script>`, which exits by itself when another planner already runs. Undefined when it doesn't
 * come up within `timeoutMs`.
 */
export async function ensurePlanner(script: string, node = process.execPath, timeoutMs = 8000): Promise<PlannerClient | undefined> {
	const existing = await PlannerClient.connect();
	if (existing) return existing;
	fs.mkdirSync(plannerDir(), { recursive: true, mode: 0o700 });
	const spawnDetached = () => {
		const child = spawn(node, [script], { cwd: os.homedir(), detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
		child.on("error", () => {});
		child.unref();
	};
	const start = Date.now();
	let direct = !startService();
	if (direct) spawnDetached();
	while (Date.now() - start < timeoutMs) {
		await sleep(150);
		const client = await PlannerClient.connect(500);
		if (client) return client;
		if (!direct && Date.now() - start > 2000) {
			direct = true;
			spawnDetached();
		}
	}
	return undefined;
}

/** Asks the running planner to exit and waits until its socket stops answering. */
export async function stopPlanner(timeoutMs = 5000): Promise<boolean> {
	const client = await PlannerClient.connect();
	if (!client) return false;
	await client.request("shutdown", {}, 3000).catch(() => {});
	client.close();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const again = await PlannerClient.connect(300);
		if (!again) return true;
		again.close();
		await sleep(100);
	}
	return false;
}
