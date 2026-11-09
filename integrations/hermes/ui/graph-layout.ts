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
	const graphH = tallest ? tallest * (NODE_H + GAP_Y) - GAP_Y : 0;
	layers.forEach((cs, l) => {
		// Each column centred on the tallest one.
		const top = PAD + (graphH - (cs.length * (NODE_H + GAP_Y) - GAP_Y)) / 2;
		cs.forEach((card, row) => {
			const node = { card, layer: l, x: PAD + l * (NODE_W + GAP_X), y: top + row * (NODE_H + GAP_Y) };
			nodes.push(node);
			at.set(card.id, node);
		});
	});
	const looseTop = PAD + (graphH ? graphH + LOOSE_GAP : 0);
	const cols = Math.max(layers.length, 4);
	loose.forEach((card, i) => nodes.push({ card, layer: -1, x: PAD + (i % cols) * (NODE_W + GAP_X), y: looseTop + Math.floor(i / cols) * (NODE_H + GAP_Y) }));

	const edges = links.map(({ from, to }) => {
		const a = at.get(from) as GraphNode;
		const b = at.get(to) as GraphNode;
		const x1 = a.x + NODE_W;
		const y1 = a.y + NODE_H / 2;
		const x2 = b.x;
		const y2 = b.y + NODE_H / 2;
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
