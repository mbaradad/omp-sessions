// omp Doctor's server section: the omp-sessions server, its login service, the omp it launches, the
// scheduler and remote access. Pure: doctor.ts reads `omp-sessions status --json` (shared/server-status.ts,
// the same overview as the CLI and the phone app) and this maps it to checks.

import { compareVersions } from "../shared/server-client";
import type { MachineStatus } from "../shared/server-status";
import { isRecord } from "../shared/transcript-files";
import type { Check, Fix } from "./doctor-report";

export interface ServerFacts {
	/** `omp-sessions status --json`; absent when it could not be read (`error`). */
	status?: MachineStatus;
	error?: string;
	extensionVersion: string;
	/** Unix ms. */
	now: number;
}

const START: Fix = { label: "Start server", command: "omp.server.start" };
const RESTART: Fix = { label: "Restart server", command: "omp.server.restart" };
const LOG: Fix = { label: "Show server log", command: "omp.server.showLog" };
const TERMINAL: Fix = { label: "Open status in terminal", command: "omp.server.statusInTerminal" };
const INSTALL_SERVICE: Fix = { label: "Install service", command: "omp.server.install" };
const REPAIR_SERVICE: Fix = { label: "Repair service", command: "omp.server.install" };

function isMachineStatus(v: unknown): v is MachineStatus {
	return (
		isRecord(v) &&
		typeof v.ok === "boolean" &&
		Array.isArray(v.problems) &&
		isRecord(v.server) &&
		typeof v.server.running === "boolean" &&
		isRecord(v.service) &&
		isRecord(v.omp) &&
		Array.isArray(v.omp.extraArgs) &&
		isRecord(v.scheduler) &&
		isRecord(v.remote) &&
		isRecord(v.sessions) &&
		isRecord(v.tasks)
	);
}

/** The overview printed by `omp-sessions status --json` (it exits 1 when there are problems, with the JSON still on stdout). */
export function parseMachineStatus(stdout: string): MachineStatus | undefined {
	try {
		const v: unknown = JSON.parse(stdout);
		return isMachineStatus(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

function uptime(ms: number): string {
	const min = Math.max(0, Math.round(ms / 60_000));
	if (min < 60) return `${min} min`;
	if (min < 48 * 60) return `${Math.round(min / 60)} h`;
	return `${Math.round(min / 1440)} days`;
}

export function serverChecks(f: ServerFacts): Check[] {
	const s = f.status;
	if (!s) return [{ level: "warn", title: "Could not read the omp-sessions status", detail: f.error, fixes: [TERMINAL, LOG] }];
	const out: Check[] = [];

	// The server.
	const srv = s.server;
	const where = [srv.socket ? `Socket: ${srv.socket}` : undefined, `Log: ${srv.log}`].filter(Boolean).join("\n");
	if (!srv.running) {
		out.push({ level: "warn", title: "omp-sessions server is not running", detail: `Queued and scheduled sessions won't start, and the phone app and Hermes can't reach this machine, until it runs.\n${where}`, fixes: [START, TERMINAL, LOG] });
	} else {
		const up = srv.startedAt ? `, up ${uptime(f.now - srv.startedAt)}` : "";
		const older = !!srv.version && f.extensionVersion !== "unknown" && compareVersions(srv.version, f.extensionVersion) < 0;
		out.push(
			older
				? { level: "warn", title: `omp-sessions server ${srv.version} is older than this extension (${f.extensionVersion})`, detail: `pid ${srv.pid}${up}. Restarting it runs this extension's version.\n${where}`, fixes: [RESTART, LOG] }
				: { level: "ok", title: `omp-sessions server ${srv.version ?? "(unknown version)"} running`, detail: `pid ${srv.pid}${up}\n${where}`, fixes: [LOG] },
		);
	}

	// The login service.
	const svc = s.service;
	if (!svc.kind) out.push({ level: "info", title: "No login service on this platform", detail: "The server starts on demand: when VS Code opens or an omp-sessions command needs it." });
	else if (!svc.installed) {
		const why = svc.noAutoInstall === "service off" ? "The service is turned off (omp.server.installService)." : svc.noAutoInstall ? `It isn't installed by itself: ${svc.noAutoInstall}.` : "The next on-demand server start installs it.";
		out.push({ level: "info", title: `Login service (${svc.kind}) not installed`, detail: `${why} Without it the server doesn't come back after a reboot until VS Code or an omp-sessions command starts it.`, ...(svc.noAutoInstall === "not the default data home" ? {} : { fixes: [INSTALL_SERVICE] }) });
	} else if (!svc.servesThisHome) {
		out.push({ level: "info", title: `Login service (${svc.kind}) serves another data home`, detail: `It runs the server for ${svc.home ?? "the default home"}, not this one.${svc.file ? `\n${svc.file}` : ""}` });
	} else {
		const gone = [svc.nodeExists === false ? svc.node : undefined, svc.scriptExists === false ? svc.script : undefined].filter((x): x is string => !!x);
		const files = [svc.file, svc.node ? `node: ${svc.node}` : undefined, svc.script ? `server: ${svc.script}` : undefined].filter(Boolean).join("\n");
		out.push(
			gone.length
				? { level: "error", title: `Login service (${svc.kind}) runs files that no longer exist`, detail: `Missing: ${gone.join(", ")}. It won't start the server at login.\n${files}`, fixes: [REPAIR_SERVICE, TERMINAL] }
				: { level: "ok", title: `Login service (${svc.kind}) installed`, detail: files },
		);
	}

	// The omp sessions start with.
	const omp = s.omp;
	if (omp.error) out.push({ level: "error", title: "Sessions can't find omp", detail: omp.error, fixes: [{ label: "Set path…", command: "omp.setOmpPath" }, { label: "Install omp", command: "omp.installOmp" }] });
	else {
		const extra = omp.extraArgs.length ? `\nExtra arguments: ${omp.extraArgs.join(" ")}` : "";
		out.push({ level: "ok", title: "Sessions start omp", detail: `${omp.path ?? ""}${omp.configured ? " (from omp.path)" : ""}${extra}` });
		if (omp.launchError) out.push({ level: "error", title: "Starting a session failed recently", detail: omp.launchError, fixes: [LOG, TERMINAL] });
	}
	out.push({ level: "info", title: `Default model: ${omp.defaultModel ?? "omp's own default"}`, detail: omp.defaultModel ? undefined : "Set one with omp-sessions config set model <provider/id>." });
	out.push({ level: "info", title: `Default permission mode: ${omp.defaultMode ?? "omp's tools.approvalMode, else Auto"}`, detail: "New sessions that ask for no mode start in it. Edits and Ask wait for a person at the first command.", fixes: [{ label: "Change…", command: "omp.setDefaultMode" }] });

	// The scheduler.
	const sch = s.scheduler;
	const counts = `${sch.running} running · ${sch.waiting} waiting · ${sch.scheduled} scheduled`;
	out.push({
		level: sch.paused && (sch.waiting > 0 || s.tasks.pending > 0) ? "warn" : "info",
		title: `Scheduler: ${sch.maxConcurrent ? `limit ${sch.maxConcurrent}` : "no limit"}${sch.paused ? ", paused" : ""}`,
		detail: `${counts}\nTasks: ${s.tasks.pending} pending · ${s.tasks.running} running${sch.paused ? "\nPaused: no queued task starts until it is resumed (omp-sessions scheduler resume)." : ""}`,
	});

	// Remote access.
	const r = s.remote;
	if (!r.enabled) out.push({ level: "info", title: "Remote access off" });
	else if (r.listening) {
		const notes = [`bind ${r.bind}`, r.tokenSet ? "pairing token set" : "no pairing token", r.https ? "secure cookie" : undefined, r.trustedProxy ? "behind a trusted proxy" : undefined].filter(Boolean).join(", ");
		out.push({ level: "ok", title: `Remote access on: ${r.url ?? `${r.listening.host}:${r.listening.port}`}`, detail: `${notes}${r.localUrl ? `\nListener: ${r.localUrl}` : ""}` });
	} else if (!srv.running) out.push({ level: "info", title: "Remote access on (listens while the server runs)", fixes: [START] });
	else out.push({ level: "error", title: "Remote access is on but not listening", detail: r.error, fixes: [RESTART, LOG] });

	// Everything the status reports as a problem, as the CLI prints it (each is also a check above).
	if (s.problems.length) out.push({ level: "info", title: `omp-sessions status: ${s.problems.length} problem(s)`, detail: s.problems.map(p => `• ${p}`).join("\n"), fixes: [TERMINAL] });
	return out;
}
