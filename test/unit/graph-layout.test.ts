import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GRAPH_METRICS, type GraphEdge, type GraphLayout, layoutGraph } from "../../src/shared/graph-layout";

// Ported with the layout from the parked omp/deps branch (test/unit/kanban-graph.test.ts).

const layerOf = (l: GraphLayout, id: string) => l.positions.get(id)?.layer;

describe("layoutGraph", () => {
	test("chain A→B→C: increasing layers left to right", () => {
		const l = layoutGraph(["c", "b", "a"], [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		]);
		assert.deepEqual(l.layers, [["a"], ["b"], ["c"]]);
		const xs = ["a", "b", "c"].map(id => l.positions.get(id)?.x ?? -1);
		assert.ok(xs[0] < xs[1] && xs[1] < xs[2]);
		assert.ok(l.width > 0 && l.height > 0);
	});

	test("diamond: the join waits for the longest path", () => {
		const edges: GraphEdge[] = [
			{ from: "a", to: "b" },
			{ from: "a", to: "c" },
			{ from: "b", to: "d" },
			{ from: "c", to: "d" },
			{ from: "a", to: "d" },
		];
		const l = layoutGraph(["a", "b", "c", "d"], edges);
		assert.deepEqual(["a", "b", "c", "d"].map(id => layerOf(l, id)), [0, 1, 1, 2]);
		assert.deepEqual(new Set(l.layers[1]), new Set(["b", "c"]));
		assert.notEqual(l.positions.get("b")?.y, l.positions.get("c")?.y);
	});

	test("disconnected nodes sit in the first layer; unknown ids, self-loops and duplicates are ignored", () => {
		const l = layoutGraph(["x", "a", "b", "y"], [
			{ from: "a", to: "b" },
			{ from: "a", to: "b" },
			{ from: "y", to: "y" },
			{ from: "ghost", to: "x" },
		]);
		assert.deepEqual(["x", "a", "b", "y"].map(id => layerOf(l, id)), [0, 0, 1, 0]);
		assert.equal(l.positions.size, 4);
		assert.deepEqual(l.reversed, []);
	});

	test("barycenter ordering untangles crossing edges", () => {
		// a1→b2, a2→b1 in input order would cross; the sweep swaps one layer.
		const l = layoutGraph(["a1", "a2", "b1", "b2"], [
			{ from: "a1", to: "b2" },
			{ from: "a2", to: "b1" },
		]);
		const ord = (id: string) => l.positions.get(id)?.order ?? -1;
		assert.equal(ord("a1") < ord("a2"), ord("b2") < ord("b1"));
	});

	test("cycles terminate, place every node once and are broken deterministically", () => {
		const nodes = ["a", "b", "c", "d"];
		const edges: GraphEdge[] = [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "c", to: "a" },
			{ from: "c", to: "d" },
			{ from: "d", to: "b" },
		];
		const l = layoutGraph(nodes, edges);
		assert.equal(l.positions.size, 4);
		assert.deepEqual(l.layers.flat().sort(), nodes);
		assert.ok(l.reversed.length >= 1);
		assert.deepEqual(layoutGraph(nodes, edges), l);
		// Two-node cycle.
		const two = layoutGraph(["p", "q"], [
			{ from: "p", to: "q" },
			{ from: "q", to: "p" },
		]);
		assert.deepEqual(two.layers, [["p"], ["q"]]);
	});

	test("long edges route through a virtual slot instead of across the node in between", () => {
		const l = layoutGraph(["a", "b", "c"], [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "a", to: "c" },
		]);
		assert.deepEqual(l.layers, [["a"], ["b"], ["c"]]);
		const long = l.routes.find(r => r.from === "a" && r.to === "c");
		assert.equal(long?.points.length, 4);
		const b = l.positions.get("b");
		const via = long?.points[1];
		assert.ok(b && via && via.x === b.x && via.y !== b.y + GRAPH_METRICS.nodeHeight / 2);
		const short = l.routes.find(r => r.from === "a" && r.to === "b");
		assert.equal(short?.points.length, 2);
		assert.equal(l.routes.length, 3);
	});

	test("empty graph", () => {
		assert.deepEqual(layoutGraph([], []), { layers: [], positions: new Map(), routes: [], reversed: [], width: 0, height: 0 });
	});
});
