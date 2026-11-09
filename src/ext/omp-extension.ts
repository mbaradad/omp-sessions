// Keeps the omp extensions Switchyard ships (checkpoints, todo mirror, …) installed in omp's agent
// folder, so omp processes AO starts load them. Runs at activation; cheap when nothing changed.
import * as path from "node:path";
import * as vscode from "vscode";
import { installOmpExtensions, ompExtensionDir, removeLegacyOmpExtensions } from "../shared/omp-extension-install";
import type { OmpApi } from "./api";

export function registerOmpExtensions(api: OmpApi): void {
	const target = ompExtensionDir();
	try {
		installOmpExtensions(path.join(api.context.extensionPath, "out", "omp-extension"), target);
		removeLegacyOmpExtensions(target);
	} catch (err) {
		void vscode.window.showWarningMessage(`Switchyard: could not install its omp extensions into ${target}: ${err instanceof Error ? err.message : String(err)}. Sessions started now get no checkpoints (undo) and omp's own plan won't show in the Tasks view.`);
	}
}
