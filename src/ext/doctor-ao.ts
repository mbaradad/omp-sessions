// omp Doctor's machine sections on AO: the Agent Orchestrator daemon (reachable, how it is supervised, whether
// it can run omp: `GET /api/v1/agents/readiness`) and the planner. Pure: doctor.ts gathers the facts.
import type { Check, Fix } from "./doctor-report";

export interface AoFacts {
	/** Base URL of the daemon this window talks to; absent when none answered. */
	url?: string;
	pid?: number;
	/** The systemd user unit that runs it, when one is installed. */
	unit?: string;
	/** Why the daemon could not be reached. */
	error?: string;
	/** AO's readiness snapshot of the `omp` agent; absent when the daemon is unreachable or doesn't list omp. */
	omp?: { installation: "installed" | "not_installed" | "unknown"; installationReason?: string; authentication: string; authenticationReason?: string };
	/** Sessions AO lists (all states). */
	sessions?: number;
	/** Whether this platform can run AO as a login service (systemd). */
	serviceAvailable: boolean;
}

export interface PlannerFacts {
	version?: string;
	pid?: number;
	/** Why the planner could not be reached (it's down, or never started). */
	error?: string;
}

const START: Fix = { label: "Start planner and AO", command: "omp.server.start" };
const LOG: Fix = { label: "Show log", command: "omp.server.showLog" };
const INSTALL_SERVICE: Fix = { label: "Install login services", command: "omp.server.install" };

export function aoChecks(f: AoFacts): Check[] {
	if (!f.url) {
		return [{ level: "error", title: "The AO daemon is not reachable", detail: `${f.error ?? "No daemon answered."}\nEvery omp session runs in Agent Orchestrator (\`ao daemon\`); Switchyard finds it through ~/.ao/running.json.`, fixes: [START, LOG] }];
	}
	const checks: Check[] = [
		{ level: "ok", title: `AO daemon running at ${f.url}`, detail: [f.pid ? `pid ${f.pid}` : "", f.sessions !== undefined ? `${f.sessions} session(s)` : ""].filter(Boolean).join(" · ") || undefined },
		f.unit
			? { level: "ok", title: `Runs as the systemd user service ${f.unit}.service`, detail: "It starts at login and restarts after a crash." }
			: f.serviceAvailable
				? { level: "info", title: "Not a login service", detail: "The daemon runs as a plain process: it doesn't come back after a reboot until a client starts it.", fixes: [INSTALL_SERVICE] }
				: { level: "info", title: "Started by clients when needed", detail: "No login service on this platform." },
	];
	const omp = f.omp;
	if (!omp) checks.push({ level: "warn", title: "AO doesn't report on omp", detail: "Its agent readiness list has no omp entry (an older AO?)." });
	else if (omp.installation === "not_installed") checks.push({ level: "error", title: "AO can't find omp", detail: `${omp.installationReason ?? ""}\nAO runs the omp on the daemon's PATH.`.trim(), fixes: [{ label: "Install omp", command: "omp.installOmp" }] });
	else if (omp.authentication === "unauthorized") checks.push({ level: "warn", title: "omp is not logged in to a model provider", detail: omp.authenticationReason, fixes: [{ label: "Log in", command: "omp.login" }] });
	else checks.push({ level: "ok", title: "AO can run omp", detail: [omp.installationReason, omp.authenticationReason].filter(Boolean).join("\n") || undefined });
	return checks;
}

export function plannerChecks(f: PlannerFacts): Check[] {
	if (!f.version) return [{ level: "warn", title: "The planner is not running", detail: `${f.error ?? "No planner answered."}\nQueued tasks, dependencies and scheduled starts wait until it runs.`, fixes: [START, LOG] }];
	return [{ level: "ok", title: `Planner ${f.version} running`, detail: f.pid ? `pid ${f.pid}` : undefined }];
}
