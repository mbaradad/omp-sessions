// The permission mode of a Switchyard session and the omp extension that enforces it (MAPPING D11, G7, G38).
// AO runs every session in `bypass-permissions`; the Switchyard omp extension's gate (`mode.js`) reads the
// session's mode file and asks, or not. Without the extension nothing asks, so ask, edits and plan are
// refused when it is missing. Node-only.
import * as fs from "node:fs";
import * as path from "node:path";
import type { AoClient } from "../ao/client";
import { sessionStateFile, shimDir } from "../ao/native";
import type { AoPermissionMode } from "../ao/report";
import { ompPaths } from "../shared/omp-paths";

/** The package folder the extension installs into (`checkpoints`: OMP_EXTENSION_PACKAGE). */
const EXTENSION_PACKAGE = "switchyard";
const MODES: readonly AoPermissionMode[] = ["ask", "edits", "plan", "auto"];

/** Where the extension's gate module lives in omp's agent folder. */
export function gateModulePath(): string {
	return path.join(ompPaths().agentDir, "extensions", EXTENSION_PACKAGE, "mode.js");
}

/** Whether the gate is installed: without it a session in ask, edits or plan mode asks for nothing. */
export function gateInstalled(): boolean {
	return fs.existsSync(gateModulePath());
}

/** The `omp` shim (G34) that appends a session's extra arguments; first on the daemon's PATH when Switchyard started it. */
export function shimPath(): string {
	return path.join(shimDir(), "omp");
}

/** The mode the session's gate reads; undefined for a session that never had one (started before Switchyard's gate). */
export function readSessionMode(sessionId: string): AoPermissionMode | undefined {
	try {
		const text = fs.readFileSync(sessionStateFile(sessionId, "mode"), "utf8").trim();
		return MODES.find(m => m === text);
	} catch {
		return undefined;
	}
}

/** Why a mode cannot be enforced here, or undefined when it can. */
export function modeProblem(mode: AoPermissionMode): string | undefined {
	if (mode === "auto" || gateInstalled()) return undefined;
	return `--mode ${mode} needs Switchyard's omp extension, which is not installed (${gateModulePath()}): without it nothing asks and the session would run unrestricted. Use auto, or install the extension (the Switchyard VS Code extension installs it)`;
}

/**
 * Sets the mode of a running session: the file the gate reads, and omp's own `plan` option.
 * INTERIM (G40): checkpoints' `setSessionMode` also declines gate questions left open by the old mode;
 * this does not, so a question that was already waiting stays until answered. Replace with it
 * when `src/shared/session-mode-ops.ts` is reachable from foundation.
 */
export async function applySessionMode(client: AoClient, sessionId: string, mode: AoPermissionMode): Promise<void> {
	const file = sessionStateFile(sessionId, "mode");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${mode}\n`);
	fs.renameSync(tmp, file);
	const options = await client.configOptions(sessionId).catch(() => undefined);
	const current = options?.options.find(o => o.id === "mode")?.currentValue;
	if (mode === "plan" && current !== "plan") await client.setConfigOption(sessionId, "mode", { value: "plan" });
	else if (mode !== "plan" && current === "plan") await client.setConfigOption(sessionId, "mode", { value: "default" });
}
