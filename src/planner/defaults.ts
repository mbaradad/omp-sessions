// The user's defaults for sessions that pick nothing (MAPPING D7): `model` and `mode` in
// `<switchyard home>/config.json`, the file the CLI and the extension write (`switchyard config set …`).
// The planner reads it at every dispatch, so a change applies to the next session it starts. Node-only.
import * as fs from "node:fs";
import * as path from "node:path";
import { switchyardHome } from "../ao/native";
import { PERMISSION_MODES, type PermissionMode } from "./types";

export interface UserDefaults {
	/** `provider/id`. */
	model?: string;
	mode?: PermissionMode;
}

export function readUserDefaults(file = path.join(switchyardHome(), "config.json")): UserDefaults {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: UserDefaults = {};
	if ("model" in raw && typeof raw.model === "string" && /^[^/\s]+\/\S+$/.test(raw.model.trim())) out.model = raw.model.trim();
	if ("mode" in raw && typeof raw.mode === "string" && (PERMISSION_MODES as readonly string[]).includes(raw.mode)) out.mode = raw.mode as PermissionMode;
	return out;
}
