// Hermes Agent in VS Code: "Install Hermes Plugin…" (src/shared/hermes-plugin.ts, the same logic as
// `omp-sessions hermes install`), keeping the copies omp-sessions installed current when the extension updates,
// the Doctor's one-click fixes, and the Hermes origin of sessions the plugin started (open its card).
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
	AFTER_INSTALL,
	DEFAULT_DASHBOARD_URL,
	type HermesRun,
	type HermesTarget,
	PLUGIN_BUNDLE,
	type PluginUpdate,
	disablePlugin,
	dispatcherConfigured,
	enablePlugin,
	findHermes,
	hermesCommand,
	hermesLookup,
	hermesRoot,
	listProfiles,
	pluginReport,
	pluginState,
	pluginTarget,
	reloadSteps,
	reportLine,
	resolveTargets,
	runningDashboardUrl,
	staleCopies,
	uninstallPlugin,
	updateLines,
	updatePlugin,
} from "../shared/hermes-plugin";
import { type HermesOrigin, hermesOrigin, kanbanUrl, showCardArgs } from "../shared/hermes-origin";
import type { OmpApi } from "./api";
import { plain } from "./plain";

const RESTART_COMMAND = "hermes gateway restart";

/** `hermes <args>` without blocking the extension host (no shell, but for a .cmd shim on Windows). */
function hermesAsync(hermes: string, args: string[]): Promise<{ ok: boolean; output: string }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; output: string }>();
	const cmd = hermesCommand(hermes, args);
	execFile(cmd.file, cmd.args, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 60_000, shell: cmd.shell, windowsHide: true }, (err, stdout, stderr) => {
		const out = `${stdout}${stderr}`.trim();
		resolve({ ok: !err, output: out || err?.message || "" });
	});
	return promise;
}

/** `hermes -p <profile> <args>`. */
function hermesIn(hermes: string, target: HermesTarget, args: string[]): Promise<{ ok: boolean; output: string }> {
	return hermesAsync(hermes, ["-p", target.profile, ...args]);
}

/** Disable → enable (retried once): the running gateway reloads the plugin's new files in place (no restart). */
async function reload(hermes: string, target: HermesTarget): Promise<{ reload: HermesRun; leftDisabled: boolean }> {
	const steps = reloadSteps();
	let step = steps.next();
	while (!step.done) step = steps.next(await hermesIn(hermes, target, step.value));
	return step.value;
}

/** updatePlugin with the hermes runs off the extension host's thread; `enable`: enable copies that aren't. */
async function update(source: string, target: HermesTarget, hermes: string | undefined, opts: { force?: boolean; enable?: boolean; onlyIfNewer?: boolean }): Promise<PluginUpdate> {
	const u = updatePlugin(source, target, undefined, opts);
	if (!hermes || u.outcome === "skipped" || u.outcome === "busy") return u;
	if (u.needsReload) {
		const r = await reload(hermes, target);
		u.reload = r.reload;
		if (r.leftDisabled) u.leftDisabled = true;
	} else if (opts.enable) u.enable = enablePlugin(hermes, target);
	return u;
}

/** Says plainly that a reload left the plugin disabled, with an Enable action. */
function warnLeftDisabled(labels: string[]): void {
	if (!labels.length) return;
	void vscode.window
		.showWarningMessage(plain(`The omp-sessions Hermes plugin was left disabled in profile ${labels.join(", ")}: enabling it again after the update failed twice.`), "Enable")
		.then(a => a && vscode.commands.executeCommand("omp.hermes.enable", labels));
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

/** Targets by profile label from a command argument (a label or a list of labels). */
function targetsFrom(arg: unknown): HermesTarget[] {
	const labels = Array.isArray(arg) ? arg.filter((v): v is string => typeof v === "string") : typeof arg === "string" ? [arg] : [];
	return resolveTargets({ all: true }).filter(t => labels.includes(t.label));
}

/** Tells the user once what an automatic refresh changed and what reloads the rest. */
function announceRefresh(lines: string[], dashboardChanged: boolean, reloaded: boolean): void {
	const detail = [
		...lines,
		"",
		reloaded ? "Where the plugin was enabled, the running gateway reloaded it: hooks and commands use the new code now, tools from the next Hermes session." : "New Hermes sessions pick up the plugin's tools.",
		...(dashboardChanged ? ["The dashboard's omp Sessions page backend changed: it loads when the Hermes dashboard restarts."] : []),
		...(reloaded ? [] : [`If hooks (notifications, the kanban lane) still run the old code, restart the gateway: ${RESTART_COMMAND}.`]),
	].join("\n");
	const actions = reloaded && !dashboardChanged ? ["Details"] : ["Details", "Copy Restart Command", "Open Terminal"];
	void vscode.window.showInformationMessage("omp Sessions updated its Hermes plugin.", ...actions).then(a => {
		if (a === "Details") void vscode.window.showInformationMessage("Hermes plugin updated", { modal: true, detail });
		else if (a === "Copy Restart Command") void vscode.env.clipboard.writeText(RESTART_COMMAND);
		else if (a === "Open Terminal") {
			// The command is typed, not run: restarting the gateway interrupts running Hermes chats.
			const term = vscode.window.createTerminal({ name: "Hermes" });
			term.show();
			term.sendText(RESTART_COMMAND, false);
		}
	});
}

/**
 * Refreshes the copies omp-sessions installed when this extension's bundled plugin is newer (never a
 * downgrade, so editors with different versions don't fight). Never touches other copies; a profile
 * another window is installing into right now is skipped quietly.
 */
async function refreshStaleCopies(source: string): Promise<void> {
	if (!fs.existsSync(path.join(source, "plugin.yaml")) || !fs.existsSync(hermesRoot())) return;
	const stale = staleCopies(source, resolveTargets({ all: true }));
	if (!stale.length) return;
	const hermes = findHermes();
	const lines: string[] = [];
	const disabled: string[] = [];
	let dashboardChanged = false;
	let reloaded = false;
	for (const t of stale) {
		try {
			const u = await update(source, t, hermes, { enable: false, onlyIfNewer: true });
			if (u.outcome !== "updated" && u.outcome !== "installed") continue;
			lines.push(...updateLines(t.label, u));
			dashboardChanged ||= u.dashboardChanged;
			reloaded ||= !!u.reload?.ok;
			if (u.leftDisabled) disabled.push(t.label);
		} catch (err) {
			lines.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (lines.length) announceRefresh(lines, dashboardChanged, reloaded);
	warnLeftDisabled(disabled);
}

/** Session id → Hermes origin, from its tags in organize.json. */
function originOf(api: OmpApi, id: string | undefined): HermesOrigin | undefined {
	return id ? hermesOrigin(api.organize.session(id).tags) : undefined;
}

export function registerHermesPlugin(api: OmpApi): void {
	let cardOutput: vscode.OutputChannel | undefined;
	const source = path.join(api.context.extensionPath, "out", PLUGIN_BUNDLE);
	// After activation settles: a few file reads per profile, and hermes runs only for copies that changed.
	const timer = setTimeout(() => void refreshStaleCopies(source), 3000);
	api.context.subscriptions.push({ dispose: () => clearTimeout(timer) });

	const rerunDoctor = (lines: string[], title: string) => {
		void vscode.window.showInformationMessage(title, { modal: true, detail: lines.join("\n").trim() }).then(() => vscode.commands.executeCommand("omp.doctor"));
	};

	api.context.subscriptions.push(
		vscode.commands.registerCommand("omp.hermes.install", async () => {
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
			const disabled: string[] = [];
			for (const t of targets) {
				const dir = pluginTarget(t.home);
				try {
					if (pick.action === "install") {
						let u = await update(source, t, hermes, { enable: true });
						if (u.outcome === "skipped") {
							const replace = await vscode.window.showWarningMessage(`${dir} holds a plugin omp-sessions didn't install. Replace it?`, { modal: true }, "Replace");
							if (replace !== "Replace") continue;
							u = await update(source, t, hermes, { force: true, enable: true });
						}
						lines.push(...updateLines(t.label, u));
						if (u.leftDisabled) disabled.push(t.label);
					} else if (pick.action === "uninstall") {
						if (hermes) disablePlugin(hermes, t);
						lines.push(uninstallPlugin(dir) ? `${t.label}: removed ${dir}` : `${t.label}: nothing omp-sessions installed at ${dir}`);
					}
				} catch (err) {
					lines.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (pick.action === "install") lines.push(hermes ? "" : "hermes not found: enable it with `hermes -p <profile> plugins enable omp-sessions`.", ...AFTER_INSTALL);
			const reports = targets.map(t => pluginReport(source, t));
			lines.push("", `hermes: ${hermes ?? `not found (${hermesLookup()})`}`, ...reports.map(reportLine));
			if (hermes) for (const [i, r] of reports.entries()) if (r.lane) lines.push("", `${r.label}:`, (await hermesIn(hermes, targets[i], ["omp", "status"])).output);
			void vscode.window.showInformationMessage("Hermes plugin", { modal: true, detail: lines.join("\n").trim() });
			warnLeftDisabled(disabled);
		}),

		// Doctor fixes.
		vscode.commands.registerCommand("omp.hermes.update", async (arg?: unknown) => {
			const targets = targetsFrom(arg);
			if (!targets.length) return;
			const hermes = findHermes();
			const lines: string[] = [];
			const disabled: string[] = [];
			for (const t of targets) {
				try {
					const u = await update(source, t, hermes, { enable: false });
					lines.push(...updateLines(t.label, u));
					if (u.leftDisabled) disabled.push(t.label);
				} catch (err) {
					lines.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			rerunDoctor(lines, "Hermes plugin updated");
			warnLeftDisabled(disabled);
		}),
		vscode.commands.registerCommand("omp.hermes.enable", async (arg?: unknown) => {
			const hermes = findHermes();
			const targets = targetsFrom(arg);
			if (!targets.length) return;
			if (!hermes) {
				void vscode.window.showWarningMessage(plain(`hermes not found (${hermesLookup()}).`));
				return;
			}
			const lines = targets.map(t => {
				const r = enablePlugin(hermes, t);
				return `${t.label}: ${r.ok ? "enabled, notifications allowed" : r.output}`;
			});
			rerunDoctor(lines, "Hermes plugin");
		}),
		vscode.commands.registerCommand("omp.hermes.lane", async (profile?: unknown, state?: unknown) => {
			const hermes = findHermes();
			const [target] = targetsFrom(profile);
			if (!target || (state !== "on" && state !== "off")) return;
			if (!hermes) {
				void vscode.window.showWarningMessage(plain(`hermes not found (${hermesLookup()}).`));
				return;
			}
			const command = `hermes -p ${target.label} omp lane ${state}`;
			const ok = await vscode.window.showWarningMessage(`Turn the kanban lane ${state} in profile ${target.label}?`, { modal: true, detail: `Runs: ${command}` }, `Turn ${state === "on" ? "On" : "Off"}`);
			if (!ok) return;
			const r = await hermesIn(hermes, target, ["omp", "lane", state]);
			rerunDoctor([r.output || (r.ok ? "done" : "failed")], r.ok ? "Kanban lane" : "Kanban lane: command failed");
		}),

		// Sessions started from Hermes.
		vscode.commands.registerCommand("omp.hermes.openCard", async (arg?: unknown) => {
			const origin = originOf(api, api.idFrom(arg));
			if (!origin?.card) return;
			// The setting, else the dashboard Hermes's spawn ledger records as running (any port), else the default.
			const configured = vscode.workspace.getConfiguration("omp.hermes").get<string>("dashboardUrl")?.trim();
			const running = configured ? undefined : runningDashboardUrl(hermesRoot());
			if (!configured && !running) {
				const pick = await vscode.window.showWarningMessage(
					"No running Hermes dashboard found",
					{ modal: true, detail: `Hermes doesn't record a running dashboard on this machine. Start it with \`hermes dashboard\`, set omp.hermes.dashboardUrl when it runs elsewhere, or show card ${origin.card} here.` },
					"Show Card",
					`Open ${DEFAULT_DASHBOARD_URL}`,
				);
				if (pick === "Show Card") await vscode.commands.executeCommand("omp.hermes.showCard", arg);
				if (pick !== `Open ${DEFAULT_DASHBOARD_URL}`) return;
			}
			// openExternal forwards a remote machine's localhost port to this window's machine itself (Remote-SSH,
			// WSL, dev containers); resolving it with asExternalUri first would forward the forwarded port again.
			await vscode.env.openExternal(vscode.Uri.parse(kanbanUrl(configured || running || DEFAULT_DASHBOARD_URL)));
			// The Kanban page has no link to a board or card: say where to look.
			vscode.window.setStatusBarMessage(`$(link-external) Hermes Kanban: card ${origin.card}${origin.board ? ` on board ${origin.board}` : ""}`, 15_000);
		}),
		vscode.commands.registerCommand("omp.hermes.showCard", async (arg?: unknown) => {
			const origin = originOf(api, api.idFrom(arg));
			if (!origin?.card) return;
			const args = showCardArgs({ ...origin, card: origin.card });
			if (!args) {
				void vscode.window.showWarningMessage("This session's Hermes card or board tag isn't a plain Hermes id, so omp won't pass it to hermes.");
				return;
			}
			const hermes = findHermes();
			if (!hermes) {
				void vscode.window.showWarningMessage(plain(`hermes not found (${hermesLookup()}).`));
				return;
			}
			cardOutput ??= vscode.window.createOutputChannel("Hermes Card");
			const out = cardOutput;
			out.clear();
			out.appendLine(`$ hermes ${args.join(" ")}`);
			out.show(true);
			const r = await hermesAsync(hermes, args);
			out.appendLine(r.output || (r.ok ? "(no output)" : "failed"));
		}),
		{ dispose: () => cardOutput?.dispose() },
	);
}
