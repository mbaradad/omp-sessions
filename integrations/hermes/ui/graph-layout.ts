// The layered layout of a board's dependency graph (parent → child, left to right): pure, so the
// Graph view (graph.ts) only draws it. Layers are longest paths from the roots, rows are ordered by
// the barycenter of each card's neighbours to cut crossings, and cards without links go in a grid
// under the graph.
import type { GraphCard } from "./api";

export const NODE_W = 228;
export const NODE_H = 58;
export const GAP_X = 64;
export const GAP_Y = 14;
export const PAD = 12;
/** Space between the graph and the grid of unlinked cards. */
const LOOSE_GAP = 36;
const SWEEPS = 4;
/** Clearance between a routed edge and the cards it passes, and the step between parallel routed edges. */
const ROUTE_CLEAR = 4;
const ROUTE_STEP = 6;
/** How far a skipping edge's curve runs inside the gap before it turns along its row (a share of GAP_X). */
const ROUTE_TURN = 0.6;

export interface GraphNode {
	card: GraphCard;
	/** Column: 0 for roots, else one past the deepest parent; -1 for the grid of unlinked cards. */
	layer: number;
	x: number;
	y: number;
}

export interface GraphEdge {
	from: string;
	to: string;
	/** SVG path data, from the parent's right edge to the child's left edge. */
	d: string;
	/** For an edge that skips columns: the y of the straight run between the cards of the columns it passes (never through one). */
	routeY?: number;
}

export interface GraphLayout {
	nodes: GraphNode[];
	edges: GraphEdge[];
	width: number;
	height: number;
	/** Cards the layout left out (no link to another card on the board) while `showAll` is off. */
	hidden: number;
}

/** The parent → child links between the given cards (links to cards not among them are dropped). */
export function graphLinks(cards: readonly GraphCard[]): Array<{ from: string; to: string }> {
	const ids = new Set(cards.map(c => c.id));
	const seen = new Set<string>();
	const out: Array<{ from: string; to: string }> = [];
	const add = (from: string, to: string): void => {
		const key = `${from}\n${to}`;
		if (from === to || !ids.has(from) || !ids.has(to) || seen.has(key)) return;
		seen.add(key);
		out.push({ from, to });
	};
	for (const c of cards) {
		for (const p of c.parents) add(p, c.id);
		for (const ch of c.children) add(c.id, ch);
	}
	return out;
}

/** Lays out `cards` (in the backend's order: priority, then age); only linked cards unless `showAll`. */
export function layoutGraph(cards: readonly GraphCard[], showAll: boolean): GraphLayout {
	const links = graphLinks(cards);
	const parentsOf = new Map<string, string[]>();
	const childrenOf = new Map<string, string[]>();
	for (const { from, to } of links) {
		parentsOf.set(to, [...(parentsOf.get(to) ?? []), from]);
		childrenOf.set(from, [...(childrenOf.get(from) ?? []), to]);
	}
	const isLinked = (id: string): boolean => parentsOf.has(id) || childrenOf.has(id);
	const linked = cards.filter(c => isLinked(c.id));
	const loose = showAll ? cards.filter(c => !isLinked(c.id)) : [];

	// Longest path from the roots; a cycle (Hermes refuses them, but the table could hold one) is cut
	// where the walk meets a card it is still inside.
	const layerOf = new Map<string, number>();
	const visiting = new Set<string>();
	const layer = (id: string): number => {
		const known = layerOf.get(id);
		if (known !== undefined) return known;
		visiting.add(id);
		let l = 0;
		for (const p of parentsOf.get(id) ?? []) if (!visiting.has(p)) l = Math.max(l, layer(p) + 1);
		visiting.delete(id);
		layerOf.set(id, l);
		return l;
	};
	const layers: GraphCard[][] = [];
	for (const c of linked) (layers[layer(c.id)] ??= []).push(c);
	for (let i = 0; i < layers.length; i++) layers[i] ??= [];

	// Barycenter sweeps: down by parents' rows, up by children's rows.
	const rowOf = new Map<string, number>();
	const number = (): void => layers.forEach(cs => cs.forEach((c, i) => rowOf.set(c.id, i)));
	number();
	const reorder = (cs: GraphCard[], neighbours: Map<string, string[]>): GraphCard[] => {
		const key = new Map(
			cs.map((c, i) => {
				const rows = (neighbours.get(c.id) ?? []).map(n => rowOf.get(n)).filter((r): r is number => r !== undefined);
				return [c.id, rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : i] as const;
			}),
		);
		return cs.map((c, i) => ({ c, i })).sort((a, b) => (key.get(a.c.id) ?? 0) - (key.get(b.c.id) ?? 0) || a.i - b.i).map(x => x.c);
	};
	for (let s = 0; s < SWEEPS; s++) {
		for (let i = 1; i < layers.length; i++) {
			layers[i] = reorder(layers[i], parentsOf);
			number();
		}
		for (let i = layers.length - 2; i >= 0; i--) {
			layers[i] = reorder(layers[i], childrenOf);
			number();
		}
	}

	const nodes: GraphNode[] = [];
	const at = new Map<string, GraphNode>();
	const tallest = Math.max(0, ...layers.map(cs => cs.length));
	const cardsH = tallest ? tallest * (NODE_H + GAP_Y) - GAP_Y : 0;
	// Room above and below the cards for edges that skip a column and find no gap between the cards they pass.
	const skipping = links.filter(({ from, to }) => (layerOf.get(to) ?? 0) - (layerOf.get(from) ?? 0) > 1).length;
	const reserve = skipping ? Math.min(skipping, 6) * ROUTE_STEP + ROUTE_CLEAR * 2 : 0;
	const graphH = cardsH ? cardsH + reserve * 2 : 0;
	layers.forEach((cs, l) => {
		// Each column centred on the tallest one.
		const top = PAD + reserve + (cardsH - (cs.length * (NODE_H + GAP_Y) - GAP_Y)) / 2;
		cs.forEach((card, row) => {
			const node = { card, layer: l, x: PAD + l * (NODE_W + GAP_X), y: top + row * (NODE_H + GAP_Y) };
			nodes.push(node);
			at.set(card.id, node);
		});
	});
	const looseTop = PAD + (graphH ? graphH + LOOSE_GAP : 0);
	const cols = Math.max(layers.length, 4);
	loose.forEach((card, i) => nodes.push({ card, layer: -1, x: PAD + (i % cols) * (NODE_W + GAP_X), y: looseTop + Math.floor(i / cols) * (NODE_H + GAP_Y) }));

	const used: Array<{ y: number; from: number; to: number }> = [];
	const edges = links.map(({ from, to }): GraphEdge => {
		const a = at.get(from) as GraphNode;
		const b = at.get(to) as GraphNode;
		const x1 = a.x + NODE_W;
		const y1 = a.y + NODE_H / 2;
		const x2 = b.x;
		const y2 = b.y + NODE_H / 2;
		if (b.layer - a.layer > 1) {
			const y = routeRow(nodes.filter(n => n.layer > a.layer && n.layer < b.layer), (y1 + y2) / 2, PAD, PAD + graphH, x1, x2, used);
			used.push({ y, from: x1, to: x2 });
			const t1 = x1 + GAP_X * ROUTE_TURN;
			const t2 = x2 - GAP_X * ROUTE_TURN;
			const h = GAP_X * ROUTE_TURN * 0.5;
			return { from, to, routeY: y, d: `M${x1} ${y1} C${x1 + h} ${y1} ${t1 - h} ${y} ${t1} ${y} L${t2} ${y} C${t2 + h} ${y} ${x2 - h} ${y2} ${x2} ${y2}` };
		}
		const bend = Math.max(GAP_X / 2, Math.abs(x2 - x1) / 2);
		return { from, to, d: `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}` };
	});
	const columns = loose.length ? Math.max(layers.length, Math.min(cols, loose.length)) : layers.length;
	const looseRows = Math.ceil(loose.length / cols);
	return {
		nodes,
		edges,
		width: columns ? PAD * 2 + columns * (NODE_W + GAP_X) - GAP_X : 0,
		height: nodes.length ? (loose.length ? looseTop + looseRows * (NODE_H + GAP_Y) - GAP_Y : PAD + graphH) + PAD : 0,
		hidden: showAll ? 0 : cards.length - linked.length,
	};
}

/**
 * The y of a straight run across the columns an edge skips: a row between (or above or below) the cards of
 * those columns, nearest to `target`, away from the runs of the edges already routed over the same stretch.
 */
function routeRow(passed: readonly GraphNode[], target: number, lo: number, hi: number, x1: number, x2: number, used: ReadonlyArray<{ y: number; from: number; to: number }>): number {
	const blocked = passed.map(n => [n.y - ROUTE_CLEAR, n.y + NODE_H + ROUTE_CLEAR] as const);
	const free = (y: number): boolean => blocked.every(([top, bottom]) => y < top || y > bottom);
	let best = hi;
	let bestCost = Number.POSITIVE_INFINITY;
	for (let y = lo; y <= hi; y += 1) {
		if (!free(y)) continue;
		const crowd = used.filter(u => u.from < x2 && u.to > x1 && Math.abs(u.y - y) < ROUTE_STEP).length;
		const cost = Math.abs(y - target) + crowd * 1000;
		if (cost < bestCost) {
			bestCost = cost;
			best = y;
		}
	}
	return best;
}

/**
 * `text` cut to at most `maxWidth` rendered pixels (as `measure` reports them), ending in an ellipsis
 * when it was cut: by width, not by character count, so narrow and wide letters fill the card alike.
 */
export function clipToWidth(text: string, maxWidth: number, measure: (s: string) => number): string {
	if (measure(text) <= maxWidth) return text;
	const chars = Array.from(text);
	let fit = 0;
	let low = 0;
	let high = chars.length;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (measure(`${chars.slice(0, mid).join("").trimEnd()}…`) <= maxWidth) {
			fit = mid;
			low = mid + 1;
		} else high = mid - 1;
	}
	return `${chars.slice(0, fit).join("").trimEnd()}…`;
}

/** A time as the node shows it: the clock today, else the day with it ("Nov 10 09:30"). */
export function shortTime(ms: number, now: number = Date.now()): string {
	const d = new Date(ms);
	const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return d.toDateString() === new Date(now).toDateString() ? clock : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

/** What a card's planner state adds to the graph node: a short label (fitting the node) and the tooltip's full sentence; none for a card whose session runs or finished. */
export function planNote(card: GraphCard, titleOf: (id: string) => string, clock: (ms: number) => string = shortTime): { label: string; tone: string; detail: string } | null {
	const plan = card.plan;
	if (!plan?.state) return null;
	const names = (ids: string[]): string => ids.map(titleOf).join(", ");
	const until = plan.until !== undefined ? ` until ${clock(plan.until)}` : "";
	switch (plan.state) {
		case "blocked":
			return { label: plan.blockedBy.length ? `blocked · ${plan.blockedBy.length} to finish` : "blocked", tone: "blocked", detail: `Switchyard holds this card's task until ${plan.blockedBy.length ? names(plan.blockedBy) : "its dependencies"} finish${plan.blockedBy.length === 1 ? "es" : ""}${plan.reason ? ` (${plan.reason})` : ""}` };
		case "held":
			return { label: plan.reason ? `held · ${plan.reason.replace(/ until .*/, "")}` : "held", tone: "held", detail: `Held by Switchyard${plan.reason ? `: ${plan.reason}` : ""}${plan.reason?.includes(" until ") ? "" : until}` };
		case "scheduled":
			return { label: plan.until !== undefined ? `scheduled · ${clock(plan.until)}` : "scheduled", tone: "scheduled", detail: `Scheduled${until}` };
		case "paused":
			return { label: "paused", tone: "held", detail: "Paused in Switchyard (the task, its queue or the planner)" };
		case "waiting":
			return { label: "waiting for a slot", tone: "queued", detail: "Ready; waiting for a free concurrency slot or for its queue" };
		case "interrupted":
			return { label: "interrupted", tone: "interrupted", detail: "Cut short by a crash or restart: it needs a person to run it again" };
		default:
			return null;
	}
}
