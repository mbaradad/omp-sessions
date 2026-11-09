// Read-only view of the old omp Sessions state dir (`$OMP_VSCODE_HOME` or `~/.omp/vscode`), for
// `switchyard migrate`. Every reader is tolerant: a missing or corrupt file reads as absent, never throws.
// Node-only.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeOrgData, type OrgData } from "../shared/organize";
import type { TaskQueue } from "../shared/protocol";
import { normalizeQueue } from "../shared/queue";
import { isRecord } from "../shared/transcript-files";

/** The old state dir: OMP_VSCODE_HOME, default ~/.omp/vscode. */
export function legacyHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.OMP_VSCODE_HOME ? path.resolve(env.OMP_VSCODE_HOME) : path.join(os.homedir(), ".omp", "vscode");
}

export interface LegacySession {
	id: string;
	cwd: string;
	title: string;
	/** The old host's last reported status (`starting|idle|working|waiting|stopped`). */
	status: string;
	/** The old host process is still alive. */
	hostAlive: boolean;
	createdAt: number;
	ompSessionId?: string;
	ompSessionFile?: string;
	/** Earlier transcripts of the session (fresh-context tasks, `/new`), oldest first. */
	ompSessionFiles: string[];
	model?: string;
	/** `ask|edits|plan|auto` (old names). */
	permissionMode?: string;
	/** `launch.json` `ompArgs`: extra omp flags the old host started omp with. */
	ompArgs: string[];
	queue?: TaskQueue;
	cost?: number;
}

export interface LegacyScheduler {
	maxConcurrent: number;
	paused?: boolean;
	stopWhenQueueDone?: boolean;
}

export interface LegacyLauncher {
	ompPath?: string;
	extraArgs?: string[];
	model?: string;
	service?: string;
	mode?: string;
}

export interface LegacyState {
	home: string;
	exists: boolean;
	sessions: LegacySession[];
	/** Session dirs without a readable meta.json. */
	unreadable: string[];
	organize?: OrgData;
	/** organize.json exists but does not parse. */
	organizeError?: string;
	scheduler?: LegacyScheduler;
	launcher?: LegacyLauncher;
	/** remote.json: whether phone access was on. */
	remoteEnabled?: boolean;
}

function readJson(file: string): { value?: unknown; error?: string; missing?: true } {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { missing: true };
	}
	try {
		return { value: JSON.parse(text) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

function processAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err instanceof Error && "code" in err && err.code === "EPERM";
	}
}

function readSession(dir: string, id: string): LegacySession | undefined {
	const meta = readJson(path.join(dir, "meta.json")).value;
	if (!isRecord(meta)) return undefined;
	const cwd = str(meta.cwd);
	if (!cwd) return undefined;
	const launch = readJson(path.join(dir, "launch.json")).value;
	const ompArgs = isRecord(launch) && Array.isArray(launch.ompArgs) ? launch.ompArgs.filter((a): a is string => typeof a === "string") : [];
	const queueFile = readJson(path.join(dir, "queue.json"));
	const session: LegacySession = {
		id,
		cwd,
		title: str(meta.title) ?? id,
		status: str(meta.status) ?? "stopped",
		hostAlive: processAlive(meta.pid),
		createdAt: typeof meta.createdAt === "number" ? meta.createdAt : 0,
		ompSessionFiles: Array.isArray(meta.ompSessionFiles) ? meta.ompSessionFiles.filter((f): f is string => typeof f === "string") : [],
		ompArgs,
	};
	const ompSessionId = str(meta.ompSessionId);
	if (ompSessionId) session.ompSessionId = ompSessionId;
	const ompSessionFile = str(meta.ompSessionFile);
	if (ompSessionFile) session.ompSessionFile = ompSessionFile;
	const model = str(meta.model);
	if (model) session.model = model;
	const permissionMode = str(meta.permissionMode);
	if (permissionMode) session.permissionMode = permissionMode;
	if (typeof meta.cost === "number" && Number.isFinite(meta.cost)) session.cost = meta.cost;
	if (queueFile.value !== undefined) {
		const queue = normalizeQueue(queueFile.value);
		if (queue.tasks.length) session.queue = queue;
	}
	return session;
}

/** Everything `migrate` reads from the old state dir. */
export function readLegacyState(home = legacyHome()): LegacyState {
	const state: LegacyState = { home, exists: fs.existsSync(home), sessions: [], unreadable: [] };
	if (!state.exists) return state;
	let ids: string[] = [];
	try {
		ids = fs
			.readdirSync(path.join(home, "sessions"), { withFileTypes: true })
			.filter(e => e.isDirectory())
			.map(e => e.name)
			.sort();
	} catch {
		/* no sessions dir */
	}
	for (const id of ids) {
		const session = readSession(path.join(home, "sessions", id), id);
		if (session) state.sessions.push(session);
		else state.unreadable.push(id);
	}
	state.sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

	const organize = readJson(path.join(home, "organize.json"));
	if (organize.error) state.organizeError = organize.error;
	else if (!organize.missing) state.organize = normalizeOrgData(organize.value);

	const scheduler = readJson(path.join(home, "scheduler.json")).value;
	if (isRecord(scheduler)) {
		const n = typeof scheduler.maxConcurrent === "number" && Number.isFinite(scheduler.maxConcurrent) ? Math.max(0, Math.trunc(scheduler.maxConcurrent)) : 0;
		state.scheduler = { maxConcurrent: n };
		if (scheduler.paused === true) state.scheduler.paused = true;
		if (typeof scheduler.stopWhenQueueDone === "boolean") state.scheduler.stopWhenQueueDone = scheduler.stopWhenQueueDone;
	}

	const launcher = readJson(path.join(home, "launcher.json")).value;
	if (isRecord(launcher)) {
		const out: LegacyLauncher = {};
		if (str(launcher.ompPath)) out.ompPath = String(launcher.ompPath).trim();
		if (Array.isArray(launcher.extraArgs)) out.extraArgs = launcher.extraArgs.filter((a): a is string => typeof a === "string");
		if (str(launcher.model)) out.model = String(launcher.model).trim();
		if (str(launcher.service)) out.service = String(launcher.service);
		if (str(launcher.mode)) out.mode = String(launcher.mode);
		state.launcher = out;
	}

	const remote = readJson(path.join(home, "remote.json")).value;
	if (isRecord(remote)) state.remoteEnabled = remote.enabled === true;
	return state;
}
