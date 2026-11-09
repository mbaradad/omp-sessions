// Keeps the omp extensions omp Sessions ships (todo mirror, …) installed in omp's agent folder, so
// omp processes AO starts load them. Runs at activation; cheap when nothing changed.
import * as path from "node:path";
import * as vscode from "vscode";
import { installOmpExtensions, ompExtensionDir } from "../shared/omp-extension-install";
import type { OmpApi } from "./api";

export function registerOmpExtensions(api: OmpApi): void {
	const target = ompExtensionDir();
	try {
		installOmpExtensions(path.join(api.context.extensionPath, "out", "omp-extension"), target);
	} catch (err) {
		void vscode.window.showWarningMessage(`omp: could not install omp Sessions' omp extensions into ${target}: ${err instanceof Error ? err.message : String(err)}. omp's own plan won't show in the Tasks view.`);
	}
}
