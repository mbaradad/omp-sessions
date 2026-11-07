// Permission modes: how a session host answers omp's tool-approval prompts. The host always runs
// omp with `--approval-mode always-ask` (read-only tools need no approval) and approves, refuses
// or forwards every prompt according to the session's mode, so the mode can change mid-turn.
// The starting mode is the session's `--approval-mode` launch flag (omp's values or ours).

export const PERMISSION_MODES = ["ask", "edits", "plan", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_MODE_INFO: Record<PermissionMode, { label: string; detail: string }> = {
	ask: { label: "Ask", detail: "Ask before every file edit and command" },
	edits: { label: "Edits", detail: "Apply file edits automatically; ask before commands" },
	plan: { label: "Plan", detail: "Read-only: explore and propose a plan; file edits are refused" },
	auto: { label: "Auto", detail: "Approve every tool call" },
};

/** Tools that change files: approved in `edits`, refused in `plan`. */
export const EDIT_TOOLS: Readonly<Record<string, true>> = { edit: true, write: true, ast_edit: true, notebook: true, apply_patch: true };

/** Prepended to prompts sent in plan mode, so the model plans instead of running into refusals. */
export const PLAN_PROMPT_PREFIX = "[Plan mode: read-only. Explore and reply with a plan; file edits are refused until I switch modes.]\n\n";

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && PERMISSION_MODES.some(m => m === value);
}

/** The permission mode an `--approval-mode` value (omp's or ours) or omp's `tools.approvalMode` stands for. */
export function permissionModeOf(value: unknown): PermissionMode | undefined {
	switch (value) {
		case "ask":
		case "always-ask":
		case "always-ask-cached":
			return "ask";
		case "edits":
		case "write":
			return "edits";
		case "plan":
			return "plan";
		case "auto":
		case "yolo":
			return "auto";
	}
	return undefined;
}

const AUTO_APPROVE_FLAGS: Readonly<Record<string, true>> = { "--auto-approve": true, "--yolo": true };

/** The mode an omp argument list starts in: its last `--approval-mode`, else `--auto-approve` / `--yolo`. */
export function permissionModeInArgs(args: readonly string[]): PermissionMode | undefined {
	let mode: PermissionMode | undefined;
	let autoApprove = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--approval-mode") mode = permissionModeOf(args[++i]) ?? mode;
		else if (arg.startsWith("--approval-mode=")) mode = permissionModeOf(arg.slice("--approval-mode=".length)) ?? mode;
		else if (AUTO_APPROVE_FLAGS[arg]) autoApprove = true;
	}
	return mode ?? (autoApprove ? "auto" : undefined);
}

/** `args` without approval flags, so the host's own `--approval-mode always-ask` is what omp sees. */
export function withoutApprovalArgs(args: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--approval-mode") i++;
		else if (!arg.startsWith("--approval-mode=") && !AUTO_APPROVE_FLAGS[arg]) out.push(arg);
	}
	return out;
}

/** The tool an omp approval prompt asks about (a `select` titled `Allow tool: <name>`), else undefined. */
export function approvalTool(req: { method?: unknown; title?: unknown }): string | undefined {
	if (req.method !== "select" || typeof req.title !== "string") return undefined;
	return /^Allow tool: (\S+)/.exec(req.title)?.[1];
}

export type ApprovalDecision = "approve" | "deny" | "ask";

export function approvalDecision(mode: PermissionMode, tool: string): ApprovalDecision {
	if (mode === "auto") return "approve";
	if (!EDIT_TOOLS[tool]) return "ask";
	return mode === "edits" ? "approve" : mode === "plan" ? "deny" : "ask";
}

/**
 * The answer `mode` gives an approval prompt: an `extension_ui_response` payload choosing the
 * prompt's approve-this-call or Deny option, or undefined when the person has to decide (or the
 * prompt lacks the expected option).
 */
export function autoApproval(mode: PermissionMode, req: { id: string; method?: unknown; title?: unknown; options?: unknown }): { id: string; value: string } | undefined {
	const tool = approvalTool(req);
	if (!tool) return undefined;
	const decision = approvalDecision(mode, tool);
	if (decision === "ask") return undefined;
	const options = Array.isArray(req.options) ? req.options.filter((o): o is string => typeof o === "string") : [];
	const value = decision === "approve" ? options.find(o => o === "Approve" || o === "Approve Once") : options.find(o => o === "Deny");
	return value ? { id: req.id, value } : undefined;
}
