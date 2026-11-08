// The omp-sessions server's remote HTTP API (docs/REMOTE-API.md) against real hosts and the fake omp:
// auth (bearer, pairing cookie, CSRF guards, lockout), listing and creating sessions, live
// session events over SSE, permission mode switches, answering approvals, and turning it off.
import { type ChildProcess, spawn } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import type { SessionMeta } from "../../src/shared/protocol";
import { type RemoteStatus, parseRemoteConfig, resolveBind, tailscaleAddress, tokenMatches, trustsProxy } from "../../src/shared/remote";
import { qrHalfBlocks, qrMatrix } from "../../src/shared/remote-qr";
import { ServerClient } from "../../src/shared/server-client";
import { alive, isRecord, removeSocket, textOf, until } from "./harness";

const SERVER_JS = process.env.OMP_TEST_SERVER_JS ?? "";
const FAKE_OMP = process.env.OMP_TEST_FAKE_OMP ?? "";
const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv";

let home = "";
let cwd = "";
let server: ChildProcess | undefined;
let base = "";

const auth = { authorization: `Bearer ${TOKEN}` };

/** Atomic, like writeRemoteConfig: the server re-reads remote.json on its own schedule, and a torn
 * read (empty or half-written) would turn the listener off and back on at another random port. */
function writeRemote(cfg: Record<string, unknown>): void {
	const file = path.join(home, "remote.json");
	fs.writeFileSync(`${file}.tmp`, JSON.stringify({ bind: "localhost", port: 0, token: TOKEN, ...cfg }), { mode: 0o600 });
	fs.renameSync(`${file}.tmp`, file);
}

async function remoteStatus(): Promise<RemoteStatus> {
	const client = await ServerClient.connect();
	assert.ok(client, "server answers on its socket");
	try {
		return await client.request("remote", {});
	} finally {
		client.close();
	}
}

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = auth): Promise<{ status: number; body: unknown; headers: Headers }> {
	const res = await fetch(base + p, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		/* not JSON */
	}
	return { status: res.status, body: parsed, headers: res.headers };
}

/** Reads a server-sent events stream; `next` waits for the first event matching `pick`. */
class Sse {
	private buffer = "";
	private readonly events: Array<{ event: string; data: unknown }> = [];
	private readonly abort = new AbortController();
	private done = false;

	static async open(p: string): Promise<Sse> {
		const sse = new Sse();
		const res = await fetch(base + p, { headers: auth, signal: sse.abort.signal });
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
		assert.ok(res.body);
		void sse.pump(res.body.getReader());
		return sse;
	}

	private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				this.buffer += decoder.decode(value, { stream: true });
				let at = this.buffer.indexOf("\n\n");
				while (at >= 0) {
					const chunk = this.buffer.slice(0, at);
					this.buffer = this.buffer.slice(at + 2);
					let event = "message";
					let data = "";
					for (const line of chunk.split("\n")) {
						if (line.startsWith("event: ")) event = line.slice(7);
						else if (line.startsWith("data: ")) data += line.slice(6);
					}
					if (data) this.events.push({ event, data: JSON.parse(data) });
					at = this.buffer.indexOf("\n\n");
				}
			}
		} catch {
			/* aborted */
		}
		this.done = true;
	}

	/** Consumes events up to and including the first match. */
	async next<T>(pick: (event: string, data: unknown) => T | undefined, what: string, timeout = 10000): Promise<T> {
		return until(() => {
			while (this.events.length) {
				const e = this.events.shift();
				if (!e) break;
				const hit = pick(e.event, e.data);
				if (hit !== undefined) return hit;
			}
			return undefined;
		}, what, timeout);
	}

	get ended(): boolean {
		return this.done;
	}

	close(): void {
		this.abort.abort();
	}
}

function hostEvent(data: unknown): Record<string, unknown> | undefined {
	return isRecord(data) && data.t === "event" && isRecord(data.ev) ? data.ev : undefined;
}

function sessionIds(): string[] {
	try {
		return fs.readdirSync(path.join(home, "sessions"));
	} catch {
		return [];
	}
}

function meta(id: string): SessionMeta | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(home, "sessions", id, "meta.json"), "utf8"));
	} catch {
		return undefined;
	}
}

before(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-remote-"));
	cwd = path.join(home, "work");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
	fs.writeFileSync(path.join(home, "launcher.json"), JSON.stringify({ ompPath: FAKE_OMP }));
	writeRemote({ enabled: true });
	process.env.OMP_VSCODE_HOME = home;
	server = spawn(process.execPath, [SERVER_JS], { env: { ...process.env, OMP_VSCODE_HOME: home, FAKE_OMP_SESSIONS: path.join(home, "fake-sessions") }, stdio: "ignore" });
	let status: RemoteStatus | undefined;
	for (const deadline = Date.now() + 15000; !status?.listening; await sleep(50)) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the remote listener");
		const client = await ServerClient.connect(300);
		if (!client) continue;
		client.close();
		status = await remoteStatus();
	}
	assert.equal(status.listening?.host, "127.0.0.1");
	assert.ok(status.url?.startsWith("http://127.0.0.1:"));
	base = status.url?.replace(/\/$/, "") ?? "";
});

after(async () => {
	server?.kill("SIGTERM");
	const metas = sessionIds().flatMap(id => meta(id) ?? []);
	const pids = metas.flatMap(m => [m.pid, m.ompPid ?? 0].filter(p => p > 0));
	for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
	await until(() => pids.every(p => !alive(p)) && server?.exitCode !== null, "processes to exit", 5000).catch(() => {});
	// Killed hosts leave their sockets, possibly in the short tmp fallback outside `home`.
	for (const m of metas) removeSocket(m.socket);
	fs.rmSync(home, { recursive: true, force: true });
});

test("remote config: defaults, token compare, bind resolution, QR", () => {
	assert.deepEqual(parseRemoteConfig(undefined), { enabled: false, bind: "tailscale", port: 7413, token: "" });
	assert.deepEqual(parseRemoteConfig('{"enabled":true,"bind":"nope","port":99999,"token":5}'), { enabled: true, bind: "tailscale", port: 7413, token: "" });
	assert.equal(parseRemoteConfig('{"bind":"10.1.2.3"}').bind, "10.1.2.3");
	assert.ok(tokenMatches("abc", "abc"));
	assert.ok(!tokenMatches("abd", "abc"));
	assert.ok(!tokenMatches("", ""));
	const ifaces = {
		eth0: [{ address: "192.168.1.20", family: "IPv4" as const, internal: false, netmask: "255.255.255.0", mac: "", cidr: null }],
		tailscale0: [{ address: "100.101.102.103", family: "IPv4" as const, internal: false, netmask: "255.192.0.0", mac: "", cidr: null }],
	};
	assert.equal(tailscaleAddress(ifaces), "100.101.102.103");
	assert.deepEqual(resolveBind("tailscale", ifaces), { host: "100.101.102.103", advertise: "100.101.102.103" });
	assert.deepEqual(resolveBind("lan", ifaces), { host: "0.0.0.0", advertise: "192.168.1.20" });
	assert.deepEqual(resolveBind("localhost", ifaces), { host: "127.0.0.1", advertise: "127.0.0.1" });
	assert.throws(() => resolveBind("tailscale", { eth0: ifaces.eth0 }), /Tailscale/);
	const m = qrMatrix("http://100.101.102.103:7413/#pair=abc");
	assert.ok(m.length >= 21 && m.every(r => r.length === m.length));
	assert.ok(m[0][0] && m[0][6] && !m[0][7], "finder pattern in the corner");
	const text = qrHalfBlocks("hi", false);
	assert.equal(text.split("\n").filter(Boolean).length, Math.ceil((qrMatrix("hi").length + 4) / 2));
});

test("remote: health is open; the API needs the token; pairing sets a cookie that works", async () => {
	const health = await api("GET", "/api/health", undefined, {});
	assert.equal(health.status, 200);
	assert.ok(isRecord(health.body) && typeof health.body.version === "string");

	assert.equal((await api("GET", "/api/sessions", undefined, {})).status, 401);
	const listed = await api("GET", "/api/sessions");
	assert.equal(listed.status, 200);
	assert.deepEqual(listed.body, []);
	assert.equal(listed.headers.get("access-control-allow-origin"), null, "no CORS headers");

	const paired = await api("POST", "/api/pair", { token: TOKEN }, {});
	assert.equal(paired.status, 200);
	const cookie = paired.headers.get("set-cookie") ?? "";
	assert.match(cookie, /^omp_sessions=/);
	assert.match(cookie, /HttpOnly/);
	assert.match(cookie, /SameSite=Strict/);
	assert.doesNotMatch(cookie, /Secure/, "plain HTTP: no Secure cookie");
	const jar = { cookie: cookie.split(";")[0] };
	assert.ok(!jar.cookie.includes(TOKEN), "the cookie carries an HMAC of the token, not the token");
	assert.equal((await api("GET", "/api/sessions", undefined, jar)).status, 200);
	// Cookie-authenticated writes: JSON from this origin only.
	const form = await fetch(`${base}/api/sessions`, { method: "POST", headers: { ...jar, "content-type": "application/x-www-form-urlencoded" }, body: "cwd=/tmp" });
	assert.equal(form.status, 415);
	assert.equal((await api("POST", "/api/sessions", { cwd }, { ...jar, origin: "http://evil.example" })).status, 403);

	assert.equal((await api("GET", "/api/sessions/nope")).status, 404);
	assert.equal((await api("DELETE", "/api/sessions")).status, 405);
	const big = await fetch(`${base}/api/sessions`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ cwd, prompt: "x".repeat(1024 * 1024 + 10) }) });
	assert.equal(big.status, 413);
});

test("remote: behind a proxy, the public URL is the pairing URL and its origin may write", async () => {
	const pub = "https://box.tailnet.ts.net";
	assert.equal(parseRemoteConfig(JSON.stringify({ publicUrl: pub })).publicUrl, `${pub}/`);
	assert.equal(parseRemoteConfig(JSON.stringify({ publicUrl: "ftp://x" })).publicUrl, undefined);
	assert.equal(parseRemoteConfig(JSON.stringify({ publicUrl: `${pub}/?a=1` })).publicUrl, undefined);
	assert.equal(parseRemoteConfig(JSON.stringify({ publicUrl: `${pub}/omp/` })).publicUrl, undefined, "the app calls /api/… at the root");
	const statusWhere = async (pred: (s: RemoteStatus) => boolean, what: string): Promise<RemoteStatus> => {
		for (const deadline = Date.now() + 8000; ; await sleep(100)) {
			const s = await remoteStatus();
			if (pred(s)) return s;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s)}`);
		}
	};
	writeRemote({ enabled: true, publicUrl: pub });
	try {
		const status = await statusWhere(s => s.url === `${pub}/`, "the public URL");
		assert.equal(status.localUrl, `${base}/`, "the listener's own address, for the proxy");
		const paired = await api("POST", "/api/pair", { token: TOKEN }, {});
		assert.match(paired.headers.get("set-cookie") ?? "", /^__Host-omp_sessions=[^;]+;.*; Secure/, "https public URL: a Secure __Host- cookie");
		const jar = { cookie: (paired.headers.get("set-cookie") ?? "").split(";")[0] };
		// The page is served from the proxy's origin; its writes pass the origin check (404: no such session).
		assert.equal((await api("POST", "/api/sessions/nope/prompt", { text: "hi" }, { ...jar, origin: pub })).status, 404);
		assert.equal((await api("POST", "/api/sessions/nope/prompt", { text: "hi" }, { ...jar, origin: "https://evil.example" })).status, 403);
		// Every proxied client arrives from 127.0.0.1: lockouts follow the address the proxy forwards.
		const from = (ip: string) => ({ "x-forwarded-for": `203.0.113.9, ${ip}` });
		for (let i = 0; i < 5; i++) assert.equal((await api("GET", "/api/sessions", undefined, { authorization: "Bearer wrong", ...from("100.64.0.9") })).status, 401);
		assert.equal((await api("GET", "/api/sessions", undefined, { ...auth, ...from("100.64.0.9") })).status, 429);
		assert.equal((await api("GET", "/api/sessions", undefined, { ...auth, ...from("100.64.0.10") })).status, 200, "another device is not locked out");
	} finally {
		writeRemote({ enabled: true });
	}
	await statusWhere(s => s.url === `${base}/` && s.localUrl === undefined, "the plain URL back");
});

test("remote: every route needs the token or a current cookie, SSE streams and POSTs included; status and models", async () => {
	const routes: Array<[string, string, unknown?]> = [
		["GET", "/api/sessions"],
		["GET", "/api/projects"],
		["GET", "/api/status"],
		["GET", "/api/models"],
		["GET", "/api/events"],
		["GET", "/api/sessions/nope"],
		["GET", "/api/sessions/nope/events"],
		["POST", "/api/sessions", { cwd }],
		["POST", "/api/sessions/nope/prompt", { text: "hi" }],
		["POST", "/api/sessions/nope/stop", {}],
		["POST", "/api/sessions/nope/model", { model: "fake/fake-mini" }],
		["POST", "/api/sessions/nope/vscode", {}],
	];
	for (const [method, p, body] of routes) assert.equal((await api(method, p, body, {})).status, 401, `${method} ${p} without credentials`);
	const forged = await api("POST", "/api/sessions/nope/prompt", { text: "hi" }, { cookie: "omp_sessions=forged" });
	assert.equal(forged.status, 401, "a forged cookie");
	assert.match(forged.headers.get("set-cookie") ?? "", /omp_sessions=; .*Max-Age=0/);
	// That failure counted; pairing (a success) clears it before it adds up to a lockout.
	const jar = { cookie: ((await api("POST", "/api/pair", { token: TOKEN }, {})).headers.get("set-cookie") ?? "").split(";")[0] };

	const status = await api("GET", "/api/status", undefined, jar);
	assert.equal(status.status, 200);
	assert.ok(isRecord(status.body) && isRecord(status.body.server) && isRecord(status.body.remote) && isRecord(status.body.sessions));
	assert.equal(status.body.server.running, true);
	assert.equal(status.body.remote.enabled, true);
	assert.ok(!JSON.stringify(status.body).includes(TOKEN), "status never shows the token");
	const models = await api("GET", "/api/models", undefined, jar);
	assert.ok(isRecord(models.body) && Array.isArray(models.body.models) && models.body.models.some(m => isRecord(m) && m.selector === "fake/fake-model"));

	const abort = new AbortController();
	const stream = await fetch(`${base}/api/events`, { headers: jar, signal: abort.signal });
	assert.equal(stream.status, 200);
	assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
	abort.abort();
	assert.equal(trustsProxy({ publicUrl: "https://box.ts.net/", bind: "localhost" }), true);
	assert.equal(trustsProxy({ publicUrl: "https://box.ts.net/", bind: "lan" }), false, "bound to the network, X-Forwarded-For is ignored");
	assert.equal(trustsProxy({ bind: "localhost" }), false);
});

test("remote: after a rotation an old cookie asks to pair again and never locks the phone out; legacy cookies are upgraded", async () => {
	const jar = { cookie: ((await api("POST", "/api/pair", { token: TOKEN }, {})).headers.get("set-cookie") ?? "").split(";")[0] };
	const legacy = await api("GET", "/api/sessions", undefined, { cookie: `omp_vs=${TOKEN}` });
	assert.equal(legacy.status, 200, "the first cookie (the raw token) still works");
	const upgrade = legacy.headers.get("set-cookie") ?? "";
	assert.match(upgrade, /omp_sessions=/);
	assert.match(upgrade, /omp_vs=; .*Max-Age=0/);

	const rotated = "rotated-token-0123456789abcdefghijklmnopqrstu";
	writeRemote({ enabled: true, token: rotated });
	await remoteStatus();
	try {
		for (let i = 0; i < 8; i++) {
			const stale = await api("GET", "/api/sessions", undefined, jar);
			assert.equal(stale.status, 401);
			assert.ok(isRecord(stale.body) && typeof stale.body.error === "string" && /pairing expired/.test(stale.body.error));
			assert.match(stale.headers.get("set-cookie") ?? "", /Max-Age=0/, "the browser is told to drop it");
		}
		assert.equal((await api("POST", "/api/pair", { token: rotated }, {})).status, 200, "pairing again works after many stale requests");
		assert.equal((await api("GET", "/api/sessions", undefined, { authorization: `Bearer ${rotated}` })).status, 200);
	} finally {
		writeRemote({ enabled: true });
		await remoteStatus();
	}
});

test("remote: create, list, projects; a prompt's reply streams over SSE; mode switches show in the list", async () => {
	const created = await api("POST", "/api/sessions", { cwd, prompt: "echo hello remote", title: "Remote one" });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	assert.ok(isRecord(created.body) && typeof created.body.id === "string");
	const id = created.body.id;

	const list = await api("GET", "/api/sessions");
	assert.ok(Array.isArray(list.body) && list.body.some(i => isRecord(i) && isRecord(i.meta) && i.meta.id === id && i.meta.title === "Remote one"));
	const projects = await api("GET", "/api/projects");
	assert.ok(Array.isArray(projects.body) && projects.body.some(p => isRecord(p) && p.path === cwd));

	const events = await Sse.open(`/api/sessions/${id}/events`);
	const snapshot = await events.next((e, d) => (e === "host" && isRecord(d) && d.t === "snapshot" ? d : undefined), "snapshot first");
	assert.ok(isRecord(snapshot.meta) && snapshot.meta.id === id);
	assert.ok(Array.isArray(snapshot.messages));
	assert.equal("commands" in snapshot, false, "slim snapshot");

	const sent = await api("POST", `/api/sessions/${id}/prompt`, { text: "echo streamed over sse" });
	assert.equal(sent.status, 200, JSON.stringify(sent.body));
	await events.next((e, d) => {
		const ev = hostEvent(d);
		return ev?.type === "message_update" ? true : undefined;
	}, "streaming update");
	const reply = await events.next((e, d) => {
		const ev = hostEvent(d);
		return ev?.type === "message_end" && isRecord(ev.message) && ev.message.role === "assistant" && textOf(ev.message) === "streamed over sse" ? ev : undefined;
	}, "assistant reply over SSE");
	assert.ok(reply);

	const detail = await api("GET", `/api/sessions/${id}`);
	assert.equal(detail.status, 200);
	assert.ok(isRecord(detail.body) && isRecord(detail.body.info) && isRecord(detail.body.snapshot));
	const messages = detail.body.snapshot.messages;
	assert.ok(Array.isArray(messages) && messages.some(m => textOf(m) === "hello remote") && messages.some(m => textOf(m) === "streamed over sse"));

	const sessionsStream = await Sse.open("/api/events");
	await sessionsStream.next((e, d) => (e === "sessions" && Array.isArray(d) ? true : undefined), "current list first");
	assert.equal((await api("POST", `/api/sessions/${id}/mode`, { mode: "bogus" })).status, 400);
	assert.equal((await api("POST", `/api/sessions/${id}/mode`, { mode: "plan" })).status, 200);
	await sessionsStream.next(
		(e, d) => (e === "sessions" && Array.isArray(d) && d.some(i => isRecord(i) && isRecord(i.meta) && i.meta.id === id && i.meta.permissionMode === "plan") ? true : undefined),
		"plan mode in the live sessions list",
		15000,
	);
	events.close();
	sessionsStream.close();

	assert.equal((await api("POST", `/api/sessions/${id}/stop`, {})).status, 200);
	await until(() => meta(id)?.status === "stopped", "stopped");
	const stopped = await Sse.open(`/api/sessions/${id}/events`);
	const end = await stopped.next((e, d) => (e === "end" && isRecord(d) ? d : undefined), "stopped session: snapshot then end");
	assert.equal(end.reason, "stopped");
});

test("remote: a session started in ask mode asks before writing; /ui approves it", async () => {
	const created = await api("POST", "/api/sessions", { cwd, prompt: "write a.txt hi", mode: "ask" });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	assert.ok(isRecord(created.body) && typeof created.body.id === "string");
	const id = created.body.id;
	const events = await Sse.open(`/api/sessions/${id}/events`);
	const request = await events.next((e, d) => {
		if (e !== "host" || !isRecord(d)) return undefined;
		const candidates = d.t === "snapshot" && Array.isArray(d.pendingUi) ? d.pendingUi : d.t === "event" ? [d.ev] : [];
		return candidates.find(r => isRecord(r) && r.method === "select" && typeof r.title === "string" && r.title.startsWith("Allow tool: write"));
	}, "approval request");
	assert.ok(isRecord(request) && typeof request.id === "string");
	assert.equal(fs.existsSync(path.join(cwd, "a.txt")), false, "nothing written before approval");
	assert.equal(meta(id)?.permissionMode, "ask");

	const answered = await api("POST", `/api/sessions/${id}/ui`, { id: request.id, value: "Approve" });
	assert.equal(answered.status, 200, JSON.stringify(answered.body));
	await events.next((e, d) => (isRecord(d) && d.t === "ui_resolved" && d.id === request.id ? true : undefined), "dialog resolved");
	await until(() => fs.existsSync(path.join(cwd, "a.txt")) && fs.readFileSync(path.join(cwd, "a.txt"), "utf8") === "hi\n", "file written after approval");
	await events.next((e, d) => {
		const ev = hostEvent(d);
		return ev?.type === "message_end" && textOf(ev.message) === "Wrote a.txt" ? true : undefined;
	}, "reply after approval");
	events.close();
});

test("remote: wrong tokens lock the address out; turning remote off closes the listener", async () => {
	for (let i = 0; i < 5; i++) assert.equal((await api("GET", "/api/sessions", undefined, { authorization: "Bearer wrong" })).status, 401);
	const locked = await api("GET", "/api/sessions");
	assert.equal(locked.status, 429, "even the right token waits out the lockout");
	assert.ok(Number(locked.headers.get("retry-after")) > 0);
	assert.equal((await api("POST", "/api/pair", { token: TOKEN }, {})).status, 429);

	writeRemote({ enabled: false });
	const status = await remoteStatus();
	assert.equal(status.enabled, false);
	assert.equal(status.listening, undefined);
	await assert.rejects(fetch(`${base}/api/health`));
});
