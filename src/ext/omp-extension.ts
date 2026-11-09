// Keeps what Switchyard needs inside omp installed: the package with the permission gate and the other
// omp extension modules, and the `omp` shim (GAPS.md G34, G46). Runs at activation through the one shared
// function every entry point uses (ensureOmpIntegration); cheap when nothing changed. Only an installed
// (Production) extension writes there: a development host or an e2e run leaves the real omp alone unless
// SWITCHYARD_INSTALL_OMP_EXTENSIONS=1.
import * as path from "node:path";
import * as vscode from "vscode";
import { ensureOmpIntegration } from "../shared/omp-extension-install";
import type { OmpApi } from "./api";

export function registerOmpExtensions(api: OmpApi): void {
	const result = ensureOmpIntegration({ bundleRoot: path.join(api.context.extensionPath, "out"), production: api.context.extensionMode === vscode.ExtensionMode.Production });
	if (!result.error) return;
	console.warn("[switchyard] omp integration:", result.error);
	void vscode.window.showWarningMessage(`Switchyard: ${result.error}. Sessions started now run without permission modes (ask, edits, plan are not enforced), checkpoints (undo) and extra omp flags; the omp todo plan won't show in the Tasks view.`);
}
