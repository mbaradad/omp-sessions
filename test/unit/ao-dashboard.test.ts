// AO's dashboard (src/ao/dashboard.ts, src/ao/dashboard-install.ts): the config keys, the request policy that
// replaces the daemon's browser check, the headers the daemon sees, the served index/shim/static files, the
// proxy (REST, SSE, WebSocket, the chat-hibernation PATCH Switchyard owns) against a fake daemon, and the
// installer on a synthetic AO package (.deb → data.tar → app.asar → renderer).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { readSwitchyardConfig, writeSwitchyardConfig } from "../../src/ao/config";
import {
	DASHBOARD_DEFAULT_PORT,
	bridgeChunk,
	createDashboardServer,
	daemonRequestHeaders,
	dashboardEnabled,
	dashboardIndex,
	dashboardPort,
	dashboardUrl,
	isDaemonPath,
	loopbackHost,
	readDashboardInstall,
	refusal,
	rendererDir,
	shimModule,
	staticFile,
} from "../../src/ao/dashboard";
import { installDashboard, releaseUrl, uninstallDashboard } from "../../src/ao/dashboard-install";

const INDEX = `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<script type="module" crossorigin src="./assets/index-AAAA.js"></script>
<link rel="modulepreload" crossorigin href="./assets/bridge-Cvu0vIgr.js">
</head><body><div id="root"></div></body></html>`;

function tmp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function listen(server: http.Server | net.Server): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		resolve(address && typeof address === "object" ? address.port : 0);
	});
	return promise;
}

function get(port: number, urlPath: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; headers: http.IncomingHttpHeaders; body: string }>();
	const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, res => {
		let text = "";
		res.setEncoding("utf8");
		res.on("data", chunk => (text += chunk));
		res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
	});
	req.on("error", reject);
	req.end(body);
	return promise;
}

test("config: dashboard on by default on port 3012; only on/off and a valid port count", () => {
	const dir = tmp("sy-dash-config-");
	try {
		const file = path.join(dir, "config.json");
		assert.equal(dashboardEnabled(readSwitchyardConfig(file)), true);
		assert.equal(dashboardPort(readSwitchyardConfig(file)), DASHBOARD_DEFAULT_PORT);
		fs.writeFileSync(file, JSON.stringify({ dashboard: "maybe", dashboardPort: 70000 }));
		assert.deepEqual(readSwitchyardConfig(file), {});
		writeSwitchyardConfig({ dashboard: "off", dashboardPort: 3999 }, file);
		const config = readSwitchyardConfig(file);
		assert.equal(dashboardEnabled(config), false);
		assert.equal(dashboardPort(config), 3999);
		assert.equal(dashboardUrl(3999), "http://127.0.0.1:3999/");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("request policy: loopback Host only, no foreign Origin, cross-site only to load the page", () => {
	for (const host of ["127.0.0.1:3012", "localhost:55123", "localhost", "[::1]:3012", "ao.localhost:1"]) assert.equal(loopbackHost(host), true, host);
	for (const host of [undefined, "", "evil.com:3012", "127.0.0.1.evil.com", "10.0.0.2:3012", "localhost.evil.com", "[::2]:1"]) assert.equal(loopbackHost(host), false, String(host));
	const req = (headers: Record<string, string>, url = "/api/v1/projects", method = "GET") => refusal({ method, url, headers: { host: "localhost:5000", ...headers } });
	assert.equal(req({}), undefined, "a native client");
	assert.equal(req({ origin: "http://localhost:5000", "sec-fetch-site": "same-origin" }), undefined, "the page itself");
	assert.match(req({ host: "rebind.example:5000" }) ?? "", /loopback/);
	assert.match(req({ origin: "http://evil.com" }) ?? "", /Origin/);
	assert.match(req({ origin: "http://localhost:5001" }) ?? "", /Origin/, "another port is another origin");
	assert.match(req({ origin: "null" }) ?? "", /Origin/);
	assert.match(req({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "empty" }) ?? "", /cross-site/);
	assert.match(req({ "sec-fetch-site": "same-site", "sec-fetch-dest": "empty" }, "/", "POST") ?? "", /same-site/);
	assert.equal(req({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" }, "/"), undefined, "a webview or page framing the dashboard");
	assert.equal(req({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" }, "/index.html?x=1"), undefined);
	assert.match(req({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" }, "/api/v1/projects") ?? "", /cross-site/, "only the page, not the API");
});

test("daemon headers: the browser's identity and hop-by-hop headers are dropped; a WebSocket handshake keeps its own", () => {
	const headers = daemonRequestHeaders(
		{ host: "localhost:5000", origin: "http://localhost:5000", referer: "http://localhost:5000/", cookie: "a=b", authorization: "Bearer x", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "x-forwarded-for": "1.2.3.4", connection: "keep-alive", accept: "text/event-stream", "last-event-id": "42", "content-type": "application/json" },
		3001,
	);
	assert.deepEqual(headers, { accept: "text/event-stream", "last-event-id": "42", "content-type": "application/json", host: "127.0.0.1:3001" });
	const ws = daemonRequestHeaders({ host: "localhost:5000", origin: "http://localhost:5000", connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "k", "sec-websocket-version": "13" }, 3001, true);
	assert.deepEqual(ws, { "sec-websocket-key": "k", "sec-websocket-version": "13", host: "127.0.0.1:3001", connection: "Upgrade", upgrade: "websocket" });
	assert.equal(isDaemonPath("/api/v1/events"), true);
	assert.equal(isDaemonPath("/mux"), true);
	assert.equal(isDaemonPath("/shutdown"), false, "never the daemon's shutdown");
	assert.equal(isDaemonPath("/internal/telemetry/usage-flush"), false);
	assert.equal(isDaemonPath("/assets/index.js"), false);
});

test("index and shim: the shim loads before AO's entry and imports AO's bridge chunk; static files stay inside the renderer", () => {
	assert.equal(bridgeChunk(INDEX), "./assets/bridge-Cvu0vIgr.js");
	assert.equal(bridgeChunk("<html></html>"), undefined);
	const page = dashboardIndex(INDEX);
	assert.ok(page.indexOf('src="./switchyard-ao-shim.js"') < page.indexOf("./assets/index-AAAA.js"), "relative, and first");
	assert.throws(() => dashboardIndex("<html></html>"), /no module script/);
	const shim = shimModule("./assets/bridge-Cvu0vIgr.js");
	assert.match(shim, /^\/\/ .*\nimport \* as bridge from "\.\/assets\/bridge-Cvu0vIgr\.js";\n\(function/);
	assert.match(shim, /"statusUrl":".\/switchyard-ao-dashboard\/status"/, "relative: works under a path prefix");
	// The function is serialized on its own: it must not lean on anything outside itself.
	assert.doesNotThrow(() => new Function(`return ${shim.slice(shim.indexOf("(function") + 1, shim.lastIndexOf(")(bridge"))};`));
	const root = tmp("sy-dash-static-");
	try {
		fs.mkdirSync(path.join(root, "assets"));
		fs.writeFileSync(path.join(root, "assets", "a b.js"), "x");
		fs.writeFileSync(path.join(path.dirname(root), `${path.basename(root)}-secret`), "s");
		assert.equal(staticFile(root, "/assets/a%20b.js"), path.join(root, "assets", "a b.js"));
		assert.equal(staticFile(root, "/assets"), undefined, "a folder");
		assert.equal(staticFile(root, "/../etc/passwd"), undefined);
		assert.equal(staticFile(root, `/..%2F${path.basename(root)}-secret`), undefined);
		assert.equal(staticFile(root, "/%E0%A4%A"), undefined, "bad escapes");
	} finally {
		fs.rmSync(`${root}-secret`, { force: true });
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("server: serves AO's UI with the shim, proxies REST/SSE/WebSocket to the daemon as a native client, keeps chat hibernation", async () => {
	const home = tmp("sy-dash-server-");
	const seen: http.IncomingHttpHeaders[] = [];
	const paths: string[] = [];
	const daemon = http.createServer((req, res) => {
		seen.push(req.headers);
		paths.push(`${req.method} ${req.url}`);
		if (req.url?.startsWith("/api/v1/events")) {
			res.writeHead(200, { "content-type": "text/event-stream", "transfer-encoding": "chunked" });
			res.write("id: 1\nevent: cursor\ndata: {}\n\n");
			return; // stays open, like the daemon's feed
		}
		if (req.url === "/api/v1/settings") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ chatHibernation: false }));
		}
		res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
		res.end(JSON.stringify({ projects: [] }));
	});
	daemon.on("upgrade", (req, socket) => {
		seen.push(req.headers);
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
		socket.on("data", chunk => socket.write(chunk));
		// Like the daemon: a closed peer closes the connection (Node's server sockets stay half open).
		socket.on("end", () => socket.end());
	});
	const daemonPort = await listen(daemon);
	const server = createDashboardServer({ home, daemon: async () => ({ port: daemonPort, pid: 4242 }) });
	const port = await listen(server);
	try {
		// Not installed yet: a page that says so, and the status.
		const missing = await get(port, "/");
		assert.equal(missing.status, 200);
		assert.match(missing.body, /switchyard dashboard install/);
		assert.deepEqual(JSON.parse((await get(port, "/switchyard-ao-dashboard/status")).body), { installed: false, version: null, source: null, daemon: true, daemonPort, daemonPid: 4242, port });

		fs.mkdirSync(path.join(rendererDir(home), "assets"), { recursive: true });
		fs.writeFileSync(path.join(rendererDir(home), "index.html"), INDEX);
		fs.writeFileSync(path.join(rendererDir(home), "assets", "bridge-Cvu0vIgr.js"), "export const a = {};");
		const index = await get(port, "/", { "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" });
		assert.match(index.body, /switchyard-ao-shim\.js/);
		assert.equal(index.headers["cache-control"], "no-store");
		const shim = await get(port, "/switchyard-ao-shim.js");
		assert.match(shim.headers["content-type"] ?? "", /javascript/);
		assert.match(shim.body, /bridge-Cvu0vIgr\.js/);
		const asset = await get(port, "/assets/bridge-Cvu0vIgr.js");
		assert.equal(asset.body, "export const a = {};");
		assert.match(asset.headers["cache-control"] ?? "", /immutable/);
		assert.equal((await get(port, "/assets/nope.js")).status, 404);
		assert.equal((await get(port, "/switchyard-ao-dashboard/status")).body.includes('"installed":true'), true);

		// REST: forwarded without the browser's identity.
		const projects = await get(port, "/api/v1/projects?x=1", { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", cookie: "hermes=1" });
		assert.equal(projects.status, 200);
		assert.equal(paths.at(-1), "GET /api/v1/projects?x=1");
		const forwarded = seen.at(-1) ?? {};
		assert.equal(forwarded.origin, undefined);
		assert.equal(forwarded["sec-fetch-site"], undefined);
		assert.equal(forwarded.cookie, undefined);
		assert.equal(forwarded.host, `127.0.0.1:${daemonPort}`);
		// Refused before the daemon sees it.
		const before = paths.length;
		assert.equal((await get(port, "/api/v1/projects", { host: "evil.example" })).status, 403);
		assert.equal((await get(port, "/api/v1/sessions", { "sec-fetch-site": "cross-site", "sec-fetch-dest": "empty" }, "POST", "{}")).status, 403);
		assert.equal((await get(port, "/shutdown", {}, "POST")).status, 405, "never forwarded");
		assert.equal(paths.length, before);

		// Chat hibernation is Switchyard's: the PATCH is answered with the settings, never forwarded.
		const patched = await get(port, "/api/v1/settings/chat-hibernation", { "content-type": "application/json" }, "PATCH", '{"enabled":true}');
		assert.deepEqual(JSON.parse(patched.body), { chatHibernation: false });
		assert.equal(paths.at(-1), "GET /api/v1/settings");

		// SSE: the first event arrives while the stream stays open.
		const { promise: firstEvent, resolve: gotEvent } = Promise.withResolvers<string>();
		const sse = http.get({ host: "127.0.0.1", port, path: "/api/v1/events?after=latest", headers: { accept: "text/event-stream" } }, res => {
			res.setEncoding("utf8");
			res.once("data", chunk => gotEvent(String(chunk)));
		});
		assert.match(await firstEvent, /event: cursor/);
		sse.destroy();

		// WebSocket: the handshake reaches the daemon without the page's Origin, then bytes flow both ways.
		const ws = net.connect(port, "127.0.0.1");
		const { promise: echoed, resolve: gotEcho } = Promise.withResolvers<string>();
		let buffer = "";
		ws.on("data", chunk => {
			buffer += chunk.toString("latin1");
			if (buffer.includes("\r\n\r\n") && buffer.endsWith("ping")) gotEcho(buffer);
		});
		ws.write(`GET /mux HTTP/1.1\r\nHost: localhost:${port}\r\nOrigin: http://localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n`);
		ws.once("data", () => ws.write("ping"));
		assert.match(await echoed, /^HTTP\/1\.1 101/);
		ws.destroy();
		const handshake = seen.at(-1) ?? {};
		assert.equal(handshake.origin, undefined);
		assert.equal(handshake["sec-websocket-key"], "k");
		// A WebSocket from another site is refused.
		const bad = net.connect(port, "127.0.0.1");
		const { promise: refused, resolve: gotRefusal } = Promise.withResolvers<string>();
		bad.on("data", chunk => gotRefusal(chunk.toString("latin1")));
		bad.write(`GET /mux HTTP/1.1\r\nHost: localhost:${port}\r\nOrigin: http://evil.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n`);
		assert.match(await refused, /^HTTP\/1\.1 403/);
		bad.destroy();
	} finally {
		server.closeAllConnections();
		server.close();
		daemon.closeAllConnections();
		daemon.close();
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("server: AO's daemon down → 502 for its API and a status that says so", async () => {
	const home = tmp("sy-dash-down-");
	const server = createDashboardServer({ home, daemon: async () => undefined });
	const port = await listen(server);
	try {
		assert.equal((await get(port, "/api/v1/projects")).status, 502);
		assert.equal(JSON.parse((await get(port, "/switchyard-ao-dashboard/status")).body).daemon, false);
	} finally {
		server.closeAllConnections();
		server.close();
		fs.rmSync(home, { recursive: true, force: true });
	}
});

// ---------- a synthetic AO package ----------

function asar(files: Record<string, string>): Buffer {
	type Node = { files: Record<string, Node> } | { size: number; offset: string };
	const root: { files: Record<string, Node> } = { files: {} };
	const chunks: Buffer[] = [];
	let offset = 0;
	for (const [name, text] of Object.entries(files)) {
		const parts = name.split("/");
		let dir = root;
		for (const part of parts.slice(0, -1)) {
			const next = dir.files[part];
			dir = next && "files" in next ? next : (dir.files[part] = { files: {} });
		}
		const data = Buffer.from(text);
		dir.files[parts.at(-1) ?? ""] = { size: data.length, offset: String(offset) };
		chunks.push(data);
		offset += data.length;
	}
	const json = Buffer.from(JSON.stringify(root));
	const padded = Math.ceil(json.length / 4) * 4;
	const head = Buffer.alloc(16 + padded);
	head.writeUInt32LE(4, 0);
	head.writeUInt32LE(8 + padded, 4);
	head.writeUInt32LE(4 + padded, 8);
	head.writeUInt32LE(json.length, 12);
	json.copy(head, 16);
	return Buffer.concat([head, ...chunks]);
}

function tarEntry(name: string, data: Buffer, type = "0"): Buffer {
	const header = Buffer.alloc(512);
	header.write(name.slice(0, 100), 0, "utf8");
	header.write("0000644\0", 100);
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write(type, 156);
	header.write("ustar\0", 257);
	return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function deb(appAsar: Buffer): Buffer {
	const longName = `./usr/lib/agent-orchestrator/${"deep/".repeat(20)}resources/app.asar`;
	const tar = Buffer.concat([
		tarEntry("./usr/share/doc/readme", Buffer.from("not this")),
		// A GNU long name ahead of the archive, as tar writes for paths over 100 bytes.
		tarEntry("././@LongLink", Buffer.from(`${longName}\0`), "L"),
		tarEntry("short-name-replaced", appAsar),
		Buffer.alloc(1024),
	]);
	const member = (name: string, data: Buffer) => {
		const header = Buffer.from(`${name.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\`\n`, "latin1");
		return Buffer.concat([header, data, data.length % 2 ? Buffer.from("\n") : Buffer.alloc(0)]);
	};
	return Buffer.concat([Buffer.from("!<arch>\n"), member("debian-binary", Buffer.from("2.0\n")), member("control.tar.gz", zlib.gzipSync(Buffer.alloc(1024))), member("data.tar.gz", zlib.gzipSync(tar))]);
}

test("install: AO's renderer out of a .deb (ar → data.tar → app.asar), its version recorded; replaced on reinstall; uninstall", async () => {
	const home = tmp("sy-dash-install-");
	try {
		const app = asar({
			"package.json": JSON.stringify({ name: "agent-orchestrator", version: "9.8.7" }),
			".vite/build/main.js": "main process",
			".vite/renderer/main_window/index.html": INDEX,
			".vite/renderer/main_window/assets/bridge-Cvu0vIgr.js": "export const a = {};",
		});
		const pkg = path.join(home, "ao.deb");
		fs.writeFileSync(pkg, deb(app));
		const installed = await installDashboard({ from: pkg, home });
		assert.equal(installed.version, "9.8.7");
		assert.equal(installed.source, pkg);
		assert.equal(fs.readFileSync(path.join(rendererDir(home), "index.html"), "utf8"), INDEX);
		assert.equal(fs.readFileSync(path.join(rendererDir(home), "assets", "bridge-Cvu0vIgr.js"), "utf8"), "export const a = {};");
		assert.equal(fs.existsSync(path.join(rendererDir(home), "..", "build")), false, "only the renderer");
		assert.equal(readDashboardInstall(home)?.version, "9.8.7");
		// From a renderer folder (a build of AO's frontend): replaces the previous one, no version.
		const built = path.join(home, "built");
		fs.mkdirSync(built);
		fs.writeFileSync(path.join(built, "index.html"), INDEX.replace("<body>", "<body>built"));
		const again = await installDashboard({ from: built, home });
		assert.equal(again.version, null);
		assert.match(fs.readFileSync(path.join(rendererDir(home), "index.html"), "utf8"), /built/);
		assert.equal(fs.existsSync(path.join(rendererDir(home), "assets")), false, "the old files are gone");
		assert.deepEqual(fs.readdirSync(path.dirname(rendererDir(home))).sort(), ["install.json", "renderer"], "no staging left behind");
		// An AO build without the bridge chunk is refused, and the installed one stays.
		fs.writeFileSync(path.join(built, "index.html"), "<html><script type=module src=./x.js></script></html>");
		await assert.rejects(installDashboard({ from: built, home }), /bridge/);
		assert.match(fs.readFileSync(path.join(rendererDir(home), "index.html"), "utf8"), /built/);
		await assert.rejects(installDashboard({ from: path.join(home, "nothing-here"), home }), /ENOENT/);
		assert.equal(uninstallDashboard(home), true);
		assert.equal(readDashboardInstall(home), undefined);
		assert.equal(uninstallDashboard(home), false);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("install: release URLs", () => {
	assert.equal(releaseUrl(), "https://github.com/OrchestratorInc/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.deb");
	assert.equal(releaseUrl("0.14.10"), "https://github.com/OrchestratorInc/agent-orchestrator/releases/download/v0.14.10/agent-orchestrator-linux-x64.deb");
	assert.equal(releaseUrl("v0.14.10"), releaseUrl("0.14.10"));
	assert.throws(() => releaseUrl("../../evil"), /not a release tag/);
});
