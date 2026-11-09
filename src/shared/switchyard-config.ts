// Switchyard's user settings (`~/.switchyard/config.json`, MAPPING D7): the model and permission mode
// new sessions start with when they ask for none (AO has no per-harness default model), and whether
// the planner may install itself as a user service. Shared by the CLI, the extension and the planner.
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
}

export function switchyardConfigPath(home = switchyardHome()): string {
	return path.join(home, "config.json");
}

export function readSwitchyardConfig(file = switchyardConfigPath()): SwitchyardConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object") return {};
	const out: SwitchyardConfig = {};
	if ("model" in raw && typeof raw.model === "string" && raw.model.trim()) out.model = raw.model.trim();
	if ("mode" in raw && isPermissionMode(raw.mode)) out.mode = raw.mode;
	if ("service" in raw && (raw.service === "on" || raw.service === "off")) out.service = raw.service;
	return out;
}

/** Merges `patch` into config.json (a key given as undefined is removed); atomic. */
export function writeSwitchyardConfig(patch: SwitchyardConfig, file = switchyardConfigPath()): SwitchyardConfig {
	const next = { ...readSwitchyardConfig(file), ...patch };
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`);
	fs.renameSync(tmp, file);
	return readSwitchyardConfig(file);
}
