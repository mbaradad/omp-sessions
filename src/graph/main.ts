// Webview of the Task Graph (src/ext/task-graph.ts): the plan's tasks as a left-to-right DAG. Solid arrows
// are dependencies, dashed arrows the order a queue runs its tasks in; a node's stripe shows its state.
// Click a node to select it and get its actions. The extension host sends the graph, this draws it.
import { GRAPH_METRICS, layoutGraph } from "../shared/graph-layout";
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
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: Array<Node | string>): SVGElementTagNameMap[K] {
	const e = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	e.append(...children);
	return e;
}

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

/** Edge colour per propagation state (`in-sync`/`merged` look like any other dependency). */
const SYNC_CLASS: Partial<Record<string, string>> = { pending: "sync-pending", "upstream-changed": "sync-changed", resolving: "sync-changed", conflict: "sync-conflict" };
const SYNC_TITLE: Partial<Record<string, string>> = {
	pending: "The parent changed; the change is merged into this task when its turn ends",
	"upstream-changed": "The parent changed after this task finished; re-run it to take the change into account",
	resolving: "The task's agent is resolving a merge conflict",
	conflict: "The merge conflicted: a person decides",
};

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

	const { nodeWidth: w, nodeHeight: h } = GRAPH_METRICS;
	const pad = 16;
	const layout = layoutGraph(
		graph.nodes.map(n => n.id),
		graph.edges,
	);
	const width = layout.width + 2 * pad;
	const height = layout.height + 2 * pad;
	const svg = svgEl("svg", { class: "graph-svg", width, height, viewBox: `${-pad} ${-pad} ${width} ${height}`, role: "group", "aria-label": "Task dependencies and queue order" });
	const defs = svgEl("defs", {});
	for (const id of ["graph-arrow", "graph-arrow-pending"]) defs.append(svgEl("marker", { id, class: id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" }, svgEl("path", { d: "M0 0L10 5L0 10z" })));
	svg.append(defs);

	// Edge look by kind and by whether they still hold something back.
	const edgeInfo = new Map(graph.edges.map(e => [`${e.from}\n${e.to}`, e]));
	const edgeLayer = svgEl("g", { class: "graph-edges" });
	for (const r of layout.routes) {
		// Horizontal tangents at every point: smooth S-curves between layers, straight runs through virtual slots.
		const d = r.points
			.map((q, i) => {
				if (i === 0) return `M${q.x} ${q.y}`;
				const p = r.points[i - 1];
				const dx = Math.max(30, Math.abs(q.x - p.x) / 2);
				return `C${p.x + dx} ${p.y} ${q.x - dx} ${q.y} ${q.x} ${q.y}`;
			})
			.join("");
		const info = edgeInfo.get(`${r.from}\n${r.to}`);
		const pending = info?.pending === true;
		const highlight = selected !== undefined && (r.from === selected || r.to === selected);
		const sync = info?.sync && SYNC_CLASS[info.sync];
		const cls = ["gedge", info?.kind === "lane" ? "lane" : "", pending ? "pending" : "", sync ?? "", highlight ? "hl" : ""].filter(Boolean).join(" ");
		edgeLayer.append(svgEl("path", { class: cls, d, "marker-end": `url(#${pending ? "graph-arrow-pending" : "graph-arrow"})` }, ...(info?.sync && SYNC_TITLE[info.sync] ? [svgEl("title", {}, SYNC_TITLE[info.sync])] : [])));
	}

	const nodeLayer = svgEl("g", { class: "graph-nodes" });
	const maxChars = Math.floor((w - 22) / 7);
	for (const n of graph.nodes) {
		const p = layout.positions.get(n.id);
		if (!p) continue;
		const clip = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);
		const label = [n.state, n.text !== n.state ? n.text : ""].filter(Boolean).join(" · ");
		const g = svgEl(
			"g",
			{ class: `gnode ${STATE_CLASS[n.state] ?? ""}${n.id === selected ? " selected" : ""}`, transform: `translate(${p.x} ${p.y})`, tabindex: 0, role: "button", "aria-label": `${n.title}, ${label}` },
			svgEl("title", {}, [n.title, n.lane ? `queue: ${n.lane}` : "separate task", label].join("\n")),
			svgEl("rect", { class: "gnode-box", width: w, height: h, rx: 6 }),
			svgEl("rect", { class: "gnode-stripe", width: 4, height: h - 12, x: 4, y: 6, rx: 2 }),
			svgEl("text", { class: "gnode-title", x: 14, y: 20 }, clip(n.title)),
			svgEl("text", { class: "gnode-state", x: 14, y: 37 }, clip(n.text)),
		);
		g.addEventListener("click", () => select(n.id === selected ? undefined : n.id));
		g.addEventListener("keydown", e => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				select(n.id === selected ? undefined : n.id);
			}
		});
		nodeLayer.append(g);
	}
	svg.append(edgeLayer, nodeLayer);

	const legend = el("div", "legend", el("span", "key solid", "dependency"), el("span", "key dashed", "queue order"), el("span", "key pending", "still waiting"), el("span", "key changed", "parent changed"), el("span", "key conflict", "conflict"));
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
