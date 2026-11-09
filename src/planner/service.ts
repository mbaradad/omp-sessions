// The planner as a per-user service, like the old server's (src/shared/server-client.ts): a systemd user
// unit on Linux, a launchd agent on macOS, so plans keep running with no client open and after
// reboots. Windows has none: clients start the planner detached. Node-only.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SYSTEMD_UNIT = "omp-sessions-planner.service";
export const LAUNCHD_LABEL = "dev.omp.sessions-planner";
const DESCRIPTION = "omp Sessions planner (task graphs, queues and schedules dispatched to Agent Orchestrator)";

export type ServiceKind = "systemd" | "launchd";

export function serviceKind(platform: NodeJS.Platform = process.platform): ServiceKind | undefined {
	return platform === "linux" ? "systemd" : platform === "darwin" ? "launchd" : undefined;
}

export function serviceUnitPath(kind: ServiceKind, home = os.homedir()): string {
	return kind === "systemd" ? path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT) : path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

const xmlText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The unit text; `env` entries are `NAME=value`. */
export function serviceUnitText(kind: ServiceKind, node: string, script: string, env: string[]): string {
	if (kind === "systemd") {
		return [
			"[Unit]",
			`Description=${DESCRIPTION}`,
			"StartLimitIntervalSec=300",
			"StartLimitBurst=5",
			"",
			"[Service]",
			"Type=exec",
			`ExecStart=${JSON.stringify(node)} ${JSON.stringify(script)}`,
			...env.map(e => `Environment=${JSON.stringify(e)}`),
			// A clean exit is deliberate (shutdown op, or another planner owns the socket).
			"Restart=on-failure",
			"RestartSec=5",
			"",
			"[Install]",
			"WantedBy=default.target",
			"",
		].join("\n");
	}
	const envXml = env.map(e => {
		const i = e.indexOf("=");
		return `\t\t<key>${xmlText(e.slice(0, i))}</key><string>${xmlText(e.slice(i + 1))}</string>`;
	});
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key><array><string>${xmlText(node)}</string><string>${xmlText(script)}</string></array>
	<key>EnvironmentVariables</key><dict>
${envXml.join("\n")}
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`;
}

export type ServiceExec = (cmd: string, argv: string[]) => boolean;
const quietExec: ServiceExec = (cmd, argv) => spawnSync(cmd, argv, { stdio: "ignore", timeout: 60_000 }).status === 0;

/** The environment the unit pins: the data home (when not the default), PATH (omp, ao), AO discovery overrides. */
export function serviceEnv(env: NodeJS.ProcessEnv = process.env): string[] {
	const out = ["ELECTRON_RUN_AS_NODE=1", `PATH=${[...new Set((env.PATH ?? "").split(path.delimiter).filter(Boolean))].join(path.delimiter)}`];
	for (const k of ["OMP_VSCODE_HOME", "AO_RUN_FILE", "AO_PORT", "OMP_PLANNER_OMP"]) if (env[k]) out.push(`${k}=${env[k]}`);
	return out;
}

/** Writes the unit for `script` and enables + starts it. False when systemctl/launchctl failed (the unit is written). */
export function installService(script: string, node = process.execPath, exec: ServiceExec = quietExec, home = os.homedir()): { kind: ServiceKind; file: string; ok: boolean } | undefined {
	const kind = serviceKind();
	if (!kind) return undefined;
	const file = serviceUnitPath(kind, home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, serviceUnitText(kind, node, script, serviceEnv()));
	if (kind === "systemd") return { kind, file, ok: exec("systemctl", ["--user", "daemon-reload"]) && exec("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]) };
	const domain = `gui/${os.userInfo().uid}`;
	exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
	return { kind, file, ok: exec("launchctl", ["bootstrap", domain, file]) };
}

/** Stops, disables and deletes the unit. */
export function uninstallService(exec: ServiceExec = quietExec, home = os.homedir()): boolean {
	const kind = serviceKind();
	if (!kind) return false;
	const file = serviceUnitPath(kind, home);
	if (!fs.existsSync(file)) return false;
	if (kind === "systemd") exec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
	else exec("launchctl", ["bootout", `gui/${os.userInfo().uid}/${LAUNCHD_LABEL}`]);
	fs.rmSync(file, { force: true });
	if (kind === "systemd") exec("systemctl", ["--user", "daemon-reload"]);
	return true;
}

/**
 * Starts the installed unit when it serves this data home (the unit pins OMP_VSCODE_HOME only when it
 * is set); false when none is installed for it or starting failed.
 */
export function startService(exec: ServiceExec = quietExec, home = os.homedir(), dataHome = process.env.OMP_VSCODE_HOME): boolean {
	const kind = serviceKind();
	let text: string;
	try {
		text = kind ? fs.readFileSync(serviceUnitPath(kind, home), "utf8") : "";
	} catch {
		return false;
	}
	if (!kind) return false;
	const servesHome = dataHome ? text.includes(kind === "systemd" ? `"OMP_VSCODE_HOME=${dataHome}"` : `<key>OMP_VSCODE_HOME</key><string>${xmlText(dataHome)}</string>`) : !text.includes("OMP_VSCODE_HOME");
	if (!servesHome) return false;
	return kind === "systemd" ? exec("systemctl", ["--user", "start", SYSTEMD_UNIT]) : exec("launchctl", ["kickstart", `gui/${os.userInfo().uid}/${LAUNCHD_LABEL}`]);
}
