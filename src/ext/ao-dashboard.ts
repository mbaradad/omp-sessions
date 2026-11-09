// *Open AO Dashboard*: Agent Orchestrator's own web UI in a VS Code panel. The planner serves it on loopback
// (src/ao/dashboard.ts, `dashboardPort` in ~/.switchyard/config.json); the panel frames the URL VS Code
// forwards (`asExternalUri`: Remote-SSH, WSL and Codespaces reach the remote port). *Install AO Dashboard*
// runs `switchyard dashboard install` in a terminal.
import * as crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { switchyardConfigPath, readSwitchyardConfig } from "../ao/config";
import { type DashboardStatus, INSTALL_COMMAND, dashboardEnabled, dashboardPort, dashboardUrl, probeDashboard } from "../ao/dashboard";
import { dashboardHtml } from "./ao-dashboard-core";
import type { OmpApi } from "./api";
import { plain } from "./plain";
import type { ServerControl } from "./server";

/** How long Open AO Dashboard waits for a planner it just started to serve the dashboard. */
const SERVE_TIMEOUT_MS = 8_000;
const POLL_MS = 500;

export function registerAoDashboard(api: OmpApi, server: ServerControl): void {
	const { context } = api;
	let panel: vscode.WebviewPanel | undefined;
	/** The forwarded URL the panel frames. */
	let shown: vscode.Uri | undefined;

	const install = () => server.runCli(["dashboard", "install"]);

	/** The dashboard's status, starting the planner (which serves it) when nothing answers on the port. */
	const reach = async (port: number): Promise<{ status?: DashboardStatus; error?: string }> => {
		const first = await probeDashboard(port);
		if (first) return { status: first };
		let error: string | undefined;
		try {
			api.ao.log.info(await server.planner());
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		const deadline = Date.now() + SERVE_TIMEOUT_MS;
		while (!error && Date.now() < deadline) {
			const status = await probeDashboard(port);
			if (status) return { status };
			await sleep(POLL_MS);
		}
		return { error };
	};

	const showPanel = async (port: number) => {
		const external = await vscode.env.asExternalUri(vscode.Uri.parse(dashboardUrl(port)));
		if (!panel) {
			const created = vscode.window.createWebviewPanel("switchyard.aoDashboard", "AO Dashboard", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
			created.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "omp-color.svg");
			created.onDidDispose(() => {
				if (panel !== created) return;
				panel = undefined;
				shown = undefined;
			});
			created.webview.onDidReceiveMessage((msg: unknown) => {
				if (typeof msg === "object" && msg !== null && "type" in msg && msg.type === "open" && shown) void vscode.env.openExternal(shown);
			});
			panel = created;
		}
		// Re-rendering reloads AO's UI: only when the URL changed (another port, a new forward).
		if (shown?.toString() !== external.toString()) {
			shown = external;
			panel.webview.html = dashboardHtml(external.toString(true), crypto.randomBytes(16).toString("base64"));
		}
		panel.reveal();
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("switchyard.installAoDashboard", install),
		vscode.commands.registerCommand("switchyard.openAoDashboard", async () => {
			const config = readSwitchyardConfig();
			if (!dashboardEnabled(config)) {
				const pick = await vscode.window.showInformationMessage(plain(`AO's dashboard is turned off ("dashboard": "off" in ${switchyardConfigPath()}).`), "Open config.json");
				if (pick) await vscode.window.showTextDocument(vscode.Uri.file(switchyardConfigPath()));
				return;
			}
			const port = dashboardPort(config);
			const { status, error } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Switchyard: opening the AO dashboard…" }, () => reach(port));
			if (!status) {
				const why = error ? `the planner did not start: ${error}` : "the planner serves it (an older planner doesn't: restart it)";
				const pick = await vscode.window.showErrorMessage(plain(`Nothing answers on ${dashboardUrl(port)}: ${why}.`), "Start Planner", "Show Log");
				if (pick === "Start Planner") void vscode.commands.executeCommand("switchyard.server.start");
				else if (pick === "Show Log") void vscode.commands.executeCommand("switchyard.server.showLog");
				return;
			}
			if (!status.installed) {
				const pick = await vscode.window.showWarningMessage(plain(`AO's dashboard is not installed. \`${INSTALL_COMMAND}\` fetches AO's web UI from its official release.`), "Install", "Copy Command");
				if (pick === "Install") install();
				else if (pick === "Copy Command") {
					await vscode.env.clipboard.writeText(INSTALL_COMMAND);
					void vscode.window.showInformationMessage(plain(`Copied \`${INSTALL_COMMAND}\`; run it on this machine${vscode.env.remoteName ? " (the remote one)" : ""}, then open the dashboard again.`));
				}
				return;
			}
			if (!status.daemon) {
				void vscode.window.showWarningMessage("The AO daemon isn't running: the dashboard shows no sessions until it runs.", "Start AO").then(pick => {
					if (pick) void vscode.commands.executeCommand("switchyard.server.start");
				});
			}
			try {
				await showPanel(port);
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`Could not open the AO dashboard: ${err instanceof Error ? err.message : String(err)}`));
			}
		}),
	);
}
