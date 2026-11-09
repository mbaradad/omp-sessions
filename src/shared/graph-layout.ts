// Layered left-to-right layout of a dependency graph, for the task graph view (src/graph). Ported as it
// was from the parked `omp/deps` branch (`src/kanban/graph.ts`), minus its board-card helpers.
// Pure: no DOM, vscode or node imports; it is bundled into the webview.

export interface GraphEdge {
	/** The dependency (must finish first). */
	from: string;
	/** The dependent session (waits for `from`). */
	to: string;
}

export interface GraphPos {
	/** Top-left corner of the node box. */
	x: number;
	y: number;
	layer: number;
	/** Index inside its layer. */
	order: number;
}

export interface GraphLayout {
	/** Node ids per layer (left to right), each in display order (top to bottom). */
	layers: string[][];
	/** Real nodes only. */
	positions: Map<string, GraphPos>;
	/** One polyline per drawn edge, from the dependency's right side to the dependent's left side. */
	routes: GraphRoute[];
	/** Edges that were dropped to break cycles (routed straight, right to left). */
	reversed: GraphEdge[];
	width: number;
	height: number;
}

export interface GraphRoute extends GraphEdge {
	points: Array<{ x: number; y: number }>;
}

export interface GraphMetrics {
	nodeWidth: number;
	nodeHeight: number;
	gapX: number;
	gapY: number;
}

export const GRAPH_METRICS: GraphMetrics = { nodeWidth: 200, nodeHeight: 48, gapX: 70, gapY: 18 };

/**
 * Layered left-to-right layout: dependencies left of their dependents. Layer = longest path from a root;
 * a few barycenter sweeps reduce crossings. Cycles are broken deterministically (DFS in `nodes` order drops
 * back edges), so it always terminates and places every node. Self-loops, duplicates and edges to unknown
 * nodes are ignored.
 */
export function layoutGraph(nodes: string[], edges: GraphEdge[], metrics: GraphMetrics = GRAPH_METRICS): GraphLayout {
	const ids = [...new Set(nodes)];
	const index = new Map(ids.map((id, i) => [id, i]));
	const out = new Map<string, string[]>(ids.map(id => [id, []]));
	const seen = new Set<string>();
	for (const e of edges) {
		const key = `${e.from}\n${e.to}`;
		if (e.from === e.to || !index.has(e.from) || !index.has(e.to) || seen.has(key)) continue;
		seen.add(key);
		out.get(e.from)?.push(e.to);
	}

	// Break cycles: iterative DFS, an edge into a node still on the stack is a back edge.
	const reversed: GraphEdge[] = [];
	const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
	const dag = new Map<string, string[]>(ids.map(id => [id, []]));
	for (const root of ids) {
		if (state.has(root)) continue;
		state.set(root, 1);
		const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
		while (stack.length) {
			const top = stack[stack.length - 1];
			const succ = out.get(top.id) ?? [];
			if (top.next >= succ.length) {
				state.set(top.id, 2);
				stack.pop();
				continue;
			}
			const to = succ[top.next++];
			const s = state.get(to);
			if (s === 1) reversed.push({ from: top.id, to });
			else {
				dag.get(top.id)?.push(to);
				if (s === undefined) {
					state.set(to, 1);
					stack.push({ id: to, next: 0 });
				}
			}
		}
	}

	// Longest path from the roots, in topological order (Kahn, ties by input order).
	const preds = new Map<string, string[]>(ids.map(id => [id, []]));
	for (const [from, tos] of dag) for (const to of tos) preds.get(to)?.push(from);
	const indeg = new Map(ids.map(id => [id, preds.get(id)?.length ?? 0]));
	const layerOf = new Map<string, number>(ids.map(id => [id, 0]));
	const ready = ids.filter(id => indeg.get(id) === 0);
	for (let i = 0; i < ready.length; i++) {
		const id = ready[i];
		for (const to of dag.get(id) ?? []) {
			layerOf.set(to, Math.max(layerOf.get(to) ?? 0, (layerOf.get(id) ?? 0) + 1));
			const d = (indeg.get(to) ?? 0) - 1;
			indeg.set(to, d);
			if (d === 0) ready.push(to);
		}
	}

	// Long edges get a virtual slot in every layer they cross, so they route around the nodes in between.
	const layerAll = new Map(layerOf);
	const prevOf = new Map<string, string[]>(ids.map(id => [id, []]));
	const nextOf = new Map<string, string[]>(ids.map(id => [id, []]));
	const link = (a: string, b: string) => {
		nextOf.get(a)?.push(b);
		prevOf.get(b)?.push(a);
	};
	const chains: Array<{ from: string; to: string; via: string[] }> = [];
	for (const [from, tos] of dag) {
		for (const to of tos) {
			const via: string[] = [];
			let prev = from;
			for (let l = (layerOf.get(from) ?? 0) + 1; l < (layerOf.get(to) ?? 0); l++) {
				const v = `\0${from}\0${to}\0${l}`;
				layerAll.set(v, l);
				prevOf.set(v, []);
				nextOf.set(v, []);
				link(prev, v);
				via.push(v);
				prev = v;
			}
			link(prev, to);
			chains.push({ from, to, via });
		}
	}

	const layerCount = ids.length ? Math.max(...layerOf.values()) + 1 : 0;
	const slots: string[][] = Array.from({ length: layerCount }, () => []);
	for (const [id, l] of layerAll) slots[l].push(id);

	// Barycenter sweeps: down (by predecessors), then up (by successors).
	const pos = new Map<string, number>();
	const reindex = (layer: string[]) => {
		layer.forEach((id, i) => pos.set(id, i));
	};
	slots.forEach(reindex);
	const order = (layer: string[], neighbours: Map<string, string[]>) => {
		const bary = new Map<string, number>();
		for (const id of layer) {
			const ns = neighbours.get(id) ?? [];
			bary.set(id, ns.length ? ns.reduce((s, n) => s + (pos.get(n) ?? 0), 0) / ns.length : (pos.get(id) ?? 0));
		}
		layer.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || (pos.get(a) ?? 0) - (pos.get(b) ?? 0));
		reindex(layer);
	};
	for (let pass = 0; pass < 2; pass++) {
		for (let l = 1; l < slots.length; l++) order(slots[l], prevOf);
		for (let l = slots.length - 2; l >= 0; l--) order(slots[l], nextOf);
	}

	const { nodeWidth, nodeHeight, gapX, gapY } = metrics;
	const tallest = Math.max(0, ...slots.map(l => l.length));
	const height = tallest ? tallest * nodeHeight + (tallest - 1) * gapY : 0;
	const width = layerCount ? layerCount * nodeWidth + (layerCount - 1) * gapX : 0;
	const slotPos = new Map<string, GraphPos>();
	slots.forEach((layer, l) => {
		// Center shorter layers vertically.
		const offset = (height - (layer.length * nodeHeight + (layer.length - 1) * gapY)) / 2;
		layer.forEach((id, i) => slotPos.set(id, { x: l * (nodeWidth + gapX), y: offset + i * (nodeHeight + gapY), layer: l, order: i }));
	});

	const layers = slots.map(layer => layer.filter(id => index.has(id)));
	const positions = new Map<string, GraphPos>();
	layers.forEach(layer => {
		layer.forEach((id, i) => {
			const p = slotPos.get(id);
			if (p) positions.set(id, { ...p, order: i });
		});
	});
	const at = (id: string, side: 0 | 1) => {
		const p = slotPos.get(id) ?? { x: 0, y: 0 };
		return { x: p.x + side * nodeWidth, y: p.y + nodeHeight / 2 };
	};
	const routes: GraphRoute[] = [
		...chains.map(c => ({ from: c.from, to: c.to, points: [at(c.from, 1), ...c.via.flatMap(v => [at(v, 0), at(v, 1)]), at(c.to, 0)] })),
		...reversed.map(e => ({ ...e, points: [at(e.from, 1), at(e.to, 0)] })),
	];
	return { layers, positions, routes, reversed, width, height };
}
