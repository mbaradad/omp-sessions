// The AO orchestrator in VS Code: the Orchestrators view and `switchyard.orchestrator.*` commands. Everything it
// shows and does is src/ao/orchestrator.ts's (the same calls as `switchyard orchestrator` and the Hermes page);
// the view refreshes on AO's change events, and the orchestrator's chat is an ordinary Switchyard chat panel.
import * as vscode from "vscode";
import type { AoClient, AoProject } from "../ao/client";
import { readSwitchyardConfig } from "../ao/config";
import { availableHarnesses } from "../ao/harness";
import {
	ORCHESTRATOR_PERMISSIONS,
	type OrchestratorConfig,
	type OrchestratorConfigPatch,
	listOrchestrators,
	orchestratorConfig,
	resolveProject,
	restartOrchestrator,
	setOrchestratorConfig,
	submitTask,
} from "../ao/orchestrator";
import type { OmpApi } from "./api";
import type { AoConnection } from "./ao-connection";
import { type ProjectEntry, SETTING_LABELS, briefOf, briefPreview, chooseProject, isSettingKey, projectEntries, projectIdFrom, settingRows } from "./orchestrator-core";
import { RULES_SCHEME, RulesFileSystem, rulesUri } from "./orchestrator-rules";
import { OrchestratorTree } from "./orchestrator-tree";
import { plain } from "./plain";
import { withinAny } from "./session-scope";

/** How long AO's events must stay quiet before the view reads AO again (a working session emits many). */
const SETTLE_MS = 600;

/** The folders of this window as paths on the machine AO runs on (sessions.inWorkspace counts the same ones). */
function workspaceFolders(only?: vscode.Uri): string[] {
	const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === "file" || f.uri.scheme === "vscode-remote").map(f => f.uri.fsPath);
	const owner = only && folders.find(f => withinAny([only.fsPath], [f]));
	return owner ? [owner] : folders;
}

/** The AO projects of the window's git folders (registered in AO when `create`; folders outside git have none). */
async function workspaceProjects(client: AoClient, create: boolean, only?: vscode.Uri): Promise<AoProject[]> {
	const found = await Promise.all(workspaceFolders(only).map(folder => resolveProject(client, undefined, folder, { create }).catch(() => undefined)));
	const projects = found.filter((p): p is AoProject => !!p);
	return projects.filter((p, i) => projects.findIndex(x => x.id === p.id) === i);
}

/**
 * Every project's orchestrator with its workers and PRs, plus this window's projects, read from AO and read again
 * when AO says something changed (the shared change stream: no timer polls). A hidden view waits until it shows.
 */
export class OrchestratorStore implements vscode.Disposable {
	entries: ProjectEntry[] = [];
	/** The first read finished (until then the view shows nothing, not "none"). */
	loaded = false;
	/** Why the last read failed (AO unreachable…); the entries stay what they were. */
	error: string | undefined;
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private running: Promise<void> | undefined;
	private again = false;
	private timer: NodeJS.Timeout | undefined;
	private stale = false;
	/** Who is showing what the store reads (the Orchestrators view, the Overview): it reads again only while one of them is. */
	private readonly showing = new Map<string, boolean>([["view", true]]);
	private disposed = false;

	constructor(private readonly ao: AoConnection) {}

	entry(projectId: string): ProjectEntry | undefined {
		return this.entries.find(e => e.project.id === projectId);
	}

	private get visible(): boolean {
		return [...this.showing.values()].some(Boolean);
	}

	setVisible(visible: boolean, holder = "view"): void {
		this.showing.set(holder, visible);
		if (this.visible && this.stale) void this.refresh();
	}

	/** An AO event happened: read again once things settle (when the view is on screen). */
	schedule(): void {
		if (!this.visible) {
			this.stale = true;
			return;
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.refresh(), SETTLE_MS);
	}

	/** Reads AO now; calls made while a read runs share one more read afterwards. */
	refresh(): Promise<void> {
		this.stale = false;
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			do {
				this.again = false;
				try {
					this.entries = await this.load();
					this.error = undefined;
				} catch (err) {
					this.error = err instanceof Error ? err.message : String(err);
				}
				this.loaded = true;
				if (!this.disposed) this.emitter.fire();
			} while (this.again && !this.disposed);
		})().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	private async load(): Promise<ProjectEntry[]> {
		const client = await this.ao.client(false);
		const [infos, mine] = await Promise.all([listOrchestrators(client, { includeStopped: true }), workspaceProjects(client, false)]);
		// A project of this window with no orchestrator yet still shows the settings its first one starts with.
		const without = mine.filter(p => !infos.some(o => o.projectId === p.id));
		const configs = new Map(await Promise.all(without.map(async p => [p.id, await orchestratorConfig(client, p.id).catch((): OrchestratorConfig => ({}))] as const)));
		return projectEntries(infos, mine, configs);
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.emitter.dispose();
	}
}

/** What a quick pick or input box answered: `value` null clears the setting; undefined (no answer) is a cancel. */
type Answer = { value: string | null } | undefined;

/** What `Configure Orchestrator…` explains about each permission level. */
const PERMISSION_TEXT: Record<(typeof ORCHESTRATOR_PERMISSIONS)[number], string> = {
	default: "asks before tools run",
	"accept-edits": "accepts file edits, asks for the rest",
	auto: "AO's automatic approval",
	"bypass-permissions": "no prompts (what an orchestrator starts with: it runs ao commands unattended)",
};

export interface OrchestratorUi {
	readonly store: OrchestratorStore;
	/** Redraws the view (the chat's unread mark changed). */
	refresh(): void;
}

export function registerOrchestrators(api: OmpApi): OrchestratorUi {
	const { context, sessions } = api;
	const store = api.orchestrators;
	const tree = new OrchestratorTree(store, sessions, id => api.isUnread(id));
	const view = vscode.window.createTreeView("switchyard.orchestrators", { treeDataProvider: tree, showCollapseAll: true });
	const rules = new RulesFileSystem(() => api.ao.client(), projectId => void afterConfigChange(projectId));
	store.setVisible(view.visible);

	const fail = (what: string, err: unknown) => {
		void vscode.window.showErrorMessage(plain(`Could not ${what}: ${err instanceof Error ? err.message : String(err)}`), "Show AO Log").then(a => a && api.ao.log.show());
	};

	/** The chat panel of an orchestrator or one of its workers (a session the watcher may not have listed yet). */
	async function openSessionChat(id: string): Promise<void> {
		if (!sessions.get(id)) await sessions.refreshSession(id);
		api.openPanel(id)?.focusComposer();
	}

	/** The project a command means: the node's, else this window's (the active file's folder when `uri` says), else a pick over AO's. */
	async function pickProject(arg: unknown, placeHolder: string, uri?: vscode.Uri): Promise<AoProject | undefined> {
		const client = await api.ao.client();
		const given = projectIdFrom(arg);
		const mine = given ? [] : await workspaceProjects(client, true, uri);
		const known = given || mine.length === 1 ? [] : await client.listProjects();
		const choice = chooseProject(arg, mine.map(p => p.id), known.map(p => p.id));
		if (choice.kind === "none") {
			void vscode.window.showWarningMessage("The orchestrator coordinates an AO project: open a folder of a git repository first.");
			return undefined;
		}
		if (choice.kind === "project") return mine.find(p => p.id === choice.id) ?? resolveProject(client, choice.id, "/");
		const pool = (mine.length ? mine : known).filter(p => choice.ids.includes(p.id));
		return (await vscode.window.showQuickPick(pool.map(project => ({ label: project.name, description: project.path, project })), { placeHolder }))?.project;
	}

	/** The entry of the project a command means, which must have an orchestrator (a running one with `active`); asks when several do. */
	async function entryFor(arg: unknown, need: "orchestrator" | "active", what: string): Promise<ProjectEntry | undefined> {
		const given = projectIdFrom(arg);
		if (!given || !store.loaded) await store.refresh();
		const fits = (e: ProjectEntry) => (need === "active" ? e.orchestrator?.active === true : !!e.orchestrator);
		const lacking = (e: ProjectEntry | undefined) => {
			void vscode.window.showInformationMessage(plain(`${e ? `${e.project.name} has` : "No project has"} no ${need === "active" ? "running " : ""}orchestrator.`), "Give Orchestrator a Task").then(a => a && vscode.commands.executeCommand("switchyard.orchestrator.submit", e?.project.id));
			return undefined;
		};
		if (given) {
			const entry = store.entry(given);
			return entry && fits(entry) ? entry : lacking(entry);
		}
		const all = store.entries.filter(fits);
		const mine = all.filter(e => e.inWorkspace);
		const pool = mine.length ? mine : all;
		if (pool.length === 0) return lacking(undefined);
		if (pool.length === 1) return pool[0];
		return (await vscode.window.showQuickPick(pool.map(e => ({ label: e.project.name, description: e.project.path, entry: e })), { placeHolder: `${what} of which project?` }))?.entry;
	}

	/** Harness for an orchestrator this task would start: asked when nobody chose and several are logged in (as a new session is); undefined when cancelled. */
	async function startOptions(client: AoClient, project: AoProject): Promise<{ harness?: string } | undefined> {
		if ((await client.listOrchestrators({ projectId: project.id, active: true }))[0]) return {};
		if ((await orchestratorConfig(client, project.id).catch((): OrchestratorConfig => ({}))).harness) return {};
		const harness = await sessions.chooseHarness(project.path);
		return harness ? { harness } : undefined;
	}

	/** Sends the task (or steering) to the project's orchestrator, starting it when needed, and opens its chat. */
	async function deliver(project: AoProject, text: string, steer: boolean): Promise<void> {
		try {
			const client = await api.ao.client();
			const start = await startOptions(client, project);
			if (!start) return;
			const defaultHarness = vscode.workspace.getConfiguration("switchyard").get<string>("defaultHarness")?.trim() || readSwitchyardConfig().harness?.trim() || undefined;
			const title = steer ? "Switchyard: steering the orchestrator" : "Switchyard: giving the orchestrator the task";
			const sent = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => submitTask(client, project, text, { steer, ...start, ...(defaultHarness && { defaultHarness }) }));
			await Promise.all([store.refresh(), sessions.refreshSession(sent.orchestrator)]);
			api.openPanel(sent.orchestrator);
		} catch (err) {
			fail(steer ? "steer the orchestrator" : "give the orchestrator the task", err);
		}
	}

	async function confirmBrief(project: AoProject, brief: string, from: string): Promise<boolean> {
		return (await vscode.window.showInformationMessage(`Give ${project.name}'s orchestrator ${from} as its task?`, { modal: true, detail: briefPreview(brief) }, "Give Task")) === "Give Task";
	}

	async function giveTask(arg: unknown, steer: boolean): Promise<void> {
		if (steer) {
			const entry = await entryFor(arg, "active", "Steer the orchestrator");
			const project = entry && (await pickProject(entry.project.id, ""));
			if (!project) return;
			const text = await vscode.window.showInputBox({ title: `Steer ${project.name}'s orchestrator`, prompt: "Redirects what it is doing now (sent as a steering message)", ignoreFocusOut: true });
			if (text?.trim()) await deliver(project, text, true);
			return;
		}
		const project = await pickProject(arg, "Give which project's orchestrator a task?");
		if (!project) return;
		const text = await vscode.window.showInputBox({
			title: `Give ${project.name}'s orchestrator a task`,
			prompt: "A high-level task: it splits it into worker sessions, steers them and has their pull requests reviewed. A long brief: Give Orchestrator the Active File as a Task.",
			placeHolder: "Move the billing module to the new API and update its tests",
			ignoreFocusOut: true,
		});
		if (text?.trim()) await deliver(project, text, false);
	}

	async function giveEditorText(arg: unknown, what: "selection" | "file"): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || (what === "selection" && editor.selection.isEmpty)) {
			void vscode.window.showInformationMessage(what === "selection" ? "Select the text of the task first." : "Open the file with the brief first (an untitled document works).");
			return;
		}
		const raw = what === "selection" ? editor.document.getText(editor.selection) : editor.document.getText();
		let brief: string;
		try {
			brief = briefOf(raw, what === "selection" ? "The selection" : "The file");
		} catch (err) {
			void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
			return;
		}
		const project = await pickProject(arg, "Give which project's orchestrator the task?", editor.document.uri);
		if (!project || !(await confirmBrief(project, brief, what === "selection" ? "the selected text" : editor.document.isUntitled ? "this document" : vscode.workspace.asRelativePath(editor.document.uri)))) return;
		await deliver(project, brief, false);
	}

	/** After a setting changed: a running orchestrator keeps what it started with, so offer the restart. */
	async function afterConfigChange(projectId: string): Promise<void> {
		await store.refresh();
		const entry = store.entry(projectId);
		if (!entry?.orchestrator?.active) return;
		const pick = await vscode.window.showInformationMessage(plain(`Saved. ${entry.project.name}'s running orchestrator keeps what it started with.`), "Restart Orchestrator");
		if (pick) await vscode.commands.executeCommand("switchyard.orchestrator.restart", projectId);
	}

	async function pickOne(title: string, items: Array<{ label: string; description?: string; value: string }>, clear = "AO's default"): Promise<Answer> {
		const pick = await vscode.window.showQuickPick([{ label: `$(discard) ${clear}`, description: "clears the setting", value: null as string | null }, ...items], { title, placeHolder: title });
		return pick && { value: pick.value };
	}

	async function askText(title: string, prompt: string, current: string | undefined): Promise<Answer> {
		const text = await vscode.window.showInputBox({ title, prompt: `${prompt} Empty clears it.`, value: current, ignoreFocusOut: true });
		return text === undefined ? undefined : { value: text.trim() || null };
	}

	async function pickHarness(client: AoClient, title: string, current: string | undefined): Promise<Answer> {
		const harnesses = await availableHarnesses(client);
		return pickOne(
			title,
			harnesses.map(h => ({
				label: h.label && h.label !== h.id ? `${h.label} (${h.id})` : h.id,
				description: [h.id === current ? "current" : "", h.authStatus === "authorized" ? "logged in" : h.authStatus, h.unavailable ? `unavailable: ${h.unavailable}` : ""].filter(Boolean).join(" · "),
				value: h.id,
			})),
		);
	}

	async function pickModel(title: string, harness: string | undefined, current: string | undefined): Promise<Answer> {
		const choices = harness ? await sessions.modelChoices(harness) : undefined;
		if (!choices) return askText(title, harness ? "A model id of the harness." : "A model id (the harness is AO's choice, so there is no list).", current);
		return pickOne(title, choices.map(c => ({ label: c.name, description: [c.value === current ? "current" : "", c.value !== c.name ? c.value : ""].filter(Boolean).join(" · "), value: c.value })));
	}

	async function pickEffort(client: AoClient, harness: string | undefined, model: string | undefined, current: string | undefined): Promise<Answer> {
		const title = "Orchestrator effort";
		const catalog = harness ? await client.agentModels(harness).catch(() => undefined) : undefined;
		const own = catalog?.models.find(m => m.id === model)?.efforts;
		const efforts = [...new Set(own?.length ? own : (catalog?.models ?? []).flatMap(m => m.efforts ?? []))];
		if (!efforts.length) return askText(title, "How much the model thinks (as the harness names it: low, medium, high…).", current);
		return pickOne(title, efforts.map(value => ({ label: value, description: value === current ? "current" : undefined, value })));
	}

	/** Asks for one setting; the patch that saves the answer, or undefined when cancelled. */
	async function askSetting(client: AoClient, title: string, key: Exclude<keyof OrchestratorConfig, "rules">, config: OrchestratorConfig): Promise<OrchestratorConfigPatch | undefined> {
		const onOff = [
			{ label: "on", description: key === "autoReview" ? "AO reviews PRs by itself" : "workers ask AO's reviewer to review their PRs", value: "on" },
			{ label: "off", value: "off" },
		];
		switch (key) {
			case "harness": {
				const a = await pickHarness(client, title, config.harness);
				return a && { harness: a.value };
			}
			case "workerHarness": {
				const a = await pickHarness(client, title, config.workerHarness);
				return a && { workerHarness: a.value };
			}
			case "model": {
				const a = await pickModel(title, config.harness, config.model);
				return a && { model: a.value };
			}
			case "workerModel": {
				const a = await pickModel(title, config.workerHarness, config.workerModel);
				return a && { workerModel: a.value };
			}
			case "effort": {
				const a = await pickEffort(client, config.harness, config.model, config.effort);
				return a && { effort: a.value };
			}
			case "permissions": {
				const a = await pickOne(
					title,
					ORCHESTRATOR_PERMISSIONS.map(value => ({ label: value, description: [value === config.permissions ? "current" : "", PERMISSION_TEXT[value]].filter(Boolean).join(" · "), value })),
				);
				return a && { permissions: a.value };
			}
			case "rulesFile": {
				const a = await askText(title, "A file in the project (relative path) with the rules, for example docs/ORCHESTRATOR.md.", config.rulesFile);
				return a && { rulesFile: a.value };
			}
			case "workersRequestReview": {
				const a = await pickOne(title, onOff);
				return a && { workersRequestReview: a.value === null ? null : a.value === "on" };
			}
			case "autoReview": {
				const a = await pickOne(title, onOff);
				return a && { autoReview: a.value === null ? null : a.value === "on" };
			}
		}
	}

	/** One setting of the project's orchestrator config, asked for and saved in AO; false when cancelled (or for the rules, which open in an editor). */
	async function editSetting(project: { id: string; name: string }, key: keyof OrchestratorConfig, config: OrchestratorConfig): Promise<boolean> {
		if (key === "rules") {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(rulesUri(project.id)), { preview: false });
			void vscode.window.showInformationMessage(plain(`Save the rules (Ctrl+S) to store them in ${project.name}'s AO settings; a running orchestrator reads them when it is restarted.`));
			return false;
		}
		const client = await api.ao.client();
		const patch = await askSetting(client, `${project.name}: ${SETTING_LABELS[key]}`, key, config);
		if (!patch) return false;
		await setOrchestratorConfig(client, project.id, patch);
		return true;
	}

	const reg = (name: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`switchyard.orchestrator.${name}`, fn));
	reg("submit", arg => giveTask(arg, false));
	reg("steer", arg => giveTask(arg, true));
	reg("submitSelection", arg => giveEditorText(arg, "selection"));
	reg("submitDocument", arg => giveEditorText(arg, "file"));
	reg("openSessionChat", async arg => {
		const id = api.idFrom(arg);
		if (id) await openSessionChat(id);
	});
	reg("openChat", async arg => {
		const entry = await entryFor(arg, "orchestrator", "Open the orchestrator");
		if (entry?.orchestrator) await openSessionChat(entry.orchestrator.id);
	});
	reg("configure", async arg => {
		const project = await pickProject(arg, "Configure which project's orchestrator?");
		if (!project) return;
		let changed = false;
		for (;;) {
			try {
				const config = await orchestratorConfig(await api.ao.client(), project.id);
				const pick = await vscode.window.showQuickPick(
					settingRows(config).map(row => ({ label: row.label, description: row.value, key: row.key })),
					{ title: `Configure ${project.name}'s orchestrator`, placeHolder: "Pick a setting to change (Esc when done)" },
				);
				if (!pick) break;
				changed = (await editSetting(project, pick.key, config)) || changed;
			} catch (err) {
				fail("change the orchestrator's settings", err);
				break;
			}
		}
		if (changed) await afterConfigChange(project.id);
	});
	reg("editSetting", async (projectId, key) => {
		const entry = typeof projectId === "string" ? store.entry(projectId) : undefined;
		if (!entry || !isSettingKey(key)) return;
		try {
			const config = await orchestratorConfig(await api.ao.client(), entry.project.id);
			if (await editSetting(entry.project, key, config)) await afterConfigChange(entry.project.id);
		} catch (err) {
			fail("change the setting", err);
		}
	});
	reg("restart", async arg => {
		const entry = await entryFor(arg, "orchestrator", "Restart the orchestrator");
		if (!entry) return;
		const ok = await vscode.window.showWarningMessage(
			`Replace ${entry.project.name}'s orchestrator with a fresh one?`,
			{ modal: true, detail: "The current one is told to stop; the new one starts with the project's current settings (harness, model, rules). Its chat starts empty." },
			"Restart",
		);
		if (ok !== "Restart") return;
		try {
			const client = await api.ao.client();
			const project = await resolveProject(client, entry.project.id, "/");
			const fresh = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Switchyard: restarting the orchestrator" }, () => restartOrchestrator(client, project));
			await Promise.all([store.refresh(), sessions.refreshSession(fresh.id)]);
			void vscode.window.showInformationMessage(plain(`${project.name}'s orchestrator was replaced${fresh.harness ? ` (${fresh.harness})` : ""}.`), "Open Chat").then(a => a && openSessionChat(fresh.id));
		} catch (err) {
			fail("restart the orchestrator", err);
		}
	});
	reg("stop", async arg => {
		const entry = await entryFor(arg, "active", "Stop the orchestrator");
		const o = entry?.orchestrator;
		if (!entry || !o) return;
		if (o.state === "working") {
			const ok = await vscode.window.showWarningMessage(`${entry.project.name}'s orchestrator is working. Stop it?`, { modal: true, detail: "The agent exits; its session and transcript stay, and giving it a task again resumes it. Its workers keep running." }, "Stop");
			if (ok !== "Stop") return;
		}
		try {
			await sessions.stop(o.id);
			await store.refresh();
		} catch (err) {
			fail(`stop ${entry.project.name}'s orchestrator`, err);
		}
	});
	reg("openInDashboard", () => vscode.commands.executeCommand("switchyard.openAoDashboard"));
	reg("refresh", () => store.refresh());

	context.subscriptions.push(
		view,
		store,
		vscode.workspace.registerFileSystemProvider(RULES_SCHEME, rules, { isCaseSensitive: true }),
		view.onDidChangeVisibility(e => store.setVisible(e.visible)),
		api.ao.onEvent(() => store.schedule()),
		// After a gap the stream cannot say what it missed.
		api.ao.onStatus(s => s.state === "open" && store.schedule()),
		api.ao.onDidConnect(() => void store.refresh()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => void store.refresh()),
		store.onDidChange(() => {
			const asking = store.entries.filter(e => e.orchestrator?.state === "needs_input" && e.orchestrator.active).length;
			view.badge = asking ? { value: asking, tooltip: `${asking} orchestrator${asking === 1 ? " needs" : "s need"} your answer` } : undefined;
		}),
	);
	void store.refresh();
	return { store, refresh: () => tree.refresh() };
}
