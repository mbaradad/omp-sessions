// Switchyard's user settings (`~/.switchyard/config.json`, MAPPING D7): the model and permission mode
// new sessions start with when they ask for none (AO has no per-harness default model), extra `omp acp`
// arguments (G34: the `omp` shim reads `omp.extraArgs`), and whether the planner may install itself as a
// user service. Shared by the CLI, the extension and the planner.
import * as fs from "node:fs";
import * as path from "node:path";
import { switchyardHome } from "../ao/client";
import { type PermissionMode, isPermissionMode } from "./permissions";

export interface SwitchyardConfig {
	/** `provider/id` of new sessions that pick no model; absent: omp's own default. */
	model?: string;
	/** Permission mode of new sessions that ask for none; absent: AO's default for omp. */
	mode?: PermissionMode;
	/** "off": never install the planner as a user service by itself. */
	service?: "on" | "off";
	/** The nested key the `omp` shim reads (G34): arguments added to every `omp acp` an AO session starts, e.g. `["--profile", "work"]`. */
	omp?: { extraArgs?: string[] };
}

export function switchyardConfigPath(home = switchyardHome()): string {
	return path.join(home, "config.json");
}

function readRaw(file: string): Record<string, unknown> {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
	} catch {
		return {};
	}
}

export function readSwitchyardConfig(file = switchyardConfigPath()): SwitchyardConfig {
	const raw = readRaw(file);
	const out: SwitchyardConfig = {};
	if (typeof raw.model === "string" && raw.model.trim()) out.model = raw.model.trim();
	if (isPermissionMode(raw.mode)) out.mode = raw.mode;
	if (raw.service === "on" || raw.service === "off") out.service = raw.service;
	const omp = raw.omp;
	if (omp && typeof omp === "object" && "extraArgs" in omp && Array.isArray(omp.extraArgs)) {
		const extraArgs = omp.extraArgs.filter((a): a is string => typeof a === "string");
		if (extraArgs.length) out.omp = { extraArgs };
	}
	return out;
}

/**
 * Merges `patch` into config.json (a key given as undefined is removed); atomic. Keys this module
 * doesn't know are kept: other Switchyard parts (the shim, the planner) read the same file. `omp` is
 * merged key by key, so other `omp.*` keys survive a change to `omp.extraArgs`.
 */
export function writeSwitchyardConfig(patch: SwitchyardConfig, file = switchyardConfigPath()): SwitchyardConfig {
	const raw = readRaw(file);
	const next: Record<string, unknown> = { ...raw, ...patch };
	if (patch.omp && typeof raw.omp === "object" && raw.omp !== null && !Array.isArray(raw.omp)) next.omp = { ...raw.omp, ...patch.omp };
	for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`);
	fs.renameSync(tmp, file);
	return readSwitchyardConfig(file);
}
