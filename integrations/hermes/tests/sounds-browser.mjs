// The Switchyard page's session sounds in a headless Chromium (`npm run test:hermes:sounds`): the real built dashboard
// bundle (switchyard/dashboard/dist/index.js + style.css) on a harness page that provides what the Hermes dashboard
// does (window.__HERMES_PLUGIN_SDK__, __HERMES_PLUGINS__), against a tiny local server that plays the plugin's
// /sessions endpoint. AudioContext is replaced by a counting fake, so each cue the page plays is observable (a cue is one playSound: the master low-pass at 3800 Hz).
//
// Checks: the bell toggle (title, mute, unmute previews a cue, the choice survives a reload), a working → idle change
// sounds once, a muted page is silent, a question sounds, and TWO tabs of one browser play a change once even though
// the server stamps a different `updatedAt` on each poll (the claim key is the turn id).
//
// Needs react, react-dom and playwright-core, which the repo does not depend on: SWITCHYARD_BROWSER_DEPS=<dir whose
// node_modules has them> (e.g. a scratch `npm install react@18 react-dom@18 playwright-core`), and a Chromium
// (CHROMIUM_PATH, else the newest chrome-headless-shell of ~/.cache/ms-playwright). Skips (exit 0) without them.
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dist = path.join(root, "integrations/hermes/switchyard/dashboard/dist");
const depsDir = process.env.SWITCHYARD_BROWSER_DEPS;

function chromium() {
	if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
	const base = path.join(os.homedir(), ".cache", "ms-playwright");
	const found = fs.existsSync(base) ? fs.readdirSync(base).filter(d => d.startsWith("chromium_headless_shell-")).sort().reverse() : [];
	for (const d of found) {
		const exe = path.join(base, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
		if (fs.existsSync(exe)) return exe;
	}
	return undefined;
}

const exe = chromium();
if (!depsDir || !fs.existsSync(path.join(depsDir, "node_modules", "playwright-core")) || !exe) {
	console.log("hermes sounds browser test skipped: set SWITCHYARD_BROWSER_DEPS (a dir with node_modules/{react,react-dom,playwright-core}) and have a Chromium (CHROMIUM_PATH)");
	process.exit(0);
}
const need = createRequire(path.join(depsDir, "noop.js"));
const { chromium: playwright } = need("playwright-core");
const esbuild = await import("esbuild");

// ---------- the harness page: the dashboard SDK on real React, and a counting AudioContext ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-hermes-sounds-"));
const harnessSrc = path.join(work, "harness.js");
fs.writeFileSync(
	harnessSrc,
	`import * as React from "react";
import { createRoot } from "react-dom/client";
window.__HERMES_PLUGIN_SDK__ = { React, fetchJSON: async (url, init) => {
	const r = await fetch(url, init);
	if (!r.ok) throw new Error("HTTP " + r.status);
	return r.json();
} };
window.__HERMES_PLUGINS__ = { register(name, Page) { createRoot(document.getElementById("root")).render(React.createElement(Page, null)); } };
`,
);
const harnessJs = await esbuild.build({ entryPoints: [harnessSrc], bundle: true, write: false, format: "iife", nodePaths: [path.join(depsDir, "node_modules")], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error" });
const FAKE_AUDIO = `
window.__cues = 0;
window.__cueLog = [];
window.__voices = 0;
class FakeNode { connect(n) { return n; } start() { window.__voices++; } stop() {} disconnect() {} }
const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
window.AudioContext = class {
	constructor() { this.state = "running"; this.currentTime = 0; this.sampleRate = 44100; this.destination = new FakeNode(); }
	resume() { return Promise.resolve(); }
	createGain() { const n = new FakeNode(); n.gain = param(); return n; }
	createBiquadFilter() { const n = new FakeNode(); n.frequency = param(); n.frequency.setValueAtTime = v => { if (v === 3800) { window.__cues++; window.__cueLog.push(Math.round(performance.timeOrigin + performance.now()) % 100000); } }; n.Q = param(); n.gain = param(); return n; }
	createOscillator() { const n = new FakeNode(); n.frequency = param(); n.detune = param(); return n; }
	createBufferSource() { return new FakeNode(); }
	createConvolver() { return new FakeNode(); }
	createDelay() { const n = new FakeNode(); n.delayTime = param(); return n; }
	createWaveShaper() { return new FakeNode(); }
	createStereoPanner() { const n = new FakeNode(); n.pan = param(); return n; }
	createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len), length: len, numberOfChannels: ch }; }
};
`;

// ---------- the plugin's backend, scripted ----------
const server = { sessions: [], turn: 0 };
function session(id, state, turnId) {
	return {
		id,
		title: `session ${id}`,
		cwd: `/work/${id}`,
		cwdLabel: `/work/${id}`,
		project: "work",
		state,
		status: state === "needs_input" ? "waiting" : state,
		cost: 0,
		changedFiles: 0,
		createdAt: 1,
		// A different stamp on every poll, as two clients polling at different moments would see.
		updatedAt: Date.now() + Math.random(),
		turnId,
		tags: [],
		archived: false,
		completed: false,
		queue: { pending: 0, running: 0, done: 0, total: 0 },
	};
}
const httpServer = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://x");
	const send = (type, body) => {
		res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
		res.end(body);
	};
	if (url.pathname === "/") return send("text/html", `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script>${FAKE_AUDIO}</script><script>${harnessJs.outputFiles[0].text}</script><script src="/index.js"></script></body></html>`);
	if (url.pathname === "/index.js") return send("text/javascript", fs.readFileSync(path.join(dist, "index.js")));
	if (url.pathname === "/style.css") return send("text/css", fs.readFileSync(path.join(dist, "style.css")));
	if (url.pathname === "/api/plugins/switchyard/sessions") return send("application/json", JSON.stringify({ sessions: server.sessions.map(s => session(s.id, s.state, s.turnId)), at: Date.now() / 1000 }));
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ detail: "Not Found" }));
});
await new Promise(r => httpServer.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${httpServer.address().port}/`;

// ---------- checks ----------
const results = [];
let failed = false;
const check = (name, ok, detail = "") => {
	results.push(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed = true;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cues = page => page.evaluate(() => window.__cues);
async function until(what, fn, ms = 15_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await sleep(150);
	}
	return false;
}

const browser = await playwright.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
try {
	const context = await browser.newContext();
	const a = await context.newPage();
	a.on("pageerror", e => check("no page errors", false, String(e)));
	server.sessions = [
		{ id: "s1", state: "working", turnId: "t1" },
		{ id: "s2", state: "working", turnId: "u1" },
	];
	await a.goto(base);
	const bell = a.locator('[title^="Session sounds"]');
	check("the bell toggle is in the header, sounds on", await until("bell", async () => (await bell.count()) === 1) && /on: click to mute/.test((await bell.getAttribute("title")) ?? ""));
	// The first list is a baseline: working sessions do not sound.
	await sleep(4500);
	check("the first list sounds nothing", (await cues(a)) === 0);

	// working → idle: one cue, though the server's updatedAt differs on every poll.
	server.sessions[0] = { id: "s1", state: "idle", turnId: "t1" };
	check("a session finishing its turn sounds (a polled change)", await until("cue", async () => (await cues(a)) >= 1, 12_000), `cues=${await cues(a)}`);
	await sleep(9000);
	check("it sounds once, not on every later poll", (await cues(a)) === 1, `cues=${await cues(a)}`);
	check("the cue's voices ran (oscillators started)", (await a.evaluate(() => window.__voices)) > 0);

	// Mute: the next finish is silent, the choice is stored, unmuting previews a cue.
	await bell.click();
	check("muting flips the title", /off: click to hear/.test((await bell.getAttribute("title")) ?? ""));
	const mutedAt = await cues(a);
	server.sessions[1] = { id: "s2", state: "idle", turnId: "u1" };
	await sleep(9000);
	check("a muted page is silent", (await cues(a)) === mutedAt, `cues=${await cues(a)} was ${mutedAt}`);
	check("the choice is kept in localStorage", (await a.evaluate(() => localStorage.getItem("omp.sound.muted"))) === "1");
	await a.reload();
	check("and survives a reload", await until("bell", async () => /off: click to hear/.test((await a.locator('[title^="Session sounds"]').getAttribute("title").catch(() => "")) ?? "")));
	const before = await cues(a);
	await a.locator('[title^="Session sounds"]').click();
	check("unmuting plays a preview cue", (await cues(a)) === before + 1, `cues=${await cues(a)}`);

	// Two tabs of one browser: a change sounds once across both.
	const b = await context.newPage();
	await b.goto(base);
	await sleep(4500);
	check("two tabs open, both on baseline", (await cues(a)) === before + 1 && (await cues(b)) === 0, `a=${await cues(a)} b=${await cues(b)}`);
	const total = () => Promise.all([cues(a), cues(b)]).then(([x, y]) => x + y);
	const t0 = await total();
	server.sessions[0] = { id: "s1", state: "working", turnId: "t2" };
	await sleep(5000);
	server.sessions[0] = { id: "s1", state: "idle", turnId: "t2" };
	await until("a cue", async () => (await total()) > t0, 12_000);
	await sleep(9000);
	check("a change shown in two tabs sounds once (claim key = turn id, not updatedAt)", (await total()) === t0 + 1, `cues added: ${(await total()) - t0}`);

	// A question.
	const t1 = await total();
	server.sessions[1] = { id: "s2", state: "needs_input", turnId: "req-1" };
	check("a question sounds, once across tabs", (await until("cue", async () => (await total()) > t1, 12_000)) && (await sleep(9000), (await total()) === t1 + 1), `added ${(await total()) - t1}; cue times a=${JSON.stringify(await a.evaluate(() => window.__cueLog))} b=${JSON.stringify(await b.evaluate(() => window.__cueLog))}`);
} catch (err) {
	check("browser test ran", false, String(err?.stack ?? err));
} finally {
	await browser.close();
	httpServer.close();
	fs.rmSync(work, { recursive: true, force: true });
}
console.log(results.join("\n"));
process.exit(failed ? 1 : 0);
