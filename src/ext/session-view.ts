// How the views see an AO session: the `SessionMeta` record the tree, board, status bar and notifications
// read (built from src/ao's AoSessionModel), and the permission-mode and launch-flag mappings. Pure (no
// vscode), so the CLI and tests can use it too.
import type { AoNativeSession, AoTurnSettings } from "../ao/client";
import type { AoAgentState, AoSessionModel } from "../ao/model";
import type { PlanView } from "../planner/types";
import type { PermissionMode } from "../shared/permissions";
import type { SessionMeta, SessionStatus } from "../shared/protocol";

/** AO launch settings for a permission mode. omp maps AO `default` to its own asking mode and `bypass-permissions` to yolo; plan is omp's `mode` config option. */
export function approvalModeFor(mode: PermissionMode): { approvalMode: NonNullable<AoTurnSettings["approvalMode"]>; plan: boolean } {
	switch (mode) {
		case "ask":
			return { approvalMode: "default", plan: false };
		case "edits":
			return { approvalMode: "accept-edits", plan: false };
		case "auto":
			return { approvalMode: "bypass-permissions", plan: false };
		case "plan":
			return { approvalMode: "default", plan: true };
	}
}

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
 * the Switchyard omp extension recorded, for the transcript). Host-only fields stay empty: AO runs the agent.
 */
export function metaOf(model: AoSessionModel, cwd: string, native?: AoNativeSession): SessionMeta {
	const state = model.state;
	const permissionMode = permissionModeOf(model.conversation?.settings);
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

/** Parses the omp flags `omp acp` can still honor out of old-style launch arguments; returns the others. */
export function launchFlags(args: readonly string[]): { model?: string; effort?: string; mode?: PermissionMode; ignored: string[] } {
	const out: { model?: string; effort?: string; mode?: PermissionMode; ignored: string[] } = { ignored: [] };
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
		} else out.ignored.push(a);
	}
	return out;
}


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
	// Dependencies are task ids in the planner; the views (cards, graph) show sessions: the AO session each task runs in or its lane continues.
	const laneOf = new Map(plan.lanes.map(l => [l.id, l]));
	const sessionOf = (taskId: string): string | undefined => {
		const t = plan.tasks.find(x => x.id === taskId);
		return t && (t.session ?? (t.lane !== undefined ? (laneOf.get(t.lane)?.session ?? t.lane) : undefined));
	};
	const sessionsOf = (taskIds: Iterable<string>) => [...new Set([...taskIds].flatMap(id => sessionOf(id) ?? []))].filter(s => s !== sessionId);
	const after = sessionsOf(tasks.flatMap(t => t.after ?? []));
	const blockedBy = sessionsOf(tasks.flatMap(t => t.blockedBy ?? []));
	const failed = tasks.filter(t => t.state === "failed").length;
	return {
		pending: total("pending"),
		running: total("running"),
		done: total("done"),
		total: total("total"),
		autoRun: lanes.some(l => l.autoRun),
		...(Number.isFinite(startAt) && { startAt }),
		...(interrupted && { interrupted }),
		...(failed && { failed }),
		...(after.length && { after }),
		...(blockedBy.length && { blockedBy }),
		...(waiting?.position !== undefined && { waiting: { position: waiting.position, since: waiting.createdAt } }),
	};
}
