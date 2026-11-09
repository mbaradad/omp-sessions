// The planner's plan as a graph for the task graph view: tasks are nodes; an edge is either a dependency
// (`Task.after`, solid) or the order a queue runs its tasks in (dashed). Only work that still matters is
// drawn: an edge needs at least one open end (not done/skipped), and a node needs an edge, so a finished
// chain disappears and a lone task with neither dependencies nor queue neighbours doesn't clutter it.
// Pure; the webview gets the result as JSON.
import type { EdgeSync, LaneView, PlanView, TaskView } from "../planner/types";
import type { GraphEdge } from "./graph-layout";
import { syncAttention, taskStateText } from "./plan-tree";

export interface PlanGraphNode {
	id: string;
	title: string;
	state: TaskView["state"];
	/** `taskStateText`: "⛓ waits for Build", "⏰ 14:30", "running"… */
	text: string;
	/** Queue title, or undefined for a separate task. */
	lane?: string;
	/** AO session it runs / ran in (the chat to open). */
	session?: string;
	/** Worst state of its incoming dependency edges when one needs attention (a parent's changes reaching this task's branch). */
	sync?: EdgeSync["state"];
	/** The task works in a git branch (the planner can `sync` it). */
	git?: true;
}

export interface PlanGraphEdge extends GraphEdge {
	kind: "after" | "lane";
	/** The edge still holds something back (the earlier task isn't finished). */
	pending: boolean;
	/** Dependency edges: how the parent's changes reached the child (`TaskView.sync`). */
	sync?: EdgeSync["state"];
}

export interface PlanGraph {
	nodes: PlanGraphNode[];
	edges: PlanGraphEdge[];
}

const finished = (t: TaskView): boolean => t.status === "done" || t.status === "skipped";

export function planGraph(plan: PlanView, laneTitle: (lane: LaneView) => string, now = new Date()): PlanGraph {
	const byId = new Map(plan.tasks.map(t => [t.id, t]));
	const edges: PlanGraphEdge[] = [];
	// An edge between two finished tasks is clutter, unless git tracks it (`sync` entry): the parent can still change and the
	// change reaches the finished child, which is exactly when its state (upstream-changed, conflict) and its actions matter.
	const keep = (from: TaskView, to: TaskView, tracked: boolean): boolean => tracked || !(finished(from) && finished(to));
	for (const t of plan.tasks) {
		for (const dep of new Set(t.after ?? [])) {
			const parent = byId.get(dep);
			if (parent && parent !== t && keep(parent, t, !!t.sync?.[dep])) edges.push({ from: dep, to: t.id, kind: "after", pending: !finished(parent), ...(t.sync?.[dep] ? { sync: t.sync[dep].state } : {}) });
		}
	}
	const dependsOn = new Set(edges.map(e => `${e.from}\n${e.to}`));
	for (const lane of plan.lanes) {
		const tasks = plan.tasks.filter(t => t.lane === lane.id);
		for (let i = 1; i < tasks.length; i++) {
			const [from, to] = [tasks[i - 1], tasks[i]];
			// A queue edge that a dependency already draws would only double the arrow.
			if (keep(from, to, false) && !dependsOn.has(`${from.id}\n${to.id}`)) edges.push({ from: from.id, to: to.id, kind: "lane", pending: !finished(from) });
		}
	}
	const lanes = new Map(plan.lanes.map(l => [l.id, l]));
	const titleOf = (id: string) => byId.get(id)?.title;
	const shown = new Set(edges.flatMap(e => [e.from, e.to]));
	const nodes = plan.tasks
		.filter(t => shown.has(t.id))
		.map((t): PlanGraphNode => {
			const lane = t.lane ? lanes.get(t.lane) : undefined;
			const node: PlanGraphNode = { id: t.id, title: t.title, state: t.state, text: taskStateText(t, titleOf, now) };
			if (lane) node.lane = laneTitle(lane);
			if (t.session) node.session = t.session;
			const sync = syncAttention(t);
			if (sync) node.sync = sync;
			if (t.git) node.git = true;
			return node;
		});
	return { nodes, edges };
}
