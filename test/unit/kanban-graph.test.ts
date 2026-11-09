import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type BoardCard, buildColumns, filterCards, statusKey } from "../../src/kanban/board";
import { GRAPH_METRICS, type GraphEdge, type GraphLayout, dependencyGraph, layoutGraph, waitsForLabel } from "../../src/kanban/graph";

const NOW = 1_700_000_000_000;

function card(id: string, extra: Partial<BoardCard> = {}): BoardCard {
	return {
		id,
		title: `Session ${id}`,
		cwd: "/work/app",
		project: "app",
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
		unread: false,
		priority: "normal",
		rank: 0,
		pinned: false,
		archived: false,
		tags: [],
		...extra,
	};
}
const queue = (pending: number) => ({ pending, running: 0, done: 0, total: pending });
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

describe("dependencyGraph", () => {
	test("cards with dependencies plus the ones they wait for; filtered-out cards drop out", () => {
		const cards = [card("a", { createdAt: NOW + 2 }), card("b", { createdAt: NOW + 1, after: ["a"] }), card("c", { after: ["a", "b", "gone"] }), card("lonely")];
		const g = dependencyGraph(cards);
		assert.deepEqual(
			g.nodes.map(c => c.id),
			["c", "b", "a"],
		);
		assert.deepEqual(g.edges, [
			{ from: "a", to: "c" },
			{ from: "b", to: "c" },
			{ from: "a", to: "b" },
		]);
		const filtered = dependencyGraph(cards.filter(c => c.id !== "a"));
		assert.deepEqual(filtered.edges, [{ from: "b", to: "c" }]);
		assert.deepEqual(dependencyGraph([card("x"), card("y")]).nodes, []);
	});
});

describe("waitsForLabel", () => {
	const cards = [card("aaaa1111", { title: "Build API" }), card("bbbb2222", { title: "Write docs" })];
	test("first title, +N for more, unknown ids shortened; none when nothing blocks", () => {
		assert.equal(waitsForLabel({ blockedBy: ["aaaa1111"] }, cards)?.text, "waits for Build API");
		const many = waitsForLabel({ blockedBy: ["bbbb2222", "aaaa1111", "zzzzzzzz-unknown"] }, cards);
		assert.equal(many?.text, "waits for Write docs +2");
		assert.match(many?.tooltip ?? "", /Write docs[\s\S]*Build API[\s\S]*zzzzzzzz$/);
		assert.equal(waitsForLabel({ blockedBy: [] }, cards), undefined);
		assert.equal(waitsForLabel({}, cards), undefined);
	});
});

describe("statusKey with dependencies", () => {
	test("blocked with pending tasks → queued, also when stopped", () => {
		assert.equal(statusKey(card("s", { status: "stopped", blockedBy: ["x"], queue: queue(1) })), "queued");
		assert.equal(statusKey(card("i", { status: "idle", blockedBy: ["x"], queue: queue(2) })), "queued");
	});
	test("no pending tasks, nothing blocking, or running: unchanged", () => {
		assert.equal(statusKey(card("s", { status: "stopped", blockedBy: ["x"], queue: queue(0) })), "stopped");
		assert.equal(statusKey(card("s", { status: "stopped", blockedBy: ["x"] })), "stopped");
		assert.equal(statusKey(card("s", { status: "stopped", after: ["x"], blockedBy: [], queue: queue(1) })), "stopped");
		assert.equal(statusKey(card("w", { status: "working", blockedBy: ["x"], queue: queue(1) })), "working");
		assert.equal(statusKey(card("n", { status: "waiting", blockedBy: ["x"], queue: queue(1) })), "waiting");
	});
	test("held by a provider limit, usage window or budget → queued, with the reason on the card's queue", () => {
		const held = { ...queue(1), state: "held", waitReason: "rate-limit anthropic until 14:05", waitUntil: NOW + 3_600_000 };
		assert.equal(statusKey(card("h", { status: "stopped", queue: held })), "queued");
		assert.equal(statusKey(card("h", { status: "idle", queue: held })), "queued");
		assert.equal(statusKey(card("h", { status: "working", queue: held })), "working");
		assert.equal(statusKey(card("h", { status: "stopped", queue: { ...held, pending: 0 } })), "stopped", "nothing left to start");
	});
	test("blocked stopped cards land in the Queued column and stay visible with stopped sessions hidden", () => {
		const blocked = card("s", { status: "stopped", blockedBy: ["x"], queue: queue(1) });
		const cols = buildColumns("status", { lanes: [], groups: [] }, [blocked]);
		assert.deepEqual(
			cols.find(c => c.value === "queued")?.sections[0].cards.map(c => c.id),
			["s"],
		);
		assert.deepEqual(
			filterCards([blocked, card("t", { status: "stopped" })], { text: "", showArchived: false, showStopped: false }).map(c => c.id),
			["s"],
		);
	});
});
