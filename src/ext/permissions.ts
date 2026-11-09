import * as vscode from "vscode";
import { isOmpHarness } from "../ao/harness";
import { PERMISSION_MODES, PERMISSION_MODE_INFO, type PermissionMode, isPermissionMode } from "../shared/permissions";
import type { OmpApi } from "./api";
import { plain } from "./plain";

const ICONS: Record<PermissionMode, string> = { ask: "$(shield)", edits: "$(edit)", plan: "$(book)", auto: "$(zap)" };

/** What each mode is for a harness other than omp: AO's own approval mode (plan is omp-only). */
const AO_MODE_DETAIL: Record<Exclude<PermissionMode, "plan">, string> = {
	ask: "AO's default approval mode: the harness asks through AO's approvals (its own baseline settings apply)",
	edits: "AO's accept-edits: file edits go through, other tools ask",
	auto: "AO's bypass-permissions: every tool call goes through",
};

/**
 * Quick pick of the modes. `defaultLabel` adds a default entry (picked → null); undefined = cancelled. `harness`
 * (absent: omp): another harness has no Plan (omp-only) and its modes are AO's approval modes.
 */
export async function pickPermissionMode(current: PermissionMode | undefined, title: string, defaultLabel?: string, harness?: string): Promise<PermissionMode | null | undefined> {
	const omp = isOmpHarness(harness);
	const items: Array<vscode.QuickPickItem & { mode: PermissionMode | null }> = [
		...(defaultLabel ? [{ label: omp ? "$(settings) omp default" : "$(settings) Default", description: `${defaultLabel}${current ? "" : " · current"}`, mode: null }] : []),
		...PERMISSION_MODES.filter(m => omp || m !== "plan").map(m => ({ label: `${ICONS[m]} ${PERMISSION_MODE_INFO[m].label}`, description: m === current ? "current" : "", detail: m === "plan" || omp ? PERMISSION_MODE_INFO[m].detail : AO_MODE_DETAIL[m], mode: m })),
	];
	const pick = await vscode.window.showQuickPick(items, { title, placeHolder: omp ? "Permission mode: how omp's tool approvals are answered" : `Permission mode of ${harness} (AO's approval mode; Plan is omp-only)` });
	return pick ? pick.mode : undefined;
}

export function registerPermissions(api: OmpApi): void {
	api.context.subscriptions.push(
		vscode.commands.registerCommand("switchyard.setPermissionMode", async (arg?: unknown, modeArg?: unknown) => {
			const id = api.idFrom(arg) ?? (await api.pickSession("Set the permission mode of which session?", m => m.status !== "stopped"));
			const meta = id ? api.sessions.get(id) : undefined;
			if (!meta) return;
			const mode = isPermissionMode(modeArg) ? modeArg : await pickPermissionMode(meta.permissionMode, `Permission mode · ${meta.title}`, undefined, meta.harness);
			if (!mode) return;
			try {
				await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Switchyard: ${PERMISSION_MODE_INFO[mode].label} mode for "${meta.title}"` }, () => api.sessions.setMode(meta.id, mode));
			} catch (err) {
				void vscode.window.showWarningMessage(plain(`Could not switch "${meta.title}" to ${PERMISSION_MODE_INFO[mode].label}: ${err instanceof Error ? err.message : String(err)}.`));
			}
			api.refreshTree();
		}),
	);
}
