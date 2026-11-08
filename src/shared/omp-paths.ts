// Where omp keeps its agent folder and session transcripts, resolved the way omp itself does
// (`@oh-my-pi/pi-utils` dirs.ts plus the CLI's `--profile` / `--session-dir` handling):
// - profile: the `--profile` flag, else `OMP_PROFILE` (an empty value means the default
//   profile), else `PI_PROFILE`; "" and "default" are the default profile.
// - config root: `~/<PI_CONFIG_DIR || .omp>`, or `<root>/profiles/<profile>` for a named profile.
// - agent folder: `<config root>/agent`; `PI_CODING_AGENT_DIR` replaces it for the default
//   profile only (named profiles ignore it).
// - transcripts: `<data>/sessions/<cwd slug>/<stamp>_<id>.jsonl`, where `<data>` is the agent
//   folder, or on Linux/macOS (default agent folder only) `$XDG_DATA_HOME/omp[/profiles/<p>]`
//   when that folder exists (XDG drops the `agent/` level).
// - `--session-dir` / `PI_CODING_AGENT_SESSION_DIR`: new transcripts go flat into that folder.
// - `omp gc` archive: `<dirname(sessions)>/archive/sessions/<cwd slug>/<name>.jsonl.gz`, with the
//   transcript's artifact folder (subagent transcripts) moved next to it uncompressed. omp cannot
//   open a `.jsonl.gz`, so resuming one first restores it the way gc's own rollback does.
// Node-only.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const APP_NAME = "omp";
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;
export const TRANSCRIPT_SUFFIX = ".jsonl";
export const ARCHIVED_SUFFIX = ".jsonl.gz";

export interface OmpPathOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
	platform?: NodeJS.Platform;
	/** `--profile` flag value (wins over the environment). */
	profile?: string;
	/** `--session-dir` flag value (wins over `PI_CODING_AGENT_SESSION_DIR`). */
	sessionDir?: string;
}

export interface OmpPaths {
	/** Named profile; undefined for the default profile. */
	profile?: string;
	configRoot: string;
	/** Config folder (`config.yml`, `mcp.json`, `skills/`). */
	agentDir: string;
	/** Per-cwd transcript folders. */
	sessionsDir: string;
	/** Where `omp gc` moves cold transcripts (`*.jsonl.gz`). */
	archivedSessionsDir: string;
	/** `--session-dir` override: new transcripts are written flat into it. */
	sessionDir?: string;
}

/** A profile name as omp normalizes it; undefined for the default profile or an invalid name. */
function profileName(value: string | undefined): string | undefined {
	const name = value?.trim();
	if (!name || name === "default" || name === "." || name === ".." || name.endsWith(".")) return undefined;
	return PROFILE_NAME_RE.test(name) && !WINDOWS_RESERVED_RE.test(name) ? name : undefined;
}

function exists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

/** omp's folders for this environment (and optional `--profile` / `--session-dir` flags). */
export function ompPaths(opts: OmpPathOptions = {}): OmpPaths {
	const env = opts.env ?? process.env;
	const home = opts.home ?? os.homedir();
	const platform = opts.platform ?? process.platform;
	const profile = opts.profile !== undefined ? profileName(opts.profile) : profileName(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
	const baseRoot = path.join(home, env.PI_CONFIG_DIR || ".omp");
	const configRoot = profile ? path.join(baseRoot, "profiles", profile) : baseRoot;
	const defaultAgent = path.join(configRoot, "agent");
	// Default profile only; a value equal to the agent folder of a bypassed `PI_PROFILE` was set by
	// a parent omp's profile switch and doesn't count (omp's resolvePreProfileAgentDir).
	const legacyProfile = profileName(env.PI_PROFILE);
	let override = profile ? undefined : env.PI_CODING_AGENT_DIR || undefined;
	if (override && legacyProfile && override === path.join(baseRoot, "profiles", legacyProfile, "agent")) override = undefined;
	const agentDir = override ? path.resolve(override) : defaultAgent;
	let dataDir = agentDir;
	const xdg = env.XDG_DATA_HOME;
	if ((platform === "linux" || platform === "darwin") && agentDir === defaultAgent && xdg) {
		const appRoot = path.join(xdg, APP_NAME);
		const candidate = profile ? path.join(appRoot, "profiles", profile) : appRoot;
		if (exists(candidate)) dataDir = candidate;
	}
	const sessionsDir = path.join(dataDir, "sessions");
	const sessionDirValue = opts.sessionDir ?? (env.PI_CODING_AGENT_SESSION_DIR || undefined);
	return {
		profile,
		configRoot,
		agentDir,
		sessionsDir,
		archivedSessionsDir: path.join(path.dirname(sessionsDir), "archive", "sessions"),
		sessionDir: sessionDirValue ? path.resolve(sessionDirValue) : undefined,
	};
}

/** Value of `--name <v>` / `--name=<v>` in omp arguments (last one wins). */
function flagValue(args: readonly string[], name: string): string | undefined {
	let value: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") break;
		if (a === name && i + 1 < args.length) value = args[++i];
		else if (a.startsWith(`${name}=`)) value = a.slice(name.length + 1);
	}
	return value;
}

/** {@link ompPaths} for an omp started with `args` (e.g. the `omp.extraArgs` setting). */
export function ompPathsForArgs(args: readonly string[], opts: Omit<OmpPathOptions, "profile" | "sessionDir"> = {}): OmpPaths {
	return ompPaths({ ...opts, profile: flagValue(args, "--profile"), sessionDir: flagValue(args, "--session-dir") });
}

export interface TranscriptRoot {
	dir: string;
	/** Transcripts sit directly in `dir` (`--session-dir`) instead of per-cwd subfolders. */
	flat: boolean;
	/** `omp gc` archive: gzipped transcripts. */
	archived: boolean;
}

/** Every folder omp transcripts of `paths` can be in. */
export function transcriptRoots(paths: OmpPaths): TranscriptRoot[] {
	const roots: TranscriptRoot[] = [];
	if (paths.sessionDir && path.resolve(paths.sessionDir) !== path.resolve(paths.sessionsDir)) roots.push({ dir: paths.sessionDir, flat: true, archived: false });
	roots.push({ dir: paths.sessionsDir, flat: false, archived: false });
	roots.push({ dir: paths.archivedSessionsDir, flat: false, archived: true });
	return roots;
}

export function isArchivedTranscript(file: string): boolean {
	return file.endsWith(ARCHIVED_SUFFIX);
}

/** The folder holding a transcript's artifacts and subagent transcripts. */
export function transcriptArtifactsDir(file: string): string {
	if (file.endsWith(ARCHIVED_SUFFIX)) return file.slice(0, -ARCHIVED_SUFFIX.length);
	return file.endsWith(TRANSCRIPT_SUFFIX) ? file.slice(0, -TRANSCRIPT_SUFFIX.length) : file;
}

/** Where `omp gc` puts `<x>/sessions/<slug>/<name>.jsonl`: `<x>/archive/sessions/<slug>/<name>.jsonl.gz`. */
export function archivedTranscriptPath(file: string): string | undefined {
	if (!file.endsWith(TRANSCRIPT_SUFFIX)) return undefined;
	const slugDir = path.dirname(file);
	const sessionsDir = path.dirname(slugDir);
	if (path.basename(sessionsDir) !== "sessions") return undefined;
	return path.join(path.dirname(sessionsDir), "archive", "sessions", path.basename(slugDir), `${path.basename(file)}.gz`);
}

/** The original location of an archived transcript (inverse of {@link archivedTranscriptPath}). */
export function liveTranscriptPath(archived: string): string | undefined {
	if (!archived.endsWith(ARCHIVED_SUFFIX)) return undefined;
	const slugDir = path.dirname(archived);
	const sessionsDir = path.dirname(slugDir);
	const archiveDir = path.dirname(sessionsDir);
	if (path.basename(sessionsDir) !== "sessions" || path.basename(archiveDir) !== "archive") return undefined;
	return path.join(path.dirname(archiveDir), "sessions", path.basename(slugDir), path.basename(archived, ".gz"));
}

/** `file` if it exists, else its `omp gc` archive if that exists. */
export function locateTranscript(file: string): string | undefined {
	if (exists(file)) return file;
	const archived = archivedTranscriptPath(file);
	return archived && exists(archived) ? archived : undefined;
}

function moveSync(from: string, to: string): void {
	try {
		fs.renameSync(from, to);
	} catch (err) {
		if (!(err instanceof Error && "code" in err && err.code === "EXDEV")) throw err;
		fs.cpSync(from, to, { recursive: true });
		fs.rmSync(from, { recursive: true, force: true });
	}
}

/**
 * Moves an archived transcript back to where omp wrote it (gunzipped, artifact folder moved back),
 * like `omp gc`'s own rollback. Returns the restored `.jsonl` path; throws when it can't.
 */
export function restoreArchivedTranscript(archived: string): string {
	const live = liveTranscriptPath(archived);
	if (!live) throw new Error(`${archived} is not in an omp archive folder`);
	if (exists(live)) throw new Error(`${live} already exists`);
	const fromArtifacts = transcriptArtifactsDir(archived);
	const toArtifacts = transcriptArtifactsDir(live);
	if (exists(fromArtifacts) && exists(toArtifacts)) throw new Error(`${toArtifacts} already exists`);
	fs.mkdirSync(path.dirname(live), { recursive: true });
	const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(archived)));
		fs.renameSync(tmp, live);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
	fs.unlinkSync(archived);
	if (exists(fromArtifacts)) moveSync(fromArtifacts, toArtifacts);
	return live;
}

export type ResumeTarget =
	| { kind: "present"; file: string }
	/** The transcript had been archived by `omp gc` and was restored to `file`. */
	| { kind: "restored"; file: string; archive: string }
	| { kind: "missing"; file: string; reason: string };

/** Checks a transcript before `omp --resume`: present, restored from the gc archive, or gone. */
export function prepareResume(file: string): ResumeTarget {
	const found = locateTranscript(file);
	if (!found) return { kind: "missing", file, reason: "the file no longer exists and is not in omp's archive" };
	if (!isArchivedTranscript(found)) return { kind: "present", file: found };
	const live = liveTranscriptPath(found);
	if (live && exists(live)) return { kind: "present", file: live };
	try {
		return { kind: "restored", file: restoreArchivedTranscript(found), archive: found };
	} catch (err) {
		return { kind: "missing", file, reason: `restoring it from ${found} failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}
