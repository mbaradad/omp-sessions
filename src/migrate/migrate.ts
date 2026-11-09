// `switchyard migrate`: brings an omp Sessions user's sessions and organization over to Switchyard on
// AO (MAPPING.md "Data migration plan").
// - Each old session with an omp transcript becomes an AO omp Chat session carrying its history
//   (transcript graft, see graft.ts) in the AO project of its folder (MAPPING D2), stopped afterwards.
// - organize.json is merged into `<switchyard home>/organize.json` with the old ids replaced by the AO
//   ids; pins become AO pins. launcher.json defaults go to `<switchyard home>/config.json`.
// - Dry run unless `apply`. Before its first write a run copies the old state dir into
//   `<switchyard home>/backups/`. Nothing under the old dir or in old transcripts is written or deleted.
// - Idempotent: `<switchyard home>/migration.json` records every step per old session (old id → AO id;
//   other clients remap ids with it), so a re-run skips what is done and resumes what was interrupted.
//   The spawn carries a fixed clientRequestId, so even a crash before the ledger write cannot duplicate it.
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type AoClient, type AoSchemas, type AoSpawnRequest, gitRoot, nativeSessionFile, switchyardHome, unwrap } from "../ao/client";
import { ompPaths, locateTranscript } from "../shared/omp-paths";
import { emptyOrgData, normalizeOrgData, type OrgData } from "../shared/organize";
import { type PermissionMode, permissionModeInArgs, permissionModeOf } from "../shared/permissions";
import { graftTranscript, isFreshTranscript, readTranscriptHeader, transcriptsForCwd } from "./graft";
import { type LegacySession, type LegacyState, legacyHome, readLegacyState } from "./legacy";

type AoApprovalMode = NonNullable<AoSpawnRequest["approvalMode"]>;

export const LEDGER_FILE = "migration.json";

export interface LedgerSession {
	aoSessionId: string;
	/** `spawned`: AO session made; `grafted`: its transcript holds the old history; `done`: history imported, organized. */
	state: "spawned" | "grafted" | "done";
	title: string;
	/** The old session's folder. */
	cwd: string;
	projectId?: string;
	/** The AO session's workspace (where omp now runs). */
	workspace?: string;
	sourceOmpSessionId?: string;
	sourceTranscript: string;
	/** omp's id for the AO session's transcript (AO's provider id). */
	ompSessionId?: string;
	transcript?: string;
	/** Messages AO showed after importing the history. */
	importedMessages?: number;
	spawnedAt: number;
	updatedAt: number;
}

export interface Ledger {
	version: 1;
	/** The old state dir migrated from. */
	source: string;
	backups: string[];
	/** Old omp Sessions id → its AO session. */
	sessions: Record<string, LedgerSession>;
}

export interface MigrateOptions {
	apply: boolean;
	/** Needed for `apply`; a dry run without one cannot tell existing AO projects from new ones. */
	client?: AoClient;
	legacyHome?: string;
	home?: string;
	/** omp's per-cwd transcript folders (default: omp's for this environment). */
	ompSessionsDir?: string;
	/** Only these old session ids. */
	only?: readonly string[];
	/** Model the adopted sessions continue with (appended to the copied transcript). */
	model?: string;
	log?: (line: string) => void;
	/** Tests: how long to wait for the spawned session's transcript. */
	transcriptTimeoutMs?: number;
}

export type SessionAction =
	| { kind: "adopt"; id: string; title: string; cwd: string; transcript: string; projectRoot?: string; projectId?: string; standaloneReason?: string; approvalMode: AoApprovalMode; resumeFrom?: LedgerSession["state"]; notes: string[] }
	| { kind: "skip"; id: string; title: string; reason: string }
	| { kind: "done"; id: string; title: string; aoSessionId: string };

export interface SessionOutcome {
	id: string;
	title: string;
	kind: SessionAction["kind"] | "failed";
	aoSessionId?: string;
	reason?: string;
	notes?: string[];
}

export interface MigrateReport {
	apply: boolean;
	source: string;
	home: string;
	backup?: string;
	sessions: SessionOutcome[];
	organize?: { groups: number; sessions: number; written: boolean };
	config?: { set: Record<string, string>; written: boolean };
	/** Old state that does not come over, with the reason. */
	dropped: string[];
	ledger: string;
}

const MODE_TO_AO: Record<PermissionMode, AoApprovalMode> = { ask: "default", edits: "accept-edits", plan: "default", auto: "auto" };
const SPAWN_REQUEST_PREFIX = "switchyard-migrate:";

function readLedger(file: string, source: string): Ledger {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Ledger;
		if (raw && raw.version === 1 && raw.sessions && typeof raw.sessions === "object") return { ...raw, backups: Array.isArray(raw.backups) ? raw.backups : [] };
	} catch {
		/* none yet */
	}
	return { version: 1, source, backups: [], sessions: {} };
}

function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** The transcript to adopt: the old session's current one (live or `omp gc` archived), else found by id. */
function sourceTranscript(session: LegacySession, sessionsDir: string): string | undefined {
	if (session.ompSessionFile) {
		const found = locateTranscript(session.ompSessionFile);
		if (found) return found;
	}
	if (!session.ompSessionId) return undefined;
	for (const dir of [sessionsDir, path.join(path.dirname(sessionsDir), "archive", "sessions")]) {
		let slugs: string[];
		try {
			slugs = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const slug of slugs) {
			for (const suffix of [".jsonl", ".jsonl.gz"]) {
				let names: string[];
				try {
					names = fs.readdirSync(path.join(dir, slug));
				} catch {
					break;
				}
				const name = names.find(n => n.endsWith(`_${session.ompSessionId}${suffix}`));
				if (name) return path.join(dir, slug, name);
			}
		}
	}
	return undefined;
}

function approvalModeOf(session: LegacySession): AoApprovalMode {
	const mode = permissionModeInArgs(session.ompArgs) ?? permissionModeOf(session.permissionMode) ?? "auto";
	return MODE_TO_AO[mode];
}

/** What a run would do for each old session, given the ledger and (when reachable) AO's projects. */
export function planSessions(state: LegacyState, ledger: Ledger, opts: { sessionsDir: string; projects?: ReadonlyArray<{ id: string; path: string }>; only?: readonly string[] }): SessionAction[] {
	const actions: SessionAction[] = [];
	for (const s of state.sessions) {
		if (opts.only && !opts.only.includes(s.id)) continue;
		const entry = ledger.sessions[s.id];
		if (entry?.state === "done") {
			actions.push({ kind: "done", id: s.id, title: s.title, aoSessionId: entry.aoSessionId });
			continue;
		}
		if (!entry && s.hostAlive && (s.status === "working" || s.status === "waiting" || s.status === "starting")) {
			actions.push({ kind: "skip", id: s.id, title: s.title, reason: `busy in omp Sessions (${s.status}); stop it there, then migrate again` });
			continue;
		}
		const transcript = entry?.sourceTranscript ?? sourceTranscript(s, opts.sessionsDir);
		if (!transcript) {
			actions.push({ kind: "skip", id: s.id, title: s.title, reason: "no omp transcript" });
			continue;
		}
		if (!entry && isFreshTranscript(transcript)) {
			actions.push({ kind: "skip", id: s.id, title: s.title, reason: "empty omp transcript (no conversation)" });
			continue;
		}
		const notes: string[] = [];
		if (s.hostAlive) notes.push("its old host is still running: changes made there after the migration stay in omp Sessions");
		if (s.ompSessionFiles.length) notes.push(`${s.ompSessionFiles.length} earlier transcript(s) stay in omp only (omp --resume)`);
		// The approval mode becomes AO's; the model comes back with the transcript (its last model switch).
		const carried = (a: string | undefined) => a === "--approval-mode" || a === "--model";
		const extra = s.ompArgs.filter((a, i, all) => !carried(a) && !carried(all[i - 1]) && !a.startsWith("--approval-mode=") && !a.startsWith("--model="));
		if (extra.length) notes.push(`omp flags not carried over: ${extra.join(" ")}`);
		const action: SessionAction = { kind: "adopt", id: s.id, title: s.title, cwd: s.cwd, transcript, approvalMode: approvalModeOf(s), notes };
		if (entry) {
			action.resumeFrom = entry.state;
			if (entry.projectId) action.projectId = entry.projectId;
		} else if (!fs.existsSync(s.cwd)) {
			action.standaloneReason = "folder no longer exists";
		} else {
			const root = gitRoot(s.cwd);
			if (!root) action.standaloneReason = "folder is not in a git repo";
			else {
				action.projectRoot = root;
				const project = opts.projects?.find(p => path.resolve(p.path) === root);
				if (project) action.projectId = project.id;
			}
		}
		actions.push(action);
	}
	return actions;
}

/**
 * Merges the old organization into `existing` (entries already there win). `idMap`: old id → AO id.
 * An adopted session's pin is not kept here: the adoption pinned it in AO.
 */
export function mergeOrganize(existing: OrgData | undefined, legacy: OrgData, idMap: Readonly<Record<string, string>>): { data: OrgData; groups: number; sessions: number } {
	const data = existing ? normalizeOrgData(existing) : emptyOrgData();
	let groups = 0;
	let sessions = 0;
	const groupIds = new Set(data.groups.map(g => g.id));
	for (const g of legacy.groups) {
		if (groupIds.has(g.id)) continue;
		data.groups.push({ ...g });
		groupIds.add(g.id);
		groups++;
	}
	if (!data.lanes.length && legacy.lanes.length) data.lanes = legacy.lanes.map(l => ({ ...l }));
	for (const [oldId, entry] of Object.entries(legacy.sessions)) {
		const id = idMap[oldId] ?? oldId;
		// An earlier run, before this session was adopted, kept its entry under the old id: it moves now.
		if (id !== oldId && data.sessions[oldId] && JSON.stringify(data.sessions[oldId]) === JSON.stringify(entry)) delete data.sessions[oldId];
		if (data.sessions[id]) continue;
		const { pinned: _pinned, ...rest } = entry;
		const kept = idMap[oldId] ? rest : entry;
		if (Object.keys(kept).length) {
			data.sessions[id] = { ...kept, ...(kept.tags && { tags: [...kept.tags] }) };
			sessions++;
		}
	}
	for (const [k, v] of Object.entries(legacy.collapsed)) if (!(k in data.collapsed)) data.collapsed[k] = v;
	return { data, groups, sessions };
}

/** Old state that has no Switchyard counterpart, as dry-run lines. */
function droppedItems(state: LegacyState): string[] {
	const out: string[] = [];
	const has = (name: string) => fs.existsSync(path.join(state.home, name));
	if (state.remoteEnabled) out.push("remote.json: phone access was on; pair the phone again with AO's mobile app (Connect Phone)");
	else if (has("remote.json")) out.push("remote.json: old phone access settings (AO's mobile app pairs separately)");
	if (state.launcher?.ompPath) out.push(`launcher.json ompPath ${state.launcher.ompPath}: AO finds omp on PATH`);
	if (state.launcher?.extraArgs?.length) out.push(`launcher.json extraArgs ${state.launcher.extraArgs.join(" ")}: AO launches omp itself`);
	if (state.scheduler?.stopWhenQueueDone !== undefined) out.push("scheduler.json stopWhenQueueDone: AO hibernates idle sessions itself");
	for (const name of ["runtime", "slots", "bridge", "server.log", "server.pid", "vscode-window.json"]) if (has(name)) out.push(`${name}: old server runtime state`);
	out.push("sessions/*/changes.jsonl, blobs/: old change snapshots (checkpoints start fresh); left in place");
	return out;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Copies the old state dir (sockets skipped) into `<home>/backups/omp-vscode-<stamp>`. */
export function backupLegacy(source: string, home: string, now = new Date()): string {
	const dest = path.join(home, "backups", `omp-vscode-${now.toISOString().replace(/[:.]/g, "-")}`);
	fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
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
}

interface AdoptContext {
	client: AoClient;
	ledger: Ledger;
	saveLedger: () => void;
	sessionsDir: string;
	home: string;
	model?: string;
	pinned: boolean;
	log: (line: string) => void;
	transcriptTimeoutMs: number;
}

async function activityState(client: AoClient, sessionId: string): Promise<string | undefined> {
	return (await client.getSession(sessionId)).activity?.state;
}

async function exitAgent(client: AoClient, sessionId: string): Promise<void> {
	if ((await activityState(client, sessionId)) === "exited") return;
	await unwrap(client.api.POST("/api/v1/sessions/{sessionId}/exit-agent", { params: { path: { sessionId } } }));
}

/** Runs (or resumes) the adoption of one old session; returns the AO session id. */
async function adopt(ctx: AdoptContext, action: Extract<SessionAction, { kind: "adopt" }>): Promise<string> {
	const { client, ledger } = ctx;
	let entry = ledger.sessions[action.id];
	if (!entry) {
		const project = action.projectRoot ? await client.projectForFolder(action.projectRoot) : undefined;
		const spawnedAt = Date.now();
		const res = await client.spawnSession({
			harness: "omp",
			mode: "chat",
			kind: "worker",
			displayName: action.title.slice(0, 100),
			approvalMode: action.approvalMode,
			clientRequestId: `${SPAWN_REQUEST_PREFIX}${action.id}`,
			...(project && { projectId: project.id }),
			...(ctx.model && { model: ctx.model }),
		});
		entry = { aoSessionId: res.session.id, state: "spawned", title: action.title, cwd: action.cwd, sourceTranscript: action.transcript, spawnedAt, updatedAt: Date.now() };
		if (project) entry.projectId = project.id;
		const sourceId = readTranscriptHeader(action.transcript)?.id;
		if (sourceId) entry.sourceOmpSessionId = sourceId;
		ledger.sessions[action.id] = entry;
		ctx.saveLedger();
		ctx.log(`  spawned ${entry.aoSessionId}${project ? ` in project ${project.id}` : " (standalone)"}`);
	}
	const aoId = entry.aoSessionId;
	if (entry.state === "spawned") {
		const ws = await unwrap<AoSchemas["DesktopWorkspaceLocationResponse"]>(client.api.GET("/api/v1/desktop/sessions/{sessionId}/workspace", { params: { path: { sessionId: aoId } } }));
		entry.workspace = ws.workspacePath;
		// AO's spawn ran omp's session/new in the workspace, which wrote a header-only transcript.
		const deadline = Date.now() + ctx.transcriptTimeoutMs;
		let candidates: string[] = [];
		for (;;) {
			candidates = transcriptsForCwd(ctx.sessionsDir, ws.workspacePath, entry.spawnedAt - 60_000).filter(f => {
				const header = readTranscriptHeader(f);
				return isFreshTranscript(f) || header?.parentSession === entry.sourceOmpSessionId;
			});
			if (candidates.length || Date.now() > deadline) break;
			await sleep(500);
		}
		if (candidates.length !== 1) throw new Error(`expected one new omp transcript for ${ws.workspacePath}, found ${candidates.length}`);
		await exitAgent(client, aoId);
		const result = graftTranscript({ source: entry.sourceTranscript, target: candidates[0], ...(ctx.model && { model: ctx.model }) });
		entry.state = "grafted";
		entry.ompSessionId = result.targetId;
		entry.transcript = candidates[0];
		entry.updatedAt = Date.now();
		ctx.saveLedger();
		ctx.log(`  copied ${result.entries} transcript entries into omp session ${result.targetId}`);
	}
	if (entry.state === "grafted") {
		if ((await activityState(client, aoId)) === "exited") {
			await unwrap(client.api.POST("/api/v1/sessions/{sessionId}/resume-agent", { params: { path: { sessionId: aoId } } }));
		}
		const conversation = await client.getConversation(aoId);
		entry.importedMessages = conversation.messages.length;
		if (!entry.importedMessages) throw new Error(`AO resumed ${aoId} but shows no history`);
		// Stopped like any idle session; the next message resumes it.
		await exitAgent(client, aoId);
		if (ctx.pinned) await unwrap(client.api.POST("/api/v1/sessions/{sessionId}/pin", { params: { path: { sessionId: aoId } } }));
		if (entry.ompSessionId && entry.transcript && entry.workspace) {
			writeJsonAtomic(nativeSessionFile(aoId, ctx.home), { aoSessionId: aoId, ompSessionId: entry.ompSessionId, sessionFile: entry.transcript, cwd: entry.workspace });
		}
		entry.state = "done";
		entry.updatedAt = Date.now();
		ctx.saveLedger();
		ctx.log(`  AO shows ${entry.importedMessages} messages of history; session stopped`);
	}
	return aoId;
}

/** Plans and, with `apply`, performs the migration. */
export async function migrate(opts: MigrateOptions): Promise<MigrateReport> {
	const log = opts.log ?? (() => {});
	const source = opts.legacyHome ?? legacyHome();
	const home = opts.home ?? switchyardHome();
	const sessionsDir = opts.ompSessionsDir ?? ompPaths().sessionsDir;
	const ledgerFile = path.join(home, LEDGER_FILE);
	const state = readLegacyState(source);
	const ledger = readLedger(ledgerFile, source);
	const report: MigrateReport = { apply: opts.apply, source, home, sessions: [], dropped: [], ledger: ledgerFile };
	if (!state.exists) {
		log(`Nothing to migrate: ${source} does not exist.`);
		return report;
	}
	if (opts.apply && !opts.client) throw new Error("migrate --apply needs a running AO daemon");
	const projects = opts.client ? await opts.client.listProjects() : undefined;
	const actions = planSessions(state, ledger, { sessionsDir, projects, only: opts.only });

	const organizeFile = path.join(home, "organize.json");
	const configFile = path.join(home, "config.json");
	const legacyConfig: Record<string, string> = {};
	if (state.launcher?.mode && permissionModeOf(state.launcher.mode)) legacyConfig.mode = String(permissionModeOf(state.launcher.mode));
	if (state.launcher?.model) legacyConfig.model = state.launcher.model;
	if (state.launcher?.service === "off") legacyConfig.service = "off";
	report.dropped = droppedItems(state);

	log(`${opts.apply ? "Migrating" : "Dry run: would migrate"} ${source} → AO + ${home}`);
	const pending = actions.filter(a => a.kind === "adopt");
	const writes = pending.length > 0 || !!state.organize || Object.keys(legacyConfig).length > 0;
	if (opts.apply && writes) {
		report.backup = backupLegacy(source, home);
		ledger.backups.push(report.backup);
		writeJsonAtomic(ledgerFile, ledger);
		log(`Backed up ${source} to ${report.backup}`);
	}

	const saveLedger = () => writeJsonAtomic(ledgerFile, ledger);
	for (const action of actions) {
		if (action.kind === "done") {
			log(`= ${action.id} "${action.title}": already migrated as ${action.aoSessionId}`);
			report.sessions.push({ id: action.id, title: action.title, kind: "done", aoSessionId: action.aoSessionId });
			continue;
		}
		if (action.kind === "skip") {
			log(`- ${action.id} "${action.title}": skipped, ${action.reason}`);
			report.sessions.push({ id: action.id, title: action.title, kind: "skip", reason: action.reason });
			continue;
		}
		const where = action.projectId
			? `project ${action.projectId}`
			: action.projectRoot
				? `new project for ${action.projectRoot}`
				: `standalone (${action.standaloneReason ?? "no project"})`;
		const resume = action.resumeFrom ? ` (resuming: ${action.resumeFrom})` : "";
		log(`+ ${action.id} "${action.title}": ${opts.apply ? "adopting" : "would adopt"} into ${where}, mode ${action.approvalMode}, transcript ${action.transcript}${resume}`);
		for (const note of action.notes) log(`    note: ${note}`);
		const outcome: SessionOutcome = { id: action.id, title: action.title, kind: "adopt", ...(action.notes.length && { notes: action.notes }) };
		if (opts.apply && opts.client) {
			try {
				outcome.aoSessionId = await adopt(
					{ client: opts.client, ledger, saveLedger, sessionsDir, home, model: opts.model, pinned: state.organize?.sessions[action.id]?.pinned === true, log, transcriptTimeoutMs: opts.transcriptTimeoutMs ?? 30_000 },
					action,
				);
			} catch (err) {
				outcome.kind = "failed";
				outcome.reason = errorText(err);
				const at = ledger.sessions[action.id];
				if (at) outcome.aoSessionId = at.aoSessionId;
				log(`  FAILED: ${outcome.reason}${/restore model/i.test(outcome.reason) ? " (its model is unavailable: rerun with --model <provider/id>)" : ""}`);
			}
		}
		report.sessions.push(outcome);
	}

	const idMap: Record<string, string> = {};
	for (const [oldId, e] of Object.entries(ledger.sessions)) if (e.state === "done") idMap[oldId] = e.aoSessionId;
	if (state.organize) {
		let existing: OrgData | undefined;
		try {
			existing = normalizeOrgData(JSON.parse(fs.readFileSync(organizeFile, "utf8")));
		} catch {
			existing = undefined;
		}
		const merged = mergeOrganize(existing, state.organize, idMap);
		const changed = JSON.stringify(merged.data) !== JSON.stringify(existing ?? emptyOrgData());
		report.organize = { groups: merged.groups, sessions: merged.sessions, written: opts.apply && changed };
		if (opts.apply && changed) writeJsonAtomic(organizeFile, merged.data);
		log(`organize.json: ${merged.groups} group(s), ${merged.sessions} session entr${merged.sessions === 1 ? "y" : "ies"} ${opts.apply ? (changed ? "merged into" : "already in") : "would be merged into"} ${organizeFile}`);
	} else if (state.organizeError) {
		log(`organize.json: unreadable (${state.organizeError}); not migrated`);
	}

	if (Object.keys(legacyConfig).length) {
		let existing: Record<string, unknown> = {};
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(configFile, "utf8"));
			if (raw && typeof raw === "object" && !Array.isArray(raw)) existing = raw as Record<string, unknown>;
		} catch {
			/* none yet */
		}
		const set: Record<string, string> = {};
		for (const [k, v] of Object.entries(legacyConfig)) if (!(k in existing)) set[k] = v;
		const written = opts.apply && Object.keys(set).length > 0;
		if (written) writeJsonAtomic(configFile, { ...existing, ...set });
		report.config = { set, written };
		const text = Object.entries(set).map(([k, v]) => `${k}=${v}`).join(", ") || "nothing new";
		log(`launcher.json → ${configFile}: ${text}${opts.apply ? "" : " (dry run)"}`);
	}
	for (const d of report.dropped) log(`not migrated: ${d}`);
	if (!opts.apply) log("Dry run: nothing was written. Run again with --apply to migrate.");
	return report;
}
