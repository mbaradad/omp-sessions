// The session-level dependency graph that the Sessions Board and the Switchyard Overview draw: which sessions
// show, how an arrow reads (propagation state, else whether the child still waits), and the planner-state
// badge of a session. The planner computes all of it (`SessionMeta.queue`); this only picks and words it.
// Pure: no DOM, vscode or node imports (it is bundled into the webviews).
import type { GraphEdge } from "./graph-layout";
import type { DagEdge, DagNode } from "./graph-svg";
import type { SyncState } from "./protocol";
import { formatStartTime, holdText } from "./task-text";

/** What `dependencyGraph` needs of a session. */
export interface GraphSession {
	id: string;
	createdAt: number;
	/** Sessions this one waits for (its task queue's `after`). */
	after?: string[];
}

/**
 * Sessions in the graph view: every session with dependencies plus every one it depends on, among `sessions`
 * (the filtered ones); edges only between shown sessions. Nodes oldest first.
 */
export function dependencyGraph<S extends GraphSession>(sessions: S[]): { nodes: S[]; edges: GraphEdge[] } {
	const shown = new Set(sessions.map(c => c.id));
	const keep = new Set<string>();
	for (const c of sessions) {
		if (!c.after?.length) continue;
		keep.add(c.id);
		for (const d of c.after) if (shown.has(d)) keep.add(d);
	}
	const nodes = sessions.filter(c => keep.has(c.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	const edges: GraphEdge[] = [];
	for (const c of nodes) for (const d of new Set(c.after ?? [])) if (d !== c.id && keep.has(d)) edges.push({ from: d, to: c.id });
	return { nodes, edges };
}

/** Badge for unfinished dependencies: `waits for <title>` (`+N` for more), tooltip lists all; undefined when none. */
export function waitsForLabel(card: { blockedBy?: string[] }, cards: Array<{ id: string; title: string }>): { text: string; tooltip: string } | undefined {
	const ids = card.blockedBy ?? [];
	if (!ids.length) return undefined;
	const names = ids.map(id => cards.find(c => c.id === id)?.title || id.slice(0, 8));
	return { text: `waits for ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}`, tooltip: `Waits for:\n${names.map(n => `• ${n}`).join("\n")}` };
}

export const EDGE_KINDS = ["pending", "changed", "conflict", "merged"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** How an arrow reads: the parent's changes in the child (propagation), else whether the child still waits for it. */
export function edgeKind(state: SyncState | undefined, blocked: boolean): EdgeKind | undefined {
	if (state === "conflict" || state === "resolving") return "conflict";
	if (state === "upstream-changed") return "changed";
	if (state === "pending") return "pending";
	if (state === "merged") return "merged";
	return blocked ? "pending" : undefined;
}

/** The planner's word for what a session's queue is doing (`SessionMeta.queue`), for the badge on cards and graph nodes. */
export interface PlannerQueueFacts {
	state?: string;
	waitReason?: string;
	waitUntil?: number;
	startAt?: number;
	pending?: number;
	waiting?: { position: number };
}

export interface PlannerBadge {
	/** "Scheduled 14:30", "Held", "Blocked", "Queued #2", "Paused", "Interrupted". */
	label: string;
	/** The same where room is tight (a graph node): the time alone for a scheduled start. */
	short: string;
	/** Longer: why, and until when. */
	title: string;
	tone: "wait" | "bad";
}

/** The badge of a queue that is not running: undefined while it runs, has nothing pending, or the planner says nothing. */
export function plannerBadge(q: PlannerQueueFacts | undefined, now = new Date()): PlannerBadge | undefined {
	if (!q?.state || q.state === "running") return undefined;
	if (q.state !== "interrupted" && !q.pending) return undefined;
	switch (q.state) {
		case "scheduled": {
			const at = q.waitUntil ?? q.startAt;
			const time = at ? formatStartTime(at, now) : undefined;
			return { label: time ? `Scheduled ${time}` : "Scheduled", short: time ?? "scheduled", title: at ? `Starts ${new Date(at).toLocaleString()}` : "Scheduled", tone: "wait" };
		}
		case "held":
			return { label: "Held", short: "held", title: holdText(q.waitReason, q.waitUntil, now), tone: "wait" };
		case "blocked":
			return { label: "Blocked", short: "blocked", title: q.waitReason ?? "Waits for another session", tone: "wait" };
		case "paused":
			return { label: "Paused", short: "paused", title: q.waitReason ?? "Paused", tone: "wait" };
		case "waiting": {
			const label = q.waiting ? `Queued #${q.waiting.position}` : "Waiting";
			return { label, short: label.toLowerCase(), title: q.waitReason ?? "Waiting for a free slot", tone: "wait" };
		}
		case "interrupted":
			return { label: "Interrupted", short: "interrupted", title: "A crash or restart cut a task short: it never re-runs unattended. Run or requeue it.", tone: "bad" };
		default:
			return undefined;
	}
}

/** What the session graph reads of a session (a board card or an overview session). */
export interface GraphCard extends GraphSession {
	title: string;
	project?: string;
	/** Board status key: working, waiting, queued, idle, completed, stopped. */
	state: string;
	blockedBy?: string[];
	sync?: { edges?: Record<string, SyncState> };
	queue?: PlannerQueueFacts & { failed?: number };
}

const STATE_TEXT: Record<string, string> = { working: "working", waiting: "needs input", queued: "queued", idle: "idle", completed: "completed", stopped: "stopped" };

const EDGE_TITLE: Record<EdgeKind, string> = {
	pending: "Holds the child back: the parent has not finished (or its change is not merged yet)",
	changed: "The parent changed after the child finished: re-run it with the parent's changes",
	conflict: "Merging the parent's changes conflicted",
	merged: "The parent's changes are merged into the child",
};

/** Arrow heads `sessionDag` uses (the stylesheet colours each by its class). */
export const SESSION_MARKERS: readonly string[] = ["graph-arrow", ...EDGE_KINDS.map(k => `graph-arrow-${k}`)];

/**
 * The nodes and edges of the session graph, ready for `drawDag`: stripe = session state, badge = the planner's
 * state, dashed arrow = the child still waits for (or has not merged) the parent, thick = a dependency the planner enforces.
 * `all` names the sessions that `blockedBy` mentions (also those filtered out of `sessions`).
 */
export function sessionDag(sessions: GraphCard[], all: Array<{ id: string; title: string }>, now = new Date()): { nodes: DagNode[]; edges: DagEdge[] } {
	const graph = dependencyGraph(sessions);
	const byId = new Map(graph.nodes.map(n => [n.id, n]));
	const nodes = graph.nodes.map((c): DagNode => {
		const waits = waitsForLabel(c, all);
		const failed = c.queue?.failed;
		const badge = plannerBadge(c.queue, now);
		return {
			id: c.id,
			title: c.title,
			sub: [STATE_TEXT[c.state] ?? c.state, waits?.text, failed ? `${failed} failed` : ""].filter(Boolean).join(" · "),
			classes: [`s-${c.state}`, ...(c.blockedBy?.length ? ["blocked"] : [])],
			tooltip: [c.title, [c.project, STATE_TEXT[c.state] ?? c.state].filter(Boolean).join(" · "), badge?.title, waits?.tooltip].filter(Boolean).join("\n"),
			...(badge && { badge: { text: badge.short, tone: badge.tone } }),
		};
	});
	const edges = graph.edges.map((e): DagEdge => {
		const to = byId.get(e.to);
		const kind = edgeKind(to?.sync?.edges?.[e.from], to?.blockedBy?.includes(e.from) === true);
		return { from: e.from, to: e.to, classes: ["enforced", ...(kind ? [kind] : [])], marker: kind ? `graph-arrow-${kind}` : "graph-arrow", ...(kind && { tooltip: EDGE_TITLE[kind] }) };
	});
	return { nodes, edges };
}
