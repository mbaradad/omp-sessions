// What a requested permission mode needs on this machine (MAPPING D11, G7, G38). AO runs every session in
// `bypass-permissions`; the Switchyard omp extension's gate (`mode.js`) reads the session's mode file and
// asks, or not. Without the extension nothing asks, so ask, edits and plan are refused when it is missing.
import { gateStatus } from "../ao/gate";
import type { PermissionMode } from "../shared/permissions";

/** Why a mode cannot be enforced here, or undefined when it can. `flag`: how the message names the request. */
export function modeProblem(mode: PermissionMode, flag = `--mode ${mode}`): string | undefined {
	if (mode === "auto") return undefined;
	const { gate, extensionDir } = gateStatus();
	if (gate) return undefined;
	return `${flag} needs Switchyard's omp extension, which is not installed (${extensionDir}): without it nothing asks and the session would run unrestricted. Use auto, or install it: switchyard omp-extension install`;
}
