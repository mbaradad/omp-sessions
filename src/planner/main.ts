// Switchyard planner: the headless per-user service that holds plans and dispatches them to Agent
// Orchestrator (see PLANNER-API.md). `node planner.js` runs it (normally as the user service);
// `node planner.js install|uninstall` sets the service up or removes it.
import * as fs from "node:fs";
import * as net from "node:net";
import { connectAo } from "./ao-port";
import { createApiServer } from "./api";
import { forgetPipe, listenPath, logPath, pidPath, planPath, plannerDir, recordPipe, socketPath } from "./paths";
import { switchyardHome } from "../ao/native";
import { Planner } from "./planner";
import { installService, uninstallService } from "./service";
import { loadPlan } from "./store";
import { readOmpUsage } from "./usage-source";
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
	const target = listenPath();
	if (!IS_WINDOWS) fs.rmSync(target, { force: true });
	let planner: Planner;
	try {
		planner = new Planner({
			file: planPath(),
			initial: loadPlan(planPath()),
			connect: connectAo,
			...(process.env.SWITCHYARD_PLANNER_USAGE === "off" ? {} : { usage: () => readOmpUsage() }),
			log,
			version: VERSION,
			...(process.env.SWITCHYARD_PLANNER_RETRY_BASE_MS ? { retryBaseMs: Number(process.env.SWITCHYARD_PLANNER_RETRY_BASE_MS) } : {}),
		});
	} catch (err) {
		log("cannot start:", String(err));
		releaseLock(pidPath());
		process.exit(1);
	}
	let finished = false;
	const shutdown = (reason: string) => {
		if (finished) return;
		finished = true;
		log("planner stopping:", reason);
		planner.stop();
		server.close();
		if (IS_WINDOWS) forgetPipe(target);
		releaseLock(pidPath());
		process.exit(0);
	};
	const server = createApiServer({ planner, info: () => ({ pid: process.pid, version: VERSION, root: switchyardHome(), startedAt: planner.startedAt, api: 1 }), shutdown, log });
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
