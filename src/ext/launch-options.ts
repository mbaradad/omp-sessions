// "New Session with Options…": the omp CLI flags that shape a session, as a short wizard.
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { resolveOmpPath } from "./sessions";

export interface ModelEntry {
	selector: string;
	name: string;
	provider: string;
	contextWindow?: number;
}

export function listModels(cwd: string): Promise<ModelEntry[]> {
	const omp = resolveOmpPath();
	const { promise, resolve } = Promise.withResolvers<ModelEntry[]>();
	if (!omp) {
		resolve([]);
		return promise;
	}
	execFile(omp, ["models", "--json"], { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
		try {
			const parsed = JSON.parse(stdout) as { models?: Array<Record<string, unknown>> };
			resolve(
				(parsed.models ?? [])
					.filter(m => m.kind === undefined || m.kind === "chat")
					.map(m => ({ selector: String(m.selector ?? `${String(m.provider)}/${String(m.id)}`), name: String(m.name ?? m.id), provider: String(m.provider), contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined })),
			);
		} catch {
			resolve([]);
		}
	});
	return promise;
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
	{ label: "Auto-approve all tool calls", description: "--auto-approve", flag: "--auto-approve" },
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
	modelPick.busy = true;
	modelPick.items = [{ label: "$(settings) Default model", description: "from omp config" }];
	modelPick.show();
	void listModels(cwd).then(models => {
		modelPick.items = [
			{ label: "$(settings) Default model", description: "from omp config" },
			...models.map(m => ({ label: m.name, description: m.selector, detail: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : undefined, selector: m.selector })),
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

	const approval = await vscode.window.showQuickPick(
		[
			{ label: "$(settings) Default approvals", value: "" },
			{ label: "always-ask", description: "confirm every tool call", value: "always-ask" },
			{ label: "always-ask-cached", description: "confirm once per tool/command", value: "always-ask-cached" },
			{ label: "write", description: "confirm writes only", value: "write" },
			{ label: "yolo", description: "never ask", value: "yolo" },
		],
		{ title: step(3), placeHolder: "Approval mode (approval prompts appear in the chat)" },
	);
	if (!approval) return undefined;
	if (approval.value) args.push("--approval-mode", approval.value);

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
