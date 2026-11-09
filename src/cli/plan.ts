// The CLI's side of the planner (PLANNER-API.md): connecting to it (starting it, and installing it as a
// user service the first time, unless `config set service off`), each session lane's summary for
// `ls`/`show`/`wait` (MAPPING D3), and managing the planner service (`switchyard server …`).
import * as fs from "node:fs";
import * as path from "node:path";
import { PlannerClient, ensurePlanner, stopPlanner } from "../planner/client";
import { logPath, socketPath } from "../planner/paths";
import { SYSTEMD_UNIT, type ServiceKind, installService, serviceKind, serviceUnitPath, uninstallService } from "../planner/service";
import type { PlanView, PlannerOpName, PlannerOps, QueueOp as PlannerQueueOp, QueueView } from "../planner/types";
import type { Priority } from "../shared/organize";
import { readSwitchyardConfig } from "../shared/switchyard-config";

export type QueueOp = PlannerQueueOp;
export type PlannerQueue = QueueView;
export type { PlannerConfig, PlannerStatus } from "../planner/types";

/** `out/planner.js`, next to `out/cli.js` (resolved on use: `__dirname` exists only in the CommonJS bundle). */
function plannerScript(): string {
	const script = path.join(__dirname, "planner.js");
	if (!fs.existsSync(script)) throw new Error(`the planner is missing next to the CLI (${script}); reinstall switchyard`);
	return script;
}

export interface Planner {
	call<K extends PlannerOpName>(op: K, args: PlannerOps[K]["args"]): Promise<PlannerOps[K]["result"]>;
	close(): void;
}

function wrap(client: PlannerClient): Planner {
	return { call: (op, args) => client.request(op, args), close: () => client.close() };
}

/** The installed unit file of this machine's planner service, if any. */
function installedUnit(): { kind: ServiceKind; file: string } | undefined {
	const kind = serviceKind();
	if (!kind) return undefined;
	const file = serviceUnitPath(kind);
	return fs.existsSync(file) ? { kind, file } : undefined;
}

/**
 * The running planner; with `start`, started when none runs. The first start installs it as a user
 * service (it then survives logouts and reboots) unless `config set service off`, or when this CLI
 * runs on VS Code's own runtime, which VS Code updates replace.
 */
export async function connectPlanner(opts: { start: boolean }): Promise<Planner | undefined> {
	const running = await PlannerClient.connect();
	if (running) return wrap(running);
	if (!opts.start) return undefined;
	const script = plannerScript();
	const vscodeRuntime = !!process.env.ELECTRON_RUN_AS_NODE || !!process.versions.electron;
	if (!installedUnit() && readSwitchyardConfig().service !== "off" && !vscodeRuntime) {
		const r = installService(script);
		if (r) process.stderr.write(`switchyard: installed the planner as a ${r.kind} user service (${r.file})${r.ok ? "" : "; it couldn't be started"}. Opt out: switchyard server uninstall && switchyard config set service off\n`);
	}
	const client = await ensurePlanner(script);
	return client ? wrap(client) : undefined;
}

/** A session lane as `ls`, `show` and `wait` need it (MAPPING D3: the planner's state wins when nothing runs). */
export interface LaneSummary {
	pending: number;
	running: number;
	done: number;
	total: number;
	autoRun: boolean;
	startAt?: number;
	/** When a task was cut short by a crash or restart (epoch ms): it waits for a person. */
	interrupted?: number;
	/** The next task waits for its start time. */
	scheduled?: boolean;
	/** The next task is ready but waits (a slot, usage limits, dependencies); `position` is 1-based in start order, 0 when it isn't waiting for a slot. */
	waiting?: { position: number };
	priority?: Priority;
	/** Why the next task is held, e.g. `rate-limit anthropic until 14:05` (planner usage gating). */
	waitReason?: string;
	/** Earliest known end of the wait (epoch ms). */
	waitUntil?: number;
	/** Marked completed (epoch ms of the mark; the marker lives on the lane, PARKED §5). */
	completed?: number;
	/** The worst state of its incoming graph edges, and each edge (a task in a git project that waits for other tasks). */
	upstream?: { state: string; edges: GraphEdge[] };
}

const EDGE_RANK = ["conflict", "resolving", "upstream-changed", "pending", "merged", "in-sync"];

/** The state that needs the most attention among edges: conflict, resolving, upstream-changed, pending, merged, in-sync. */
export function worstEdgeState(edges: readonly { state: string }[]): string {
	return [...edges].sort((a, b) => (EDGE_RANK.indexOf(a.state) + 1 || 99) - (EDGE_RANK.indexOf(b.state) + 1 || 99))[0]?.state ?? "in-sync";
}

/** Every lane that continues an AO session, by session id. */
export function laneSummaries(plan: PlanView): Map<string, LaneSummary> {
	const out = new Map<string, LaneSummary>();
	for (const lane of plan.lanes) {
		const session = lane.session ?? lane.id;
		const tasks = plan.tasks.filter(t => t.lane === lane.id);
		const next = tasks.find(t => t.status === "pending" || t.status === "running");
		const summary: LaneSummary = { pending: lane.pending, running: lane.running, done: lane.done, total: lane.total, autoRun: lane.autoRun };
		if (lane.startAt !== undefined) summary.startAt = lane.startAt;
		if (lane.priority) summary.priority = lane.priority;
		const cut = tasks.find(t => t.state === "interrupted");
		if (cut) summary.interrupted = cut.interrupted ?? cut.startedAt ?? 0;
		if (next?.state === "scheduled") summary.scheduled = true;
		if (next && (next.state === "waiting" || next.state === "held" || next.state === "blocked")) summary.waiting = { position: next.position ?? 0 };
		// Why queued work waits when it isn't a slot or dependency (provider limit, usage window, budget, retry backoff).
		if (next?.state === "held" && next.waitReason) summary.waitReason = next.waitReason;
		if (next?.waitUntil !== undefined) summary.waitUntil = next.waitUntil;
		if (lane.completed) summary.completed = lane.completedAt ?? 0;
		out.set(session, summary);
	}
	// How far the parents' changes reached each session (graph propagation); a free task's session has no lane.
	const byChild = new Map<string, GraphEdge[]>();
	for (const e of graphEdges(plan)) if (e.childSession) byChild.set(e.childSession, [...(byChild.get(e.childSession) ?? []), e]);
	for (const [session, edges] of byChild) {
		const summary = out.get(session) ?? { pending: 0, running: 0, done: 0, total: 0, autoRun: false };
		summary.upstream = { state: worstEdgeState(edges), edges };
		out.set(session, summary);
	}
	return out;
}

export async function lanesOf(planner: Planner): Promise<Map<string, LaneSummary>> {
	return laneSummaries(await planner.call("plan", {}));
}

// ---------- graph propagation (GRAPH-PROPAGATION.md) ----------

/** One parent → child edge of the plan graph and how far the parent's changes reached the child. */
export interface GraphEdge {
	parent: string;
	parentSession?: string;
	child: string;
	childSession?: string;
	/** `in-sync`, `pending`, `merged`, `upstream-changed`, `resolving` or `conflict`. */
	state: string;
	/** Conflicted files. */
	files?: string[];
	/** The parent's head the child has, or the newer one waiting to be merged. */
	parentHead?: string;
	childHead?: string;
	/** Child branch head before and after the last merge (undo by hand with `git reset`). */
	before?: string;
	after?: string;
	at: number;
}

/** Every edge the planner has propagation state for (tasks in a git project); non-git tasks only receive results. */
export function graphEdges(plan: PlanView): GraphEdge[] {
	const byId = new Map(plan.tasks.map(t => [t.id, t]));
	const out: GraphEdge[] = [];
	for (const child of plan.tasks) {
		for (const [parentId, e] of Object.entries(child.sync ?? {})) {
			const parent = byId.get(parentId);
			out.push({
				parent: parentId,
				...(parent?.session && { parentSession: parent.session }),
				child: child.id,
				...(child.session && { childSession: child.session }),
				state: e.state,
				...(e.files?.length && { files: e.files }),
				...((e.pendingHead ?? e.head) && { parentHead: e.pendingHead ?? e.head }),
				...(child.git?.head && { childHead: child.git.head }),
				...(e.before && { before: e.before }),
				...(e.after && { after: e.after }),
				at: e.at,
			});
		}
	}
	return out;
}

/** Tasks a user's reference names: a task id (or unique prefix), or every task that runs in an AO session. */
export function tasksOfRef(plan: PlanView, ref: string): PlanView["tasks"] {
	const exact = plan.tasks.filter(t => t.id === ref);
	if (exact.length) return exact;
	const bySession = plan.tasks.filter(t => t.session === ref || t.lane === ref);
	if (bySession.length) return bySession;
	return plan.tasks.filter(t => t.id.startsWith(ref));
}

/** Edges that touch the tasks of `ref` (as parent or child). */
export function edgesOfRef(plan: PlanView, ref: string): GraphEdge[] {
	const ids = new Set(tasksOfRef(plan, ref).map(t => t.id));
	return graphEdges(plan).filter(e => ids.has(e.parent) || ids.has(e.child));
}

// ---------- the planner service ----------

export interface PlannerInfo {
	pid: number;
	version: string;
	startedAt: number;
}

export interface PlannerServiceState {
	kind: ServiceKind | null;
	installed: boolean;
	file?: string;
	autoInstall: boolean;
}

async function ping(): Promise<PlannerInfo | undefined> {
	const client = await PlannerClient.connect();
	if (!client) return undefined;
	try {
		const { pid, version, startedAt } = await client.request("ping", {}, 3000);
		return { pid, version, startedAt };
	} catch {
		return undefined;
	} finally {
		client.close();
	}
}

/** `switchyard server …`: the planner process and its user service. */
export function plannerService() {
	return {
		status: ping,
		async start(): Promise<PlannerInfo> {
			const p = await connectPlanner({ start: true });
			p?.close();
			const info = await ping();
			if (!info) throw new Error(`the planner did not start (see ${logPath()})`);
			return info;
		},
		stop: () => stopPlanner(),
		socket: (): string | undefined => socketPath(),
		logPath: (): string => logPath(),
		serviceState(): PlannerServiceState {
			const kind = serviceKind() ?? null;
			const unit = installedUnit();
			return { kind, installed: !!unit, ...(unit && { file: unit.file }), autoInstall: readSwitchyardConfig().service !== "off" };
		},
		async install(): Promise<{ ok: boolean; file: string; hint: string }> {
			const script = plannerScript();
			// A planner started by hand holds the socket: the service's own one must take over.
			await stopPlanner();
			const r = installService(script);
			if (!r) throw new Error("server install supports Linux (systemd) and macOS (launchd); on Windows the planner starts on demand");
			return { ok: r.ok, file: r.file, hint: r.kind === "systemd" ? `systemctl --user enable --now ${SYSTEMD_UNIT}` : "launchctl bootstrap" };
		},
		async uninstall(): Promise<string | undefined> {
			const unit = installedUnit();
			return unit && uninstallService() ? unit.file : undefined;
		},
	};
}
