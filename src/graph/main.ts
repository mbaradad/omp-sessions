// Webview of the Task Graph (src/ext/task-graph.ts): the plan's tasks as a left-to-right DAG. Thick arrows
// are dependencies the planner enforces, dotted arrows the order a queue runs its tasks in; a node's stripe
// shows its state and its badge the planner's word for a task that is not running. Click a node to select it
// and get its actions. The extension host sends the graph, this draws it (src/shared/graph-svg.ts).
import { type DagEdge, type DagNode, drawDag } from "../shared/graph-svg";
import type { PlanGraph } from "../shared/plan-graph";

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** Messages from the extension host. */
export type ToGraph = { type: "graph"; graph: PlanGraph } | { type: "unreachable"; reason: string };
/** Messages to the extension host. */
export type FromGraph = { type: "ready" } | { type: "action"; action: GraphAction; id: string };
export type GraphAction = "openChat" | "runNow" | "requeue" | "dependencies" | "schedule" | "rerun" | "sync";

const vscode = acquireVsCodeApi();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	e.className = cls;
	e.append(...children);
	return e;
}

/** Stripe/colour class per task state. */
const STATE_CLASS: Record<string, string> = {
	running: "s-running",
	done: "s-done",
	failed: "s-failed",
	interrupted: "s-failed",
	skipped: "s-skipped",
	blocked: "s-waiting",
	scheduled: "s-waiting",
	paused: "s-waiting",
	held: "s-waiting",
	waiting: "s-waiting",
};

/** The planner's word for a task that is not running, as a node badge. */
const STATE_BADGE: Partial<Record<string, { text: string; tone: "wait" | "bad" }>> = {
	blocked: { text: "blocked", tone: "wait" },
	scheduled: { text: "scheduled", tone: "wait" },
	paused: { text: "paused", tone: "wait" },
	held: { text: "held", tone: "wait" },
	waiting: { text: "queued", tone: "wait" },
	interrupted: { text: "interrupted", tone: "bad" },
	failed: { text: "failed", tone: "bad" },
};

/** Edge look per propagation state (`in-sync`/`merged` look like any other dependency). */
const SYNC_CLASS: Partial<Record<string, string>> = { pending: "syncing", "upstream-changed": "changed", resolving: "changed", conflict: "conflict" };
const SYNC_TITLE: Partial<Record<string, string>> = {
	pending: "The parent changed; the change is merged into this task when its turn ends",
	"upstream-changed": "The parent changed after this task finished; re-run it to take the change into account",
	resolving: "The task's agent is resolving a merge conflict",
	conflict: "The merge conflicted: a person decides",
};

const MARKERS = ["graph-arrow", "graph-arrow-pending", "graph-arrow-syncing", "graph-arrow-changed", "graph-arrow-conflict"];
const SYNC_MARKER: Partial<Record<string, string>> = { syncing: "graph-arrow-syncing", changed: "graph-arrow-changed", conflict: "graph-arrow-conflict" };

const root = el("div", "app");
document.body.append(root);
let graph: PlanGraph | undefined;
let unreachable: string | undefined;
let selected = (vscode.getState() as { selected?: string } | undefined)?.selected;

function select(id: string | undefined): void {
	selected = id;
	vscode.setState({ selected });
	render();
}

function actionsFor(node: PlanGraph["nodes"][number]): Array<{ action: GraphAction; label: string }> {
	const open = node.state !== "done" && node.state !== "skipped";
	return [
		...(node.session ? [{ action: "openChat" as const, label: "Open chat" }] : []),
		...(node.state === "running" ? [] : [{ action: "runNow" as const, label: open ? "Run now" : "Run again" }]),
		...(node.state === "failed" || node.state === "interrupted" || !open ? [{ action: "requeue" as const, label: "Requeue" }] : []),
		{ action: "dependencies", label: "Dependencies…" },
		...(open ? [{ action: "schedule" as const, label: "Schedule…" }] : []),
		// The parent's changes reached a task that had already finished: run it once more with just that note.
		...(node.sync === "upstream-changed" || node.sync === "conflict" ? [{ action: "rerun" as const, label: "Re-run with parent changes" }] : []),
		...(node.git ? [{ action: "sync" as const, label: "Sync branch" }] : []),
	];
}

function render(): void {
	root.replaceChildren();
	if (unreachable) {
		root.append(el("div", "notice", `The planner is not reachable (${unreachable}). Retrying…`));
		return;
	}
	if (!graph) {
		root.append(el("div", "notice", "Loading the plan…"));
		return;
	}
	if (!graph.nodes.length) {
		root.append(el("div", "notice", "No dependencies or queued sequences to draw yet. Add tasks to a queue, or right-click a task → Set Dependencies…"));
		return;
	}
	if (selected && !graph.nodes.some(n => n.id === selected)) selected = undefined;

	const nodes = graph.nodes.map((n): DagNode => {
		const label = [n.state, n.text !== n.state ? n.text : ""].filter(Boolean).join(" · ");
		const badge = STATE_BADGE[n.state];
		return {
			id: n.id,
			title: n.title,
			sub: n.text.replace(/^[^\p{L}\p{N}]+/u, ""),
			classes: [STATE_CLASS[n.state] ?? "", ...(n.id === selected ? ["selected"] : [])].filter(Boolean),
			tooltip: [n.title, n.lane ? `queue: ${n.lane}` : "separate task", label].join("\n"),
			...(badge && { badge }),
		};
	});
	const edges = graph.edges.map((e): DagEdge => {
		const sync = e.sync ? SYNC_CLASS[e.sync] : undefined;
		const highlight = selected !== undefined && (e.from === selected || e.to === selected);
		const classes = [e.kind === "lane" ? "lane" : "enforced", e.pending ? "pending" : "", highlight ? "hl" : "", sync ?? ""].filter(Boolean);
		const syncTitle = e.sync ? SYNC_TITLE[e.sync] : undefined;
		return { from: e.from, to: e.to, classes, marker: (sync && SYNC_MARKER[sync]) || (e.pending ? "graph-arrow-pending" : "graph-arrow"), ...(syncTitle && { tooltip: syncTitle }) };
	});
	const svg = drawDag({ nodes, edges, markers: MARKERS, label: "Task dependencies and queue order", onSelect: id => select(id === selected ? undefined : id) });

	const legend = el("div", "legend graph-legend", el("span", "key enforced", "dependency"), el("span", "key lane", "queue order"), el("span", "key pending", "still waiting"), el("span", "key changed", "parent changed"), el("span", "key conflict", "conflict"));
	root.append(legend, el("div", "graph", svg));

	const node = graph.nodes.find(n => n.id === selected);
	if (node) {
		const bar = el("div", "actions", el("span", "actions-title", node.title));
		for (const a of actionsFor(node)) {
			const b = el("button", "action", a.label);
			b.addEventListener("click", () => vscode.postMessage({ type: "action", action: a.action, id: node.id } satisfies FromGraph));
			bar.append(b);
		}
		root.append(bar);
	}
}

window.addEventListener("message", e => {
	const msg = e.data as ToGraph;
	if (msg.type === "graph") {
		graph = msg.graph;
		unreachable = undefined;
	} else if (msg.type === "unreachable") unreachable = msg.reason;
	render();
});
render();
vscode.postMessage({ type: "ready" } satisfies FromGraph);
