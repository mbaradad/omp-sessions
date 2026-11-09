// "New Session with Options…": model, thinking, permission mode and a first prompt for the AO spawn; and
// the Switchyard defaults for new sessions (`model`/`mode` in ~/.switchyard/config.json, shared with the CLI's `config set`).
// The harness is chosen before the wizard (SessionManager.chooseHarness): another harness than omp gets AO's model
// catalog of it, no Plan mode and no extra omp flags (omp-only).
import * as vscode from "vscode";
import { isOmpHarness } from "../ao/harness";
import { THINKING_LEVELS } from "../planner/types";
import { type ModelList, listModels } from "../shared/models";
import { PERMISSION_MODE_INFO, type PermissionMode } from "../shared/permissions";
import { readSwitchyardConfig, writeSwitchyardConfig } from "../ao/config";
import { pickPermissionMode } from "./permissions";
import { plain } from "./plain";
import { splitArgs } from "./session-view";

/** A source of model lists (SessionManager.modelChoices): omp, a live omp session's own choices; another harness, AO's catalog of it. */
export interface ModelChoices {
	modelChoices(harness?: string): Promise<Array<{ value: string; name: string }> | undefined>;
}

/**
 * The models to pick from for a new session of `harness` (default omp). omp: the Switchyard default marked, a live
 * session's own choices when one runs (the only exact list), else omp's `models` listing; no models when neither
 * answers (a typed id is still accepted, and the spawn helper checks it against the new session's choices). Another
 * harness: AO's model catalog of it; the Switchyard default (an omp model) does not apply.
 */
export async function loadModels(cwd: string, sessions?: ModelChoices, harness?: string): Promise<ModelList> {
	const omp = isOmpHarness(harness);
	const choices = await sessions?.modelChoices(harness).catch(() => undefined);
	if (choices || !omp) {
		const preferred = omp ? (readSwitchyardConfig().model ?? null) : null;
		return {
			models: (choices ?? []).map(c => ({ selector: c.value, provider: c.value.split("/")[0], id: c.value.split("/").slice(1).join("/") || c.value, name: c.name, default: c.value === preferred })),
			default: preferred,
			ompDefault: null,
		};
	}
	try {
		return await listModels(cwd);
	} catch {
		return { models: [], default: readSwitchyardConfig().model ?? null, ompDefault: null };
	}
}

/** "provider/model · Switchyard default" for the default-model row of a picker; another harness's own default for a non-omp session. */
export function defaultModelLabel(list: Pick<ModelList, "default" | "ompDefault">, harness?: string): string {
	if (!isOmpHarness(harness)) return `${harness}'s default`;
	if (list.default) return `${list.default} · Switchyard default`;
	return list.ompDefault ? `${list.ompDefault} · omp's default` : "omp's default";
}

/** `switchyard.setDefaultModel`: the model new omp sessions start with when none is picked, for every client (an omp model: other harnesses keep their own default). */
export async function chooseDefaultModel(cwd: string, sessions?: ModelChoices): Promise<void> {
	const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { selector: string | null }>();
	qp.title = "Default model for new omp sessions (VS Code, switchyard, phone, Hermes)";
	qp.placeholder = "Model";
	qp.matchOnDescription = true;
	qp.busy = true;
	qp.items = [{ label: "$(settings) omp's own default", description: "omp config modelRoles.default", selector: null }];
	qp.show();
	void loadModels(cwd, sessions).then(list => {
		qp.items = [
			{ label: "$(settings) omp's own default", description: `${list.ompDefault ?? "omp config modelRoles.default"}${list.default ? "" : " · current"}`, selector: null },
			...list.models.map(m => ({ label: `${m.default ? "$(star-full) " : ""}${m.name}`, description: `${m.selector}${m.default ? " · current" : ""}`, selector: m.selector })),
		];
		const current = qp.items.find(i => i.selector === list.default);
		if (current) qp.activeItems = [current];
		qp.busy = false;
	});
	const done = Promise.withResolvers<(vscode.QuickPickItem & { selector: string | null }) | undefined>();
	qp.onDidAccept(() => done.resolve(qp.selectedItems[0]));
	qp.onDidHide(() => done.resolve(undefined));
	const pick = await done.promise;
	qp.dispose();
	if (!pick) return;
	writeSwitchyardConfig({ model: pick.selector ?? undefined });
	void vscode.window.showInformationMessage(plain(pick.selector ? `New omp sessions start with ${pick.selector} unless another model is picked (other harnesses keep their own default).` : "New omp sessions start with omp's own default model."));
}

/** `switchyard.setDefaultMode`: the permission mode new sessions start in when they ask for none, for every client. */
export async function chooseDefaultMode(): Promise<void> {
	const current = readSwitchyardConfig().mode;
	const mode = await pickPermissionMode(current, "Default permission mode for new sessions (VS Code, switchyard, phone, Hermes)", "omp's tools.approvalMode, else Auto");
	if (mode === undefined) return;
	writeSwitchyardConfig({ mode: mode ?? undefined });
	void vscode.window.showInformationMessage(mode ? `New sessions start in ${PERMISSION_MODE_INFO[mode].label} mode unless another mode is picked${mode === "plan" ? " (Plan is omp-only: sessions of other harnesses need another mode picked)" : ""}.` : "New omp sessions start in omp's tools.approvalMode (Auto when unset); other harnesses in Auto.");
}

/** What the wizard picked; absent fields keep the defaults. */
export interface LaunchChoices {
	model?: string;
	effort?: string;
	mode?: PermissionMode;
	/** Extra `omp acp` flags for this session (G34: `--plan-yolo`, `--advisor`, …), on top of `switchyard.extraArgs`. omp only. */
	ompArgs?: string[];
	prompt?: string;
}

/**
 * Asks for model, thinking, permission mode, extra omp flags (applied by the Switchyard omp shim: the
 * session restarts once before its first message) and a first prompt. `harness` (absent: omp): another
 * harness picks from AO's model catalog of it, has no Plan mode and skips the omp flags step.
 */
export async function askLaunchOptions(cwd: string, sessions?: ModelChoices, harness?: string): Promise<LaunchChoices | undefined> {
	const out: LaunchChoices = {};
	const omp = isOmpHarness(harness);
	const steps = omp ? 5 : 4;
	const step = (n: number) => `New ${harness ?? "omp"} session (${n}/${steps})`;

	const modelPick = vscode.window.createQuickPick<vscode.QuickPickItem & { selector?: string }>();
	modelPick.title = step(1);
	modelPick.placeholder = "Model";
	modelPick.matchOnDescription = true;
	modelPick.busy = true;
	modelPick.items = [{ label: "$(settings) Default model", description: defaultModelLabel({ default: omp ? (readSwitchyardConfig().model ?? null) : null, ompDefault: null }, harness) }];
	modelPick.show();
	let listed: Array<vscode.QuickPickItem & { selector?: string }> = [];
	const render = () => {
		const typed = modelPick.value.trim();
		// A model that is in no list yet (a new session has none): the typed id is tried, and refused by the spawn if the session does not offer it.
		const custom = typed && !listed.some(i => i.selector === typed) ? [{ label: `$(edit) ${typed}`, description: "typed model id", selector: typed, alwaysShow: true }] : [];
		modelPick.items = [...custom, ...listed];
	};
	modelPick.onDidChangeValue(render);
	void loadModels(cwd, sessions, harness).then(list => {
		listed = [
			{ label: "$(settings) Default model", description: defaultModelLabel(list, harness) },
			...list.models.map(m => ({ label: `${m.default ? "$(star-full) " : ""}${m.name}`, description: `${m.selector}${m.default ? " · default" : ""}`, detail: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : undefined, selector: m.selector })),
		];
		render();
		modelPick.busy = false;
	});
	const picked = Promise.withResolvers<(vscode.QuickPickItem & { selector?: string }) | undefined>();
	modelPick.onDidAccept(() => picked.resolve(modelPick.selectedItems[0]));
	modelPick.onDidHide(() => picked.resolve(undefined));
	const model = await picked.promise;
	modelPick.dispose();
	if (!model) return undefined;
	if (model.selector) out.model = model.selector;

	const thinking = await vscode.window.showQuickPick(
		["default", ...THINKING_LEVELS].map(l => ({ label: l === "default" ? "$(settings) Default thinking" : l, value: l })),
		{ title: step(2), placeHolder: "Thinking level" },
	);
	if (!thinking) return undefined;
	if (thinking.value !== "default") out.effort = thinking.value;

	const configMode = readSwitchyardConfig().mode;
	// Plan is omp-only: another harness falls back to Auto (the spawn's default) rather than a default it can't run.
	const defaultMode = omp || configMode !== "plan" ? configMode : undefined;
	const mode = await pickPermissionMode(undefined, step(3), defaultMode ? `the default, ${PERMISSION_MODE_INFO[defaultMode].label}` : omp ? "omp's tools.approvalMode" : "Auto", harness);
	if (mode === undefined) return undefined;
	if (mode) out.mode = mode;
	else if (!omp && configMode === "plan") out.mode = "auto";

	if (omp) {
		const flags = await vscode.window.showInputBox({
			title: step(4),
			prompt: "Extra omp flags for this session (optional), e.g. --plan-yolo --advisor. The session restarts once to apply them; switchyard.extraArgs applies on top.",
			ignoreFocusOut: true,
			validateInput: v => (splitArgs(v).some(a => /^--(model|thinking|approval-mode)\b/.test(a)) ? "Pick the model, thinking level and mode in the steps before this one." : undefined),
		});
		if (flags === undefined) return undefined;
		if (flags.trim()) out.ompArgs = splitArgs(flags);
	}

	const prompt = await vscode.window.showInputBox({ title: step(steps), prompt: "First prompt (optional): the session starts working on it right away", ignoreFocusOut: true });
	if (prompt === undefined) return undefined;
	if (prompt.trim()) out.prompt = prompt.trim();
	return out;
}
