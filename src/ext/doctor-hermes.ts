// omp Doctor's Hermes section: the omp-sessions plugin in each Hermes profile, notifications, the
// kanban lane against where Hermes's dispatcher runs, and the omp-vs the plugin runs. Pure: doctor.ts
// gathers the facts (shared/hermes-plugin.ts, the same data as `omp-vs hermes status --json`).

import type { LaneStatus, PluginReport } from "../shared/hermes-plugin";
import type { Check, Fix } from "./doctor-report";

/** The dispatcher ticks every ~60 s; quieter than this means it stopped (the plugin uses the same bound). */
const DISPATCHER_STALE_S = 180;

export interface HermesFacts {
	/** The hermes executable, when found; `lookup`: where it was looked for (hermesLookup). */
	hermes?: string;
	lookup?: string;
	/** Every profile, default first. */
	profiles: PluginReport[];
	/** `hermes -p <profile> omp status --json` from one profile with the plugin enabled. */
	lane?: { profile: string; status?: LaneStatus; error?: string };
	/** The omp-vs the plugin finds; `gatewayPath`: the gateway's PATH was readable and searched. */
	ompVs?: { path: string; via: "setting" | "PATH" | "install" };
	gatewayPath: boolean;
	/** Unix ms. */
	now: number;
}

const INSTALL: Fix = { label: "Install…", command: "omp.hermes.install" };

function names(list: readonly PluginReport[]): string {
	return list.map(r => r.label).join(", ");
}

function ago(seconds: number): string {
	if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s ago`;
	if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
	return `${Math.round(seconds / 3600)} h ago`;
}

export function hermesChecks(f: HermesFacts): Check[] {
	const out: Check[] = [];
	out.push(f.hermes ? { level: "ok", title: "Hermes Agent found", detail: f.hermes } : { level: "info", title: `hermes not found (${f.lookup ?? "PATH, ~/.local/bin"})`, detail: "The Doctor reads the profiles' files; enabling the plugin and the fixes below need the hermes command." });

	const installed = f.profiles.filter(r => r.state.installed);
	if (!installed.length) {
		out.push({ level: "info", title: "omp-sessions plugin not installed", detail: "omp tools, notifications and a kanban lane for Hermes Agent (docs/HERMES.md).", fixes: [INSTALL] });
		return out;
	}
	const outdated = installed.filter(r => r.state.managed && !r.state.current && !r.ahead);
	const ahead = installed.filter(r => r.state.managed && !r.state.current && r.ahead);
	const foreign = installed.filter(r => !r.state.managed && !r.state.current);
	const off = installed.filter(r => r.status !== "enabled");
	const good = installed.filter(r => r.state.current && r.status === "enabled");
	if (good.length) out.push({ level: "ok", title: `omp-sessions plugin current and enabled in ${good.length} profile(s)`, detail: names(good) });
	if (outdated.length)
		out.push({
			level: "warn",
			title: `omp-sessions plugin outdated in ${names(outdated)}`,
			detail: "omp-vs installed these copies; the extension's bundled plugin is newer. Update replaces them and reloads the plugin in the running gateway (no restart); a changed dashboard page backend loads when the dashboard restarts.",
			fixes: [{ label: "Update", command: "omp.hermes.update", args: [outdated.map(r => r.label)] }],
		});
	if (foreign.length) out.push({ level: "info", title: `omp-sessions plugin in ${names(foreign)} differs from the bundled one`, detail: "Installed with Git or the catalog: omp-vs leaves it alone. Update it with `hermes plugins update omp-sessions`, or replace it with Install… (Replace)." });
	if (ahead.length) out.push({ level: "info", title: `omp-sessions plugin in ${names(ahead)} is newer than this extension's`, detail: "A newer omp-vs (another editor or the CLI) installed it; this extension leaves it as is. Update the extension to match." });
	for (const r of off) out.push({ level: "warn", title: `omp-sessions plugin ${r.status ?? "not enabled"} in ${r.label}`, detail: "Installed but Hermes doesn't load it there.", fixes: [{ label: "Enable", command: "omp.hermes.enable", args: [r.label] }] });
	const missing = f.profiles.filter(r => !r.state.installed);
	if (missing.length) out.push({ level: "info", title: `Not installed in ${missing.length} profile(s)`, detail: `${names(missing)}. Plugins are per profile: install it where you chat with Hermes about code.`, fixes: [INSTALL] });

	// Notifications.
	for (const r of installed.filter(p => p.status === "enabled" && p.injection === false))
		out.push({ level: "warn", title: `Notifications off in ${r.label}`, detail: "allow_gateway_injection is false: Hermes sessions there aren't told when their omp sessions finish or need input.", fixes: [{ label: "Allow", command: "omp.hermes.enable", args: [r.label] }] });
	const note = f.lane?.status?.lastNotification;
	if (note && !note.ok) {
		const consent = installed.find(r => r.label === f.lane?.profile)?.injection;
		const when = `${ago(f.now / 1000 - note.at)}${note.session ? `, omp session ${note.session.slice(0, 8)}` : ""}`;
		out.push(
			consent === true
				? { level: "info", title: `Hermes didn't deliver the last notification (${f.lane?.profile})`, detail: `${when}. Notifications are allowed there, so the chat that started the session had ended (a one-shot \`hermes chat -Q\` or a closed CLI chat). Chats in the gateway, the dashboard and Desktop get them.` }
				: { level: "warn", title: `Hermes refused the last notification (${f.lane?.profile})`, detail: `${when}. allow_gateway_injection off is the usual cause.` },
		);
	}

	// Kanban lane against the dispatcher.
	const lanes = installed.filter(r => r.lane);
	const st = f.lane?.status;
	const where = st?.dispatcher?.profile;
	const laneFix = (label: string, on: boolean): Fix => ({ label: `Turn ${on ? "on" : "off"} in ${label}`, command: "omp.hermes.lane", args: [label, on ? "on" : "off"] });
	if (f.lane?.error) out.push({ level: "info", title: "Could not read the plugin's status", detail: `hermes -p ${f.lane.profile} omp status --json: ${f.lane.error}` });
	else if (st && st.dispatcher === undefined && f.lane) out.push({ level: "info", title: `The plugin in ${f.lane.profile} doesn't report the kanban dispatcher`, detail: "An older plugin: update it, then restart the gateway." });
	else if (st && st.dispatcher === null) out.push({ level: lanes.length ? "warn" : "info", title: "No kanban dispatcher tick has reached the plugin", detail: st.dispatcherNotes[0] ?? "Is the gateway running with the plugin enabled?" });
	else if (st?.dispatcher) {
		const age = f.now / 1000 - st.dispatcher.at;
		out.push(
			age > DISPATCHER_STALE_S
				? { level: lanes.length ? "warn" : "info", title: `Kanban dispatcher last ticked ${ago(age)}`, detail: `In profile ${st.dispatcher.profile}. The gateway or its dispatcher has stopped.` }
				: { level: "ok", title: `Kanban dispatcher runs the plugin in ${st.dispatcher.profile}`, detail: `Last tick ${ago(age)}${st.dispatcher.board ? ` (board ${st.dispatcher.board})` : ""}.` },
		);
	}
	const several = `Kanban lane on in ${lanes.length} profiles: ${names(lanes)}`;
	if (where) {
		const wrong = lanes.filter(r => r.label !== where);
		const onThere = lanes.some(r => r.label === where);
		if (wrong.length)
			out.push({
				level: "warn",
				title: lanes.length > 1 ? several : `Kanban lane on in ${names(wrong)}, but the dispatcher runs the plugin in ${where}`,
				detail: `Hermes's kanban dispatcher ticks the plugin in ${where}: cards assigned to omp start only if the lane is on there, and its lane settings apply. Keep it on in that profile only.`,
				fixes: [...(onThere ? [] : [laneFix(where, true)]), ...wrong.map(r => laneFix(r.label, false))],
			});
		else if (onThere) out.push({ level: "ok", title: `Kanban lane on in ${where}, the dispatcher's profile` });
	} else if (lanes.length > 1)
		out.push({
			level: "warn",
			title: several,
			detail: "Turn it on in one profile only, the one whose gateway runs the kanban dispatcher (with the default multiplexed gateway: default); its lane settings are the ones that apply.",
			fixes: lanes.filter(r => r.label !== "default").map(r => laneFix(r.label, false)),
		});
	else if (lanes.some(r => r.label !== "default"))
		out.push({ level: "info", title: `Kanban lane on in ${names(lanes)}`, detail: "Where the dispatcher runs is unknown. With the default multiplexed gateway it ticks in the default profile; turn the lane on there." });
	if (!lanes.length && installed.some(r => r.status === "enabled")) out.push({ level: "info", title: "Kanban lane off", detail: "Cards assigned to omp run as omp sessions once it is on in the dispatcher's profile.", ...(where ? { fixes: [laneFix(where, true)] } : {}) });

	// omp-vs for the plugin.
	if (installed.some(r => r.status === "enabled")) {
		const setting = installed.find(r => r.ompVs)?.ompVs;
		if (f.ompVs) out.push({ level: "ok", title: "The plugin finds omp-vs", detail: `${f.ompVs.path} (${f.ompVs.via === "setting" ? "omp_vs setting" : f.ompVs.via === "PATH" ? "the gateway's PATH" : "where omp: Install omp-vs Command puts it"})` });
		else
			out.push({
				level: f.gatewayPath ? "error" : "warn",
				title: "The plugin may not find omp-vs",
				detail: `${setting ? `The omp_vs setting (${setting}) is not an executable, and ` : ""}omp-vs is not where omp: Install omp-vs Command puts it${f.gatewayPath ? " or on the gateway's PATH" : " (the gateway's PATH is unknown: no gateway runs, or it is only read on Linux), so it must be on the gateway's PATH or set as the plugin's omp_vs setting"}.`,
				fixes: [{ label: "Install omp-vs", command: "omp.installCli" }],
			});
	}
	return out;
}
