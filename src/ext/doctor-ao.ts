// omp Doctor's machine sections on AO: the Agent Orchestrator daemon (reachable, how it is supervised, whether
// it can run omp: `GET /api/v1/agents/readiness`), AO's dashboard (served by the planner) and the planner.
// Pure: doctor.ts gathers the facts.
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

/** AO's dashboard (src/ao/dashboard.ts): what is installed on disk and what answers on its port. */
export interface DashboardFacts {
	/** False when config.json says `"dashboard": "off"`. */
	enabled: boolean;
	url: string;
	/** The installed renderer; absent when not installed. */
	install?: { version: string | null; source: string };
	/** `GET /switchyard-ao-dashboard/status`; absent when nothing answers on the port. */
	serving?: { daemon: boolean };
	/** The command that installs it (`switchyard dashboard install`). */
	installCommand: string;
}

/** What the permission gate and the `omp` shim need (src/ao/gate.ts `gateStatus`). */
export interface GateFacts {
	gate: boolean;
	shim: boolean;
	extensionDir: string;
	shimFile: string;
}

const INSTALL_GATE: Fix = { label: "Install gate and shim", command: "switchyard.installOmpIntegration" };

const START: Fix = { label: "Start planner and AO", command: "switchyard.server.start" };
const LOG: Fix = { label: "Show log", command: "switchyard.server.showLog" };
const INSTALL_SERVICE: Fix = { label: "Install login services", command: "switchyard.server.install" };

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
	else if (omp.installation === "not_installed") checks.push({ level: "error", title: "AO can't find omp", detail: `${omp.installationReason ?? ""}\nAO runs the omp on the daemon's PATH.`.trim(), fixes: [{ label: "Install omp", command: "switchyard.installOmp" }] });
	else if (omp.authentication === "unauthorized") checks.push({ level: "warn", title: "omp is not logged in to a model provider", detail: omp.authenticationReason, fixes: [{ label: "Log in", command: "switchyard.login" }] });
	else checks.push({ level: "ok", title: "AO can run omp", detail: [omp.installationReason, omp.authenticationReason].filter(Boolean).join("\n") || undefined });
	return checks;
}

/**
 * G46: without the gate (an omp extension) a session's mode is only a file nothing reads: ask, edits and plan run
 * unrestricted. Without the shim, extra omp flags never reach omp.
 */
export function gateChecks(f: GateFacts): Check[] {
	return [
		f.gate
			? { level: "ok", title: "The permission gate is installed", detail: `omp loads it from ${f.extensionDir}: ask, edits and plan are enforced.` }
			: { level: "error", title: "The permission gate is not installed", detail: `Sessions run in AO's bypass mode, so ask, edits and plan are NOT enforced (a session reports its mode but runs unrestricted).\nIt installs into ${f.extensionDir}.`, fixes: [INSTALL_GATE] },
		f.shim
			? { level: "ok", title: "The omp shim is installed", detail: `${f.shimFile}: extra omp flags reach omp when the AO daemon has its folder first on PATH.` }
			: { level: "warn", title: "The omp shim is not installed", detail: `Extra omp flags (switchyard.extraArgs, New Session flags) do not reach omp.\nIt installs into ${f.shimFile}.`, fixes: [INSTALL_GATE] },
	];
}

export function plannerChecks(f: PlannerFacts): Check[] {
	if (!f.version) return [{ level: "warn", title: "The planner is not running", detail: `${f.error ?? "No planner answered."}\nQueued tasks, dependencies and scheduled starts wait until it runs.`, fixes: [START, LOG] }];
	return [{ level: "ok", title: `Planner ${f.version} running`, detail: f.pid ? `pid ${f.pid}` : undefined }];
}

/** Notes and warnings only: the dashboard is optional, nothing else depends on it. */
export function dashboardChecks(f: DashboardFacts): Check[] {
	if (!f.enabled) return [{ level: "info", title: "AO dashboard is off", detail: 'config.json has "dashboard": "off": the planner does not serve it.' }];
	const checks: Check[] = [
		f.install
			? { level: "ok", title: `AO dashboard ${f.install.version ?? "(unknown version)"} installed`, detail: `From ${f.install.source}` }
			: { level: "warn", title: "AO dashboard is not installed", detail: `Open AO Dashboard shows AO's web UI once it is: run \`${f.installCommand}\`.`, fixes: [{ label: "Install", command: "switchyard.installAoDashboard" }] },
	];
	if (!f.serving) checks.push({ level: "warn", title: `Nothing serves the AO dashboard at ${f.url}`, detail: "The planner serves it (an older planner doesn't: restart it).", fixes: [START, LOG] });
	else checks.push({ level: f.serving.daemon ? "ok" : "info", title: `AO dashboard served at ${f.url}`, detail: f.serving.daemon ? undefined : "The AO daemon isn't answering: the dashboard shows no data until it runs.", fixes: [{ label: "Open", command: "switchyard.openAoDashboard" }] });
	return checks;
}
