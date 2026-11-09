import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphCard } from "../../integrations/hermes/ui/api";
import { GAP_X, graphLinks, layoutGraph, NODE_H, NODE_W } from "../../integrations/hermes/ui/graph-layout";

function card(id: string, parents: string[] = [], children: string[] = [], status = "todo"): GraphCard {
	return { id, title: id, status, parents, children, lane: false };
}

/** A board as boards_view reports it: both ends of every link name each other. */
function board(links: Array<[string, string]>, loose: string[] = []): GraphCard[] {
	const ids = [...new Set(links.flat()), ...loose];
	return ids.map(id =>
		card(
			id,
			links.filter(([, c]) => c === id).map(([p]) => p),
			links.filter(([p]) => p === id).map(([, c]) => c),
		),
	);
}

test("layers follow the longest path from the roots and edges run parent to child", () => {
	// plan → build → ship, plan → docs → ship, plan → ship (a shortcut must not pull ship left).
	const l = layoutGraph(
		board([
			["plan", "build"],
			["plan", "docs"],
			["build", "ship"],
			["docs", "ship"],
			["plan", "ship"],
		]),
		false,
	);
	const layer = Object.fromEntries(l.nodes.map(n => [n.card.id, n.layer]));
	assert.deepEqual(layer, { plan: 0, build: 1, docs: 1, ship: 2 });
	const x = Object.fromEntries(l.nodes.map(n => [n.card.id, n.x]));
	assert.equal(x.build - x.plan, NODE_W + GAP_X);
	assert.equal(l.edges.length, 5);
	for (const e of l.edges) assert.ok(x[e.to] > x[e.from], `${e.from} → ${e.to} runs left to right`);
	assert.equal(l.width, x.ship + NODE_W + 12);
});

test("only linked cards show until showAll; unlinked ones then sit below the graph", () => {
	const cards = board([["a", "b"]], ["x", "y"]);
	const linked = layoutGraph(cards, false);
	assert.deepEqual(
		linked.nodes.map(n => n.card.id),
		["a", "b"],
	);
	assert.equal(linked.hidden, 2);
	const all = layoutGraph(cards, true);
	assert.equal(all.hidden, 0);
	const loose = all.nodes.filter(n => n.layer === -1);
	assert.deepEqual(
		loose.map(n => n.card.id),
		["x", "y"],
	);
	const graphBottom = Math.max(...all.nodes.filter(n => n.layer >= 0).map(n => n.y + NODE_H));
	for (const n of loose) assert.ok(n.y > graphBottom, "the loose grid is under the graph");
	assert.ok(all.height >= Math.max(...all.nodes.map(n => n.y + NODE_H)));
});

test("links to cards that aren't on the graph (archived) neither draw nor count as links", () => {
	const cards = [card("a", ["archived-parent"]), card("b", [], ["gone"]), card("c")];
	assert.deepEqual(graphLinks(cards), []);
	const l = layoutGraph(cards, false);
	assert.equal(l.nodes.length, 0);
	assert.equal(l.hidden, 3);
	assert.equal(l.width, 0);
	assert.equal(l.height, 0);
});

test("a cycle in the links still lays out every card once", () => {
	const l = layoutGraph(
		board([
			["a", "b"],
			["b", "c"],
			["c", "a"],
		]),
		false,
	);
	assert.equal(l.nodes.length, 3);
	assert.equal(new Set(l.nodes.map(n => n.card.id)).size, 3);
	assert.equal(l.edges.length, 3);
});

test("barycenter ordering keeps children next to their parents", () => {
	// Two chains whose children arrive in the opposite order: p1 → c1, p2 → c2 with c2 listed first.
	const cards = [card("p1", [], ["c1"]), card("p2", [], ["c2"]), card("c2", ["p2"]), card("c1", ["p1"])];
	const l = layoutGraph(cards, false);
	const y = Object.fromEntries(l.nodes.map(n => [n.card.id, n.y]));
	assert.ok(y.p1 < y.p2);
	assert.ok(y.c1 < y.c2, "no crossing: c1 beside p1, c2 beside p2");
});
