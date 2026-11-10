// What the Orchestrators view and its commands decide, without VS Code (unit-tested): which projects get a
// node, the description lines, the settings rows, and which project a command means. The data is
// src/ao/orchestrator.ts's; AO owns the orchestrator itself.
import type { OrchestratorConfig, OrchestratorInfo, OrchestratorWorker } from "../ao/orchestrator";
import { prSummaryLine } from "../shared/pr-review";
import { STATUS_LABEL, statusOf } from "./session-view";

/** An AO project in the Orchestrators view: its orchestrator (when it has one) and the settings its next one starts with. */
export interface ProjectEntry {
	project: { id: string; name: string; path: string };
	orchestrator?: OrchestratorInfo;
	config: OrchestratorConfig;
	/** The project of a folder open in this window. */
	inWorkspace: boolean;
}

/**
 * One entry per project that has an orchestrator, and one for each project of this window's folders whether or
 * not it has one (so a task can be given from the first minute). The window's projects come first, then
 * `infos` as listed (active orchestrators first). `configs` are the settings of projects without an orchestrator.
 */
export function projectEntries(infos: readonly OrchestratorInfo[], workspace: readonly { id: string; name: string; path: string }[], configs: ReadonlyMap<string, OrchestratorConfig>): ProjectEntry[] {
	const byProject = new Map(infos.map(o => [o.projectId, o]));
	const mine = new Set(workspace.map(p => p.id));
	const own = workspace.map((p): ProjectEntry => {
		const orchestrator = byProject.get(p.id);
		return { project: p, ...(orchestrator && { orchestrator }), config: orchestrator?.config ?? configs.get(p.id) ?? {}, inWorkspace: true };
	});
	const others = infos.filter(o => !mine.has(o.projectId)).map((o): ProjectEntry => ({ project: { id: o.projectId, name: o.projectName, path: o.projectPath }, orchestrator: o, config: o.config, inWorkspace: false }));
	return [...own.filter((e, i) => own.findIndex(x => x.project.id === e.project.id) === i), ...others];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The orchestrator's state as the Sessions view says it: its agent's, or `stopped` when AO ended the session. */
export function orchestratorStatus(o: OrchestratorInfo): keyof typeof STATUS_LABEL {
	return o.active ? statusOf(o.state) : "stopped";
}

/** `idle · 3 workers · 2 open PRs · claude-code` (workers needing input are said). */
export function orchestratorDescription(o: OrchestratorInfo): string {
	const n = o.counts;
	return [
		STATUS_LABEL[orchestratorStatus(o)],
		n.workers ? plural(n.workers, "worker") : "no workers",
		n.needsInput ? `${n.needsInput} need${n.needsInput === 1 ? "s" : ""} input` : "",
		n.openPrs ? plural(n.openPrs, "open PR") : "",
		o.harness ?? "",
	]
		.filter(Boolean)
		.join(" · ");
}

/** `1 working · 1 needs input · 2 idle · 1 stopped`: the Workers row (the CLI's summary line says the same). */
export function workersSummary(n: OrchestratorInfo["counts"]): string {
	return [n.working && `${n.working} working`, n.needsInput && `${n.needsInput} need${n.needsInput === 1 ? "s" : ""} input`, n.idle && `${n.idle} idle`, n.stopped && `${n.stopped} stopped`].filter(Boolean).join(" · ");
}

/** A worker row's description: its state, branch and the first PR's chip (`+N` when it has more). */
export function workerDescription(w: OrchestratorWorker): string {
	const [first, ...more] = w.prs;
	const pr = first ? `${prSummaryLine(first)}${more.length ? ` (+${more.length})` : ""}` : "";
	return [STATUS_LABEL[statusOf(w.state)], w.branch ? `⎇ ${w.branch}` : "", pr].filter(Boolean).join(" · ");
}

/** The text a setting shows when AO has none for it. */
export const UNSET = "AO's default";

export const SETTING_LABELS: Readonly<Record<keyof OrchestratorConfig, string>> = {
	harness: "Harness",
	model: "Model",
	effort: "Effort",
	permissions: "Permissions",
	rules: "Rules",
	rulesFile: "Rules file",
	workerHarness: "Worker harness",
	workerModel: "Worker model",
	workersRequestReview: "Workers request review",
	autoReview: "AO reviews PRs",
};

export const SETTING_KEYS = Object.keys(SETTING_LABELS) as Array<keyof OrchestratorConfig>;

export interface SettingRow {
	key: keyof OrchestratorConfig;
	label: string;
	/** What to show: the setting, or {@link UNSET}. */
	value: string;
	set: boolean;
}

/** A setting as one line of text (rules: their first line). */
export function settingText(key: keyof OrchestratorConfig, config: OrchestratorConfig): string | undefined {
	const v = config[key];
	if (v === undefined) return undefined;
	if (typeof v === "boolean") return v ? "on" : "off";
	if (key !== "rules") return v;
	const first = v.split("\n").find(line => line.trim())?.trim() ?? "";
	const lines = v.split("\n").filter(line => line.trim()).length;
	return `${first.length > 60 ? `${first.slice(0, 59)}…` : first}${lines > 1 ? ` (+${lines - 1} line${lines === 2 ? "" : "s"})` : ""}`;
}

export function settingRows(config: OrchestratorConfig): SettingRow[] {
	return SETTING_KEYS.map(key => {
		const text = settingText(key, config);
		return { key, label: SETTING_LABELS[key], value: text ?? UNSET, set: text !== undefined };
	});
}

export function isSettingKey(v: unknown): v is keyof OrchestratorConfig {
	return typeof v === "string" && Object.hasOwn(SETTING_LABELS, v);
}

/** The project a command argument names: a project id, or a tree node that carries one. */
export function projectIdFrom(arg: unknown): string | undefined {
	if (typeof arg === "string" && arg.trim()) return arg.trim();
	if (arg && typeof arg === "object" && "projectId" in arg && typeof arg.projectId === "string" && arg.projectId) return arg.projectId;
	return undefined;
}

/** Which project a command works on: the argument's, else this window's (asking among them when several), else a pick of AO's. */
export type ProjectChoice = { kind: "project"; id: string } | { kind: "pick"; ids: string[] } | { kind: "none" };

export function chooseProject(arg: unknown, workspaceIds: readonly string[], knownIds: readonly string[]): ProjectChoice {
	const given = projectIdFrom(arg);
	if (given) return { kind: "project", id: given };
	const mine = [...new Set(workspaceIds)];
	if (mine.length === 1) return { kind: "project", id: mine[0] };
	const ids = mine.length ? mine : [...new Set(knownIds)];
	return ids.length ? { kind: "pick", ids } : { kind: "none" };
}

/** A task, steer or brief as sent: trimmed, and never empty (`what` names where it came from). */
export function briefOf(text: string, what: string): string {
	const brief = text.trim();
	if (!brief) throw new Error(`${what} is empty: nothing to give the orchestrator`);
	return brief;
}

/** What a long brief says about itself, for the confirmation before it is sent. */
export function briefPreview(brief: string): string {
	const lines = brief.split("\n").length;
	const first = brief.split("\n").find(line => line.trim())?.trim() ?? "";
	return `${first.length > 80 ? `${first.slice(0, 79)}…` : first}\n(${plural(lines, "line")}, ${plural(brief.length, "character")})`;
}

/** One line of the orchestrator's reply, for its row. */
export function replyLine(reply: string): string {
	const line = reply.replace(/\s+/g, " ").trim();
	return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}
