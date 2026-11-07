// Installs the omp-sessions Hermes plugin (integrations/hermes/omp-sessions, bundled by build.mjs
// as out/hermes-plugin/omp-sessions with its skill) into a Hermes home's `plugins/omp-sessions` and
// enables it with the hermes CLI. Plugins are per profile: the default home is `$HERMES_HOME`, else
// ~/.hermes; named profiles are `<root>/profiles/<name>` (hermes runs as `hermes -p <name>`). Only a
// copy we wrote (the marker file) is replaced or removed. Node-only; no vscode import. Docs: docs/HERMES.md.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PLUGIN_NAME = "omp-sessions";
/** The bundled plugin, relative to the folder cli.js / extension.js runs from. */
export const PLUGIN_BUNDLE = path.join("hermes-plugin", PLUGIN_NAME);
const MARKER = ".managed-by-omp-vs";
/** config.yaml key that lets the plugin message the Hermes session that started an omp session. */
const INJECTION_KEY = `plugins.entries.${PLUGIN_NAME}.allow_gateway_injection`;
const LANE_KEY = `plugins.entries.${PLUGIN_NAME}.settings.lane.enabled`;
/** Hermes's profile id grammar and the files that make a folder under profiles/ a profile. */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE_MARKERS = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"];

export type PluginInstallOutcome = "installed" | "updated" | "unchanged" | "skipped";

/** The Hermes home used without a profile flag: `$HERMES_HOME`, else ~/.hermes (the default profile). */
export function hermesHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
	return env.HERMES_HOME || path.join(home, ".hermes");
}

/** Root of the profile tree: the default home, or its grandparent when it is `<root>/profiles/<name>`. */
export function hermesRoot(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
	const h = hermesHome(env, home);
	return path.basename(path.dirname(h)) === "profiles" ? path.dirname(path.dirname(h)) : h;
}

export function pluginTarget(hermesHomeDir: string): string {
	return path.join(hermesHomeDir, "plugins", PLUGIN_NAME);
}

/** A Hermes home to install into. */
export interface HermesTarget {
	/** "default" or the profile name. */
	label: string;
	home: string;
	/** Set: run hermes as `hermes -p <profile>`; unset: as is (it uses `$HERMES_HOME`). */
	profile?: string;
}

function exists(p: string): boolean {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/** Hermes's rule: a folder under profiles/ is a profile when it has an identity file and isn't deleted. */
export function isProfileDir(dir: string): boolean {
	const deleted = path.join(path.dirname(dir), ".deleted", path.basename(dir));
	return PROFILE_ID.test(path.basename(dir)) && PROFILE_MARKERS.some(m => exists(path.join(dir, m))) && !exists(deleted);
}

/** Named profiles under `<root>/profiles` (bare folders left by logs or cron are not profiles). */
export function listProfiles(root: string): string[] {
	try {
		return fs
			.readdirSync(path.join(root, "profiles"), { withFileTypes: true })
			.filter(e => e.isDirectory() && isProfileDir(path.join(root, "profiles", e.name)))
			.map(e => e.name)
			.sort();
	} catch {
		return [];
	}
}

/**
 * The homes `--profile <name>`… / `--all-profiles` select; neither: the default home. Throws for a
 * name that isn't a profile.
 */
export function resolveTargets(sel: { profiles?: readonly string[]; all?: boolean }, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): HermesTarget[] {
	const names = sel.profiles ?? [];
	if (!names.length && !sel.all) {
		const h = hermesHome(env, home);
		return [{ label: path.basename(path.dirname(h)) === "profiles" ? path.basename(h) : "default", home: h }];
	}
	const root = hermesRoot(env, home);
	const profiles = listProfiles(root);
	const out: HermesTarget[] = [];
	const add = (name: string) => {
		if (out.some(t => t.label === name)) return;
		if (name === "default") out.push({ label: "default", home: root, profile: "default" });
		else if (profiles.includes(name)) out.push({ label: name, home: path.join(root, "profiles", name), profile: name });
		else throw new Error(`no Hermes profile "${name}" in ${path.join(root, "profiles")} (a profile has one of ${PROFILE_MARKERS.join(", ")})`);
	};
	if (sel.all) for (const name of ["default", ...profiles]) add(name);
	for (const name of names) add(name);
	return out;
}

/**
 * The profile's config.yaml turns its gateway's kanban dispatcher on explicitly
 * (`kanban: dispatch_in_gateway: true`); false when it says false or nothing.
 */
export function dispatcherConfigured(hermesHomeDir: string): boolean {
	let text: string;
	try {
		text = fs.readFileSync(path.join(hermesHomeDir, "config.yaml"), "utf8");
	} catch {
		return false;
	}
	let inKanban = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\S/.test(line)) inKanban = /^kanban:\s*(#.*)?$/.test(line);
		else if (inKanban && /^\s+dispatch_in_gateway:\s*true\s*(#.*)?$/.test(line)) return true;
	}
	return false;
}

/** The hermes executable: PATH, then ~/.local/bin/hermes (where its installer puts it). */
export function findHermes(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | undefined {
	const names = process.platform === "win32" ? ["hermes.exe", "hermes.cmd", "hermes"] : ["hermes"];
	const dirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean), path.join(home, ".local", "bin")];
	for (const dir of dirs) {
		for (const n of names) {
			const p = path.join(dir, n);
			try {
				if (fs.statSync(p).isFile()) return p;
			} catch {
				/* not here */
			}
		}
	}
	return undefined;
}

/** Relative paths of every file under `dir` (sorted; Python caches skipped). */
function listFiles(dir: string, rel = ""): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		if (e.name === "__pycache__" || e.name === MARKER) continue;
		const p = path.join(rel, e.name);
		if (e.isDirectory()) out.push(...listFiles(dir, p));
		else if (e.isFile()) out.push(p);
	}
	return out.sort();
}

function sameTree(a: string, b: string): boolean {
	try {
		const files = listFiles(a);
		const other = listFiles(b);
		return files.length === other.length && files.every((f, i) => f === other[i] && fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))));
	} catch {
		return false;
	}
}

export interface PluginState {
	installed: boolean;
	/** Installed by omp-vs (the marker file), so install/uninstall may replace it. */
	managed: boolean;
	/** Same files as the bundled copy. */
	current: boolean;
}

export function pluginState(source: string | undefined, target: string): PluginState {
	const installed = fs.existsSync(path.join(target, "plugin.yaml"));
	return {
		installed,
		managed: fs.existsSync(path.join(target, MARKER)),
		current: installed && !!source && sameTree(source, target),
	};
}

/** Copies the bundled plugin to `target`. A plugin folder we didn't write is left alone unless `force`. */
export function installPlugin(source: string, target: string, force = false): PluginInstallOutcome {
	if (!fs.existsSync(path.join(source, "plugin.yaml"))) throw new Error(`the bundled Hermes plugin is missing (${source})`);
	const state = pluginState(source, target);
	if (fs.existsSync(target) && !state.managed && !force) return "skipped";
	if (state.current && state.managed) return "unchanged";
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	const old = `${target}.${process.pid}.old`;
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.cpSync(source, tmp, { recursive: true, filter: f => !f.includes("__pycache__") });
	fs.writeFileSync(path.join(tmp, MARKER), "Installed by omp-vs (omp-vs hermes install); replaced on update.\n");
	const existed = fs.existsSync(target);
	if (existed) fs.renameSync(target, old);
	fs.renameSync(tmp, target);
	fs.rmSync(old, { recursive: true, force: true });
	return existed ? "updated" : "installed";
}

/** Removes a copy we installed; true if something was removed. */
export function uninstallPlugin(target: string): boolean {
	if (!fs.existsSync(path.join(target, MARKER))) return false;
	fs.rmSync(target, { recursive: true, force: true });
	return true;
}

export interface HermesRun {
	ok: boolean;
	output: string;
}

/** Runs `hermes [-p <profile>] <args>` for `target`. */
function runHermes(hermes: string, target: HermesTarget, args: string[], env: NodeJS.ProcessEnv): HermesRun {
	const argv = target.profile ? ["-p", target.profile, ...args] : args;
	const r = spawnSync(hermes, argv, { encoding: "utf8", env: { ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
	const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	return { ok: r.status === 0, output: r.error ? `${r.error.message}${output ? `\n${output}` : ""}` : output };
}

/** `hermes plugins enable omp-sessions` plus the config key that allows notifications into sessions. */
export function enablePlugin(hermes: string, target: HermesTarget, env: NodeJS.ProcessEnv = process.env): HermesRun {
	const enable = runHermes(hermes, target, ["plugins", "enable", PLUGIN_NAME], env);
	if (!enable.ok) return enable;
	const allow = runHermes(hermes, target, ["config", "set", INJECTION_KEY, "true"], env);
	return { ok: allow.ok, output: [enable.output, allow.output].filter(Boolean).join("\n") };
}

export function disablePlugin(hermes: string, target: HermesTarget, env: NodeJS.ProcessEnv = process.env): HermesRun {
	return runHermes(hermes, target, ["plugins", "disable", PLUGIN_NAME], env);
}

/** What `hermes plugins list` says about the plugin: enabled, disabled, …; undefined when unknown. */
export function hermesPluginStatus(hermes: string, target: HermesTarget, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const r = runHermes(hermes, target, ["plugins", "list", "--user", "--json"], env);
	if (!r.ok) return undefined;
	return parsePluginStatus(r.output);
}

/** Whether the plugin's kanban lane is on in that profile (`hermes omp lane on` sets it). */
export function laneEnabled(hermes: string, target: HermesTarget, env: NodeJS.ProcessEnv = process.env): boolean {
	const r = runHermes(hermes, target, ["config", "get", LANE_KEY], env);
	return r.ok && r.output.split("\n").pop()?.trim() === "true";
}

/** The plugin's status in `hermes plugins list --json` output. */
export function parsePluginStatus(text: string): string | undefined {
	const start = text.indexOf("[");
	if (start < 0) return undefined;
	let list: unknown;
	try {
		list = JSON.parse(text.slice(start));
	} catch {
		return undefined;
	}
	if (!Array.isArray(list)) return undefined;
	for (const item of list) {
		if (item && typeof item === "object" && "name" in item && item.name === PLUGIN_NAME && "status" in item && typeof item.status === "string") return item.status;
	}
	return undefined;
}

export interface PluginReport {
	label: string;
	home: string;
	/** The plugin folder in that home. */
	target: string;
	state: PluginState;
	/** From `hermes plugins list` (enabled, disabled, …), when hermes runs. */
	status?: string;
	/** The kanban lane is on there (only checked where the plugin is enabled). */
	lane?: boolean;
}

export function pluginReport(source: string | undefined, target: HermesTarget, hermes: string | undefined, env: NodeJS.ProcessEnv = process.env): PluginReport {
	const dir = pluginTarget(target.home);
	const state = pluginState(source, dir);
	const status = hermes && state.installed ? hermesPluginStatus(hermes, target, env) : undefined;
	const lane = hermes && status === "enabled" ? laneEnabled(hermes, target, env) : undefined;
	return { label: target.label, home: target.home, target: dir, state, status, lane };
}

/** One plain-text line per report (CLI and VS Code). */
export function reportLine(r: PluginReport): string {
	if (!r.state.installed) return `${r.label}: not installed (${r.target})`;
	const freshness = r.state.current ? "current" : r.state.managed ? "outdated, run install to update" : "not installed by omp-vs";
	const lane = r.lane === undefined ? "" : ` · lane ${r.lane ? "on" : "off"}`;
	return `${r.label}: ${freshness}${r.status ? `, ${r.status}` : ""}${lane} (${r.target})`;
}

export const AFTER_INSTALL = [
	"Plugin tools (omp_session_start, …) appear in new Hermes sessions. A running gateway picks the plugin up when it is enabled; if `hermes plugins list` shows it enabled but the tools are missing, restart the gateway (hermes gateway restart).",
	"Kanban lane: turn it on in one profile, `hermes [-p <profile>] omp lane on` (cards assigned to omp run as omp sessions); `hermes omp status` shows it.",
];
