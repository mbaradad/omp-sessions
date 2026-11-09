// AO's own dashboard (the web UI of AO's desktop app) served by Switchyard on a loopback port, so a browser
// that is not on this machine can show it: a VS Code webview over Remote-SSH (asExternalUri forwards the
// port), the Hermes dashboard (its plugin proxies `/api/plugins/switchyard/ao/…` here, behind Hermes's auth).
//
// AO's UI is the renderer of its Electron app (`frontend/` in the AO repo), installed from AO's official
// release by src/ao/dashboard-install.ts into `<switchyard home>/ao-dashboard/renderer/`. Outside Electron it
// needs three things, all done here without changing AO:
// - The daemon on the same origin. The server reverse-proxies the daemon's API (`/api/…` REST and SSE, the
//   `/mux` terminal WebSocket, `/healthz`, `/readyz`) and drops the browser's `Origin` and `Sec-Fetch-*`
//   headers, so the daemon sees a native client: its loopback listener accepts browser requests only from
//   AO's own renderer origin (AO_ALLOWED_ORIGINS, `app://renderer`). The daemon's browser check moves here:
//   loopback `Host` names only (DNS rebinding) and no cross-site requests (CSRF), see `refusal`.
// - A daemon status. The renderer learns the daemon's port from the Electron preload (`window.ao.daemon`);
//   without it AO's own browser fallback reports "stopped". The shim (`shimModule`) loads that fallback
//   first (the `bridge-*.js` chunk; ES modules are evaluated once, so the app gets the same object) and
//   replaces its `daemon.getStatus`/`onStatus` with this server's status.
// - Same-origin URLs. The renderer builds every daemon URL as `http://127.0.0.1:<port>/…`; the shim rewrites
//   those (fetch, XHR, EventSource, WebSocket, src/href attributes, window.open) to the page's own base URL,
//   which also makes the UI work under a path prefix such as Hermes's.
// Switchyard owns AO's chat hibernation (config `hibernation`, G28): the renderer's sync of its Developer
// Mode to `PATCH /api/v1/settings/chat-hibernation` is answered with the current settings, not forwarded.
// What needs the Electron main process stays unavailable, as in AO's own browser preview: the embedded
// browser panel, opening local folders and editors, desktop notifications, cloud sign-in.
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { type SwitchyardConfig, readSwitchyardConfig } from "./config";
import { findDaemon } from "./daemon";
import { switchyardHome } from "./native";

export const DASHBOARD_DEFAULT_PORT = 3012;
export const INSTALL_COMMAND = "switchyard dashboard install";
/** This server's own status, `DashboardStatus` (the shim polls it too). */
export const STATUS_PATH = "/switchyard-ao-dashboard/status";
const SHIM_PATH = "/switchyard-ao-shim.js";
const HOST = "127.0.0.1";

export function dashboardEnabled(config: SwitchyardConfig = readSwitchyardConfig()): boolean {
	return config.dashboard !== "off";
}

export function dashboardPort(config: SwitchyardConfig = readSwitchyardConfig()): number {
	return config.dashboardPort ?? DASHBOARD_DEFAULT_PORT;
}

export function dashboardUrl(port = dashboardPort()): string {
	return `http://${HOST}:${port}/`;
}

/** `<switchyard home>/ao-dashboard`: `renderer/` (AO's UI) and `install.json` (what it is). */
export function dashboardDir(home = switchyardHome()): string {
	return path.join(home, "ao-dashboard");
}

export function rendererDir(home = switchyardHome()): string {
	return path.join(dashboardDir(home), "renderer");
}

/** `install.json`, written by src/ao/dashboard-install.ts. */
export interface DashboardInstall {
	/** AO's version (the app's package.json), when known. */
	version: string | null;
	/** Where it came from: a release URL or a local path. */
	source: string;
	installedAt: string;
}

/** The installed renderer, or undefined when there is none (no index.html). */
export function readDashboardInstall(home = switchyardHome()): DashboardInstall | undefined {
	if (!fs.existsSync(path.join(rendererDir(home), "index.html"))) return undefined;
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(path.join(dashboardDir(home), "install.json"), "utf8"));
		const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		return { version: typeof r.version === "string" ? r.version : null, source: typeof r.source === "string" ? r.source : "unknown", installedAt: typeof r.installedAt === "string" ? r.installedAt : "" };
	} catch {
		return { version: null, source: "unknown", installedAt: "" };
	}
}

/** `GET STATUS_PATH`. */
export interface DashboardStatus {
	installed: boolean;
	version: string | null;
	source: string | null;
	/** AO answers. */
	daemon: boolean;
	daemonPort?: number;
	daemonPid?: number;
	/** The port this server listens on. */
	port: number;
}

/** Asks the dashboard server on `port` for its status; undefined when nothing (or something else) answers. */
export async function probeDashboard(port = dashboardPort(), timeoutMs = 2_000): Promise<DashboardStatus | undefined> {
	try {
		const response = await fetch(`http://${HOST}:${port}${STATUS_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		return body && typeof body === "object" && "installed" in body && typeof body.installed === "boolean" ? (body as DashboardStatus) : undefined;
	} catch {
		return undefined;
	}
}

// ---------- request policy ----------

/** A `Host` header naming this machine's loopback (any port): what a browser sends here directly or through a port forward. */
export function loopbackHost(host: string | undefined): boolean {
	const m = host ? /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::\d{1,5})?$/i.exec(host) : null;
	if (!m) return false;
	const name = m[1].toLowerCase();
	return name === "127.0.0.1" || name === "[::1]" || name === "localhost" || name.endsWith(".localhost");
}

export interface PolicyRequest {
	method?: string;
	url?: string;
	headers: http.IncomingHttpHeaders;
}

/**
 * Why a request is refused, or undefined. The daemon trusts loopback clients without a browser origin;
 * this server strips that origin, so it refuses what the daemon would: a `Host` that isn't loopback (a DNS
 * rebinding page), an `Origin` other than this server's (another site's page), and a request the browser
 * marks as cross-site or same-site. The one cross-site request allowed is loading the page itself (`GET /`
 * as a document or frame), which is how a VS Code webview or another page embeds it.
 */
export function refusal(req: PolicyRequest): string | undefined {
	const host = req.headers.host;
	if (!loopbackHost(host)) return `Host ${host ?? "(none)"} is not a loopback name`;
	const origin = req.headers.origin;
	if (origin !== undefined) {
		let originHost: string | undefined;
		try {
			originHost = new URL(origin).host;
		} catch {
			originHost = undefined;
		}
		if (originHost !== host) return `Origin ${origin} is not this server`;
	}
	const site = String(req.headers["sec-fetch-site"] ?? "");
	if (site === "cross-site" || site === "same-site") {
		const dest = String(req.headers["sec-fetch-dest"] ?? "");
		const pathname = (req.url ?? "/").split("?")[0];
		const pageLoad = (req.method === "GET" || req.method === "HEAD") && (dest === "document" || dest === "iframe") && (pathname === "/" || pathname === "/index.html");
		if (!pageLoad) return `a ${site} request`;
	}
	return undefined;
}

// ---------- proxying ----------

/** Paths served by the daemon; everything else is AO's UI (static files) or this server's own. */
export function isDaemonPath(pathname: string): boolean {
	return pathname.startsWith("/api/") || pathname === "/mux" || pathname.startsWith("/mux/") || pathname === "/healthz" || pathname === "/readyz";
}

/** Request headers never forwarded to the daemon: the browser's identity (it would be refused or is not AO's business) and hop-by-hop headers. */
const DROP_REQUEST = new Set(["host", "origin", "referer", "cookie", "authorization", "proxy-authorization", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-prefix", "x-real-ip", "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "trailer", "upgrade"]);

/** The headers a browser request is forwarded to the daemon with: a native client's (no Origin, no Sec-Fetch-*). `upgrade` keeps a WebSocket handshake's. */
export function daemonRequestHeaders(headers: http.IncomingHttpHeaders, daemonPort: number, upgrade = false): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || DROP_REQUEST.has(name) || name.startsWith("sec-fetch-")) continue;
		out[name] = value;
	}
	out.host = `${HOST}:${daemonPort}`;
	if (upgrade) {
		out.connection = "Upgrade";
		out.upgrade = headers.upgrade ?? "websocket";
	}
	return out;
}

export function clientResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) if (value !== undefined && !DROP_RESPONSE.has(name)) out[name] = value;
	return out;
}

// ---------- AO's index.html and the shim ----------

/** The chunk holding AO's preload fallback (`frontend/src/renderer/lib/bridge.ts`), from index.html's module preloads. */
export function bridgeChunk(html: string): string | undefined {
	return /\b(?:src|href)="(\.\/assets\/bridge-[\w-]+\.js)"/.exec(html)?.[1];
}

/** AO's index.html with the shim loaded before AO's own entry module (module scripts run in document order). */
export function dashboardIndex(html: string): string {
	const at = html.indexOf('<script type="module"');
	if (at < 0) throw new Error("AO's index.html has no module script");
	return `${html.slice(0, at)}<script type="module" src=".${SHIM_PATH}"></script>\n\t\t${html.slice(at)}`;
}

/** The page's settings for `installShim`. */
interface ShimConfig {
	statusUrl: string;
	pollMs: number;
}

/**
 * Runs in the page (serialized with `toString`, so it must not reference anything outside itself). `bridge` is
 * the module namespace of AO's bridge chunk.
 */
function installShim(bridge: Record<string, unknown>, cfg: ShimConfig): void {
	const base = new URL(".", location.href).href.replace(/\/$/, "");
	let daemonPort = 0;
	const loopback = () => new RegExp(`^(?:http|ws)s?://(?:127\\.0\\.0\\.1|localhost|ao-events\\.localhost|\\[::1\\]):${daemonPort}(?=[/?#]|$)`, "i");
	const rewrite = (url: string): string => {
		if (!daemonPort) return url;
		const m = loopback().exec(url);
		if (!m) return url;
		return (/^ws/i.test(url) ? base.replace(/^http/, "ws") : base) + url.slice(m[0].length);
	};
	const win = window;
	const realFetch = win.fetch;
	win.fetch = async function (this: Window, input: RequestInfo | URL, init?: RequestInit) {
		if (typeof input === "string") return realFetch.call(this, rewrite(input), init);
		if (input instanceof URL) return realFetch.call(this, rewrite(input.href), init);
		const url = rewrite(input.url);
		if (url === input.url) return realFetch.call(this, input, init);
		// As AO's own runtimeFetch rebases: copy the fields and buffer the body (`new Request(url, request)` with a
		// streamed body needs `duplex`, and the request fails).
		const body = input.method === "GET" || input.method === "HEAD" ? undefined : await input.arrayBuffer();
		const { method, headers, signal, credentials, cache, redirect, referrerPolicy, integrity, keepalive } = input;
		return realFetch.call(this, url, { method, headers, body, signal, credentials, cache, redirect, referrerPolicy, integrity, keepalive, ...init });
	};
	const RealEventSource = win.EventSource;
	win.EventSource = class extends RealEventSource {
		constructor(url: string | URL, init?: EventSourceInit) {
			super(rewrite(String(url)), init);
		}
	};
	const RealWebSocket = win.WebSocket;
	win.WebSocket = class extends RealWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(rewrite(String(url)), protocols);
		}
	};
	const realOpen = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...args: unknown[]) => void;
	XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
		realOpen.call(this, method, rewrite(String(url)), ...rest);
	} as typeof XMLHttpRequest.prototype.open;
	const realSetAttribute = Element.prototype.setAttribute;
	Element.prototype.setAttribute = function (name: string, value: string) {
		realSetAttribute.call(this, name, (name === "src" || name === "href" || name === "poster") && typeof value === "string" ? rewrite(value) : value);
	};
	for (const proto of [HTMLImageElement.prototype, HTMLIFrameElement.prototype, HTMLMediaElement.prototype, HTMLSourceElement.prototype, HTMLScriptElement.prototype]) {
		const desc = Object.getOwnPropertyDescriptor(proto, "src");
		if (!desc?.set || !desc.get) continue;
		const set = desc.set;
		Object.defineProperty(proto, "src", { ...desc, set(this: Element, v: unknown) { set.call(this, rewrite(String(v))); } });
	}
	const realWindowOpen = win.open;
	win.open = function (this: Window, url?: string | URL, target?: string, features?: string) {
		return realWindowOpen.call(this, url === undefined ? url : rewrite(String(url)), target, features);
	};

	interface Status { state: string; port?: number; pid?: number; ipv6Loopback?: boolean; message?: string; code?: string }
	const readStatus = async (): Promise<Status> => {
		try {
			const s: unknown = await (await realFetch(cfg.statusUrl, { cache: "no-store" })).json();
			if (s && typeof s === "object" && "daemon" in s && s.daemon === true && "daemonPort" in s && typeof s.daemonPort === "number") {
				daemonPort = s.daemonPort;
				return { state: "ready", port: s.daemonPort, pid: "daemonPid" in s && typeof s.daemonPid === "number" ? s.daemonPid : undefined, ipv6Loopback: false };
			}
			return { state: "error", code: "daemon_unreachable", message: "AO's daemon is not running on omp's machine (any switchyard command starts it, or: systemctl --user start ao-daemon)." };
		} catch {
			return { state: "error", code: "daemon_unreachable", message: "Switchyard's AO dashboard server does not answer." };
		}
	};
	const ao = Object.values(bridge).find(
		(v): v is { daemon: Record<string, unknown> } => !!v && typeof v === "object" && "daemon" in v && !!v.daemon && typeof v.daemon === "object" && "getStatus" in v.daemon && typeof v.daemon.getStatus === "function",
	);
	if (!ao) {
		console.error("Switchyard: AO's bridge has no daemon status to replace; this AO version is not supported by the dashboard shim");
		return;
	}
	ao.daemon.getStatus = readStatus;
	ao.daemon.onStatus = (listener: (s: Status) => void) => {
		let last = "";
		const timer = setInterval(async () => {
			const s = await readStatus();
			const key = `${s.state}:${s.port ?? ""}:${s.pid ?? ""}`;
			if (key !== last) {
				last = key;
				listener(s);
			}
		}, cfg.pollMs);
		return () => clearInterval(timer);
	};
	// Starting, stopping and restarting the daemon is Switchyard's job (systemd, the planner), not the page's.
	ao.daemon.start = ao.daemon.restart = readStatus;
	ao.daemon.stop = readStatus;
}

/** The shim module for an index.html whose bridge chunk is `bridge` (`./assets/bridge-….js`). */
export function shimModule(bridge: string): string {
	const cfg: ShimConfig = { statusUrl: `.${STATUS_PATH}`, pollMs: 5_000 };
	return `// Switchyard's shim for AO's UI outside Electron (src/ao/dashboard.ts).\nimport * as bridge from ${JSON.stringify(bridge)};\n(${installShim.toString()})(bridge, ${JSON.stringify(cfg)});\n`;
}

function notInstalledPage(): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AO dashboard</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:15vh auto;padding:0 24px;color:#222}code{background:#eee;padding:2px 6px;border-radius:4px}@media(prefers-color-scheme:dark){body{background:#1e1e1e;color:#ddd}code{background:#333}}</style>
</head><body><h1>AO dashboard not installed</h1><p>Switchyard serves Agent Orchestrator's own UI here once it is installed. On omp's machine, run:</p><p><code>${INSTALL_COMMAND}</code></p><p>then reload this page.</p></body></html>`;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
};

/** The file under `root` that `pathname` names, or undefined (outside it, or not a file). */
export function staticFile(root: string, pathname: string): string | undefined {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return undefined;
	}
	if (decoded.includes("\0")) return undefined;
	const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
	if (file !== root && !file.startsWith(root + path.sep)) return undefined;
	try {
		return fs.statSync(file).isFile() ? file : undefined;
	} catch {
		return undefined;
	}
}

// ---------- the server ----------

export interface DaemonTarget {
	port: number;
	pid: number;
}

export interface DashboardServerOptions {
	/** Switchyard's home (the renderer's location). Default `switchyardHome()`. */
	home?: string;
	/** The AO daemon to proxy to. Default: `findDaemon()` (run file, then AO_PORT), remembered for 3 s. */
	daemon?: () => Promise<DaemonTarget | undefined>;
	log?: (...parts: unknown[]) => void;
}

function cachedDaemon(): () => Promise<DaemonTarget | undefined> {
	let at = 0;
	let last: Promise<DaemonTarget | undefined> = Promise.resolve(undefined);
	return () => {
		if (Date.now() - at > 3_000) {
			at = Date.now();
			last = findDaemon({ probeTimeoutMs: 1_000 }).then(
				d => (d ? { port: d.port, pid: d.pid } : undefined),
				() => undefined,
			);
		}
		return last;
	};
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

/** The dashboard server (not listening yet). */
export function createDashboardServer(opts: DashboardServerOptions = {}): http.Server {
	const home = opts.home ?? switchyardHome();
	const root = rendererDir(home);
	const daemon = opts.daemon ?? cachedDaemon();
	const log = opts.log ?? (() => {});

	const proxy = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => {
		const target = await daemon();
		if (!target) return sendJson(res, 502, { error: "AO's daemon is not running", code: "DAEMON_UNREACHABLE" });
		if (req.method === "PATCH" && pathname === "/api/v1/settings/chat-hibernation") {
			// Switchyard owns chat hibernation (G28): answer with the daemon's settings, unchanged.
			req.resume();
			const upstream = http.request({ host: HOST, port: target.port, path: "/api/v1/settings", headers: { host: `${HOST}:${target.port}` } }, up => {
				res.writeHead(up.statusCode ?? 502, clientResponseHeaders(up.headers));
				up.pipe(res);
			});
			upstream.on("error", err => sendJson(res, 502, { error: String(err) }));
			upstream.end();
			return;
		}
		const upstream = http.request({ host: HOST, port: target.port, method: req.method, path: req.url, headers: daemonRequestHeaders(req.headers, target.port) }, up => {
			res.writeHead(up.statusCode ?? 502, clientResponseHeaders(up.headers));
			// Server-sent events must reach the page as they come.
			if (String(up.headers["content-type"] ?? "").startsWith("text/event-stream")) res.flushHeaders();
			up.pipe(res);
		});
		upstream.on("error", err => {
			if (!res.headersSent) sendJson(res, 502, { error: `AO's daemon: ${err.message}` });
			else res.destroy();
		});
		res.on("close", () => upstream.destroy());
		req.pipe(upstream);
	};

	const server = http.createServer((req, res) => {
		const why = refusal(req);
		if (why) {
			log("dashboard: refused", req.method, req.url, why);
			return sendJson(res, 403, { error: `refused: ${why}` });
		}
		const pathname = new URL(req.url ?? "/", "http://dashboard").pathname;
		if (isDaemonPath(pathname)) {
			void proxy(req, res, pathname);
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
		if (pathname === STATUS_PATH) {
			void daemon().then(target => {
				const install = readDashboardInstall(home);
				const address = server.address();
				const status: DashboardStatus = {
					installed: !!install,
					version: install?.version ?? null,
					source: install?.source ?? null,
					daemon: !!target,
					...(target && { daemonPort: target.port, daemonPid: target.pid }),
					port: address && typeof address === "object" ? address.port : 0,
				};
				sendJson(res, 200, status);
			});
			return;
		}
		let index: string | undefined;
		try {
			index = fs.readFileSync(path.join(root, "index.html"), "utf8");
		} catch {
			index = undefined;
		}
		if (pathname === "/" || pathname === "/index.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			return res.end(index === undefined ? notInstalledPage() : dashboardIndex(index));
		}
		if (pathname === SHIM_PATH) {
			const bridge = index === undefined ? undefined : bridgeChunk(index);
			if (!bridge) return sendJson(res, 404, { error: "AO's UI is not installed, or this AO version has no bridge chunk" });
			res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
			return res.end(shimModule(bridge));
		}
		const file = staticFile(root, pathname);
		if (!file) return sendJson(res, 404, { error: "not found" });
		res.writeHead(200, {
			"content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
			// Vite names assets by content hash.
			"cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
		});
		if (req.method === "HEAD") return res.end();
		fs.createReadStream(file).pipe(res);
	});

	// The terminal mux (and any other WebSocket): the handshake goes to the daemon as a native client's, then bytes flow both ways.
	server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
		const pathname = new URL(req.url ?? "/", "http://dashboard").pathname;
		const why = refusal(req) ?? (isDaemonPath(pathname) ? undefined : "not a daemon path");
		if (why) {
			log("dashboard: refused upgrade", req.url, why);
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		void daemon().then(target => {
			if (!target) {
				socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
				return;
			}
			const upstream = net.connect(target.port, HOST, () => {
				const headers = daemonRequestHeaders(req.headers, target.port, true);
				const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => `${k}: ${x}`) : [`${k}: ${String(v)}`]));
				upstream.write(`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
				if (head.length) upstream.write(head);
				upstream.pipe(socket);
				socket.pipe(upstream);
			});
			upstream.on("error", () => socket.destroy());
			socket.on("error", () => upstream.destroy());
			socket.on("close", () => upstream.destroy());
		});
	});
	return server;
}

export interface DashboardHandle {
	port: number;
	/** Listening now. */
	listening(): boolean;
	/** The last listen error (e.g. the port is taken), cleared once listening. */
	error(): string | undefined;
	close(): void;
}

/**
 * Serves the dashboard on 127.0.0.1:`port` for as long as the process runs (the planner's). A taken port is
 * retried every `retryMs` (another Switchyard home's planner may hold it until it stops).
 */
export function startDashboard(opts: DashboardServerOptions & { port?: number; retryMs?: number } = {}): DashboardHandle {
	const port = opts.port ?? dashboardPort();
	const log = opts.log ?? (() => {});
	const server = createDashboardServer(opts);
	let lastError: string | undefined;
	let retry: NodeJS.Timeout | undefined;
	let closed = false;
	const listen = () => server.listen(port, HOST);
	server.on("listening", () => {
		lastError = undefined;
		log("dashboard: serving AO's UI on", dashboardUrl(port));
	});
	server.on("error", err => {
		const message = "code" in err && err.code === "EADDRINUSE" ? `port ${port} is taken` : String(err);
		if (message !== lastError) log("dashboard: cannot listen:", message);
		lastError = message;
		if (closed) return;
		retry = setTimeout(listen, opts.retryMs ?? 60_000);
		retry.unref();
	});
	listen();
	return {
		port,
		listening: () => server.listening,
		error: () => lastError,
		close: () => {
			closed = true;
			clearTimeout(retry);
			server.close();
			server.closeAllConnections();
		},
	};
}
