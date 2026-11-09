// Switchyard planner: the headless per-user service that holds plans and dispatches them to Agent
// Orchestrator (see PLANNER-API.md). `node planner.js` runs it (normally as the user service);
// `node planner.js install|uninstall` sets the service up or removes it.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { connectAo } from "./ao-port";
import { checkpointHooks } from "./checkpoint-hooks";
import { createApiServer } from "./api";
import { forgetPipe, listenPath, logPath, pidPath, planPath, plannerDir, recordPipe, socketPath } from "./paths";
import { type DashboardHandle, dashboardEnabled, startDashboard } from "../ao/dashboard";
import { switchyardHome } from "../ao/native";
import { Planner } from "./planner";
import { installService, uninstallService } from "./service";
import { loadPlan } from "./store";
import type { OmpIntegrationStatus } from "./types";
import { readOmpUsage } from "./usage-source";
import { ensureOmpIntegration } from "../shared/omp-extension-install";
import { claimLock, holdsLock, releaseLock } from "../shared/process-lock";

declare const PLANNER_VERSION: string | undefined;
const VERSION = typeof PLANNER_VERSION === "string" ? PLANNER_VERSION : "dev";
const IS_WINDOWS = process.platform === "win32";
const MAX_LOG_BYTES = 1024 * 1024;

function log(...parts: unknown[]): void {
	const line = `[${new Date().toISOString()}] ${parts.map(p => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
	try {
		fs.appendFileSync(logPath(), line);
	} catch {
		/* state dir gone */
	}
	if (process.env.SWITCHYARD_PLANNER_STDERR) process.stderr.write(line);
}

/**
 * Test clock: the planner's `now` is real time plus the number of milliseconds in `file` (re-read at most
 * every 100 ms; missing or unreadable = 0). Lets process tests move start times and recurring schedules
 * into the past without waiting; the planner notices on its next periodic pass (SWITCHYARD_PLANNER_POLL_MS).
 */
function fileClock(file: string): () => number {
	let offset = 0;
	let readAt = 0;
	return () => {
		const real = Date.now();
		if (real - readAt > 100) {
			readAt = real;
			try {
				offset = Number(fs.readFileSync(file, "utf8").trim()) || 0;
			} catch {
				offset = 0;
			}
		}
		return real + offset;
	};
}

function canConnect(target: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const sock = net.createConnection(target);
	const done = (ok: boolean) => {
		sock.destroy();
		resolve(ok);
	};
	sock.once("connect", () => done(true));
	sock.once("error", () => done(false));
	setTimeout(() => done(false), 1000).unref();
	return promise;
}

async function run(): Promise<void> {
	fs.mkdirSync(plannerDir(), { recursive: true, mode: 0o700 });
	try {
		if (fs.statSync(logPath()).size > MAX_LOG_BYTES) fs.renameSync(logPath(), `${logPath()}.1`);
	} catch {
		/* no log yet */
	}
	process.on("uncaughtException", err => log("uncaught", err.stack ?? String(err)));
	process.on("unhandledRejection", err => log("unhandled rejection", err instanceof Error ? (err.stack ?? err.message) : String(err)));
	const running = socketPath();
	if (running && (await canConnect(running))) {
		log("another planner is running; exiting", process.pid);
		process.exit(0);
	}
	if (!claimLock(pidPath())) {
		log("another planner is starting; exiting", process.pid);
		process.exit(0);
	}
	// The permission gate and the omp shim (G46): without them a session's mode file is not enforced, and spawn
	// refuses every mode but `auto`. Idempotent, never throws; a failure is logged and shown by `ping`.
	// A planner.js copied away from its build (a runtime folder) has no gate to install: whoever copied it (the VS Code
	// extension, the CLI) installs the gate itself; copy omp-extension/ and omp-shim/ next to planner.js to have it here too.
	const omp: OmpIntegrationStatus = fs.existsSync(path.join(__dirname, "omp-extension"))
		? ensureOmpIntegration({ bundleRoot: __dirname, production: true })
		: { installed: [], upToDate: false, skipped: `no omp-extension/ next to ${__filename}: the gate is installed by the CLI or the VS Code extension` };
	if (omp.installed.length) log("omp integration installed:", omp.installed.join(", "));
	if (omp.error) log("omp integration missing:", omp.error);
	else if (omp.skipped) log("omp integration skipped:", omp.skipped);
	const target = listenPath();
	if (!IS_WINDOWS) fs.rmSync(target, { force: true });
	let planner: Planner;
	try {
		planner = new Planner({
			file: planPath(),
			initial: loadPlan(planPath()),
			connect: connectAo,
			// Undo/redo awareness and clean retries (requeue {clean}) come from the Switchyard checkpoints.
			...checkpointHooks(),
			...(process.env.SWITCHYARD_PLANNER_USAGE === "off" ? {} : { usage: () => readOmpUsage() }),
			log,
			version: VERSION,
			...(process.env.SWITCHYARD_PLANNER_RETRY_BASE_MS ? { retryBaseMs: Number(process.env.SWITCHYARD_PLANNER_RETRY_BASE_MS) } : {}),
			...(process.env.SWITCHYARD_PLANNER_POLL_MS ? { pollMs: Number(process.env.SWITCHYARD_PLANNER_POLL_MS) } : {}),
			...(process.env.SWITCHYARD_PLANNER_USAGE_EVERY_MS ? { usageEveryMs: Number(process.env.SWITCHYARD_PLANNER_USAGE_EVERY_MS) } : {}),
			...(process.env.SWITCHYARD_PLANNER_CLOCK_FILE ? { now: fileClock(process.env.SWITCHYARD_PLANNER_CLOCK_FILE) } : {}),
		});
	} catch (err) {
		log("cannot start:", String(err));
		releaseLock(pidPath());
		process.exit(1);
	}
	let finished = false;
	/** AO's dashboard (src/ao/dashboard.ts), served while the planner runs; `dashboard: "off"` in config.json or SWITCHYARD_PLANNER_DASHBOARD=off (test planners) turns it off. */
	let dashboard: DashboardHandle | undefined;
	const shutdown = (reason: string) => {
		if (finished) return;
		finished = true;
		log("planner stopping:", reason);
		planner.stop();
		dashboard?.close();
		server.close();
		if (IS_WINDOWS) forgetPipe(target);
		releaseLock(pidPath());
		process.exit(0);
	};
	const server = createApiServer({
		planner,
		info: () => ({
			pid: process.pid,
			version: VERSION,
			root: switchyardHome(),
			startedAt: planner.startedAt,
			api: 1,
			omp,
			...(dashboard && { dashboard: { port: dashboard.port, listening: dashboard.listening(), ...(dashboard.error() && { error: dashboard.error() }) } }),
		}),
		shutdown,
		log,
	});
	server.on("error", err => {
		const inUse = "code" in err && err.code === "EADDRINUSE";
		log(inUse ? "another planner took the socket; exiting" : "socket error", String(err));
		releaseLock(pidPath());
		process.exit(inUse ? 0 : 1);
	});
	server.listen(target, () => {
		if (!IS_WINDOWS) fs.chmodSync(target, 0o600);
		else recordPipe(target);
		if (!holdsLock(pidPath())) {
			shutdown("another planner owns the pid file");
			return;
		}
		const running = planner.state.tasks.filter(t => t.status === "running").length;
		log("planner started", { pid: process.pid, version: VERSION, root: switchyardHome(), node: process.version, tasks: planner.state.tasks.length, running });
		planner.start();
		if (process.env.SWITCHYARD_PLANNER_DASHBOARD !== "off" && dashboardEnabled()) dashboard = startDashboard({ log });
	});
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGHUP", () => shutdown("SIGHUP"));
}

const command = process.argv[2];
if (command === "install") {
	const res = installService(__filename);
	console.log(res ? `${res.ok ? "installed and started" : "written (start it by hand)"}: ${res.file}` : "no per-user service on this platform");
	process.exit(res?.ok === false ? 1 : 0);
} else if (command === "uninstall") {
	console.log(uninstallService() ? "removed" : "not installed");
} else if (command) {
	console.error(`unknown command ${command} (use install, uninstall, or no argument to run)`);
	process.exit(2);
} else {
	void run();
}
