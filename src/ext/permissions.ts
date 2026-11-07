// Permission modes in VS Code: the picker and the "omp: Set Permission Mode…" command.
import * as vscode from "vscode";
import { sessionPermissionMode, setSessionPermissionMode } from "../shared/launch";
import { PERMISSION_MODES, PERMISSION_MODE_INFO, type PermissionMode, isPermissionMode } from "../shared/permissions";
import type { OmpApi } from "./api";

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
		vscode.commands.registerCommand("omp.setPermissionMode", async (arg?: unknown, modeArg?: unknown) => {
			const id = api.idFrom(arg) ?? (await api.pickSession("Set the permission mode of which session?"));
			const meta = id ? api.sessions.get(id) : undefined;
			if (!meta) return;
			const mode = isPermissionMode(modeArg) ? modeArg : await pickPermissionMode(sessionPermissionMode(meta), `Permission mode · ${meta.title}`);
			if (!mode) return;
			if (!(await setSessionPermissionMode(meta, mode))) {
				void vscode.window.showWarningMessage(`"${meta.title}" runs an older session host without permission modes. Restart it (omp: Upgrade Session Host) to switch modes live.`);
				return;
			}
			api.refreshTree();
			if (meta.status === "stopped") void vscode.window.showInformationMessage(`"${meta.title}" resumes in ${PERMISSION_MODE_INFO[mode].label} mode.`);
		}),
	);
}
