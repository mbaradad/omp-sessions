// HTTP side of the omp-sessions server: the remote API (docs/REMOTE-API.md) and the phone app it serves.
// Off unless remote.json says `enabled`; the server re-reads the file on every scheduling pass and
// on the `remote` op, and starts, stops or rebinds the listener to match.
// Security: every /api/* route except health and pair needs the token (Bearer header) or the pairing
// cookie /api/pair sets (HttpOnly, SameSite=Strict, an HMAC of the token rather than the token; `Secure`
// and `__Host-` when the public URL is https); compares are constant-time. Repeated failures lock the
// client address out for a while (addresses tracked: capped, least recent dropped), and a burst of
// failures from everywhere locks out every address that hasn't authenticated lately. X-Forwarded-For
// names the client only behind the configured proxy (public URL set, listener bound to loopback). No
// CORS headers; bodies are capped at 1 MiB.
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { type RecentProject, recentProjects } from "../shared/projects";
import { isRecord } from "../shared/bridge";
import type { Control } from "../shared/control";
import { HostConnection, type Snapshot } from "../shared/host-conn";
import { readMeta, sendToHost, setSessionPermissionMode } from "../shared/launch";
import { listModels, setSessionModel } from "../shared/models";
import { isPermissionMode } from "../shared/permissions";
import type { SessionMeta } from "../shared/protocol";
import {
	LEGACY_REMOTE_COOKIE,
	REMOTE_COOKIE,
	REMOTE_COOKIE_SECURE,
	type RemoteConfig,
	type RemoteStatus,
	baseUrl,
	cookieSecret,
	isLoopbackHost,
	parseRemoteConfig,
	remoteConfigPath,
	resolveBind,
	tokenMatches,
	trustsProxy,
} from "../shared/remote";
import { REMOTE_MESSAGES, type RemoteSnapshot, slimHostMessage, slimSnapshot, stoppedSnapshot } from "../shared/remote-snapshot";
import type { SessionInfo } from "../shared/server-protocol";
import type { MachineStatus } from "../shared/server-status";
import { isAuthority, requestOpen, vscodeLink, windowFor } from "../shared/vscode-open";

const MAX_BODY = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
/** A stream whose client stopped reading (this much unsent) is dropped. */
const MAX_STREAM_BACKLOG = 4 * 1024 * 1024;
/** Failed token checks per address before it is locked out. */
const FAIL_LIMIT = 5;
/** Failures older than this (since the last one) are forgotten. */
const FAIL_WINDOW_MS = 10 * 60_000;
/** First lockout; it doubles with every further failure (up to 64×). */
const LOCK_MS = 60_000;
/** Addresses whose failures are remembered; the least recently failing one goes first. */
const MAX_TRACKED = 1024;
/** Failures from all addresses together within GLOBAL_WINDOW_MS that trigger the global lockout. */
const GLOBAL_FAIL_LIMIT = 50;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_LOCK_MS = 5 * 60_000;
/** Addresses that authenticated this recently still get in during a global lockout. */
const TRUSTED_MS = 7 * 24 * 3600_000;
const MAX_TRUSTED = 256;
/** Earlier tokens remembered (this run only), so their cookies read as "pair again", not as attacks. */
const MAX_OLD_TOKENS = 4;
/** While enabled but not listening (no Tailscale yet, port taken), retry this often. */
const RETRY_MS = 30_000;
const COOKIE_MAX_AGE = 365 * 24 * 3600;
/** The 401 a browser with an outdated pairing cookie gets (the phone app shows its pairing screen). */
export const PAIRING_EXPIRED = "pairing expired: the token changed, pair this browser again";

export interface RemoteDeps {
	version: string;
	control: Control;
	/** The server's resume (also clears its crash-loop backoff). */
	resume(id: string): { started: boolean };
	/** The sessions list as `subscribe sessions` sends it (archived ones included, flagged). */
	sessions(): SessionInfo[];
	/** The machine overview (`GET /api/status`, the same as `omp-sessions status`). */
	status(): MachineStatus;
	/** Folder holding the phone app (out/ or the runtime copy). */
	staticDir: string;
	log(...parts: unknown[]): void;
}

/** A recent project folder for the phone's new-session picker. */
export type RemoteProject = RecentProject;

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly headers: Record<string, string> = {},
	) {
		super(message);
	}
}

const BASE_HEADERS: Record<string, string> = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

const STATIC: Record<string, { file: string; type: string }> = {
	"/": { file: "mobile.html", type: "text/html; charset=utf-8" },
	"/index.html": { file: "mobile.html", type: "text/html; charset=utf-8" },
	"/mobile.js": { file: "mobile.js", type: "text/javascript; charset=utf-8" },
	"/mobile.css": { file: "mobile.css", type: "text/css; charset=utf-8" },
	"/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json" },
	"/mobile-icon.png": { file: "mobile-icon.png", type: "image/png" },
	"/mobile-icon.svg": { file: "mobile-icon.svg", type: "image/svg+xml" },
};

const HTML_HEADERS: Record<string, string> = {
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"x-frame-options": "DENY",
};

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(text)), ...headers });
	res.end(text);
}

/** Reads and discards the rest of a request body (at most a few seconds: a client that never sends it is answered anyway). */
function drain(req: http.IncomingMessage): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, 5000);
	const done = () => {
		clearTimeout(timer);
		resolve();
	};
	req.once("end", done);
	req.once("error", done);
	req.once("close", done);
	req.resume();
	return promise;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
	for (const part of (header ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) throw new HttpError(413, "request body over 1 MiB", { connection: "close" });
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buf.length;
		if (size > MAX_BODY) throw new HttpError(413, "request body over 1 MiB", { connection: "close" });
		chunks.push(buf);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text.trim()) return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new HttpError(400, "invalid JSON");
	}
	if (!isRecord(value)) throw new HttpError(400, "expected a JSON object");
	return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const v = body[key];
	if (v === undefined || v === null || v === "") return undefined;
	if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
	return v;
}

function messageLimit(url: URL): number {
	const n = Number(url.searchParams.get("limit"));
	return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : REMOTE_MESSAGES;
}

export class RemoteServer {
	private cfg: RemoteConfig = parseRemoteConfig(undefined);
	/** remote.json as last applied; null before the first read. */
	private cfgText: string | null | undefined = null;
	private server: http.Server | undefined;
	/** `port` is the real one; `requested` the config's (0 = any). */
	private bound: { host: string; port: number; requested: number; advertise: string } | undefined;
	private error: string | undefined;
	private errorAt = 0;
	private chain: Promise<void> = Promise.resolve();
	private readonly streams = new Set<http.ServerResponse>();
	private readonly listStreams = new Set<http.ServerResponse>();
	/** Failures per client address, least recently failing first (capped at MAX_TRACKED). */
	private readonly failures = new Map<string, { count: number; last: number; until: number }>();
	/** Addresses that authenticated lately → when, least recent first (capped at MAX_TRUSTED). */
	private readonly trusted = new Map<string, number>();
	private globalFailures = { start: 0, count: 0 };
	private globalUntil = 0;
	/** Tokens replaced while this server ran, newest last. */
	private oldTokens: string[] = [];

	constructor(private readonly deps: RemoteDeps) {}

	status(): RemoteStatus {
		const { enabled, bind, port } = this.cfg;
		const status: RemoteStatus = { enabled, bind, port };
		if (this.bound) {
			status.listening = { host: this.bound.host, port: this.bound.port };
			const local = baseUrl(this.bound.advertise, this.bound.port);
			status.url = this.cfg.publicUrl ?? local;
			if (this.cfg.publicUrl) status.localUrl = local;
		}
		if (this.error) status.error = this.error;
		return status;
	}

	/** Applies remote.json when it changed (`force`: re-resolve the bind address anyway). */
	reload(force = false): Promise<RemoteStatus> {
		const next = this.chain.then(() => this.apply(force));
		this.chain = next.catch(err => this.deps.log("remote: reload failed", String(err)));
		return next.then(() => this.status());
	}

	/** Scheduling-pass hook: picks up edits of remote.json, retries a failed listen now and then. */
	poll(): void {
		this.reload(this.error !== undefined && Date.now() - this.errorAt > RETRY_MS).catch(() => {});
	}

	/** Someone follows the sessions list (GET /api/events). */
	watchingSessions(): boolean {
		return this.listStreams.size > 0;
	}

	/** The sessions list changed: `json` is the serialized SessionInfo[]. */
	publishSessions(json: string): void {
		for (const res of this.listStreams) this.writeEvent(res, "sessions", json);
	}

	close(): void {
		this.dropStreams();
		this.server?.close();
		this.server?.closeAllConnections();
		this.server = undefined;
		this.bound = undefined;
	}

	// ---------- listener ----------

	private async apply(force: boolean): Promise<void> {
		let text: string | undefined;
		try {
			text = fs.readFileSync(remoteConfigPath(), "utf8");
		} catch {
			text = undefined;
		}
		if (!force && text === this.cfgText) return;
		this.cfgText = text;
		const prev = this.cfg;
		this.cfg = parseRemoteConfig(text);
		// A new token ends every stream opened with the old one; cookies of the old one ask to pair again.
		if (prev.token !== this.cfg.token) {
			this.dropStreams();
			if (prev.token) this.oldTokens = [...this.oldTokens.filter(t => t !== prev.token), prev.token].slice(-MAX_OLD_TOKENS);
		}
		if (!this.cfg.enabled) {
			if (this.bound) this.deps.log("remote: off");
			await this.stopListening();
			this.setError(undefined);
			return;
		}
		let target: { host: string; advertise: string };
		try {
			target = resolveBind(this.cfg.bind);
		} catch (err) {
			await this.stopListening();
			this.setError(err instanceof Error ? err.message : String(err));
			return;
		}
		if (this.bound && this.bound.host === target.host && this.bound.requested === this.cfg.port) {
			this.bound.advertise = target.advertise;
			this.setError(undefined);
			return;
		}
		await this.stopListening();
		try {
			const server = await this.listen(target.host, this.cfg.port);
			const address = server.address();
			const port = address && typeof address === "object" ? address.port : this.cfg.port;
			this.server = server;
			this.bound = { host: target.host, port, requested: this.cfg.port, advertise: target.advertise };
			this.setError(undefined);
			this.deps.log("remote: listening", `${target.host}:${port}`, `(bind ${this.cfg.bind})`);
		} catch (err) {
			this.setError(`cannot listen on ${target.host}:${this.cfg.port}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private setError(error: string | undefined): void {
		if (error && error !== this.error) this.deps.log("remote:", error);
		this.error = error;
		this.errorAt = Date.now();
	}

	private listen(host: string, port: number): Promise<http.Server> {
		const server = http.createServer((req, res) => void this.handle(req, res));
		const { promise, resolve, reject } = Promise.withResolvers<http.Server>();
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			server.on("error", err => this.deps.log("remote: http error", String(err)));
			resolve(server);
		});
		return promise;
	}

	private stopListening(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.bound = undefined;
		if (!server) return Promise.resolve();
		this.dropStreams();
		const { promise, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		server.closeAllConnections();
		return promise;
	}

	private dropStreams(): void {
		for (const res of this.streams) res.destroy();
		this.streams.clear();
		this.listStreams.clear();
	}

	// ---------- auth ----------

	private checkLock(ip: string): void {
		const now = Date.now();
		const f = this.failures.get(ip);
		const wait = f ? f.until - now : 0;
		if (wait > 0) throw new HttpError(429, "too many failed attempts; try again later", { "retry-after": String(Math.ceil(wait / 1000)) });
		// Many addresses failing at once (a forged or rotating source): only known clients get checked.
		const globalWait = this.globalUntil - now;
		if (globalWait > 0 && !(now - (this.trusted.get(ip) ?? 0) < TRUSTED_MS)) {
			throw new HttpError(429, "too many failed attempts from several addresses; try again later", { "retry-after": String(Math.ceil(globalWait / 1000)) });
		}
	}

	private recordFailure(ip: string): void {
		const now = Date.now();
		const prev = this.failures.get(ip);
		const f = prev && now - prev.last < FAIL_WINDOW_MS ? prev : { count: 0, last: now, until: 0 };
		f.count++;
		f.last = now;
		if (f.count >= FAIL_LIMIT) f.until = now + LOCK_MS * 2 ** Math.min(6, f.count - FAIL_LIMIT);
		// Re-inserting keeps the map ordered by last failure, so the first key is the one to drop.
		this.failures.delete(ip);
		this.failures.set(ip, f);
		while (this.failures.size > MAX_TRACKED) {
			const oldest = this.failures.keys().next().value;
			if (oldest === undefined) break;
			this.failures.delete(oldest);
		}
		if (now - this.globalFailures.start > GLOBAL_WINDOW_MS) this.globalFailures = { start: now, count: 0 };
		this.globalFailures.count++;
		if (this.globalFailures.count >= GLOBAL_FAIL_LIMIT && this.globalUntil <= now) {
			this.globalUntil = now + GLOBAL_LOCK_MS;
			this.deps.log("remote:", `${this.globalFailures.count} failed token checks within a minute; only recently signed-in addresses get in for ${GLOBAL_LOCK_MS / 60_000} min`);
		}
		this.deps.log("remote: rejected token from", ip, `(${f.count} failures)`);
	}

	private recordSuccess(ip: string): void {
		this.failures.delete(ip);
		this.trusted.delete(ip);
		this.trusted.set(ip, Date.now());
		while (this.trusted.size > MAX_TRUSTED) {
			const oldest = this.trusted.keys().next().value;
			if (oldest === undefined) break;
			this.trusted.delete(oldest);
		}
	}

	/**
	 * Who to lock out after failed tokens. Behind the configured proxy (a public URL is set and the
	 * listener is bound to loopback, e.g. `tailscale serve`), every client arrives from 127.0.0.1: use the
	 * address the proxy appended to X-Forwarded-For (the last hop; earlier hops come from the client and
	 * can be forged). Otherwise the header is ignored: a loopback peer is just a local process.
	 */
	private clientAddress(req: http.IncomingMessage): string {
		const peer = req.socket.remoteAddress ?? "";
		if (!isLoopbackHost(peer) || !this.bound || !trustsProxy(this.cfg, this.bound.host)) return peer;
		const forwarded = req.headers["x-forwarded-for"];
		const hops = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").map(h => h.trim()).filter(Boolean);
		return hops.length ? `${hops[hops.length - 1]} (via proxy)` : peer;
	}

	/** `Set-Cookie` for the pairing cookie: `__Host-` and `Secure` when the phone uses an https public URL. */
	private pairingCookie(): string {
		const secure = !!this.cfg.publicUrl?.startsWith("https:");
		return `${secure ? REMOTE_COOKIE_SECURE : REMOTE_COOKIE}=${cookieSecret(this.cfg.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure ? "; Secure" : ""}`;
	}

	/** Expires every pairing cookie name (the browser stops sending a stale one). */
	private static clearCookies(names: readonly string[]): string[] {
		return names.map(n => `${n}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${n === REMOTE_COOKIE_SECURE ? "; Secure" : ""}`);
	}

	/** Throws 401/429 unless the request carries the token or a current pairing cookie; tells how it did. */
	private authorize(req: http.IncomingMessage, res: http.ServerResponse): "bearer" | "cookie" {
		const ip = this.clientAddress(req);
		this.checkLock(ip);
		const token = this.cfg.token;
		const header = req.headers.authorization;
		const bearer = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : undefined;
		if (bearer !== undefined) {
			if (!tokenMatches(bearer, token)) {
				this.recordFailure(ip);
				throw new HttpError(401, "invalid token");
			}
			this.recordSuccess(ip);
			return "bearer";
		}
		const cookies: Array<{ name: string; value: string }> = [];
		for (const name of [REMOTE_COOKIE_SECURE, REMOTE_COOKIE, LEGACY_REMOTE_COOKIE]) {
			const value = cookieValue(req.headers.cookie, name);
			if (value) cookies.push({ name, value });
		}
		if (!cookies.length) throw new HttpError(401, "unauthorized: send Authorization: Bearer <token>, or pair this browser");
		// The legacy cookie holds the raw token; the others its HMAC.
		const secretOf = (name: string, t: string) => (name === LEGACY_REMOTE_COOKIE ? t : cookieSecret(t));
		const current = token ? cookies.find(c => tokenMatches(c.value, secretOf(c.name, token))) : undefined;
		if (current) {
			this.recordSuccess(ip);
			// Upgrade a legacy cookie to the HMAC one.
			if (current.name === LEGACY_REMOTE_COOKIE) res.setHeader("set-cookie", [this.pairingCookie(), ...RemoteServer.clearCookies([LEGACY_REMOTE_COOKIE])]);
			return "cookie";
		}
		// Not counted when it is a cookie of a token this server replaced (`remote rotate`), so a phone with an
		// old pairing is never locked out of pairing again; either way the browser is told to drop it.
		res.setHeader("set-cookie", RemoteServer.clearCookies(cookies.map(c => c.name)));
		const stale = cookies.every(c => this.oldTokens.some(t => tokenMatches(c.value, secretOf(c.name, t))));
		if (!stale) this.recordFailure(ip);
		throw new HttpError(401, PAIRING_EXPIRED);
	}

	/** Cookie-authenticated writes must come from this origin as JSON (no form posts from other sites). */
	private checkSameOrigin(req: http.IncomingMessage): void {
		const origin = req.headers.origin;
		const host = req.headers.host ?? "";
		// Behind a proxy (tailscale serve, HTTPS) the page's origin is the public URL's, not this listener's.
		const allowed = [`http://${host}`, ...(this.cfg.publicUrl ? [new URL(this.cfg.publicUrl).origin] : [])];
		if (origin !== undefined && !allowed.includes(origin)) throw new HttpError(403, "cross-origin request refused");
		if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send Content-Type: application/json");
	}

	// ---------- requests ----------

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			const p = url.pathname;
			const method = req.method ?? "GET";
			if (!p.startsWith("/api/")) return this.serveStatic(res, p, method);
			if (p === "/api/health") {
				if (method !== "GET") throw new HttpError(405, "use GET", { allow: "GET" });
				return sendJson(res, 200, { version: this.deps.version });
			}
			if (p === "/api/pair") {
				if (method !== "POST") throw new HttpError(405, "use POST", { allow: "POST" });
				return await this.pair(req, res);
			}
			const auth = this.authorize(req, res);
			if (auth === "cookie" && method !== "GET" && method !== "HEAD") this.checkSameOrigin(req);
			await this.route(req, res, url, method);
		} catch (err) {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			// A request refused before its body was read (wrong type, origin, auth): read the body first. Node
			// closes the connection when it answers a request whose body hasn't arrived, so the client would get
			// a reset while still writing instead of the error. Oversized bodies (413) close it on purpose.
			if (!req.complete && !(err instanceof HttpError && err.status === 413)) await drain(req);
			if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, err.headers);
			const message = err instanceof Error ? err.message : String(err);
			sendJson(res, /^unknown session/.test(message) ? 404 : 400, { error: message });
		}
	}

	private serveStatic(res: http.ServerResponse, p: string, method: string): void {
		const entry = Object.hasOwn(STATIC, p) ? STATIC[p] : undefined;
		if (!entry) throw new HttpError(404, "not found");
		if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "use GET", { allow: "GET, HEAD" });
		let body: Buffer;
		try {
			body = fs.readFileSync(path.join(this.deps.staticDir, entry.file));
		} catch {
			throw new HttpError(404, `${entry.file} is missing next to server.js (build the extension: node build.mjs)`);
		}
		res.writeHead(200, {
			...BASE_HEADERS,
			"cache-control": "no-cache",
			"content-type": entry.type,
			"content-length": String(body.length),
			...(entry.file === "mobile.html" ? HTML_HEADERS : {}),
		});
		res.end(method === "HEAD" ? undefined : body);
	}

	private async pair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const ip = this.clientAddress(req);
		this.checkLock(ip);
		this.checkSameOrigin(req);
		const body = await readJson(req);
		const token = typeof body.token === "string" ? body.token : "";
		if (!tokenMatches(token, this.cfg.token)) {
			this.recordFailure(ip);
			throw new HttpError(401, "invalid token");
		}
		this.recordSuccess(ip);
		this.deps.log("remote: paired a browser from", ip);
		res.setHeader("set-cookie", [this.pairingCookie(), ...RemoteServer.clearCookies([LEGACY_REMOTE_COOKIE])]);
		sendJson(res, 200, { ok: true });
	}

	private meta(id: string): SessionMeta {
		const meta = SESSION_ID.test(id) ? readMeta(id) : undefined;
		if (!meta) throw new HttpError(404, `unknown session ${id}`);
		return meta;
	}

	private async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, method: string): Promise<void> {
		const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
		const [top, id, action, extra] = parts;
		const allow = (allowed: string) => {
			if (method !== allowed) throw new HttpError(405, `use ${allowed}`, { allow: allowed });
		};
		if (extra !== undefined) throw new HttpError(404, "not found");
		if (top === "sessions" && id === undefined) {
			if (method === "POST") return this.create(req, res);
			allow("GET");
			return sendJson(res, 200, this.deps.sessions());
		}
		if (top === "projects" && id === undefined) {
			allow("GET");
			return sendJson(res, 200, this.projects());
		}
		if (top === "events" && id === undefined) {
			allow("GET");
			return this.listEvents(req, res);
		}
		if (top === "status" && id === undefined) {
			allow("GET");
			return sendJson(res, 200, this.deps.status());
		}
		if (top === "models" && id === undefined) {
			allow("GET");
			return sendJson(res, 200, await listModels(os.homedir(), url.searchParams.get("q") || undefined));
		}
		if (top !== "sessions" || id === undefined) throw new HttpError(404, "not found");
		if (action === undefined) {
			allow("GET");
			const meta = this.meta(id);
			const info = this.deps.sessions().find(i => i.meta.id === id);
			return sendJson(res, 200, { info, snapshot: await this.snapshot(meta, messageLimit(url)) });
		}
		if (action === "events") {
			allow("GET");
			return this.sessionEvents(req, res, this.meta(id), messageLimit(url));
		}
		allow("POST");
		const meta = this.meta(id);
		const body = await readJson(req);
		const { control } = this.deps;
		switch (action) {
			case "prompt": {
				const text = optionalString(body, "text");
				if (!text?.trim()) throw new HttpError(400, "text is required");
				return sendJson(res, 200, await control.prompt({ id: meta.id, text, mode: body.steer === true ? "steer" : "followUp" }));
			}
			case "abort":
				return sendJson(res, 200, await control.abort({ id: meta.id }));
			case "stop":
				return sendJson(res, 200, await control.stop({ id: meta.id }));
			case "resume":
				return sendJson(res, 200, this.deps.resume(meta.id));
			case "continue": {
				// An interrupted session goes on: its interrupted queued task runs again (the server or host
				// starts it), else the turn a host crash cut short resumes (the host asks omp to finish it).
				const info = this.deps.sessions().find(i => i.meta.id === meta.id);
				if (info?.queue.interrupted) return sendJson(res, 200, { queue: await control.queue({ id: meta.id, ops: [{ op: "run" }] }) });
				return sendJson(res, 200, this.deps.resume(meta.id));
			}
			case "model": {
				const model = optionalString(body, "model");
				if (!model) throw new HttpError(400, "model (provider/id) is required");
				return sendJson(res, 200, { id: meta.id, model, applied: await setSessionModel(meta, model) });
			}
			case "vscode": {
				// The VS Code window on this machine that takes the request when it gains focus; the link
				// opens it from the computer running VS Code (the server's own terminal env doesn't pick it).
				const authority = optionalString(body, "authority");
				if (authority !== undefined && authority !== "" && !isAuthority(authority)) throw new HttpError(400, "authority must be a VS Code remote authority like ssh-remote+box (\"\" for a local window)");
				const win = windowFor({ cwd: meta.cwd, ...(authority !== undefined ? { authority } : {}) }, {});
				requestOpen(meta.id);
				return sendJson(res, 200, { url: vscodeLink(meta, win), authority: win?.authority ?? null, windowAt: win?.at || null });
			}
			case "mode": {
				if (!isPermissionMode(body.mode)) throw new HttpError(400, "mode must be ask, edits, plan or auto");
				if (!(await setSessionPermissionMode(meta, body.mode))) throw new HttpError(409, meta.permissionMode ? "the session host is unreachable" : "this session's host predates permission modes; stop and resume it first");
				return sendJson(res, 200, { mode: body.mode });
			}
			case "ui": {
				if (typeof body.id !== "string" || !body.id) throw new HttpError(400, "id (the dialog's id) is required");
				if (meta.status === "stopped") throw new HttpError(409, "the session is stopped");
				if (!(await sendToHost(meta, { t: "ui_response", res: { ...body, id: body.id } }))) throw new HttpError(502, "the session host is unreachable");
				return sendJson(res, 200, { sent: true });
			}
			default:
				throw new HttpError(404, "not found");
		}
	}

	private async create(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const body = await readJson(req);
		const raw = optionalString(body, "cwd");
		if (!raw) throw new HttpError(400, "cwd is required");
		const cwd = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
		if (!path.isAbsolute(cwd)) throw new HttpError(400, "cwd must be an absolute path (or start with ~/)");
		if (body.mode !== undefined && body.mode !== null && !isPermissionMode(body.mode)) throw new HttpError(400, "mode must be ask, edits, plan or auto");
		const mode = isPermissionMode(body.mode) ? body.mode : undefined;
		const result = await this.deps.control.create({ cwd, prompt: optionalString(body, "prompt"), title: optionalString(body, "title"), task: optionalString(body, "task"), mode });
		sendJson(res, 201, result);
	}

	private projects(): RemoteProject[] {
		return recentProjects();
	}

	private async snapshot(meta: SessionMeta, limit: number): Promise<RemoteSnapshot> {
		if (meta.status === "stopped" || !meta.socket) return stoppedSnapshot(meta, limit);
		try {
			const { conn, snapshot } = await HostConnection.open(meta.socket, "omp-sessions-server/remote");
			conn.close();
			return slimSnapshot(snapshot, limit);
		} catch {
			return stoppedSnapshot(readMeta(meta.id) ?? meta, limit);
		}
	}

	// ---------- server-sent events ----------

	private openStream(req: http.IncomingMessage, res: http.ServerResponse): void {
		req.socket.setNoDelay(true);
		res.writeHead(200, { ...BASE_HEADERS, "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no", connection: "keep-alive" });
		res.write("retry: 3000\n\n");
		this.streams.add(res);
		const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
		res.on("close", () => {
			clearInterval(heartbeat);
			this.streams.delete(res);
			this.listStreams.delete(res);
		});
	}

	private writeEvent(res: http.ServerResponse, event: string, json: string): void {
		if (res.destroyed || res.writableEnded) return;
		if (res.writableLength > MAX_STREAM_BACKLOG) {
			res.destroy();
			return;
		}
		res.write(`event: ${event}\ndata: ${json}\n\n`);
	}

	private listEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
		this.openStream(req, res);
		this.listStreams.add(res);
		this.writeEvent(res, "sessions", JSON.stringify(this.deps.sessions()));
	}

	private async sessionEvents(req: http.IncomingMessage, res: http.ServerResponse, meta: SessionMeta, limit: number): Promise<void> {
		const ended = (reason: string, snapshot: RemoteSnapshot) => {
			this.openStream(req, res);
			this.writeEvent(res, "host", JSON.stringify(snapshot));
			this.writeEvent(res, "end", JSON.stringify({ reason }));
			res.end();
		};
		if (meta.status === "stopped" || !meta.socket) return ended("stopped", stoppedSnapshot(meta, limit));
		let opened: { conn: HostConnection; snapshot: Snapshot };
		try {
			// Not `omp-sessions-server…`: a phone following the session counts as a viewer (no auto-stop).
			opened = await HostConnection.open(meta.socket, "omp-sessions-remote");
		} catch {
			return ended("stopped", stoppedSnapshot(readMeta(meta.id) ?? meta, limit));
		}
		const { conn, snapshot } = opened;
		if (req.socket.destroyed) {
			conn.close();
			return;
		}
		this.openStream(req, res);
		this.writeEvent(res, "host", JSON.stringify(slimSnapshot(snapshot, limit)));
		conn.onMessage(msg => {
			const slim = slimHostMessage(msg, limit);
			if (slim) this.writeEvent(res, "host", JSON.stringify(slim));
		});
		conn.onClose(() => {
			this.writeEvent(res, "end", JSON.stringify({ reason: "session host closed" }));
			res.end();
		});
		res.on("close", () => conn.close());
	}
}
