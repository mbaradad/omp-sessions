// How the views see an AO session: the `SessionMeta` record the tree, board, status bar and notifications
// read (built from src/ao's AoSessionModel), and the permission-mode and launch-flag mappings. Pure (no
// vscode), so the CLI and tests can use it too.
import type { AoNativeSession, AoTurnSettings } from "../ao/client";
import type { AoAgentState, AoSessionModel } from "../ao/model";
import type { PlanOp, PlanView } from "../planner/types";
import type { Priority } from "../shared/organize";
import type { PermissionMode } from "../shared/permissions";
import type { SessionMeta, SessionStatus, SyncState } from "../shared/protocol";

/** The permission mode a conversation runs in; undefined when AO doesn't say. */
export function permissionModeOf(settings: AoTurnSettings | undefined): PermissionMode | undefined {
	if (settings?.planMode) return "plan";
	switch (settings?.approvalMode) {
		case "default":
			return "ask";
		case "accept-edits":
		case "auto":
			return "edits";
		case "bypass-permissions":
			return "auto";
	}
	return undefined;
}

/** The status the views show for an AO state; `queued`/`interrupted` show as idle with their detail on the queue or exit reason. */
export function statusOf(state: AoAgentState): SessionStatus {
	switch (state) {
		case "starting":
			return "starting";
		case "working":
			return "working";
		case "needs_input":
			return "waiting";
		case "stopped":
			return "stopped";
		default:
			return "idle";
	}
}

/** Last assistant text kept for tooltips and board cards. */
const LAST_TEXT_MAX = 600;

/**
 * The views' session record for an AO session model (`cwd`: its workspace folder; `native`: the omp session
 * the Switchyard omp extension recorded, for the transcript; `mode`: the session's mode file, which the omp
 * extension's gate reads: AO itself runs every session as bypass-permissions). Host-only fields stay empty.
 */
export function metaOf(model: AoSessionModel, cwd: string, native?: AoNativeSession, mode?: PermissionMode): SessionMeta {
	const state = model.state;
	const permissionMode = mode ?? permissionModeOf(model.conversation?.settings);
	const stoppedWithError = state === "stopped" && !!model.exitReason;
	const account = model.conversation?.account;
	const authProblem = account?.authenticationState === "required" ? account.reauthReason || account.lastAuthFailureReason || "the provider needs a login" : undefined;
	return {
		id: model.id,
		cwd,
		title: model.title,
		status: statusOf(state),
		pid: 0,
		socket: "",
		createdAt: model.createdAt,
		updatedAt: model.updatedAt,
		changedFiles: model.changedFiles.length,
		...(model.model && { model: model.model }),
		...(model.cost !== undefined && { cost: model.cost }),
		...(model.reply && { lastText: model.reply.length > LAST_TEXT_MAX ? `${model.reply.slice(0, LAST_TEXT_MAX)}…` : model.reply }),
		...(model.exitReason && { exitReason: model.exitReason }),
		...(stoppedWithError && { exitCode: 1 }),
		...(permissionMode && { permissionMode }),
		...(authProblem && { authProblem }),
		...(native?.ompSessionId && { ompSessionId: native.ompSessionId }),
		...(native?.sessionFile && { ompSessionFile: native.sessionFile }),
	};
}

/** Splits a flags line on whitespace (the omp shim reads a session's flags the same way, so no argument can contain a space). */
export function splitArgs(line: string): string[] {
	return line.split(/\s+/).filter(Boolean);
}

/**
 * Splits old-style launch arguments: model, thinking level and mode are session settings (the spawn helper
 * applies them); every other flag is an extra `omp acp` argument for the session (G34, the omp shim). A
 * `--approval-mode` value that is not a Switchyard mode goes to `ignored`: AO owns the approval level.
 */
export function launchFlags(args: readonly string[]): { model?: string; effort?: string; mode?: PermissionMode; rest: string[]; ignored: string[] } {
	const out: { model?: string; effort?: string; mode?: PermissionMode; rest: string[]; ignored: string[] } = { rest: [], ignored: [] };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
		const value = () => inline ?? args[++i];
		if (flag === "--model") out.model = value();
		else if (flag === "--thinking") out.effort = value();
		else if (flag === "--approval-mode") {
			const v = value();
			if (v === "ask" || v === "edits" || v === "plan" || v === "auto") out.mode = v;
			else out.ignored.push(`${flag} ${v}`);
		} else out.rest.push(a);
	}
	return out;
}

/** Worst first: what the user must look at before what merely happened (the board's `worstSync` orders the same). */
const SYNC_SEVERITY: Record<SyncState, number> = { conflict: 5, "upstream-changed": 4, resolving: 3, pending: 2, merged: 1, "in-sync": 0 };

/**
 * A session's task-queue summary (tree badges, the board's Queued column, hide-finished) from the planner's
 * plan: the lanes that continue this AO session (lane id = session id, or `lane.session`). Undefined when the
 * session has no lane.
 */
export function laneQueue(plan: PlanView | undefined, sessionId: string): SessionMeta["queue"] | undefined {
	const lanes = plan?.lanes.filter(l => l.id === sessionId || l.session === sessionId) ?? [];
	if (!plan || !lanes.length) return undefined;
	const ids = new Set(lanes.map(l => l.id));
	const tasks = plan.tasks.filter(t => t.lane !== undefined && ids.has(t.lane));
	const total = (key: "pending" | "running" | "done" | "total") => lanes.reduce((n, l) => n + l[key], 0);
	const startAt = Math.min(...lanes.flatMap(l => (l.startAt ? [l.startAt] : [])), ...tasks.flatMap(t => (t.state === "scheduled" && t.waitUntil ? [t.waitUntil] : [])));
	const interrupted = tasks.filter(t => t.state === "interrupted").length;
	const waiting = tasks.find(t => t.state === "waiting" && t.position !== undefined);
	const sessionOf = taskSessionOf(plan);
	const sessionsOf = (taskIds: Iterable<string>) => [...new Set([...taskIds].flatMap(id => sessionOf(id) ?? []))].filter(s => s !== sessionId);
	const after = sessionsOf(tasks.flatMap(t => t.after ?? []));
	const blockedBy = sessionsOf(tasks.flatMap(t => t.blockedBy ?? []));
	const failed = tasks.filter(t => t.state === "failed").length;
	const completed = lanes.every(l => l.completed === true);
	const completedAt = Math.max(...lanes.map(l => l.completedAt ?? 0));
	// Propagation (GRAPH-PROPAGATION.md): the worst state over every parent edge of the session's tasks, and the parent sessions in it.
	const edges = tasks.flatMap(t => Object.entries(t.sync ?? {}).map(([parent, edge]) => ({ parent, state: edge.state })));
	const syncState = edges.reduce<SyncState | undefined>((worst, e) => (worst === undefined || SYNC_SEVERITY[e.state] > SYNC_SEVERITY[worst] ? e.state : worst), undefined);
	const worstByParent = new Map<string, SyncState>();
	for (const e of edges) {
		const parent = sessionOf(e.parent);
		if (parent && parent !== sessionId && e.state !== "in-sync" && SYNC_SEVERITY[e.state] > SYNC_SEVERITY[worstByParent.get(parent) ?? "in-sync"]) worstByParent.set(parent, e.state);
	}
	const sync = syncState && syncState !== "in-sync" ? { state: syncState, parents: sessionsOf(edges.filter(e => e.state === syncState).map(e => e.parent)), edges: Object.fromEntries(worstByParent) } : undefined;
	return {
		pending: total("pending"),
		running: total("running"),
		done: total("done"),
		total: total("total"),
		autoRun: lanes.some(l => l.autoRun),
		...(Number.isFinite(startAt) && { startAt }),
		...(interrupted && { interrupted }),
		...(failed && { failed }),
		...(completed && { completed, completedAt }),
		...(sync && { sync }),
		...(after.length && { after }),
		...(blockedBy.length && { blockedBy }),
		...(waiting?.position !== undefined && { waiting: { position: waiting.position, since: waiting.createdAt } }),
	};
}

/** The session (or lane id, before the task has one) a task of the plan runs in. */
function taskSessionOf(plan: PlanView): (taskId: string) => string | undefined {
	const laneOf = new Map(plan.lanes.map(l => [l.id, l]));
	return taskId => {
		const t = plan.tasks.find(x => x.id === taskId);
		return t && (t.session ?? (t.lane !== undefined ? (laneOf.get(t.lane)?.session ?? t.lane) : undefined));
	};
}

/**
 * "Dependencies…": the plan edits that make a session's pending tasks wait for the given sessions (every task of
 * theirs, finished ones count as done). The tasks' other `after` entries (tasks of the same lane, anything that is
 * not another session) are kept. `undefined` when the session has no pending task to hold back; a cycle or an
 * unknown task is the planner's to refuse.
 */
export function dependencyOps(plan: PlanView | undefined, sessionId: string, dependsOn: readonly string[]): PlanOp[] | undefined {
	if (!plan) return undefined;
	const lanes = plan.lanes.filter(l => l.id === sessionId || l.session === sessionId);
	const own = new Set(lanes.map(l => l.id));
	const pending = plan.tasks.filter(t => (t.lane !== undefined && own.has(t.lane) || t.session === sessionId) && t.status === "pending");
	if (!pending.length) return undefined;
	const sessionOf = taskSessionOf(plan);
	const wanted = new Set(dependsOn);
	const theirs = plan.tasks.filter(t => t.status !== "skipped" && wanted.has(sessionOf(t.id) ?? "")).map(t => t.id);
	return pending.map(t => {
		const kept = (t.after ?? []).filter(id => sessionOf(id) === sessionId || sessionOf(id) === undefined);
		return { op: "after", id: t.id, ids: [...new Set([...kept, ...theirs])] };
	});
}

/**
 * `meta` with the planner's queue summary. A merge conflict that the child agent could not resolve
 * (`queue.sync.state === "conflict"`) counts as needs-input, like a question: status `waiting`, so the tree,
 * the status bar, the badge and the notification treat it as one. `base` is the status AO's state gives.
 */
export function withQueue(meta: SessionMeta, queue: SessionMeta["queue"], base: SessionStatus): SessionMeta {
	const { queue: _old, ...rest } = meta;
	const conflict = queue?.sync?.state === "conflict" && base !== "stopped";
	return { ...rest, status: conflict ? "waiting" : base, ...(queue && { queue }) };
}

/**
 * "Re-run with parent changes": the session's tasks whose parent changes were merged without re-running them
 * (`upstream-changed`) or could not be merged (`conflict`). The planner's `requeue` runs each again in its own
 * session, on top of its parents' current work.
 */
export function rerunTaskIds(plan: PlanView | undefined, sessionId: string): string[] {
	const lanes = plan?.lanes.filter(l => l.id === sessionId || l.session === sessionId) ?? [];
	const ids = new Set(lanes.map(l => l.id));
	return (plan?.tasks ?? []).filter(t => (t.lane !== undefined && ids.has(t.lane) || t.session === sessionId) && Object.values(t.sync ?? {}).some(e => e.state === "upstream-changed" || e.state === "conflict")).map(t => t.id);
}

/** Plan edits that mark sessions completed (or reopen them): `lane.complete` on the lane that continues each one; a session without a lane gets one first. */
export function completeOps(plan: PlanView | undefined, ids: readonly string[], completed: boolean): PlanOp[] {
	return ids.flatMap((id): PlanOp[] => {
		const lane = plan?.lanes.find(l => l.id === id || l.session === id);
		return [...(lane ? [] : [{ op: "lane.add" as const, id, session: id }]), { op: "lane.complete", id: lane?.id ?? id, completed }];
	});
}

/**
 * Plan edits that give sessions a scheduling priority: the lane that continues a session is updated (`normal`
 * clears it), a session without a lane gets one named after it (the planner treats a lane id equal to an AO
 * session id as that session's queue).
 */
export function priorityOps(plan: PlanView | undefined, ids: readonly string[], priority: Priority): PlanOp[] {
	const value = priority === "normal" ? null : priority;
	return ids.map(id => {
		const lane = plan?.lanes.find(l => l.id === id || l.session === id);
		return lane ? { op: "lane.update", id: lane.id, priority: value } : { op: "lane.add", id, session: id, ...(value && { priority: value }) };
	});
}
