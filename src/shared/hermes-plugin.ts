// Installs the omp-sessions Hermes plugin (integrations/hermes/omp-sessions, bundled by build.mjs
// as out/hermes-plugin/omp-sessions with its skill) into a Hermes home's `plugins/omp-sessions` and
// enables it with the hermes CLI. Plugins are per profile: the default home is `$HERMES_HOME`, else
// ~/.hermes (%LOCALAPPDATA%\hermes on Windows); named profiles are `<root>/profiles/<name>`. hermes
// always runs as `hermes -p <name>` (`-p default` too): without the flag it follows the sticky
// `hermes profile use` profile. Only a copy we wrote (the marker file) is replaced or removed.
// Node-only; no vscode import. Docs: docs/HERMES.md.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMMAND } from "./cli-launcher";

export const PLUGIN_NAME = "omp-sessions";
/** The bundled plugin, relative to the folder cli.js / extension.js runs from. */
export const PLUGIN_BUNDLE = path.join("hermes-plugin", PLUGIN_NAME);
const MARKER = ".managed-by-omp-sessions";
/** Exclusive lock (a file, so Hermes's plugin scan ignores it) around installs into one plugins/ folder. */
const INSTALL_LOCK = ".omp-sessions.install.lock";
/** A lock older than this is from a crashed run, whatever its pid says (pids get reused). */
const STALE_LOCK_MS = 10 * 60_000;
/** Staging folders: dunder names, which Hermes's plugin discovery skips, so a leftover never loads. */
const STAGING = /^__omp-sessions-(\d+)-(?:tmp|old)__$/;
/** Staging folders older versions used beside the plugin (they look like plugins to Hermes). */
const LEGACY_STAGING = /^omp-sessions\.(\d+)\.(?:tmp|old)$/;
/** config.yaml key that lets the plugin message the Hermes session that started an omp session. */
const INJECTION_KEY = `plugins.entries.${PLUGIN_NAME}.allow_gateway_injection`;
const ENTRY = ["plugins", "entries", PLUGIN_NAME];
/** Hermes's profile id grammar and the files that make a folder under profiles/ a profile. */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE_MARKERS = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"];

/** "busy": another window or omp-sessions holds the install lock; nothing was touched. */
export type PluginInstallOutcome = "installed" | "updated" | "unchanged" | "skipped" | "busy";

/** Hermes's own default home (hermes_constants._platform_default_hermes_home): ~/.hermes, %LOCALAPPDATA%\hermes on Windows. */
export function nativeHermesHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): string {
	const name = `${platform === "win32" ? "hermes" : ".hermes"}${env.HERMES_DATA_DIR_SUFFIX ?? ""}`;
	if (platform !== "win32") return path.join(home, name);
	return path.join(env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local"), name);
}

/** `$HERMES_HOME` as Hermes reads it (a leading ~ expanded); undefined when unset. */
function envHermesHome(env: NodeJS.ProcessEnv, home: string): string | undefined {
	const v = env.HERMES_HOME?.trim();
	if (!v) return undefined;
	return v === "~" || v.startsWith("~/") || v.startsWith("~\\") ? path.join(home, v.slice(1)) : v;
}

/** The Hermes home used without a profile flag: `$HERMES_HOME`, else Hermes's default home (the default profile). */
export function hermesHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): string {
	return envHermesHome(env, home) ?? nativeHermesHome(env, home, platform);
}

/**
 * Root of the profile tree, by Hermes's rule (hermes_constants._hermes_root_of): the default home
 * when `$HERMES_HOME` is unset or inside it; else `$HERMES_HOME`'s grandparent when it is
 * `<root>/profiles/<name>`, else `$HERMES_HOME` itself (a custom root).
 */
export function hermesRoot(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): string {
	const native = nativeHermesHome(env, home, platform);
	const h = envHermesHome(env, home);
	if (!h) return native;
	const rel = path.relative(path.resolve(native), path.resolve(h));
	if (!rel.startsWith("..") && !path.isAbsolute(rel)) return native;
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
	/** hermes runs as `hermes -p <profile>` for this home. */
	profile: string;
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
		const label = path.basename(path.dirname(h)) === "profiles" ? path.basename(h) : "default";
		return [{ label, home: h, profile: label }];
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

/** Reads `<home>/config.yaml`; undefined when it is missing. */
export function readConfig(hermesHomeDir: string): string | undefined {
	try {
		return fs.readFileSync(path.join(hermesHomeDir, "config.yaml"), "utf8");
	} catch {
		return undefined;
	}
}

/** A YAML key line: `key: value`, `"key": value` or `'key': value`. */
const KEY_LINE = /^(?:"([^"]*)"|'([^']*)'|([^\s"'#][^:]*?))\s*:(?:\s+(.*))?$/;
const CONTENT_LINE = /^( *)(\S.*)$/;

/** A scalar as written: quotes removed, a trailing comment dropped. */
function unquote(raw: string): string {
	const s = raw.trim();
	const dq = /^"((?:[^"\\]|\\.)*)"/.exec(s);
	if (dq) return dq[1].replace(/\\(.)/g, "$1");
	const sq = /^'((?:[^']|'')*)'/.exec(s);
	if (sq) return sq[1].replace(/''/g, "'");
	return s.replace(/(^|\s+)#.*$/, "").trim();
}

/**
 * The value at `keys` in a config.yaml: a scalar, a list of scalars (block `- x` items or a flow
 * `[a, b]`), "" for an empty value, undefined when missing or a mapping. Covers the block style
 * Hermes writes (no anchors, multi-line scalars or flow mappings), which is all the plugin's keys need.
 */
export function configValue(text: string, keys: readonly string[]): string | string[] | undefined {
	const lines = text.split(/\r?\n/);
	let start = 0;
	let end = lines.length;
	for (const [k, key] of keys.entries()) {
		let childIndent = -1;
		let hit = -1;
		let rest = "";
		for (let i = start; i < end; i++) {
			const m = CONTENT_LINE.exec(lines[i]);
			if (!m || m[2].startsWith("#")) continue;
			if (childIndent < 0) childIndent = m[1].length;
			if (m[1].length !== childIndent) continue;
			const kv = KEY_LINE.exec(m[2]);
			if (kv && (kv[1] ?? kv[2] ?? kv[3]) === key) {
				hit = i;
				rest = kv[4] ?? "";
				break;
			}
		}
		if (hit < 0) return undefined;
		// The key's block: deeper lines, plus `- ` items at its own indent (an indentless list).
		let stop = hit + 1;
		for (; stop < end; stop++) {
			const m = CONTENT_LINE.exec(lines[stop]);
			if (!m || m[2].startsWith("#")) continue;
			if (m[1].length < childIndent || (m[1].length === childIndent && !/^-(\s|$)/.test(m[2]))) break;
		}
		const inline = unquote(rest);
		if (k < keys.length - 1) {
			if (inline) return undefined;
			start = hit + 1;
			end = stop;
			continue;
		}
		if (inline.startsWith("[") && inline.endsWith("]")) return inline.slice(1, -1).split(",").map(unquote).filter(Boolean);
		if (inline || rest.trim().startsWith('"') || rest.trim().startsWith("'")) return inline;
		const items: string[] = [];
		let itemIndent = -1;
		for (const line of lines.slice(hit + 1, stop)) {
			const m = CONTENT_LINE.exec(line);
			if (!m || m[2].startsWith("#")) continue;
			const item = /^-(?:\s+(.*))?$/.exec(m[2]);
			if (itemIndent < 0) {
				if (!item) return undefined;
				itemIndent = m[1].length;
			}
			if (item && m[1].length === itemIndent) items.push(unquote(item[1] ?? ""));
		}
		return itemIndent < 0 ? "" : items;
	}
	return undefined;
}

function truthy(v: string | string[] | undefined): boolean {
	return typeof v === "string" && /^(true|yes|on)$/i.test(v);
}

/**
 * The profile's config.yaml turns its gateway's kanban dispatcher on explicitly
 * (`kanban: dispatch_in_gateway: true`); false when it says false or nothing.
 */
export function dispatcherConfigured(hermesHomeDir: string): boolean {
	const text = readConfig(hermesHomeDir);
	return text !== undefined && truthy(configValue(text, ["kanban", "dispatch_in_gateway"]));
}

/** The plugin's state in a config.yaml the way `hermes plugins list` reports a user plugin: a disable wins, then the allow-list. */
export function configPluginStatus(text: string): "enabled" | "disabled" | "not enabled" {
	const has = (key: string) => {
		const v = configValue(text, ["plugins", key]);
		return Array.isArray(v) && v.includes(PLUGIN_NAME);
	};
	return has("disabled") ? "disabled" : has("enabled") ? "enabled" : "not enabled";
}

/** Where findHermes looks, for "not found" messages. */
export function hermesLookup(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): string {
	return `PATH, ${platform === "win32" ? path.join(nativeHermesHome(env, home, platform), "bin") : "~/.local/bin"}`;
}

/**
 * The hermes executable: PATH, then where Hermes's installer puts it (~/.local/bin; on Windows
 * %LOCALAPPDATA%\hermes\bin, which a VS Code started before the install doesn't have on PATH yet).
 */
export function findHermes(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): string | undefined {
	const win = platform === "win32";
	const names = win ? ["hermes.exe", "hermes.cmd", "hermes"] : ["hermes"];
	const dirs = [...(env.PATH ?? "").split(win ? ";" : ":").filter(Boolean), win ? path.join(nativeHermesHome(env, home, platform), "bin") : path.join(home, ".local", "bin")];
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

/** How to spawn `hermes <args>`: a Windows .cmd launcher needs a shell (and its path quoted for it). */
export function hermesCommand(hermes: string, args: readonly string[], platform = process.platform): { file: string; args: string[]; shell: boolean } {
	const shell = platform === "win32" && /\.(cmd|bat)$/i.test(hermes);
	return { file: shell ? `"${hermes}"` : hermes, args: [...args], shell };
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

/** Files that differ between two plugin folders (added, removed or changed); undefined when one can't be read. */
export function changedFiles(a: string, b: string): string[] | undefined {
	try {
		const left = listFiles(a);
		const right = new Set(listFiles(b));
		const out = left.filter(f => !right.has(f) || !fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))));
		for (const f of left) right.delete(f);
		return [...out, ...right].sort();
	} catch {
		return undefined;
	}
}

export interface PluginState {
	installed: boolean;
	/** Installed by omp-sessions (the marker file), so install/uninstall may replace it. */
	managed: boolean;
	/** Same files as the bundled copy. */
	current: boolean;
}

export function pluginState(source: string | undefined, target: string): PluginState {
	const installed = fs.existsSync(path.join(target, "plugin.yaml"));
	return {
		installed,
		managed: fs.existsSync(path.join(target, MARKER)),
		current: installed && !!source && changedFiles(source, target)?.length === 0,
	};
}

/** The `version:` in a plugin folder's plugin.yaml. */
export function pluginVersion(dir: string): string | undefined {
	try {
		const v = configValue(fs.readFileSync(path.join(dir, "plugin.yaml"), "utf8"), ["version"]);
		return typeof v === "string" && v ? v : undefined;
	} catch {
		return undefined;
	}
}

/** Compares dotted versions part by part (numbers numerically, anything else as text); missing parts are 0. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.+-]/);
	const pb = b.split(/[.+-]/);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? "0";
		const y = pb[i] ?? "0";
		const d = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
		if (d) return Math.sign(d);
	}
	return 0;
}

/** A plugin folder's build stamp: its newest file's mtime (ms), set when the extension or CLI was built or installed. */
export function buildStamp(dir: string): number {
	return Math.max(0, ...listFiles(dir).map(f => fs.statSync(path.join(dir, f)).mtimeMs));
}

/** The build stamp a managed copy's marker recorded (0: an older marker without one). */
function markerStamp(target: string): number {
	try {
		const m = /^stamp:\s*(\d+(?:\.\d+)?)\s*$/m.exec(fs.readFileSync(path.join(target, MARKER), "utf8"));
		return m ? Number(m[1]) : 0;
	} catch {
		return 0;
	}
}

/**
 * The bundled plugin is newer than a managed copy: a higher plugin.yaml version, or the same version
 * from a later build (the stamp its marker recorded). An automatic refresh only replaces such copies,
 * so editors with different extension versions (Stable, Insiders, forks) never downgrade each other.
 */
export function bundleNewer(source: string, target: string): boolean {
	const ours = pluginVersion(source);
	const theirs = pluginVersion(target);
	if (!ours || !theirs) return !!ours && !theirs;
	const cmp = compareVersions(ours, theirs);
	return cmp > 0 || (cmp === 0 && buildStamp(source) > markerStamp(target));
}

function liveProcess(pid: number): boolean {
	return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
}

/** A lock left by a dead process, or older than STALE_LOCK_MS. */
function lockStale(text: string, mtimeMs: number, now: number): boolean {
	const m = /^(\d+) (\d+)/.exec(text);
	if (!m) return now - mtimeMs > STALE_LOCK_MS;
	return !liveProcess(Number(m[1])) || now - Number(m[2]) > STALE_LOCK_MS;
}

/** Takes the install lock of a plugins/ folder; undefined when a live process holds it. Returns the release. */
export function acquireInstallLock(pluginsDir: string, now = Date.now()): (() => void) | undefined {
	fs.mkdirSync(pluginsDir, { recursive: true });
	const lock = path.join(pluginsDir, INSTALL_LOCK);
	const token = `${process.pid} ${now} ${Math.random().toString(36).slice(2)}\n`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(lock, token, { flag: "wx" });
			return () => {
				try {
					if (fs.readFileSync(lock, "utf8") === token) fs.rmSync(lock);
				} catch {
					/* already gone */
				}
			};
		} catch (err) {
			if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
		}
		let text: string;
		let mtimeMs: number;
		try {
			text = fs.readFileSync(lock, "utf8");
			mtimeMs = fs.statSync(lock).mtimeMs;
		} catch {
			continue; // released meanwhile: try again
		}
		if (!lockStale(text, mtimeMs, now)) return undefined;
		// Remove the stale lock only if it is still the one judged stale (another process may have replaced it).
		try {
			if (fs.readFileSync(lock, "utf8") === text) fs.rmSync(lock);
		} catch {
			/* gone */
		}
	}
	return undefined;
}

/** Removes staging folders that crashed installs left behind (their process is gone). Call with the lock held. */
function sweepStaging(pluginsDir: string): void {
	let names: string[];
	try {
		names = fs.readdirSync(pluginsDir);
	} catch {
		return;
	}
	for (const name of names) {
		const m = STAGING.exec(name) ?? LEGACY_STAGING.exec(name);
		if (m && (Number(m[1]) === process.pid || !liveProcess(Number(m[1])))) fs.rmSync(path.join(pluginsDir, name), { recursive: true, force: true });
	}
}

/**
 * Copies the bundled plugin to `target`, under the plugins/ folder's install lock ("busy" when another
 * window or omp-sessions holds it). A plugin folder we didn't write is left alone unless `force`;
 * `onlyIfNewer` (automatic refreshes) replaces a managed copy only when the bundle is newer.
 */
export function installPlugin(source: string, target: string, opts: { force?: boolean; onlyIfNewer?: boolean } = {}): PluginInstallOutcome {
	if (!fs.existsSync(path.join(source, "plugin.yaml"))) throw new Error(`the bundled Hermes plugin is missing (${source})`);
	const pluginsDir = path.dirname(target);
	const release = acquireInstallLock(pluginsDir);
	if (!release) return "busy";
	const tmp = path.join(pluginsDir, `__${PLUGIN_NAME}-${process.pid}-tmp__`);
	const old = path.join(pluginsDir, `__${PLUGIN_NAME}-${process.pid}-old__`);
	try {
		sweepStaging(pluginsDir);
		// Decided with the lock held: another window may have just installed.
		const state = pluginState(source, target);
		if (fs.existsSync(target) && !state.managed && !opts.force) return "skipped";
		if (state.current && state.managed) return "unchanged";
		if (opts.onlyIfNewer && state.installed && !bundleNewer(source, target)) return "unchanged";
		fs.cpSync(source, tmp, { recursive: true, filter: f => !f.includes("__pycache__") });
		fs.writeFileSync(path.join(tmp, MARKER), `Installed by omp-sessions (omp-sessions hermes install); replaced on update.\nversion: ${pluginVersion(source) ?? "unknown"}\nstamp: ${buildStamp(source)}\n`);
		const existed = fs.existsSync(target);
		if (existed) fs.renameSync(target, old);
		fs.renameSync(tmp, target);
		return existed ? "updated" : "installed";
	} finally {
		// A failed swap puts the previous copy back; staging never outlives the call.
		if (!fs.existsSync(target) && fs.existsSync(old)) fs.renameSync(old, target);
		fs.rmSync(tmp, { recursive: true, force: true });
		fs.rmSync(old, { recursive: true, force: true });
		release();
	}
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

/** Runs `hermes -p <profile> <args>` for `target`. */
export function runHermes(hermes: string, target: HermesTarget, args: string[], env: NodeJS.ProcessEnv = process.env): HermesRun {
	const cmd = hermesCommand(hermes, ["-p", target.profile, ...args]);
	const r = spawnSync(cmd.file, cmd.args, { encoding: "utf8", env: { ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, shell: cmd.shell, windowsHide: true });
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

export interface PluginUpdate {
	outcome: PluginInstallOutcome;
	/** Enabling a new or not yet enabled copy (with notifications allowed), when hermes ran. */
	enable?: HermesRun;
	/** The files changed while the plugin was enabled: disable → enable makes the running gateway reload it. */
	needsReload: boolean;
	/** That disable → enable, when hermes ran. */
	reload?: HermesRun;
	/** The reload's enable failed twice: the plugin is now disabled in that profile. */
	leftDisabled?: boolean;
	/** Files under dashboard/ are new or changed: the dashboard loads its page backend when it restarts. */
	dashboardChanged: boolean;
}

/**
 * The reload as `hermes -p <profile>` argument lists, for sync and async runners alike: disable, then
 * enable, retried once (even after a failed disable, which may still have disabled it). It never
 * leaves the plugin disabled silently: `leftDisabled` says the enable failed both times.
 */
export function* reloadSteps(): Generator<string[], { reload: HermesRun; leftDisabled: boolean }, HermesRun> {
	const off = yield ["plugins", "disable", PLUGIN_NAME];
	const outputs = [off.output];
	let on = yield ["plugins", "enable", PLUGIN_NAME];
	outputs.push(on.output);
	if (!on.ok) {
		on = yield ["plugins", "enable", PLUGIN_NAME];
		outputs.push(on.output);
	}
	return { reload: { ok: off.ok && on.ok, output: outputs.filter(Boolean).join("\n") }, leftDisabled: !on.ok };
}

/**
 * Installs or updates the plugin in a profile and gets Hermes to use the new files. A copy that was
 * enabled is disabled and enabled again, which makes the running gateway reload it (hooks and
 * commands at once, tools in new sessions; `enable` alone does nothing for an enabled plugin). Any
 * other copy is enabled, unless `enable` is false. Without `hermes` only the files change (callers that
 * must not block run the reload themselves when `needsReload`). `onlyIfNewer`: see installPlugin.
 */
export function updatePlugin(
	source: string,
	target: HermesTarget,
	hermes: string | undefined,
	opts: { force?: boolean; enable?: boolean; onlyIfNewer?: boolean } = {},
	env: NodeJS.ProcessEnv = process.env,
): PluginUpdate {
	const dir = pluginTarget(target.home);
	const before = pluginReport(source, target);
	const changed = before.state.installed ? (changedFiles(source, dir) ?? []) : [];
	const outcome = installPlugin(source, dir, { force: opts.force, onlyIfNewer: opts.onlyIfNewer });
	const dashboardChanged = outcome === "installed" || (outcome === "updated" && changed.some(f => f.split(path.sep)[0] === "dashboard"));
	const out: PluginUpdate = { outcome, needsReload: outcome === "updated" && before.status === "enabled", dashboardChanged };
	if (!hermes || outcome === "skipped" || outcome === "busy") return out;
	if (out.needsReload) {
		const steps = reloadSteps();
		let step = steps.next();
		while (!step.done) step = steps.next(runHermes(hermes, target, step.value, env));
		out.reload = step.value.reload;
		if (step.value.leftDisabled) out.leftDisabled = true;
	} else if (opts.enable !== false) out.enable = enablePlugin(hermes, target, env);
	return out;
}

/** Plain-text lines about one profile's update (CLI and VS Code). */
export function updateLines(label: string, u: PluginUpdate): string[] {
	if (u.outcome === "busy") return [`${label}: skipped, another window or omp-sessions is installing the plugin there right now`];
	const lines = [`${label}: ${u.outcome}${u.reload?.ok ? ", reloaded in the running gateway" : ""}`];
	if (u.leftDisabled) lines.push(`${label}: the plugin was left DISABLED in profile ${label} (enabling it again failed twice): run hermes -p ${label} plugins enable omp-sessions. ${u.reload?.output ?? ""}`.trim());
	else if (u.reload && !u.reload.ok) lines.push(`${label}: reloading it failed (hermes -p ${label} plugins disable/enable omp-sessions): ${u.reload.output}`);
	if (u.enable && !u.enable.ok) lines.push(u.enable.output);
	if (u.dashboardChanged) lines.push(`${label}: the dashboard's omp Sessions page backend changed; it loads when the dashboard restarts`);
	return lines;
}

export interface PluginReport {
	label: string;
	home: string;
	/** The plugin folder in that home. */
	target: string;
	state: PluginState;
	/** enabled, disabled or not enabled (from config.yaml, as `hermes plugins list` says); set when installed. */
	status?: string;
	/** The kanban lane is on there (only read where the plugin is enabled). */
	lane?: boolean;
	/** `allow_gateway_injection`: notifications may reach Hermes sessions (only read where the plugin is enabled). */
	injection?: boolean;
	/** The plugin's `omp_sessions` setting, when set. */
	ompSessions?: string;
	/** A managed copy that differs because it is newer than the bundle (another editor's newer omp-sessions wrote it). */
	ahead?: boolean;
}

/** What a profile's plugin folder and config.yaml say about the plugin (no hermes process runs). */
export function pluginReport(source: string | undefined, target: HermesTarget): PluginReport {
	const dir = pluginTarget(target.home);
	const state = pluginState(source, dir);
	const report: PluginReport = { label: target.label, home: target.home, target: dir, state };
	const text = state.installed ? readConfig(target.home) : undefined;
	if (!state.installed) return report;
	if (state.managed && !state.current && source && !bundleNewer(source, dir)) report.ahead = true;
	report.status = text === undefined ? "not enabled" : configPluginStatus(text);
	if (text === undefined) return report;
	const ompSessions = configValue(text, [...ENTRY, "settings", "omp_sessions"]);
	if (typeof ompSessions === "string" && ompSessions) report.ompSessions = ompSessions;
	if (report.status === "enabled") {
		report.lane = truthy(configValue(text, [...ENTRY, "settings", "lane", "enabled"]));
		report.injection = truthy(configValue(text, [...ENTRY, "allow_gateway_injection"]));
	}
	return report;
}

/**
 * Managed copies (the marker) an automatic refresh replaces: they differ from the bundle and the bundle
 * is newer (bundleNewer). A copy a newer extension wrote is left for that extension.
 */
export function staleCopies(source: string, targets: readonly HermesTarget[]): HermesTarget[] {
	return targets.filter(t => {
		const dir = pluginTarget(t.home);
		const s = pluginState(source, dir);
		return s.installed && s.managed && !s.current && bundleNewer(source, dir);
	});
}

function isExecutable(p: string): boolean {
	try {
		if (!fs.statSync(p).isFile()) return false;
		fs.accessSync(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The omp-sessions the plugin runs, by its own rule (ompsessions.py find_omp_sessions): the `omp_sessions`
 * setting, then PATH, then where *omp: Install omp-sessions Command* puts it (~/.local/bin/omp-sessions;
 * %LOCALAPPDATA%\omp-sessions\omp-sessions.cmd). `pathEnv` is the PATH of the process that runs the
 * plugin (the gateway); undefined skips the PATH lookup when it isn't known.
 */
export function findOmpSessions(
	setting: string | undefined,
	pathEnv: string | undefined,
	home = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
	platform = process.platform,
): { path: string; via: "setting" | "PATH" | "install" } | undefined {
	if (setting) {
		const p = setting.startsWith("~/") ? path.join(home, setting.slice(2)) : setting;
		if (p.endsWith(".js") ? fs.existsSync(p) : isExecutable(p)) return { path: p, via: "setting" };
	}
	const win = platform === "win32";
	const names = win ? [`${COMMAND}.exe`, `${COMMAND}.cmd`, `${COMMAND}.bat`] : [COMMAND];
	for (const dir of (pathEnv ?? "").split(win ? ";" : ":").filter(Boolean)) {
		for (const n of names) {
			const p = path.join(dir, n);
			if (isExecutable(p)) return { path: p, via: "PATH" };
		}
	}
	const installed = [path.join(home, ".local", "bin", COMMAND), ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, COMMAND, `${COMMAND}.cmd`)] : [])];
	const found = installed.find(isExecutable);
	return found ? { path: found, via: "install" } : undefined;
}

/**
 * PATH of the gateway running for a Hermes home (its `gateway.pid` record), from /proc on Linux;
 * undefined when no gateway runs there or its environment isn't readable.
 */
export function gatewayPath(hermesHomeDir: string): string | undefined {
	try {
		const rec: unknown = JSON.parse(fs.readFileSync(path.join(hermesHomeDir, "gateway.pid"), "utf8"));
		const pid = rec && typeof rec === "object" && "pid" in rec && typeof rec.pid === "number" ? rec.pid : undefined;
		if (!pid) return undefined;
		const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
		return environ.split("\0").find(v => v.startsWith("PATH="))?.slice(5);
	} catch {
		return undefined;
	}
}

/** `hermes dashboard`'s default address. */
export const DEFAULT_DASHBOARD_URL = "http://localhost:9119";

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err instanceof Error && "code" in err && err.code === "EPERM";
	}
}

/**
 * The address of a running Hermes dashboard, from Hermes's spawn ledger (`<root>/spawn-ledger.json`,
 * the machine-wide list of the backends it started: `{pid, purpose: "dashboard", host, port}`);
 * undefined when no live dashboard is recorded. A wildcard or loopback bind is reached at localhost.
 */
export function runningDashboardUrl(root: string, alive: (pid: number) => boolean = pidAlive): string | undefined {
	let entries: unknown;
	try {
		entries = JSON.parse(fs.readFileSync(path.join(root, "spawn-ledger.json"), "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
	if (!Array.isArray(entries)) return undefined;
	for (const e of entries) {
		const r = obj(e);
		if (!r || r.purpose !== "dashboard" || typeof r.pid !== "number" || typeof r.port !== "number" || !Number.isInteger(r.port) || r.port <= 0 || r.port > 65535 || !alive(r.pid)) continue;
		const host = typeof r.host === "string" ? r.host.trim().replace(/^\[|\]$/g, "") : "";
		const name = ["", "0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(host) ? "localhost" : host.includes(":") ? `[${host}]` : host;
		return `http://${name}:${r.port}`;
	}
	return undefined;
}

/** The kanban dispatcher heartbeat in `hermes omp status --json` (plugin 0.6.0+). */
export interface DispatcherBeat {
	/** Unix seconds of the last tick. */
	at: number;
	pid?: number;
	/** The profile whose plugin instance the dispatcher ticks. */
	profile: string;
	laneOn?: boolean;
	board?: string;
}

/** The parts of `hermes -p <profile> omp status --json` the Doctor uses. */
export interface LaneStatus {
	profile?: string;
	/** undefined: an older plugin that doesn't report it; null: no tick seen yet. */
	dispatcher?: DispatcherBeat | null;
	dispatcherNotes: string[];
	/** The last notification into a Hermes session; ok false: Hermes refused it. */
	lastNotification?: { at: number; ok: boolean; session?: string } | null;
	ompSessions?: string | null;
}

function obj(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : undefined;
}

/** Parses `hermes omp status --json` output (hermes may print warnings before the JSON). */
export function parseLaneStatus(text: string): LaneStatus | undefined {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let data: Record<string, unknown> | undefined;
	try {
		data = obj(JSON.parse(text.slice(start)));
	} catch {
		return undefined;
	}
	if (!data) return undefined;
	const out: LaneStatus = { dispatcherNotes: Array.isArray(data.dispatcher_notes) ? data.dispatcher_notes.filter((n): n is string => typeof n === "string") : [] };
	if (typeof data.profile === "string") out.profile = data.profile;
	if (typeof data.omp_sessions === "string" || data.omp_sessions === null) out.ompSessions = data.omp_sessions;
	if (data.dispatcher === null) out.dispatcher = null;
	const d = obj(data.dispatcher);
	if (d && typeof d.at === "number" && typeof d.profile === "string") {
		out.dispatcher = { at: d.at, profile: d.profile };
		if (typeof d.pid === "number") out.dispatcher.pid = d.pid;
		if (typeof d.lane_on === "boolean") out.dispatcher.laneOn = d.lane_on;
		if (typeof d.board === "string") out.dispatcher.board = d.board;
	}
	if (data.last_notification === null) out.lastNotification = null;
	const n = obj(data.last_notification);
	if (n && typeof n.at === "number" && typeof n.ok === "boolean") out.lastNotification = { at: n.at, ok: n.ok, ...(typeof n.session === "string" ? { session: n.session } : {}) };
	return out;
}

/** One plain-text line per report (CLI and VS Code). */
export function reportLine(r: PluginReport): string {
	if (!r.state.installed) return `${r.label}: not installed (${r.target})`;
	const freshness = r.state.current ? "current" : r.ahead ? "newer than this omp-sessions (left as is)" : r.state.managed ? "outdated, run install to update" : "not installed by omp-sessions";
	const lane = r.lane === undefined ? "" : ` · lane ${r.lane ? "on" : "off"}`;
	const injection = r.injection === false ? " · notifications not allowed (allow_gateway_injection)" : "";
	return `${r.label}: ${freshness}${r.status ? `, ${r.status}` : ""}${lane}${injection} (${r.target})`;
}

export const AFTER_INSTALL = [
	"Plugin tools (omp_session_start, …) appear in new Hermes sessions. A running gateway picks the plugin up when it is enabled; if `hermes plugins list` shows it enabled but the tools are missing, restart the gateway (hermes gateway restart).",
	"Kanban lane: turn it on in one profile, `hermes [-p <profile>] omp lane on` (cards assigned to omp run as omp sessions); `hermes omp status` shows it.",
];
