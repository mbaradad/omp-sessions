// The chat models omp offers (`omp models --json`), for the new-session picker: the list is omp's own and the
// default is `model` in ~/.switchyard/config.json (omp's own default, `modelRoles.default`, applies when that
// is unset). Node-only.
import { execFile } from "node:child_process";
import * as path from "node:path";
import { isRecord } from "./bridge";
import { readSwitchyardConfig } from "../ao/config";
import { findOmp, ompSearchDirs } from "./omp-paths";
import { spawnTarget } from "./win-spawn";

export interface ModelEntry {
	/** `provider/id`: what `--model`, `set_model` and the default take. */
	selector: string;
	provider: string;
	/** omp's model id within the provider. */
	id: string;
	name: string;
	contextWindow?: number;
	reasoning?: boolean;
	input?: string[];
	/** The omp Sessions default model. */
	default: boolean;
}

export interface ModelList {
	models: ModelEntry[];
	/** The Switchyard default (config.json), or null: omp's own default applies. */
	default: string | null;
	/** omp's configured default (`modelRoles.default`), when it could be read. */
	ompDefault: string | null;
}

/** Chat models from `omp models --json` output; throws when it isn't that shape. */
export function parseModels(json: string, defaultModel?: string): ModelEntry[] {
	const data: unknown = JSON.parse(json);
	if (!isRecord(data) || !Array.isArray(data.models)) throw new Error("unexpected `omp models --json` output");
	const out: ModelEntry[] = [];
	for (const m of data.models) {
		if (!isRecord(m) || (m.kind !== undefined && m.kind !== "chat")) continue;
		if (typeof m.provider !== "string" || !m.provider || typeof m.id !== "string" || !m.id) continue;
		const selector = typeof m.selector === "string" && m.selector ? m.selector : `${m.provider}/${m.id}`;
		out.push({
			selector,
			provider: m.provider,
			id: m.id,
			name: typeof m.name === "string" && m.name ? m.name : m.id,
			...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
			...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
			...(Array.isArray(m.input) ? { input: m.input.filter((i): i is string => typeof i === "string") } : {}),
			default: selector === defaultModel,
		});
	}
	return out;
}

/** Parses `omp config get <key> --json` output (`{ value }`). */
function parseConfigValue(stdout: string): unknown {
	try {
		const parsed: unknown = JSON.parse(stdout);
		return isRecord(parsed) ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

function runOmp(omp: string, args: string[], cwd: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	// `.cmd` shims go through cmd.exe with every argument escaped: `search` comes from remote clients.
	const target = spawnTarget(omp, args);
	// Windows spells it `Path`: replace that key rather than adding a second one.
	const env = { ...process.env };
	const pathKey = Object.keys(env).find(k => k.toUpperCase() === "PATH") ?? "PATH";
	env[pathKey] = ompSearchDirs().join(path.delimiter);
	execFile(
		target.file,
		target.args,
		{ cwd, env, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: target.windowsVerbatimArguments },
		(err, stdout, stderr) => (err ? reject(new Error(`omp ${args.join(" ")}: ${stderr.trim().split("\n").pop() || err.message}`)) : resolve(stdout)),
	);
	return promise;
}

/** omp's chat models (`search`: `omp models find <search>`), the omp Sessions default marked. */
export async function listModels(cwd: string, search?: string): Promise<ModelList> {
	const settings = readSwitchyardConfig();
	const omp = findOmp();
	if (!omp) throw new Error("could not find the omp executable: put omp on PATH");
	const [listing, roles] = await Promise.all([
		runOmp(omp, search ? ["models", "find", search, "--json"] : ["models", "--json"], cwd),
		runOmp(omp, ["config", "get", "modelRoles", "--json"], cwd).then(parseConfigValue, () => undefined),
	]);
	const ompDefault = isRecord(roles) && typeof roles.default === "string" && roles.default ? roles.default : null;
	return { models: parseModels(listing, settings.model), default: settings.model ?? null, ompDefault };
}
