// "New Session with Options…": model, thinking, permission mode and a first prompt for the AO spawn; and
// the omp Sessions defaults for new sessions (`model`/`mode` in ~/.switchyard/config.json, shared with the CLI's `config set`).
import * as vscode from "vscode";
import { THINKING_LEVELS } from "../planner/types";
import { type ModelList, listModels } from "../shared/models";
import { PERMISSION_MODE_INFO, type PermissionMode } from "../shared/permissions";
import { readSwitchyardConfig, writeSwitchyardConfig } from "../shared/switchyard-config";
import { pickPermissionMode } from "./permissions";
import { plain } from "./plain";
import { splitArgs } from "./session-view";

/** omp's chat models (shared/models.ts) with the omp Sessions default marked; no models when omp can't list them. */
export async function loadModels(cwd: string): Promise<ModelList> {
	try {
		return await listModels(cwd);
	} catch {
		return { models: [], default: readSwitchyardConfig().model ?? null, ompDefault: null };
	}
}

/** "provider/model · omp Sessions default" for the default-model row of a picker. */
export function defaultModelLabel(list: Pick<ModelList, "default" | "ompDefault">): string {
	if (list.default) return `${list.default} · omp Sessions default`;
	return list.ompDefault ? `${list.ompDefault} · omp's default` : "omp's default";
}

/** `omp.setDefaultModel`: the model new sessions start with when none is picked, for every client. */
export async function chooseDefaultModel(cwd: string): Promise<void> {
	const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { selector: string | null }>();
	qp.title = "Default model for new omp sessions (VS Code, omp-sessions, phone, Hermes)";
	qp.placeholder = "Model";
	qp.matchOnDescription = true;
	qp.busy = true;
	qp.items = [{ label: "$(settings) omp's own default", description: "omp config modelRoles.default", selector: null }];
	qp.show();
	void loadModels(cwd).then(list => {
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
	void vscode.window.showInformationMessage(plain(pick.selector ? `New omp sessions start with ${pick.selector} unless another model is picked.` : "New omp sessions start with omp's own default model."));
}

/** `omp.setDefaultMode`: the permission mode new sessions start in when they ask for none, for every client. */
export async function chooseDefaultMode(): Promise<void> {
	const current = readSwitchyardConfig().mode;
	const mode = await pickPermissionMode(current, "Default permission mode for new omp sessions (VS Code, omp-sessions, phone, Hermes)", "omp's tools.approvalMode, else Auto");
	if (mode === undefined) return;
	writeSwitchyardConfig({ mode: mode ?? undefined });
	void vscode.window.showInformationMessage(mode ? `New omp sessions start in ${PERMISSION_MODE_INFO[mode].label} mode unless another mode is picked.` : "New omp sessions start in omp's tools.approvalMode (Auto when unset).");
}

/** What the wizard picked; absent fields keep the defaults. */
export interface LaunchChoices {
	model?: string;
	effort?: string;
	mode?: PermissionMode;
	/** Extra `omp acp` flags for this session (G34: `--plan-yolo`, `--advisor`, …), on top of `omp.extraArgs`. */
	ompArgs?: string[];
	prompt?: string;
}

/**
 * Asks for model, thinking, permission mode, extra omp flags (applied by the Switchyard omp shim: the
 * session restarts once before its first message) and a first prompt.
 */
export async function askLaunchOptions(cwd: string): Promise<LaunchChoices | undefined> {
	const out: LaunchChoices = {};
	const step = (n: number) => `New omp session (${n}/5)`;

	const modelPick = vscode.window.createQuickPick<vscode.QuickPickItem & { selector?: string }>();
	modelPick.title = step(1);
	modelPick.placeholder = "Model";
	modelPick.matchOnDescription = true;
	modelPick.busy = true;
	modelPick.items = [{ label: "$(settings) Default model", description: defaultModelLabel({ default: readSwitchyardConfig().model ?? null, ompDefault: null }) }];
	modelPick.show();
	void loadModels(cwd).then(list => {
		modelPick.items = [
			{ label: "$(settings) Default model", description: defaultModelLabel(list) },
			...list.models.map(m => ({ label: `${m.default ? "$(star-full) " : ""}${m.name}`, description: `${m.selector}${m.default ? " · default" : ""}`, detail: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : undefined, selector: m.selector })),
		];
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

	const defaultMode = readSwitchyardConfig().mode;
	const mode = await pickPermissionMode(undefined, step(3), defaultMode ? `the default, ${PERMISSION_MODE_INFO[defaultMode].label}` : "omp's tools.approvalMode");
	if (mode === undefined) return undefined;
	if (mode) out.mode = mode;

	const flags = await vscode.window.showInputBox({
		title: step(4),
		prompt: "Extra omp flags for this session (optional), e.g. --plan-yolo --advisor. The session restarts once to apply them; omp.extraArgs applies on top.",
		ignoreFocusOut: true,
		validateInput: v => (splitArgs(v).some(a => /^--(model|thinking|approval-mode)\b/.test(a)) ? "Pick the model, thinking level and mode in the steps before this one." : undefined),
	});
	if (flags === undefined) return undefined;
	if (flags.trim()) out.ompArgs = splitArgs(flags);

	const prompt = await vscode.window.showInputBox({ title: step(5), prompt: "First prompt (optional): the session starts working on it right away", ignoreFocusOut: true });
	if (prompt === undefined) return undefined;
	if (prompt.trim()) out.prompt = prompt.trim();
	return out;
}
