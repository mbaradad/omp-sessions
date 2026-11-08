// Spawns the real session host (bundled by test/run.mjs) against test/fake-omp.mjs in a throwaway
// OMP_VSCODE_HOME, and talks to it over its Unix socket like the extension does.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { canConnect } from "../../src/shared/launch";
import type { ClientToHost, HostToClient, OmpFrame, SessionMeta } from "../../src/shared/protocol";

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set; run the suite via \`npm test\` (test/run.mjs)`);
	return value;
}
const HOST_JS = requiredEnv("OMP_TEST_HOST_JS");
const FAKE_OMP = requiredEnv("OMP_TEST_FAKE_OMP");

export type Msg<T extends HostToClient["t"]> = Extract<HostToClient, { t: T }>;
export type Snapshot = Msg<"snapshot">;

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Concatenated text blocks of a transcript message. */
export function textOf(message: unknown): string {
	if (!isRecord(message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map(b => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

export function alive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Removes a killed host's leftover Unix socket; a Windows named pipe goes away with its process. */
export function removeSocket(socket: string | undefined): void {
	if (socket && process.platform !== "win32") fs.rmSync(socket, { force: true });
}

export async function until<T>(probe: () => T | undefined | false, what: string, timeout = 8000): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

export class Client {
	readonly msgs: HostToClient[] = [];
	private readonly wake = new Set<() => void>();
	private closed = false;

	private constructor(private readonly sock: net.Socket) {
		readline.createInterface({ input: sock, crlfDelay: Infinity }).on("line", line => {
			if (!line.trim()) return;
			this.msgs.push(JSON.parse(line));
			for (const w of this.wake) w();
		});
		sock.on("close", () => {
			this.closed = true;
			for (const w of this.wake) w();
		});
	}

	static open(socketPath: string): Promise<Client> {
		const { promise, resolve, reject } = Promise.withResolvers<Client>();
		const sock = net.connect(socketPath);
		sock.once("connect", () => resolve(new Client(sock)));
		sock.once("error", reject);
		return promise;
	}

	send(msg: ClientToHost): void {
		this.sock.write(`${JSON.stringify(msg)}\n`);
	}

	/** Index to pass as `from` so later waits only see messages received after this point. */
	mark(): number {
		return this.msgs.length;
	}

	waitFor<T extends HostToClient["t"]>(t: T, pred: (m: Msg<T>) => boolean = () => true, from = 0, timeout = 8000): Promise<Msg<T>> {
		const isT = (m: HostToClient): m is Msg<T> => m.t === t;
		const find = () => this.msgs.slice(from).find((m): m is Msg<T> => isT(m) && pred(m));
		const { promise, resolve, reject } = Promise.withResolvers<Msg<T>>();
		const check = () => {
			const hit = find();
			if (hit) done(() => resolve(hit));
			else if (this.closed) done(() => reject(new Error(`socket closed while waiting for ${t}`)));
		};
		const timer = setTimeout(() => done(() => reject(new Error(`timed out waiting for ${t}; got ${this.msgs.slice(from).map(m => (m.t === "event" ? `event:${m.ev.type}` : m.t)).join(",")}`))), timeout);
		const done = (settle: () => void) => {
			clearTimeout(timer);
			this.wake.delete(check);
			settle();
		};
		this.wake.add(check);
		check();
		return promise;
	}

	/** Next omp event of `type` (optionally matching `pred`) received at or after `from`. */
	async event(type: string, pred: (ev: OmpFrame) => boolean = () => true, from = 0, timeout = 8000): Promise<OmpFrame> {
		return (await this.waitFor("event", m => m.ev.type === type && pred(m.ev), from, timeout)).ev;
	}

	async rpc(cmd: { id: string; type: string; [k: string]: unknown }, timeout = 8000): Promise<OmpFrame> {
		const from = this.mark();
		this.send({ t: "rpc", cmd });
		return (await this.waitFor("response", m => m.res.id === cmd.id, from, timeout)).res;
	}

	/** Sends a prompt and resolves with its prompt_result frame. */
	async prompt(message: string, timeout = 8000): Promise<OmpFrame> {
		const from = this.mark();
		const res = await this.rpc({ id: `p${from}`, type: "prompt", message }, timeout);
		if (!res.success) throw new Error(`prompt failed: ${String(res.error)}`);
		return this.event("prompt_result", () => true, from, timeout);
	}

	/** Status of the last meta frame received, else of the first snapshot. */
	status(): string | undefined {
		for (let i = this.msgs.length - 1; i >= 0; i--) {
			const m = this.msgs[i];
			if (m.t === "meta" || m.t === "snapshot") return m.meta.status;
		}
		return undefined;
	}

	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.sock.once("close", () => resolve());
		this.sock.end();
		return promise;
	}
}

export interface FakeLogEntry {
	kind: "argv" | "cmd" | "exit";
	/** Epoch ms when the fake logged the entry. */
	t: number;
	pid: number;
	argv?: string[];
	cmd?: { type: string; [k: string]: unknown };
}

export class Host {
	readonly root: string;
	readonly home: string;
	readonly cwd: string;
	readonly sessions: string;
	readonly fakeLog: string;
	readonly dir: string;
	/** Where the host listens: `<dir>/s.sock`, or the short tmp path when that exceeds sun_path (deep macOS temp dirs). */
	get socket(): string {
		return this.metaOrUndefined()?.socket ?? path.join(this.dir, "s.sock");
	}
	private readonly clients: Client[] = [];
	private readonly pids = new Set<number>();

	constructor(
		readonly id: string,
		private readonly env: Record<string, string> = {},
		/** Shared OMP_VSCODE_HOME for multi-host tests (not removed on dispose); default: inside the sandbox. */
		home?: string,
	) {
		this.root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vsc-test-"));
		this.home = home ?? path.join(this.root, "home");
		this.cwd = path.join(this.root, "work");
		this.sessions = path.join(this.root, "omp-sessions");
		this.fakeLog = path.join(this.root, "fake-omp.log");
		fs.mkdirSync(this.cwd, { recursive: true });
		this.dir = path.join(this.home, "sessions", id);
	}

	/** Runs the `--daemonize` launcher, without waiting for the host it starts; resolves with the launcher's exit code. */
	spawnLauncher(extraArgs: string[] = []): Promise<number | null> {
		const child = spawn(process.execPath, [HOST_JS, "--daemonize", "--id", this.id, "--cwd", this.cwd, "--omp", FAKE_OMP, ...extraArgs], {
			env: { ...process.env, OMP_VSCODE_HOME: this.home, FAKE_OMP_SESSIONS: this.sessions, FAKE_OMP_LOG: this.fakeLog, ...this.env },
			stdio: "ignore",
		});
		const { promise, resolve } = Promise.withResolvers<number | null>();
		child.on("exit", resolve);
		return promise;
	}

	/** Launches `host.js --daemonize` and waits until the socket accepts connections. */
	async start(extraArgs: string[] = []): Promise<void> {
		const before = this.metaOrUndefined()?.pid;
		const status = await this.spawnLauncher(extraArgs);
		if (status !== 0) throw new Error(`host launcher failed (${status})`);
		const meta = await until(() => {
			const m = this.metaOrUndefined();
			return m && m.pid !== before && m.ompPid ? m : undefined;
		}, "host meta");
		this.pids.add(meta.pid);
		if (meta.ompPid) this.pids.add(meta.ompPid);
		// A crashed predecessor leaves its socket file behind: only a connect proves the new host listens.
		const deadline = Date.now() + 8000;
		while (!(await canConnect(this.socket))) {
			if (Date.now() > deadline) throw new Error("timed out waiting for host socket");
			await sleep(25);
		}
	}

	metaOrUndefined(): SessionMeta | undefined {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.dir, "meta.json"), "utf8"));
		} catch {
			return undefined;
		}
	}

	meta(): SessionMeta {
		const m = this.metaOrUndefined();
		if (!m) throw new Error("meta.json missing");
		return m;
	}

	/** Connects, says hello, and waits for a snapshot taken after omp is ready. */
	async connect(name = "test"): Promise<{ client: Client; snapshot: Snapshot }> {
		const client = await Client.open(this.socket);
		this.clients.push(client);
		client.send({ t: "hello", client: name });
		const snapshot = await client.waitFor("snapshot", s => s.meta.status !== "starting");
		return { client, snapshot };
	}

	fakeEntries(): FakeLogEntry[] {
		if (!fs.existsSync(this.fakeLog)) return [];
		return fs
			.readFileSync(this.fakeLog, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(l => JSON.parse(l));
	}

	fakeCommands(type: string): Array<{ type: string; [k: string]: unknown }> {
		return this.fakeEntries().flatMap(e => (e.kind === "cmd" && e.cmd?.type === type ? [e.cmd] : []));
	}

	/** Closes clients, kills every host/omp process this sandbox started, removes the sandbox. */
	async dispose(): Promise<void> {
		await Promise.all(this.clients.map(c => c.close()));
		const m = this.metaOrUndefined();
		if (m) {
			this.pids.add(m.pid);
			if (m.ompPid) this.pids.add(m.ompPid);
		}
		// On Windows meta.ompPid is the `.cmd` shim's cmd.exe: the fake logs its own pid (and its exit).
		if (process.platform === "win32") {
			const entries = this.fakeEntries();
			const exited = new Set(entries.flatMap(e => (e.kind === "exit" ? [e.pid] : [])));
			for (const e of entries) if (e.kind === "argv" && !exited.has(e.pid)) this.pids.add(e.pid);
		}
		for (const pid of this.pids) if (alive(pid)) process.kill(pid, "SIGKILL");
		await until(() => [...this.pids].every(p => !alive(p)), "sandbox processes to exit", 3000);
		// A killed host leaves its socket behind, which may be outside the sandbox (the short tmp fallback).
		removeSocket(m?.socket);
		// Windows: a just-killed process may still hold the folder for a moment.
		await fs.promises.rm(this.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

let seq = 0;
/** New host sandbox, started, disposed after the test. */
export async function launch(t: TestContext, opts: { args?: string[]; env?: Record<string, string>; home?: string } = {}): Promise<Host> {
	const host = new Host(`t${process.pid}-${++seq}`, opts.env, opts.home);
	t.after(() => host.dispose());
	await host.start(opts.args);
	return host;
}
