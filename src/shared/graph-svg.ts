// Draws a dependency graph (src/shared/graph-layout.ts layout) as SVG for the webviews that show one: the Task
// Graph, the Sessions Board's graph view and the Switchyard Overview. The callers decide what a node and an
// edge say; this is the geometry, the S-curves, the node box and the planner-state badge. DOM only; the
// styles are src/shared/graph.css.
import { GRAPH_METRICS, layoutGraph } from "./graph-layout";

const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: Array<Node | string>): SVGElementTagNameMap[K] {
	const e = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	e.append(...children);
	return e;
}

export interface DagNode {
	id: string;
	title: string;
	/** Second line (state, planner state). */
	sub: string;
	/** Classes of the node group: its stripe colour (`s-working`…) and flags (`blocked`, `selected`). */
	classes: string[];
	/** Hover text. */
	tooltip: string;
	/** Planner-state badge, right-aligned on the node's second line. */
	badge?: { text: string; tone: "wait" | "bad" | "ok" };
}

export interface DagEdge {
	from: string;
	to: string;
	/** `gedge` modifiers: `lane`, `pending`, `changed`, `conflict`, `merged`, `enforced`, `hl`… */
	classes: string[];
	/** Id of the arrow head marker (one of `DagSpec.markers`). */
	marker: string;
	tooltip?: string;
}

export interface DagSpec {
	nodes: DagNode[];
	edges: DagEdge[];
	/** Arrow head ids to define: `graph-arrow` plus one per edge state; the stylesheet colours them by class. */
	markers: readonly string[];
	label: string;
	/** Makes the nodes selectable (click, Enter, Space). */
	onSelect?: (id: string) => void;
}

/** Cubic S-curves between the points of a route: horizontal tangents at every point, straight runs through virtual slots. */
export function edgePath(points: ReadonlyArray<{ x: number; y: number }>): string {
	return points
		.map((q, i) => {
			if (i === 0) return `M${q.x} ${q.y}`;
			const p = points[i - 1];
			const dx = Math.max(30, Math.abs(q.x - p.x) / 2);
			return `C${p.x + dx} ${p.y} ${q.x - dx} ${q.y} ${q.x} ${q.y}`;
		})
		.join("");
}

/** Sizes of the badge box (from its text length: no measuring) and of a character of the clipped title. */
const BADGE_CHAR_W = 6;
const BADGE_PAD = 10;
const BADGE_H = 15;
const CHAR_W = 7;

function clip(s: string, maxChars: number): string {
	return s.length > maxChars ? `${s.slice(0, Math.max(1, maxChars - 1))}…` : s;
}

/** The graph as an SVG element. */
export function drawDag(spec: DagSpec): SVGSVGElement {
	const { nodeWidth: w, nodeHeight: h } = GRAPH_METRICS;
	const pad = 16;
	const layout = layoutGraph(
		spec.nodes.map(n => n.id),
		spec.edges,
	);
	const width = layout.width + 2 * pad;
	const height = layout.height + 2 * pad;
	const svg = svgEl("svg", { class: "graph-svg", width, height, viewBox: `${-pad} ${-pad} ${width} ${height}`, role: "group", "aria-label": spec.label });
	const defs = svgEl("defs", {});
	for (const id of spec.markers) defs.append(svgEl("marker", { id, class: id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" }, svgEl("path", { d: "M0 0L10 5L0 10z" })));
	svg.append(defs);

	const edgeInfo = new Map(spec.edges.map(e => [`${e.from}\n${e.to}`, e]));
	const edgeLayer = svgEl("g", { class: "graph-edges" });
	for (const r of layout.routes) {
		const info = edgeInfo.get(`${r.from}\n${r.to}`);
		const path = svgEl("path", { class: ["gedge", ...(info?.classes ?? [])].join(" "), d: edgePath(r.points), "marker-end": `url(#${info?.marker ?? "graph-arrow"})` });
		if (info?.tooltip) path.append(svgEl("title", {}, info.tooltip));
		path.dataset.from = r.from;
		path.dataset.to = r.to;
		edgeLayer.append(path);
	}

	const nodeLayer = svgEl("g", { class: "graph-nodes" });
	for (const n of spec.nodes) {
		const p = layout.positions.get(n.id);
		if (!p) continue;
		const badgeW = n.badge ? n.badge.text.length * BADGE_CHAR_W + BADGE_PAD : 0;
		const g = svgEl(
			"g",
			{ class: ["gnode", ...n.classes].join(" "), transform: `translate(${p.x} ${p.y})`, tabindex: 0, role: "button", "aria-label": `${n.title}, ${n.sub}${n.badge ? `, ${n.badge.text}` : ""}` },
			svgEl("title", {}, n.tooltip),
			svgEl("rect", { class: "gnode-box", width: w, height: h, rx: 6 }),
			svgEl("rect", { class: "gnode-stripe", width: 4, height: h - 12, x: 4, y: 6, rx: 2 }),
			svgEl("text", { class: "gnode-title", x: 14, y: 20 }, clip(n.title, Math.floor((w - 22) / CHAR_W))),
			svgEl("text", { class: "gnode-state", x: 14, y: 37 }, clip(n.sub, Math.floor((w - 22 - (badgeW ? badgeW + 4 : 0)) / CHAR_W))),
		);
		if (n.badge) {
			g.append(
				svgEl("rect", { class: `gnode-badge ${n.badge.tone}`, x: w - badgeW - 6, y: 25, width: badgeW, height: BADGE_H, rx: 7 }),
				svgEl("text", { class: `gnode-badge-text ${n.badge.tone}`, x: w - 6 - badgeW / 2, y: 25 + BADGE_H - 4, "text-anchor": "middle" }, n.badge.text),
			);
		}
		g.dataset.node = n.id;
		const select = spec.onSelect;
		if (select) {
			g.addEventListener("click", () => select(n.id));
			g.addEventListener("keydown", e => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					select(n.id);
				}
			});
		}
		nodeLayer.append(g);
	}
	svg.append(edgeLayer, nodeLayer);
	return svg;
}
