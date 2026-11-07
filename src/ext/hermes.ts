// "Install Hermes Plugin…": installs, updates or removes the omp-sessions plugin in the Hermes
// profiles the user picks (src/shared/hermes-plugin.ts, the same logic as `omp-vs hermes install`)
// and shows each profile's status, plus the plugin's own `hermes omp status` where the lane is on.
import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import {
	AFTER_INSTALL,
	type HermesTarget,
	PLUGIN_BUNDLE,
	disablePlugin,
	dispatcherConfigured,
	enablePlugin,
	findHermes,
	hermesRoot,
	installPlugin,
	listProfiles,
	pluginReport,
	pluginState,
	pluginTarget,
	reportLine,
	resolveTargets,
	uninstallPlugin,
} from "../shared/hermes-plugin";
import type { OmpApi } from "./api";

/** `hermes [-p <profile>] omp status` (the lane and its linked cards), or why it is unavailable. */
function laneStatus(hermes: string, target: HermesTarget): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	const argv = [...(target.profile ? ["-p", target.profile] : []), "omp", "status"];
	execFile(hermes, argv, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 60_000 }, (err, stdout, stderr) => {
		const out = `${stdout}${stderr}`.trim();
		resolve(err ? `hermes omp status failed: ${out || err.message}` : out);
	});
	return promise;
}

type Action = "install" | "uninstall" | "status";

/** Profiles to act on: every profile, the default plus those whose gateway runs the kanban dispatcher pre-selected. */
async function pickTargets(action: Action, source: string): Promise<HermesTarget[] | undefined> {
	if (!listProfiles(hermesRoot()).length) return resolveTargets({});
	const items = resolveTargets({ all: true }).map(t => {
		const state = pluginState(source, pluginTarget(t.home));
		const installed = state.installed ? (state.current ? "installed" : state.managed ? "outdated" : "another plugin with this name") : "not installed";
		const dispatcher = dispatcherConfigured(t.home);
		const picked = action === "install" ? t.label === "default" || dispatcher : action === "uninstall" ? state.installed && state.managed : true;
		return { label: t.label, description: `${installed}${dispatcher ? " · kanban dispatcher on" : ""}`, detail: t.home, picked, target: t };
	});
	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		title: "Hermes profiles",
		placeHolder: "Plugins are per profile; turn the kanban lane on in one of them",
	});
	return picked?.map(p => p.target);
}

export function registerHermesPlugin(api: OmpApi): void {
	api.context.subscriptions.push(
		vscode.commands.registerCommand("omp.hermes.install", async () => {
			const source = path.join(api.context.extensionPath, "out", PLUGIN_BUNDLE);
			const pick = await vscode.window.showQuickPick(
				[
					{ label: "Install or update, and enable", action: "install" as const },
					{ label: "Show status", action: "status" as const },
					{ label: "Uninstall", action: "uninstall" as const },
				],
				{ title: "omp-sessions plugin for Hermes Agent", placeHolder: "omp tools, notifications and a kanban lane (cards assigned to omp run as omp sessions)" },
			);
			if (!pick) return;
			const targets = await pickTargets(pick.action, source);
			if (!targets?.length) return;
			const hermes = findHermes();
			const lines: string[] = [];
			for (const t of targets) {
				const dir = pluginTarget(t.home);
				try {
					if (pick.action === "install") {
						let outcome = installPlugin(source, dir);
						if (outcome === "skipped") {
							const replace = await vscode.window.showWarningMessage(`${dir} holds a plugin omp-vs didn't install. Replace it?`, { modal: true }, "Replace");
							if (replace !== "Replace") continue;
							outcome = installPlugin(source, dir, true);
						}
						lines.push(`${t.label}: ${outcome}`);
						if (hermes) {
							const res = enablePlugin(hermes, t);
							if (!res.ok) lines.push(res.output);
						}
					} else if (pick.action === "uninstall") {
						if (hermes) disablePlugin(hermes, t);
						lines.push(uninstallPlugin(dir) ? `${t.label}: removed ${dir}` : `${t.label}: nothing omp-vs installed at ${dir}`);
					}
				} catch (err) {
					lines.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (pick.action === "install") lines.push(hermes ? "" : "hermes not found: enable it with `hermes [-p <profile>] plugins enable omp-sessions`.", ...AFTER_INSTALL);
			const reports = targets.map(t => pluginReport(source, t, hermes));
			lines.push("", `hermes: ${hermes ?? "not found (PATH, ~/.local/bin/hermes)"}`, ...reports.map(reportLine));
			for (const [i, r] of reports.entries()) if (hermes && r.lane) lines.push("", `${r.label}:`, await laneStatus(hermes, targets[i]));
			void vscode.window.showInformationMessage("Hermes plugin", { modal: true, detail: lines.join("\n").trim() });
		}),
	);
}
