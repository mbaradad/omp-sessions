// "New Session with Options…": the omp CLI flags that shape a session, as a short wizard; and the omp
// Sessions default model (launcher.json `model`, shared with `omp-sessions config set model` and Hermes).
import * as vscode from "vscode";
import { readLauncherSettings, writeLauncherSettings } from "../shared/launch";
import { type ModelList, listModels } from "../shared/models";
import { pickPermissionMode } from "./permissions";
import { plain } from "./plain";

/** omp's chat models (shared/models.ts) with the omp Sessions default marked; no models when omp can't list them. */
export async function loadModels(cwd: string): Promise<ModelList> {
	try {
		return await listModels(cwd);
	} catch {
		return { models: [], default: readLauncherSettings().model ?? null, ompDefault: null };
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
	writeLauncherSettings({ model: pick.selector ?? undefined });
	void vscode.window.showInformationMessage(plain(pick.selector ? `New omp sessions start with ${pick.selector} unless another model is picked.` : "New omp sessions start with omp's own default model."));
}

/** Shell-like split honoring single/double quotes. */
export function splitArgs(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

const FLAGS = [
	{ label: "Plan first", description: "--plan-yolo: read-only plan, auto-approved, then implement", flag: "--plan-yolo" },
	{ label: "Advisor", description: "--advisor: passive reviewer that injects notes each turn", flag: "--advisor" },
	{ label: "Prewalk", description: "--prewalk: switch to a cheaper model once the plan exists", flag: "--prewalk" },
	{ label: "No LSP", description: "--no-lsp", flag: "--no-lsp" },
	{ label: "No extensions", description: "--no-extensions", flag: "--no-extensions" },
	{ label: "No skills", description: "--no-skills", flag: "--no-skills" },
	{ label: "No rules", description: "--no-rules", flag: "--no-rules" },
];

export async function askLaunchOptions(cwd: string): Promise<{ ompArgs: string[]; goal?: string } | undefined> {
	const args: string[] = [];
	const step = (n: number) => `New omp session (${n}/6)`;

	const modelPick = vscode.window.createQuickPick<vscode.QuickPickItem & { selector?: string }>();
	modelPick.title = step(1);
	modelPick.placeholder = "Model";
	modelPick.matchOnDescription = true;
	modelPick.busy = true;
	modelPick.items = [{ label: "$(settings) Default model", description: defaultModelLabel({ default: readLauncherSettings().model ?? null, ompDefault: null }) }];
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
	if (model.selector) args.push("--model", model.selector);

	const thinking = await vscode.window.showQuickPick(
		["default", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"].map(l => ({ label: l === "default" ? "$(settings) Default thinking" : l, value: l })),
		{ title: step(2), placeHolder: "Thinking level" },
	);
	if (!thinking) return undefined;
	if (thinking.value !== "default") args.push("--thinking", thinking.value);

	const mode = await pickPermissionMode(undefined, step(3), "from omp's tools.approvalMode");
	if (mode === undefined) return undefined;
	if (mode) args.push("--approval-mode", mode);

	const flags = await vscode.window.showQuickPick(FLAGS, { title: step(4), placeHolder: "Options (Enter to continue)", canPickMany: true });
	if (!flags) return undefined;
	for (const f of flags) args.push(f.flag);

	const goal = await vscode.window.showInputBox({ title: step(5), prompt: "Goal objective (optional) — omp keeps working until it is achieved", ignoreFocusOut: true });
	if (goal === undefined) return undefined;

	const defaults = vscode.workspace.getConfiguration("omp").get<string[]>("extraArgs") ?? [];
	const extra = await vscode.window.showInputBox({
		title: step(6),
		prompt: "Extra omp arguments (e.g. --tools read,grep --max-time 1h --add-dir ../lib)",
		value: defaults.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" "),
		ignoreFocusOut: true,
	});
	if (extra === undefined) return undefined;
	args.push(...splitArgs(extra));
	return { ompArgs: args, goal: goal.trim() || undefined };
}
