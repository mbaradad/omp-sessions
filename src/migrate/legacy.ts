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
	createdAt: number;
	/** omp's session id: `omp --resume <id>` continues it. */
	ompSessionId?: string;
	queue?: TaskQueue;
}

export interface LegacyScheduler {
	maxConcurrent: number;
	paused?: boolean;
	stopWhenQueueDone?: boolean;
	/** Spend caps in USD per rolling window (the paused autoschedule branch, PARKED §4). */
	budget?: Partial<Record<"hour" | "day" | "week", number>>;
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

function readSession(dir: string, id: string): LegacySession | undefined {
	const meta = readJson(path.join(dir, "meta.json")).value;
	if (!isRecord(meta)) return undefined;
	const cwd = str(meta.cwd);
	if (!cwd) return undefined;
	const session: LegacySession = { id, cwd, title: str(meta.title) ?? id, createdAt: typeof meta.createdAt === "number" ? meta.createdAt : 0 };
	const ompSessionId = str(meta.ompSessionId);
	if (ompSessionId) session.ompSessionId = ompSessionId;
	const queueFile = readJson(path.join(dir, "queue.json"));
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
		if (isRecord(scheduler.budget)) {
			const budget: NonNullable<LegacyScheduler["budget"]> = {};
			for (const w of ["hour", "day", "week"] as const) {
				const cap = scheduler.budget[w];
				if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) budget[w] = cap;
			}
			if (Object.keys(budget).length) state.scheduler.budget = budget;
		}
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
