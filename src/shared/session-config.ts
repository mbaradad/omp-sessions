// Per-session capability toggles (skills, tools, MCP servers, rules, extensions, LSP, model…).
// Node-only: shared by the extension, the session host, the daemon and the CLI.
//
// Two layers, both re-applied on every (re)start of a session:
// - CLI flags in launch.json `ompArgs` (`--model`, `--thinking`, `--approval-mode`, `--max-time`,
//   `--no-lsp`, `--no-rules`, `--no-extensions`, `--no-skills`) — see `readFlags`/`applyFlags`.
// - omp settings the host writes into an extra `--config` overlay (`session-overlay.yml`) from
//   `session-config.json`: `disabledExtensions` (`skill:<name>`, `mcp:<name>`, …) merged with the
//   user's own list, and built-in tool gates (`bash.enabled: false`, …).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PERMISSION_MODE_INFO, permissionModeOf } from "./permissions";
import { sessionDir, stateRoot } from "./protocol";
import { spawnTarget } from "./win-spawn";

export interface SessionToggles {
	/** omp extension ids turned off for this session: `skill:<n>`, `mcp:<n>`, `rule:<n>`, `extension-module:<n>`. */
	disabled: string[];
	/** Built-in tool gates forced for this session: omp setting id → enabled. */
	tools: Record<string, boolean>;
}

/** The launch flags this feature manages; every other omp argument is left alone. */
export interface SessionFlags {
	model?: string;
	thinking?: string;
	approvalMode?: string;
	maxTime?: string;
	noLsp: boolean;
	noRules: boolean;
	noExtensions: boolean;
	noSkills: boolean;
}

export interface ProjectDefaults {
	/** Managed launch flags only (see `SessionFlags`). */
	args: string[];
	toggles: SessionToggles;
}

/** Built-in tools omp gates by a setting (an overlay can switch them per session); `on` = omp's default. */
export const TOOL_GATES: ReadonlyArray<{ setting: string; label: string; detail: string; on: boolean }> = [
	{ setting: "bash.enabled", label: "bash", detail: "Shell commands", on: true },
	{ setting: "async.enabled", label: "async / background jobs", detail: "Async bash and background tasks", on: true },
	{ setting: "launch.enabled", label: "launch", detail: "Named long-running services (proc://)", on: true },
	{ setting: "glob.enabled", label: "glob", detail: "Find files by glob", on: true },
	{ setting: "grep.enabled", label: "grep", detail: "Regex content search", on: true },
	{ setting: "find.enabled", label: "find", detail: "Natural-language file search (judge model)", on: true },
	{ setting: "astGrep.enabled", label: "ast_grep", detail: "Structural AST search", on: false },
	{ setting: "astEdit.enabled", label: "ast_edit", detail: "Structural AST rewrites", on: true },
	{ setting: "eval.js", label: "eval (JavaScript)", detail: "JavaScript cells in the eval tool", on: true },
	{ setting: "eval.py", label: "eval (Python)", detail: "Python cells in the eval tool", on: true },
	{ setting: "browser.enabled", label: "browser", detail: "Scripted Chromium automation", on: true },
	{ setting: "computer.enabled", label: "computer", detail: "Desktop screenshots and input", on: false },
	{ setting: "web_search.enabled", label: "web_search", detail: "Live web search", on: true },
	{ setting: "fetch.enabled", label: "fetch URLs", detail: "Let read fetch URLs", on: true },
	{ setting: "github.enabled", label: "github", detail: "Issues, PRs, Actions", on: false },
	{ setting: "debug.enabled", label: "debug", detail: "DAP debugger", on: true },
	{ setting: "todo.enabled", label: "todo", detail: "Todo plan tracking", on: true },
	{ setting: "ask.enabled", label: "ask", detail: "Ask you questions", on: true },
	{ setting: "checkpoint.enabled", label: "checkpoint / rewind", detail: "Context checkpoints", on: false },
	{ setting: "generate_image.enabled", label: "generate_image", detail: "Image generation", on: false },
	{ setting: "security.enabled", label: "security_scan", detail: "Security scan planning", on: false },
];

/** Enum-valued gates: setting → [on, off] values. */
const ENUM_GATES: Record<string, [string, string]> = { "find.enabled": ["on", "off"] };

/** Whether a tool gate is on given omp's effective setting value (`config`), before session overrides. */
export function gateBaseline(setting: string, config: ReadonlyMap<string, unknown>): boolean {
	const value = config.get(setting);
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value !== "off";
	return TOOL_GATES.find(g => g.setting === setting)?.on ?? true;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;

const VALUE_FLAGS: Record<string, "model" | "thinking" | "approvalMode" | "maxTime"> = {
	"--model": "model",
	"--thinking": "thinking",
	"--approval-mode": "approvalMode",
	"--max-time": "maxTime",
};
const BOOL_FLAGS: Record<string, "noLsp" | "noRules" | "noExtensions" | "noSkills"> = {
	"--no-lsp": "noLsp",
	"--no-rules": "noRules",
	"--no-extensions": "noExtensions",
	"--no-skills": "noSkills",
};

export function emptyToggles(): SessionToggles {
	return { disabled: [], tools: {} };
}

export function emptyFlags(): SessionFlags {
	return { noLsp: false, noRules: false, noExtensions: false, noSkills: false };
}

/** The managed flags in an omp argument list (last occurrence wins, like omp's parser). */
export function readFlags(args: readonly string[]): SessionFlags {
	const out = emptyFlags();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const eq = arg.indexOf("=");
		const name = eq > 0 ? arg.slice(0, eq) : arg;
		const valueKey = VALUE_FLAGS[name];
		if (valueKey) {
			const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
			if (value !== undefined) out[valueKey] = value;
			continue;
		}
		const boolKey = BOOL_FLAGS[arg];
		if (boolKey) out[boolKey] = true;
	}
	return out;
}

/** `args` without any managed flag, then the managed flags of `flags` appended (no duplicates). */
export function applyFlags(args: readonly string[], flags: SessionFlags): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const eq = arg.indexOf("=");
		const name = eq > 0 ? arg.slice(0, eq) : arg;
		if (VALUE_FLAGS[name]) {
			if (eq < 0) i++;
			continue;
		}
		if (BOOL_FLAGS[arg]) continue;
		out.push(arg);
	}
	for (const [flag, key] of Object.entries(VALUE_FLAGS)) {
		const value = flags[key];
		if (value) out.push(flag, value);
	}
	for (const [flag, key] of Object.entries(BOOL_FLAGS)) if (flags[key]) out.push(flag);
	return out;
}

/** Only the managed flags of `args`, normalized. */
export function managedArgs(args: readonly string[]): string[] {
	return applyFlags([], readFlags(args));
}

export function normalizeToggles(value: unknown): SessionToggles {
	const out = emptyToggles();
	if (!isRecord(value)) return out;
	if (Array.isArray(value.disabled)) out.disabled = [...new Set(value.disabled.filter((x): x is string => typeof x === "string" && x.length > 0))].sort();
	if (isRecord(value.tools)) for (const [k, v] of Object.entries(value.tools)) if (typeof v === "boolean") out.tools[k] = v;
	return out;
}

export function togglesEmpty(t: SessionToggles): boolean {
	return t.disabled.length === 0 && Object.keys(t.tools).length === 0;
}

function sessionConfigFile(id: string): string {
	return path.join(sessionDir(id), "session-config.json");
}

export function readSessionToggles(id: string): SessionToggles {
	return readTogglesFile(sessionConfigFile(id));
}

function readTogglesFile(file: string): SessionToggles {
	try {
		return normalizeToggles(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return emptyToggles();
	}
}

/** Persists a session's toggles (removes the file when nothing is overridden). */
export function writeSessionToggles(id: string, toggles: SessionToggles): void {
	const file = sessionConfigFile(id);
	const t = normalizeToggles(toggles);
	if (togglesEmpty(t)) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeAtomic(file, JSON.stringify(t, null, 1));
}

/** The launch.json `ompArgs` a session was (or will be) started with. */
export function readLaunchArgs(id: string): string[] | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(sessionDir(id), "launch.json"), "utf8"));
		if (isRecord(parsed) && Array.isArray(parsed.ompArgs)) return parsed.ompArgs.filter((x): x is string => typeof x === "string");
	} catch {
		/* sessions created before launch.json existed */
	}
	return undefined;
}

/** launch.json `title`: an explicit title a queued session was created with, not yet handed to its first host. */
export function readLaunchTitle(id: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(sessionDir(id), "launch.json"), "utf8"));
		if (isRecord(parsed) && typeof parsed.title === "string" && parsed.title.trim()) return parsed.title;
	} catch {
		/* none */
	}
	return undefined;
}

/** Rewrites launch.json `ompArgs` keeping every other field (used on the next resume). */
export function writeLaunchArgs(id: string, ompArgs: string[]): void {
	const file = path.join(sessionDir(id), "launch.json");
	let launch: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isRecord(parsed)) launch = parsed;
	} catch {
		/* first write */
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeAtomic(file, JSON.stringify({ ...launch, ompArgs }));
}

/** Sets (undefined: clears) a session's `--model` launch flag: the model its next resume starts on. */
export function setLaunchModel(id: string, model: string | undefined): void {
	const args = readLaunchArgs(id) ?? [];
	writeLaunchArgs(id, applyFlags(args, { ...readFlags(args), model }));
}

// ---- project defaults (per user, keyed by project folder; readable by the CLI and the daemon) ----

export function projectDefaultsFile(): string {
	return path.join(stateRoot(), "project-defaults.json");
}

function readAllDefaults(file: string): Record<string, ProjectDefaults> {
	const out: Record<string, ProjectDefaults> = {};
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isRecord(parsed)) return out;
		for (const [root, v] of Object.entries(parsed)) {
			if (!isRecord(v)) continue;
			const args = Array.isArray(v.args) ? managedArgs(v.args.filter((x): x is string => typeof x === "string")) : [];
			out[root] = { args, toggles: normalizeToggles(v.toggles) };
		}
	} catch {
		/* none saved */
	}
	return out;
}

/** Defaults of the nearest saved project folder containing `cwd` (or `cwd` itself). */
export function readProjectDefaults(cwd: string, file = projectDefaultsFile()): (ProjectDefaults & { root: string }) | undefined {
	const all = readAllDefaults(file);
	let best: string | undefined;
	for (const root of Object.keys(all)) {
		const rel = path.relative(root, cwd);
		if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
		if (!best || root.length > best.length) best = root;
	}
	return best ? { root: best, ...all[best] } : undefined;
}

/** Saves (or with `undefined`, clears) the defaults of a project folder. */
export function writeProjectDefaults(root: string, defaults: ProjectDefaults | undefined, file = projectDefaultsFile()): void {
	const all = readAllDefaults(file);
	if (defaults) all[root] = { args: managedArgs(defaults.args), toggles: normalizeToggles(defaults.toggles) };
	else delete all[root];
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeAtomic(file, JSON.stringify(all, null, 1));
}

/**
 * Launch configuration of a brand-new session in `cwd`: `extraArgs` (the `omp.extraArgs` setting)
 * with the project's default flags applied, plus the project's default toggles.
 */
export function newSessionLaunch(cwd: string, extraArgs: readonly string[], file = projectDefaultsFile()): { ompArgs: string[]; toggles?: SessionToggles } {
	const defaults = readProjectDefaults(cwd, file);
	if (!defaults) return { ompArgs: [...extraArgs] };
	return {
		ompArgs: applyFlags(extraArgs, readFlags(defaults.args)),
		toggles: togglesEmpty(defaults.toggles) ? undefined : defaults.toggles,
	};
}

// ---- overlay (host side) ----

/** omp settings overlay for `toggles`; `baseDisabled` = the user's own `disabledExtensions` (arrays replace in overlays). */
export function buildOverlay(toggles: SessionToggles, baseDisabled: readonly string[]): Record<string, unknown> {
	const overlay: Record<string, unknown> = {};
	if (toggles.disabled.length) overlay.disabledExtensions = [...new Set([...baseDisabled, ...toggles.disabled])];
	for (const [setting, enabled] of Object.entries(toggles.tools)) {
		const parts = setting.split(".");
		let node = overlay;
		for (const part of parts.slice(0, -1)) {
			const next = node[part];
			if (isRecord(next)) node = next;
			else {
				const created: Record<string, unknown> = {};
				node[part] = created;
				node = created;
			}
		}
		const enumValues = ENUM_GATES[setting];
		node[parts[parts.length - 1]] = enumValues ? enumValues[enabled ? 0 : 1] : enabled;
	}
	return overlay;
}

/** Parses `omp config get <key> --json` output (`{ value }`). */
export function parseConfigValue(stdout: string): unknown {
	try {
		const parsed: unknown = JSON.parse(stdout);
		return isRecord(parsed) ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

/** omp's effective value of one setting in `cwd` (`omp config get <key> --json`); undefined when unreadable. */
export function readOmpSetting(omp: string, key: string, cwd: string, env: NodeJS.ProcessEnv, log: (...a: unknown[]) => void = () => {}): unknown {
	const target = spawnTarget(omp, ["config", "get", key, "--json"]);
	const res = spawnSync(target.file, target.args, {
		cwd,
		env,
		encoding: "utf8",
		timeout: 15_000,
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
		windowsVerbatimArguments: target.windowsVerbatimArguments,
	});
	if (res.status === 0) return parseConfigValue(res.stdout);
	log(`session-config: could not read ${key}`, String(res.error ?? `exit ${res.status ?? res.signal}`));
	return undefined;
}

/**
 * Host side: writes `<dir>/session-overlay.yml` from `<dir>/session-config.json` and returns the
 * extra omp arguments that load it (none when the session overrides nothing).
 */
export function sessionOverlayArgs(dir: string, omp: string, cwd: string, env: NodeJS.ProcessEnv, log: (...a: unknown[]) => void = () => {}): string[] {
	const overlayFile = path.join(dir, "session-overlay.yml");
	const toggles = readTogglesFile(path.join(dir, "session-config.json"));
	if (togglesEmpty(toggles)) {
		fs.rmSync(overlayFile, { force: true });
		return [];
	}
	let base: string[] = [];
	if (toggles.disabled.length) {
		// An overlay array replaces the user's list instead of extending it, so fold that in.
		const value = readOmpSetting(omp, "disabledExtensions", cwd, env, log);
		if (Array.isArray(value)) base = value.filter((x): x is string => typeof x === "string");
	}
	// JSON is valid YAML.
	fs.writeFileSync(overlayFile, `${JSON.stringify(buildOverlay(toggles, base), null, 1)}\n`);
	return ["--config", overlayFile];
}

// ---- summaries ----

/** Compact list of what differs from omp's defaults, e.g. `think high · no LSP · 2 skills off · bash off`. */
export function settingsSummary(args: readonly string[], toggles: SessionToggles): string[] {
	const f = readFlags(args);
	const parts: string[] = [];
	if (f.model) parts.push(f.model);
	if (f.thinking) parts.push(`think ${f.thinking}`);
	const mode = permissionModeOf(f.approvalMode);
	if (mode) parts.push(`${PERMISSION_MODE_INFO[mode].label.toLowerCase()} mode`);
	if (f.maxTime) parts.push(`max ${f.maxTime}`);
	if (f.noSkills) parts.push("no skills");
	if (f.noRules) parts.push("no rules");
	if (f.noExtensions) parts.push("no extensions");
	if (f.noLsp) parts.push("no LSP");
	const count = (prefix: string) => toggles.disabled.filter(x => x.startsWith(prefix)).length;
	const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"} off`;
	if (count("skill:")) parts.push(plural(count("skill:"), "skill"));
	if (count("mcp:")) parts.push(plural(count("mcp:"), "MCP server"));
	const otherOff = toggles.disabled.length - count("skill:") - count("mcp:");
	if (otherOff) parts.push(plural(otherOff, "extension"));
	for (const [setting, on] of Object.entries(toggles.tools)) parts.push(`${TOOL_GATES.find(g => g.setting === setting)?.label ?? setting} ${on ? "on" : "off"}`);
	return parts;
}

/** The tree tooltip chip for a session: its non-default launch settings, or undefined. */
export function sessionSettingsChip(id: string): string | undefined {
	const parts = settingsSummary(readLaunchArgs(id) ?? [], readSessionToggles(id));
	return parts.length ? parts.join(" · ") : undefined;
}

// ---- helpers ----

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeAtomic(file: string, content: string): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}
