// "omp: Session Settings…": per-session skills / tools / MCP servers / rules / extensions / LSP,
// plus model, thinking, permission mode and max time. Saved to the session's launch.json (flags)
// and session-config.json (the host turns it into an omp settings overlay on every start).
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { sendToHost, setSessionPermissionMode } from "../shared/launch";
import { PERMISSION_MODE_INFO, permissionModeOf } from "../shared/permissions";
import { sessionDir } from "../shared/protocol";
import {
	type SessionFlags,
	type SessionToggles,
	THINKING_LEVELS,
	TOOL_GATES,
	applyFlags,
	emptyFlags,
	emptyToggles,
	gateBaseline,
	normalizeToggles,
	readFlags,
	readLaunchArgs,
	readProjectDefaults,
	readSessionToggles,
	settingsSummary,
	writeLaunchArgs,
	writeProjectDefaults,
	writeSessionToggles,
} from "../shared/session-config";
import { type Capabilities, discoverCapabilities } from "../shared/session-discovery";
import type { OmpApi } from "./api";
import { defaultModelLabel, loadModels } from "./launch-options";
import { pickPermissionMode } from "./permissions";
import { plain } from "./plain";
import { projectRoot, resolveOmpPath } from "./sessions";

/** The editable state: managed launch flags plus overlay toggles. */
export interface SettingsDraft {
	flags: SessionFlags;
	toggles: SessionToggles;
}

type Row = vscode.QuickPickItem & { action?: string };

const SEP = vscode.QuickPickItemKind.Separator;

function cloneDraft(d: SettingsDraft): SettingsDraft {
	return { flags: { ...d.flags }, toggles: normalizeToggles(d.toggles) };
}

/** Skills, MCP servers and omp's effective settings for `cwd`, with a progress notice. */
export function loadCapabilities(cwd: string, dir?: string): Thenable<Capabilities> {
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "omp: reading skills, tools and MCP servers…" }, () => discoverCapabilities(resolveOmpPath(), cwd, dir));
}

function setDisabled(toggles: SessionToggles, id: string, off: boolean): void {
	const set = new Set(toggles.disabled);
	if (off) set.add(id);
	else set.delete(id);
	toggles.disabled = [...set].sort();
}

// ---------- pickers (shared by Session Settings and the New Session wizard) ----------

/** Multi-select over discovered skills; none checked = `--no-skills`. False when cancelled. */
export async function pickSkills(draft: SettingsDraft, caps: Capabilities, title: string): Promise<boolean> {
	const known = new Set(caps.skills.map(s => s.name));
	const missing = draft.toggles.disabled.filter(x => x.startsWith("skill:") && !known.has(x.slice(6))).map(x => x.slice(6));
	const items: Array<vscode.QuickPickItem & { name: string }> = [
		...caps.skills.map(s => ({ label: s.name, description: s.source, detail: s.description || undefined, name: s.name, picked: !draft.flags.noSkills && !draft.toggles.disabled.includes(`skill:${s.name}`) })),
		...missing.map(name => ({ label: name, description: "not found now", name, picked: false })),
	];
	if (!items.length) {
		void vscode.window.showInformationMessage(caps.ompOk ? "omp found no skills for this folder." : "No skills found (and omp could not be run to list them).");
		return false;
	}
	const picked = await vscode.window.showQuickPick(items, {
		title,
		placeHolder: "Checked skills are available to the agent (uncheck all = no skills)",
		canPickMany: true,
		matchOnDescription: true,
		matchOnDetail: true,
		ignoreFocusOut: true,
	});
	if (!picked) return false;
	const on = new Set(picked.map(p => p.name));
	draft.flags.noSkills = on.size === 0;
	for (const it of items) setDisabled(draft.toggles, `skill:${it.name}`, !draft.flags.noSkills && !on.has(it.name));
	return true;
}

/** Multi-select over omp's setting-gated built-in tools. False when cancelled. */
export async function pickTools(draft: SettingsDraft, caps: Capabilities, title: string): Promise<boolean> {
	const items = TOOL_GATES.map(g => {
		const base = gateBaseline(g.setting, caps.config);
		const now = draft.toggles.tools[g.setting] ?? base;
		return { label: g.label, description: now !== base ? `(${base ? "on" : "off"} by default)` : undefined, detail: g.detail, setting: g.setting, base, picked: now };
	});
	const picked = await vscode.window.showQuickPick(items, {
		title,
		placeHolder: "Checked tools are enabled for this session (read/edit/write and MCP tools are always on; LSP has its own switch)",
		canPickMany: true,
		matchOnDetail: true,
		ignoreFocusOut: true,
	});
	if (!picked) return false;
	const on = new Set(picked.map(p => p.setting));
	const tools: Record<string, boolean> = {};
	for (const it of items) if (on.has(it.setting) !== it.base) tools[it.setting] = on.has(it.setting);
	draft.toggles.tools = tools;
	return true;
}

/** Multi-select over configured MCP servers. False when cancelled. */
export async function pickMcp(draft: SettingsDraft, caps: Capabilities, title: string): Promise<boolean> {
	const usable = caps.mcp.filter(s => !s.disabledByConfig);
	const known = new Set(usable.map(s => s.name));
	const missing = draft.toggles.disabled.filter(x => x.startsWith("mcp:") && !known.has(x.slice(4))).map(x => x.slice(4));
	const items: Array<vscode.QuickPickItem & { name: string }> = [
		...usable.map(s => ({ label: s.name, description: s.source, detail: s.file, name: s.name, picked: !draft.toggles.disabled.includes(`mcp:${s.name}`) })),
		...missing.map(name => ({ label: name, description: "not found now", name, picked: false })),
	];
	const off = caps.mcp.filter(s => s.disabledByConfig).map(s => s.name);
	if (!items.length) {
		void vscode.window.showInformationMessage(plain(`No MCP servers configured for this folder${off.length ? ` (disabled in omp's mcp.json: ${off.join(", ")})` : ""}.`));
		return false;
	}
	const picked = await vscode.window.showQuickPick(items, {
		title,
		placeHolder: `Checked MCP servers connect in this session${off.length ? ` · disabled in config: ${off.join(", ")}` : ""}`,
		canPickMany: true,
		matchOnDescription: true,
		ignoreFocusOut: true,
	});
	if (!picked) return false;
	const on = new Set(picked.map(p => p.name));
	for (const it of items) setDisabled(draft.toggles, `mcp:${it.name}`, !on.has(it.name));
	return true;
}

/** Model selector; `null` = omp's default, undefined = cancelled. */
async function pickModel(cwd: string, current: string | undefined, running: string | undefined, title: string): Promise<string | null | undefined> {
	const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { selector: string | null }>();
	qp.title = title;
	qp.placeholder = `Model${running ? ` (running now: ${running})` : ""}`;
	qp.matchOnDescription = true;
	const head = [{ label: "$(settings) Default model", description: `${defaultModelLabel({ default: null, ompDefault: null })}${current ? "" : " · current"}`, selector: null }];
	qp.items = head;
	qp.busy = true;
	qp.show();
	void loadModels(cwd).then(list => {
		const top = [{ ...head[0], description: `${defaultModelLabel(list)}${current ? "" : " · current"}` }];
		qp.items = [...top, ...list.models.map(m => ({ label: m.name, description: `${m.selector}${m.selector === current ? " · current" : ""}${m.default ? " · default" : ""}`, detail: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : undefined, selector: m.selector }))];
		const active = qp.items.find(i => i.selector === current);
		if (active) qp.activeItems = [active];
		qp.busy = false;
	});
	const done = Promise.withResolvers<string | null | undefined>();
	qp.onDidAccept(() => done.resolve(qp.selectedItems[0]?.selector));
	qp.onDidHide(() => done.resolve(undefined));
	const result = await done.promise;
	qp.dispose();
	return result;
}

/** Choice among `values` plus "default"; `null` = default, undefined = cancelled. */
async function pickValue(values: readonly string[], current: string | undefined, omp: unknown, title: string, placeHolder: string): Promise<string | null | undefined> {
	const items = [
		{ label: "$(settings) omp default", description: `${typeof omp === "string" ? omp : ""}${current ? "" : " · current"}`, value: null },
		...values.map(v => ({ label: v, description: v === current ? "current" : "", value: v })),
	];
	const pick = await vscode.window.showQuickPick(items, { title, placeHolder });
	return pick ? pick.value : undefined;
}

// ---------- the settings hub ----------

interface HubOptions {
	title: string;
	cwd: string;
	caps: Capabilities;
	/** Include model / thinking / approval / max time rows. */
	launchRows: boolean;
	/** Model the running session uses now (shown next to the model row). */
	runningModel?: string;
	/** Extra rows after the editable ones (their `action` ends the hub). */
	footer: () => Row[];
}

/** Lets the user edit `draft` until a footer row is accepted (its action) or Esc (undefined). */
async function hub(draft: SettingsDraft, o: HubOptions): Promise<string | undefined> {
	let focus: string | undefined;
	for (;;) {
		const f = draft.flags;
		const skillsOff = draft.toggles.disabled.filter(x => x.startsWith("skill:")).length;
		const mcpTotal = o.caps.mcp.filter(s => !s.disabledByConfig).length;
		const mcpOff = draft.toggles.disabled.filter(x => x.startsWith("mcp:")).length;
		const toolChanges = Object.entries(draft.toggles.tools);
		const cfg = o.caps.config;
		const onOff = (off: boolean) => (off ? "$(circle-slash) off" : "$(pass) on");
		const rows: Row[] = [
			...(o.launchRows
				? [
						{ label: "Launch", kind: SEP },
						{ label: "$(hubot) Model", description: f.model ?? `omp default${o.runningModel ? ` (now ${o.runningModel})` : ""}`, action: "model" },
						{ label: "$(lightbulb) Thinking", description: f.thinking ?? `omp default${typeof cfg.get("defaultThinkingLevel") === "string" ? ` (${String(cfg.get("defaultThinkingLevel"))})` : ""}`, action: "thinking" },
						{ label: "$(shield) Permission mode", description: modeLabel(f.approvalMode) ?? `omp default${modeLabel(cfg.get("tools.approvalMode")) ? ` (${modeLabel(cfg.get("tools.approvalMode"))})` : ""}`, action: "approval" },
						{ label: "$(watch) Max time", description: f.maxTime ?? "no limit", action: "maxTime" },
					]
				: []),
			{ label: "Capabilities", kind: SEP },
			{ label: "$(book) Skills", description: f.noSkills ? "$(circle-slash) all off" : `${o.caps.skills.length - Math.min(skillsOff, o.caps.skills.length)}/${o.caps.skills.length} on`, action: "skills" },
			{ label: "$(tools) Built-in tools", description: toolChanges.length ? toolChanges.map(([s, on]) => `${TOOL_GATES.find(g => g.setting === s)?.label ?? s} ${on ? "on" : "off"}`).join(", ") : "omp defaults", action: "tools" },
			{ label: "$(plug) MCP servers", description: `${Math.max(0, mcpTotal - mcpOff)}/${mcpTotal} on`, action: "mcp" },
			{ label: "$(law) Rules", description: onOff(f.noRules), detail: "Project/user rules (AGENTS.md-style rule files) — toggle", action: "rules" },
			{ label: "$(extensions) Extensions & plugins", description: onOff(f.noExtensions), detail: "Discovered omp extensions, hooks and plugins — toggle", action: "extensions" },
			{ label: "$(symbol-class) LSP", description: onOff(f.noLsp), detail: "Language servers: lsp tool, format-on-write, diagnostics — toggle", action: "lsp" },
			{ label: "", kind: SEP },
			...o.footer(),
		];
		const picked = await showRows(rows, o.title, focus);
		if (!picked?.action) return undefined;
		focus = picked.action;
		switch (picked.action) {
			case "model": {
				const v = await pickModel(o.cwd, f.model, o.runningModel, o.title);
				if (v !== undefined) f.model = v ?? undefined;
				break;
			}
			case "thinking": {
				const v = await pickValue(THINKING_LEVELS, f.thinking, cfg.get("defaultThinkingLevel"), o.title, "Thinking level");
				if (v !== undefined) f.thinking = v ?? undefined;
				break;
			}
			case "approval": {
				const v = await pickPermissionMode(permissionModeOf(f.approvalMode), o.title, modeLabel(cfg.get("tools.approvalMode")) ?? "Auto");
				if (v !== undefined) f.approvalMode = v ?? undefined;
				break;
			}
			case "maxTime": {
				const v = await vscode.window.showInputBox({
					title: o.title,
					prompt: "Stop the agent after this much wall time (e.g. 90s, 30m, 2h; empty = no limit)",
					value: f.maxTime ?? "",
					validateInput: s => (!s.trim() || /^\d+(\.\d+)?[smh]?$/.test(s.trim()) ? undefined : "A number of seconds or a duration like 10m / 1h"),
				});
				if (v !== undefined) f.maxTime = v.trim() || undefined;
				break;
			}
			case "skills":
				await pickSkills(draft, o.caps, o.title);
				break;
			case "tools":
				await pickTools(draft, o.caps, o.title);
				break;
			case "mcp":
				await pickMcp(draft, o.caps, o.title);
				break;
			case "rules":
				f.noRules = !f.noRules;
				break;
			case "extensions":
				f.noExtensions = !f.noExtensions;
				break;
			case "lsp":
				f.noLsp = !f.noLsp;
				break;
			default:
				return picked.action;
		}
	}
}

function showRows(rows: Row[], title: string, focus: string | undefined): Promise<Row | undefined> {
	const qp = vscode.window.createQuickPick<Row>();
	qp.title = title;
	qp.placeholder = "Pick a setting to change, then Apply (Esc discards)";
	qp.items = rows;
	const active = rows.find(r => r.action === focus);
	if (active) qp.activeItems = [active];
	const done = Promise.withResolvers<Row | undefined>();
	qp.onDidAccept(() => done.resolve(qp.selectedItems[0]));
	qp.onDidHide(() => done.resolve(undefined));
	qp.show();
	return done.promise.finally(() => qp.dispose());
}

// ---------- New Session wizard step ----------

/** "Skills & tools…" step of New Session with Options: edits `draft` in place; false when cancelled. */
export async function editCapabilities(cwd: string, draft: SettingsDraft, title: string): Promise<boolean> {
	const caps = await loadCapabilities(cwd);
	const work = cloneDraft(draft);
	const action = await hub(work, { title, cwd, caps, launchRows: false, footer: () => [{ label: "$(check) Done", action: "done" }] });
	if (action !== "done") return false;
	draft.flags = work.flags;
	draft.toggles = work.toggles;
	return true;
}

// ---------- Session Settings command ----------

const RESTART_FLAGS: ReadonlyArray<keyof SessionFlags> = ["maxTime", "noLsp", "noRules", "noExtensions", "noSkills"];

function modeLabel(value: unknown): string | undefined {
	const mode = permissionModeOf(value);
	return mode ? PERMISSION_MODE_INFO[mode].label : undefined;
}

async function stopAndWait(api: OmpApi, id: string): Promise<void> {
	const meta = api.sessions.get(id);
	if (!meta || meta.status === "stopped") return;
	const kill = () => {
		try {
			process.kill(meta.pid, "SIGTERM");
		} catch {
			/* already gone */
		}
	};
	if (!(await sendToHost(meta, { t: "stop" }))) kill();
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		api.sessions.refresh();
		if (api.sessions.get(id)?.status === "stopped") return;
		await sleep(200);
	}
	kill();
	await sleep(500);
}

/** Restarts a session with its saved launch settings; the conversation continues via resume. */
async function restart(api: OmpApi, id: string): Promise<void> {
	const meta = api.sessions.get(id);
	if (!meta) return;
	await stopAndWait(api, id);
	await api.launchAndOpen({ cwd: meta.cwd, id });
}

async function applyToSession(api: OmpApi, id: string, original: string[], before: SettingsDraft, draft: SettingsDraft): Promise<void> {
	writeLaunchArgs(id, applyFlags(original, draft.flags));
	writeSessionToggles(id, draft.toggles);
	api.refreshTree();
	const meta = api.sessions.get(id);
	if (!meta) return;
	if (meta.status === "stopped") {
		const a = await vscode.window.showInformationMessage(plain(`Saved settings of "${meta.title}"; they apply when it is resumed.`), "Resume now");
		if (a) await api.launchAndOpen({ cwd: meta.cwd, id });
		return;
	}
	// Model and thinking switch live; the rest needs a fresh omp process.
	const live: string[] = [];
	const model = draft.flags.model;
	if (model && model !== before.flags.model && model.includes("/")) {
		const slash = model.indexOf("/");
		if (await sendToHost(meta, { t: "rpc", cmd: { type: "set_model", provider: model.slice(0, slash), modelId: model.slice(slash + 1) } })) live.push(`model ${model}`);
	}
	if (draft.flags.thinking && draft.flags.thinking !== before.flags.thinking) {
		if (await sendToHost(meta, { t: "rpc", cmd: { type: "set_thinking_level", level: draft.flags.thinking } })) live.push(`thinking ${draft.flags.thinking}`);
	}
	const mode = permissionModeOf(draft.flags.approvalMode);
	const modeChanged = draft.flags.approvalMode !== before.flags.approvalMode;
	if (mode && modeChanged && (await setSessionPermissionMode(meta, mode))) live.push(`to ${PERMISSION_MODE_INFO[mode].label} mode`);
	// Hosts that predate permission modes take the approval flag only at start.
	const restartNeeded =
		JSON.stringify(normalizeToggles(before.toggles)) !== JSON.stringify(normalizeToggles(draft.toggles)) || RESTART_FLAGS.some(k => before.flags[k] !== draft.flags[k]) || (modeChanged && meta.permissionMode === undefined);
	const liveNote = live.length ? `Switched ${live.join(" and ")} now. ` : "";
	if (!restartNeeded) {
		void vscode.window.showInformationMessage(plain(`${liveNote}Saved settings of "${meta.title}".`));
		return;
	}
	const now = "Apply now (restart session)";
	const later = "Apply on next resume";
	const choice =
		meta.status === "idle"
			? await vscode.window.showInformationMessage(plain(`${liveNote}The other changes need "${meta.title}" to restart; the conversation continues after it.`), now, later)
			: await vscode.window.showWarningMessage(plain(`${liveNote}"${meta.title}" is ${meta.status === "working" ? "working" : "waiting for input"}; the other changes apply when it restarts.`), "Restart now anyway", later);
	if (choice === now || choice === "Restart now anyway") await restart(api, id);
}

async function sessionSettings(api: OmpApi, arg: unknown): Promise<void> {
	const id = api.idFrom(arg) ?? (await api.pickSession("Skills, tools & model of which session?"));
	const meta = id ? api.sessions.get(id) : undefined;
	if (!id || !meta) return;
	const original = readLaunchArgs(id) ?? [];
	const before: SettingsDraft = { flags: readFlags(original), toggles: readSessionToggles(id) };
	let draft = cloneDraft(before);
	const caps = await loadCapabilities(meta.cwd, sessionDir(id));
	const root = projectRoot(meta.cwd).root;
	const title = `Session settings · ${meta.title}`;
	for (;;) {
		const defaults = readProjectDefaults(meta.cwd);
		const changed = JSON.stringify(draft) !== JSON.stringify(before);
		const action = await hub(draft, {
			title,
			cwd: meta.cwd,
			caps,
			launchRows: true,
			runningModel: meta.status !== "stopped" ? meta.model : undefined,
			footer: () => [
				{ label: "$(check) Apply", description: changed ? "" : "no changes", detail: settingsSummary(applyFlags([], draft.flags), draft.toggles).join(" · ") || "omp defaults", action: "apply" },
				{ label: "$(save) Save as project default", description: root, detail: "New sessions in this project start with these settings", action: "saveDefault" },
				...(defaults
					? [
							{ label: "$(history) Reset to project default", description: settingsSummary(defaults.args, defaults.toggles).join(" · ") || "omp defaults", action: "useDefault" },
							{ label: "$(trash) Clear project default", description: defaults.root, action: "clearDefault" },
						]
					: []),
				{ label: "$(discard) Reset to omp defaults", action: "reset" },
			],
		});
		switch (action) {
			case undefined:
				return;
			case "apply":
				if (JSON.stringify(draft) !== JSON.stringify(before)) await applyToSession(api, id, original, before, draft);
				return;
			case "saveDefault":
				writeProjectDefaults(root, { args: applyFlags([], draft.flags), toggles: draft.toggles });
				void vscode.window.showInformationMessage(plain(`New omp sessions in ${root} start with these settings.`));
				break;
			case "useDefault":
				if (defaults) draft = { flags: readFlags(defaults.args), toggles: normalizeToggles(defaults.toggles) };
				break;
			case "clearDefault":
				if (defaults) writeProjectDefaults(defaults.root, undefined);
				break;
			case "reset":
				draft = { flags: emptyFlags(), toggles: emptyToggles() };
				break;
		}
	}
}

export function registerSessionConfig(api: OmpApi): void {
	api.context.subscriptions.push(vscode.commands.registerCommand("omp.sessionSettings", (arg?: unknown) => sessionSettings(api, arg)));
}
