import * as vscode from "vscode";
import { PERMISSION_MODES, PERMISSION_MODE_INFO, type PermissionMode, isPermissionMode } from "../shared/permissions";
import type { OmpApi } from "./api";
import { plain } from "./plain";

const ICONS: Record<PermissionMode, string> = { ask: "$(shield)", edits: "$(edit)", plan: "$(book)", auto: "$(zap)" };

/**
 * Quick pick of the four modes. `defaultLabel` adds an "omp default" entry (picked → null);
 * undefined = cancelled.
 */
export async function pickPermissionMode(current: PermissionMode | undefined, title: string, defaultLabel?: string): Promise<PermissionMode | null | undefined> {
	const items: Array<vscode.QuickPickItem & { mode: PermissionMode | null }> = [
		...(defaultLabel ? [{ label: "$(settings) omp default", description: `${defaultLabel}${current ? "" : " · current"}`, mode: null }] : []),
		...PERMISSION_MODES.map(m => ({ label: `${ICONS[m]} ${PERMISSION_MODE_INFO[m].label}`, description: m === current ? "current" : "", detail: PERMISSION_MODE_INFO[m].detail, mode: m })),
	];
	const pick = await vscode.window.showQuickPick(items, { title, placeHolder: "Permission mode: how omp's tool approvals are answered" });
	return pick ? pick.mode : undefined;
}

export function registerPermissions(api: OmpApi): void {
	api.context.subscriptions.push(
		vscode.commands.registerCommand("switchyard.setPermissionMode", async (arg?: unknown, modeArg?: unknown) => {
			const id = api.idFrom(arg) ?? (await api.pickSession("Set the permission mode of which session?", m => m.status !== "stopped"));
			const meta = id ? api.sessions.get(id) : undefined;
			if (!meta) return;
			const mode = isPermissionMode(modeArg) ? modeArg : await pickPermissionMode(meta.permissionMode, `Permission mode · ${meta.title}`);
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
