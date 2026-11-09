// `switchyard migrate`: brings what is worth keeping from an omp Sessions install (`~/.omp/vscode`) over
// to Switchyard (`~/.switchyard`) (MAPPING.md "Data migration plan", user decision Q2: no session is
// migrated).
// - Comes over: the organization structure (groups, board lanes, collapse state) into
//   `<switchyard home>/organize.json`; mode, model and service defaults into `config.json`; the scheduler's
//   concurrency (and budget) into the planner.
// - Stays behind: every old session, its queue and its per-session organization. The report lists each
//   session with its `omp --resume <id>` line and each unfinished queued task, so they can be continued
//   in omp or queued again with `switchyard new`.
// - The old extension may stay installed and running. `migrate` only reads its data: nothing under the old
//   dir or in omp's transcripts is written or deleted.
// - Dry run unless `apply`. Before its first write a run copies the old dir to `<home>/backups/`. Idempotent:
//   existing keys at the destination win, and `<home>/migration.json` records what a run applied.
import * as fs from "node:fs";
import * as path from "node:path";
import { switchyardHome } from "../ao/client";
import type { PlannerOpName, PlannerOps } from "../planner/types";
import { emptyOrgData, type OrgData } from "../shared/organize";
import { permissionModeOf } from "../shared/permissions";
import { isRecord } from "../shared/transcript-files";
import { type LegacyState, legacyHome, readLegacyState } from "./legacy";

export const LEDGER_FILE = "migration.json";

export interface Ledger {
	version: 1;
	/** The old state dir migrated from. */
	source: string;
	/** Copies of the old dir taken before a run's first write. */
	backups: string[];
	/** scheduler.json went to the planner's config. */
	schedulerImported?: boolean;
}

/** The part of PlannerClient the migration uses. */
export interface PlannerPort {
	request<K extends PlannerOpName>(op: K, args: PlannerOps[K]["args"]): Promise<PlannerOps[K]["result"]>;
}

export interface MigrateOptions {
	apply: boolean;
	legacyHome?: string;
	home?: string;
	/** The planner, for the scheduler settings; without it they wait for a later run. */
	planner?: PlannerPort;
	log?: (line: string) => void;
}

/** An old session that stays in omp Sessions. */
export interface LeftBehind {
	id: string;
	title: string;
	cwd: string;
	/** The line that continues it in omp's terminal UI; absent when it never got a transcript. */
	resume?: string;
	/** Queued tasks that had not finished, to queue again by hand. */
	unfinished: Array<{ title: string; status: string; hasNotes: boolean }>;
	/** The old queue file the unfinished tasks are read from. */
	queueFile?: string;
}

export interface MigrateReport {
	apply: boolean;
	source: string;
	home: string;
	backup?: string;
	/** Old sessions that stay behind. */
	sessions: LeftBehind[];
	organize?: { groups: number; lanes: number; written: boolean };
	config?: { set: Record<string, unknown>; written: boolean };
	scheduler?: { set: Record<string, unknown>; imported: boolean };
	/** Old state that does not come over, with the reason. */
	dropped: string[];
	ledger: string;
}

function readLedger(file: string, source: string): Ledger {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isRecord(raw) && raw.version === 1) return { version: 1, source, backups: Array.isArray(raw.backups) ? raw.backups.filter((b): b is string => typeof b === "string") : [], ...(raw.schedulerImported === true && { schedulerImported: true }) };
	} catch {
		/* none yet */
	}
	return { version: 1, source, backups: [] };
}

function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** The old sessions and what to do about each, in creation order. */
export function leftBehind(state: LegacyState): LeftBehind[] {
	return state.sessions.map(s => {
		const item: LeftBehind = {
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			unfinished: (s.queue?.tasks ?? []).filter(t => t.status !== "done" && t.status !== "skipped").map(t => ({ title: t.title, status: t.status, hasNotes: !!t.notes })),
		};
		if (s.ompSessionId) item.resume = `omp --resume ${s.ompSessionId}`;
		if (s.queue) item.queueFile = path.join(state.home, "sessions", s.id, "queue.json");
		return item;
	});
}

/**
 * Adds the old organization structure to `existing` (the parsed `~/.switchyard/organize.json`, kept as it
 * is, fields this version does not know included; only what is missing is added): groups by id, the board
 * lanes when there are none yet, and collapse state. Per-session entries are not carried over.
 */
export function mergeOrganize(existing: unknown, legacy: OrgData): { data: OrgData; groups: number; lanes: number } {
	const base: Record<string, unknown> = isRecord(existing) ? structuredClone(existing) : {};
	const data = {
		...emptyOrgData(),
		...base,
		groups: Array.isArray(base.groups) ? base.groups : [],
		lanes: Array.isArray(base.lanes) ? base.lanes : [],
		sessions: isRecord(base.sessions) ? base.sessions : {},
		collapsed: isRecord(base.collapsed) ? base.collapsed : {},
	} as OrgData;
	let groups = 0;
	let lanes = 0;
	const groupIds = new Set(data.groups.map(g => (isRecord(g) ? g.id : undefined)));
	for (const g of legacy.groups) {
		if (groupIds.has(g.id)) continue;
		data.groups.push({ ...g });
		groupIds.add(g.id);
		groups++;
	}
	if (!data.lanes.length && legacy.lanes.length) {
		data.lanes = legacy.lanes.map(l => ({ ...l }));
		lanes = data.lanes.length;
	}
	for (const [k, v] of Object.entries(legacy.collapsed)) if (!(k in data.collapsed)) data.collapsed[k] = v;
	return { data, groups, lanes };
}

/** Old state that has no Switchyard counterpart (or is not applied yet), as report lines. */
function droppedItems(state: LegacyState): string[] {
	const out: string[] = [];
	const has = (name: string) => fs.existsSync(path.join(state.home, name));
	if (state.remoteEnabled) out.push("remote.json: phone access was on; pair the phone again with AO's mobile app (Connect Phone)");
	else if (has("remote.json")) out.push("remote.json: old phone access settings (AO's mobile app pairs separately)");
	if (state.launcher?.ompPath) out.push(`launcher.json ompPath ${state.launcher.ompPath}: AO finds omp on PATH`);
	if (state.scheduler?.stopWhenQueueDone !== undefined) out.push("scheduler.json stopWhenQueueDone: AO hibernates idle sessions itself");
	for (const name of ["limits.json", "spend.json"]) if (has(name)) out.push(`${name}: usage holds and spend history of the old scheduler (the planner keeps its own)`);
	for (const name of ["runtime", "slots", "bridge", "server.log", "server.pid", "vscode-window.json"]) if (has(name)) out.push(`${name}: old server runtime state`);
	out.push("sessions/*/changes.jsonl, blobs/, attachments/: old per-session data; left in place");
	return out;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Copies the old state dir (sockets skipped) into `<home>/backups/omp-vscode-<stamp>`. The old extension
 * may still be running and writing there (temp files come and go), so a copy that trips over a vanished
 * file starts over, up to three times.
 */
export function backupLegacy(source: string, home: string, now = new Date()): string {
	const dest = path.join(home, "backups", `omp-vscode-${now.toISOString().replace(/[:.]/g, "-")}`);
	fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
	for (let attempt = 1; ; attempt++) {
		try {
			fs.cpSync(source, dest, {
				recursive: true,
				errorOnExist: true,
				force: false,
				filter: src => {
					try {
						return !fs.lstatSync(src).isSocket();
					} catch {
						return false;
					}
				},
			});
			return dest;
		} catch (err) {
			const vanished = err instanceof Error && "code" in err && err.code === "ENOENT";
			fs.rmSync(dest, { recursive: true, force: true });
			if (!vanished || attempt >= 3) throw err;
		}
	}
}

/** Plans and, with `apply`, performs the migration. */
export async function migrate(opts: MigrateOptions): Promise<MigrateReport> {
	const log = opts.log ?? (() => {});
	const source = opts.legacyHome ?? legacyHome();
	const home = opts.home ?? switchyardHome();
	const ledgerFile = path.join(home, LEDGER_FILE);
	const state = readLegacyState(source);
	const ledger = readLedger(ledgerFile, source);
	const report: MigrateReport = { apply: opts.apply, source, home, sessions: [], dropped: [], ledger: ledgerFile };
	if (!state.exists) {
		log(`Nothing to migrate: ${source} does not exist.`);
		return report;
	}
	log(`${opts.apply ? "Migrating" : "Dry run: would migrate"} ${source} → ${home}`);
	log("The old omp Sessions extension can stay installed and running: this only reads its data, and the two keep separate state.");

	// The first write of a run is preceded by a backup of the old dir.
	const beforeWrite = () => {
		if (report.backup) return;
		report.backup = backupLegacy(source, home);
		ledger.backups.push(report.backup);
		writeJsonAtomic(ledgerFile, ledger);
		log(`Backed up ${source} to ${report.backup}`);
	};

	if (state.organize) {
		const organizeFile = path.join(home, "organize.json");
		let existing: unknown;
		try {
			existing = JSON.parse(fs.readFileSync(organizeFile, "utf8"));
		} catch {
			existing = undefined;
		}
		const merged = mergeOrganize(existing, state.organize);
		const changed = JSON.stringify(merged.data) !== JSON.stringify(existing ?? emptyOrgData());
		report.organize = { groups: merged.groups, lanes: merged.lanes, written: opts.apply && changed };
		if (opts.apply && changed) {
			beforeWrite();
			writeJsonAtomic(organizeFile, merged.data);
		}
		const what = `${merged.groups} group(s), ${merged.lanes} board lane(s)`;
		log(`organize.json: ${what} ${opts.apply ? (changed ? "merged into" : "already in") : "would be merged into"} ${organizeFile}`);
	} else if (state.organizeError) {
		log(`organize.json: unreadable (${state.organizeError}); not migrated`);
	}

	const configFile = path.join(home, "config.json");
	const wanted: Record<string, string> = {};
	const mode = permissionModeOf(state.launcher?.mode);
	if (mode) wanted.mode = mode;
	if (state.launcher?.model) wanted.model = state.launcher.model;
	if (state.launcher?.service === "off") wanted.service = "off";
	const extraArgs = state.launcher?.extraArgs?.length ? state.launcher.extraArgs : undefined;
	if (Object.keys(wanted).length || extraArgs) {
		let existing: Record<string, unknown> = {};
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(configFile, "utf8"));
			if (isRecord(raw)) existing = raw;
		} catch {
			/* none yet */
		}
		const next: Record<string, unknown> = { ...existing };
		const set: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(wanted)) {
			if (k in existing) continue;
			next[k] = v;
			set[k] = v;
		}
		// `omp.extraArgs` is the nested key `{"omp": {"extraArgs": [...]}}` (G34: the omp shim reads it).
		const omp = isRecord(existing.omp) ? existing.omp : undefined;
		if (extraArgs && !(omp && "extraArgs" in omp) && !("omp.extraArgs" in existing)) {
			next.omp = { ...omp, extraArgs: [...extraArgs] };
			set["omp.extraArgs"] = [...extraArgs];
		}
		const written = opts.apply && Object.keys(set).length > 0;
		if (written) {
			beforeWrite();
			writeJsonAtomic(configFile, next);
		}
		report.config = { set, written };
		const text = Object.entries(set).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(" ") : String(v)}`).join(", ") || "nothing new";
		log(`launcher.json → ${configFile}: ${text}${opts.apply ? "" : " (dry run)"}`);
		if (extraArgs) log(`  omp.extraArgs is the nested key {"omp": {"extraArgs": [...]}} in ${configFile}; the omp shim applies it once installed (docs/SETUP.md#extra-omp-arguments)`);
	}

	if (state.scheduler) {
		const set: Record<string, unknown> = { maxConcurrent: state.scheduler.maxConcurrent, ...(state.scheduler.paused && { paused: true }), ...(state.scheduler.budget && { budget: state.scheduler.budget }) };
		const budget = state.scheduler.budget ? Object.entries(state.scheduler.budget).map(([w, usd]) => `${usd} USD/${w}`).join(", ") : "";
		const text = `max ${set.maxConcurrent || "unlimited"} at once${set.paused ? ", paused" : ""}${budget ? `, budget ${budget}` : ""}`;
		report.scheduler = { set, imported: !!ledger.schedulerImported };
		if (ledger.schedulerImported) log(`scheduler.json: ${text} already in the planner`);
		else if (!opts.apply) log(`scheduler.json: ${text} would go to the planner`);
		else if (opts.planner) {
			try {
				beforeWrite();
				await opts.planner.request("scheduler", { set });
				ledger.schedulerImported = true;
				writeJsonAtomic(ledgerFile, ledger);
				report.scheduler.imported = true;
				log(`scheduler.json: ${text} → planner`);
			} catch (err) {
				log(`scheduler.json: the planner refused it (${errorText(err)}); run migrate --apply again`);
			}
		} else log("scheduler.json waits for the planner: run migrate --apply again once it runs");
	}

	report.sessions = leftBehind(state);
	report.dropped = droppedItems(state);
	const unfinished = report.sessions.reduce((n, s) => n + s.unfinished.length, 0);
	log(`${report.sessions.length} old session(s) stay in omp Sessions (not migrated)${unfinished ? `, ${unfinished} unfinished queued task(s) among them` : ""}:`);
	for (const s of report.sessions) {
		log(`  ${s.id} "${s.title}" (${s.cwd}): ${s.resume ?? "no omp transcript"}`);
		for (const t of s.unfinished) log(`    unfinished (${t.status}): ${t.title}${t.hasNotes ? ` [notes in ${s.queueFile}]` : ""}; queue again with: switchyard new ${s.cwd} --task "…"`);
	}
	for (const d of report.dropped) log(`not migrated: ${d}`);
	if (!opts.apply) log("Dry run: nothing was written. Run again with --apply to migrate.");
	return report;
}
