// The planner service as a real process for tests: `node planner.js` (src/planner/main.ts bundled) with
// a private state root, pointed at an AO fixture (test/ao-fixture.mjs) and at its omp (the fake's
// `omp usage --json` feeds usage gating). Speaks the planner wire (PLANNER-API.md) directly, so .mjs
// runners (e2e, Hermes) can use it too; TypeScript tests may also use PlannerClient with `env`.
//
//   const ao = await startAoFixture();
//   const planner = await startPlannerFixture({ ao });
//   await planner.call("edit", { ops: [{ op: "add", task: { title: "A", notes: "echo hi", options: { project } } }] });
//   const plan = await planner.waitFor(p => p.tasks.every(t => t.status === "done"));
//   await planner.restart({ kill: true });        // crash + restart: nothing may be dispatched twice
//   await planner.stop(); await ao.stop();
//
// Options: { ao, stateRoot, plannerJs, env, usage, retryBaseMs, readyTimeoutMs }
//   stateRoot    OMP_VSCODE_HOME to use (e.g. the one a VS Code under test already has); default a temp dir
//   plannerJs    bundled planner (default $SWITCHYARD_TEST_PLANNER_JS, which test/run.mjs builds; else built here)
//   env          extra planner env
//   usage        false: OMP_PLANNER_USAGE=off (no `omp usage` polling); default on, against ao.ompBin
//   retryBaseMs  OMP_PLANNER_RETRY_BASE_MS (retry backoff base) for fast failure tests

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeOmpAcpPath, removeTree } from "./ao-fixture.mjs";

/** The planner's socket for a state root (same rule as src/planner/paths.ts listenPath). */
function plannerSocket(stateRoot) {
	if (process.platform === "win32") throw new Error("planner fixture: Windows named pipes are not supported yet");
	const preferred = path.join(stateRoot, "planner", "planner.sock");
	if (Buffer.byteLength(preferred) < 100) return preferred;
	const tag = crypto.createHash("sha256").update(stateRoot).digest("hex").slice(0, 16);
	return path.join(os.tmpdir(), `ompv-${process.getuid?.() ?? "u"}`, `planner-${tag}.sock`);
}

/** Bundles src/planner/main.ts into `outfile` (when no prebuilt planner.js is given). */
async function buildPlanner(outfile) {
	const repo = path.resolve(path.dirname(fakeOmpAcpPath()), "..");
	const entry = path.join(repo, "src", "planner", "main.ts");
	if (!fs.existsSync(entry)) throw new Error(`planner fixture: ${entry} not found (merge ao/planner)`);
	const esbuild = await import("esbuild");
	await esbuild.build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "cjs", target: "es2022", sourcemap: "inline", logLevel: "warning", define: { PLANNER_VERSION: '"test"' } });
	return outfile;
}

/** One request over a fresh connection: resolves with `result`, rejects with the planner's error. */
function request(socket, op, args, timeoutMs = 30_000) {
	const { promise, resolve, reject } = Promise.withResolvers();
	const sock = net.createConnection(socket);
	const timer = setTimeout(() => {
		sock.destroy();
		reject(new Error(`planner did not answer ${op} within ${timeoutMs} ms`));
	}, timeoutMs);
	sock.once("error", err => {
		clearTimeout(timer);
		reject(err);
	});
	sock.once("connect", () => sock.write(`${JSON.stringify({ id: 1, op, ...(args === undefined ? {} : { args }) })}\n`));
	const rl = readline.createInterface({ input: sock });
	rl.on("error", () => {}); // the socket's own error handler reports it
	rl.once("line", line => {
		clearTimeout(timer);
		sock.destroy();
		const res = JSON.parse(line);
		if (res.ok) resolve(res.result);
		else reject(new Error(`planner ${op}: ${res.error}`));
	});
	return promise;
}

const live = new Set();
let exitHookInstalled = false;

/**
 * Starts the planner against `ao` and waits until it answers `ping`.
 * @returns {Promise<PlannerFixture>}
 */
export async function startPlannerFixture(opts) {
	const { ao } = opts;
	if (!ao) throw new Error("startPlannerFixture needs { ao } (an AO fixture)");
	const root = fs.mkdtempSync(path.join(ao.root, "planner-"));
	const stateRoot = opts.stateRoot ?? path.join(root, "state");
	fs.mkdirSync(stateRoot, { recursive: true });
	const plannerJs = opts.plannerJs ?? process.env.SWITCHYARD_TEST_PLANNER_JS ?? (await buildPlanner(path.join(root, "planner.js")));
	const socket = plannerSocket(stateRoot);
	const logFile = path.join(root, "planner-stderr.log");
	// What a planner client (CLI, extension, Hermes) needs to reach this planner and this AO. The
	// OMP_VSCODE_HOME / OMP_PLANNER_* names are the planner's (src/planner/paths.ts, main.ts); they
	// follow the planner when it moves to the Switchyard names.
	// The state dir (OMP_VSCODE_HOME today, SWITCHYARD_HOME once the planner moves) must be a temp dir.
	const tmpRoot = fs.realpathSync(os.tmpdir());
	if (path.relative(tmpRoot, path.resolve(stateRoot)).startsWith("..")) throw new Error(`planner fixture: stateRoot ${stateRoot} is not under ${tmpRoot}: tests never touch the real state dirs`);
	const clientEnv = { ...ao.stackEnv, OMP_VSCODE_HOME: stateRoot, SWITCHYARD_HOME: stateRoot };
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AO_") && !k.startsWith("OMP_PLANNER_"))),
		...clientEnv,
		OMP_PLANNER_STDERR: "1",
		...(opts.usage === false ? { OMP_PLANNER_USAGE: "off" } : { OMP_PLANNER_OMP: ao.ompBin }),
		...(opts.retryBaseMs ? { OMP_PLANNER_RETRY_BASE_MS: String(opts.retryBaseMs) } : {}),
		...opts.env,
	};
	const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;

	let child;
	async function launch() {
		const log = fs.openSync(logFile, "a");
		const proc = spawn(process.execPath, [plannerJs], { cwd: root, env, stdio: ["ignore", log, log] });
		fs.closeSync(log);
		proc.once("error", () => {});
		const exited = new Promise(r => proc.once("exit", r));
		let dead = false;
		exited.then(() => (dead = true));
		const deadline = Date.now() + readyTimeoutMs;
		while (Date.now() < deadline && !dead) {
			try {
				const info = await request(socket, "ping", undefined, 1000);
				if (info.pid === proc.pid) return proc;
			} catch {}
			await sleep(100);
		}
		proc.kill("SIGKILL");
		throw new Error(`planner ${dead ? "exited" : "not ready"}; log tail:\n${fx.log().split("\n").slice(-30).join("\n")}`);
	}
	async function halt(signal) {
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise(r => child.once("exit", r));
		child.kill(signal);
		if ((await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)])) === false) {
			child.kill("SIGKILL");
			await exited;
		}
	}

	const fx = {
		root,
		stateRoot,
		socket,
		/** Env for planner clients (OMP_VSCODE_HOME → this planner; AO_* → the AO fixture; the fake omp first on PATH). */
		clientEnv,
		plannerJs,
		get pid() {
			return child.pid;
		},
		/** One planner op (PLANNER-API.md "Operations"). */
		call(op, args, timeoutMs) {
			return request(socket, op, args, timeoutMs);
		},
		plan(args = {}) {
			return request(socket, "plan", args);
		},
		/**
		 * `subscribe {topic: "plan"}`: calls onEvent with every `plan` snapshot and `task` transition
		 * until close(). Resolves once subscribed.
		 */
		async subscribe(onEvent) {
			const sock = net.createConnection(socket);
			const { promise, resolve, reject } = Promise.withResolvers();
			// Errors after subscribing (the planner restarted) just end the stream.
			sock.on("error", reject);
			sock.once("connect", () => sock.write(`${JSON.stringify({ id: 1, op: "subscribe", args: { topic: "plan" } })}\n`));
			const rl = readline.createInterface({ input: sock });
			rl.on("error", () => {});
			rl.on("line", line => {
				const msg = JSON.parse(line);
				if (msg.event) onEvent(msg);
				else if (msg.ok) resolve();
				else reject(new Error(`planner subscribe: ${msg.error}`));
			});
			await promise;
			return { close: () => sock.destroy() };
		},
		/** Polls `plan` until `pred(plan)` holds; resolves with that plan. */
		async waitFor(pred, { what = "the plan condition", timeoutMs = 60_000, args } = {}) {
			const deadline = Date.now() + timeoutMs;
			let last;
			for (;;) {
				last = await request(socket, "plan", args ?? {});
				if (pred(last)) return last;
				if (Date.now() > deadline) {
					const tasks = last.tasks.map(t => `${t.title}: ${t.state}${t.waitReason ? ` (${t.waitReason})` : ""}`).join(", ");
					throw new Error(`timed out waiting for ${what}: ${tasks}\nplanner log tail:\n${fx.log().split("\n").slice(-20).join("\n")}`);
				}
				await sleep(100);
			}
		},
		/** The planner's log (OMP_PLANNER_STDERR copies every line of planner.log there, plus crashes). */
		log() {
			return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
		},
		/** Restarts the planner on the same state: a clean stop (SIGTERM), or `{ kill: true }` for a crash (SIGKILL). */
		async restart({ kill = false } = {}) {
			await halt(kill ? "SIGKILL" : "SIGTERM");
			child = await launch();
		},
		/** SIGKILL, no restart (the planner is gone, e.g. to test clients without one). */
		async kill() {
			await halt("SIGKILL");
		},
		/** Stops the planner and removes its state (the AO fixture's stop() removes the rest). */
		async stop() {
			if (!live.delete(fx)) return;
			await halt("SIGTERM");
			await removeTree(root);
		},
	};
	child = await launch();
	live.add(fx);
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.on("exit", () => {
			for (const p of live) {
				try {
					process.kill(p.pid, "SIGKILL");
				} catch {}
			}
		});
	}
	return fx;
}
