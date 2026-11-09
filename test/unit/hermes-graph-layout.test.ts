import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphCard } from "../../integrations/hermes/ui/api";
import { clipToWidth, GAP_X, graphLinks, layoutGraph, NODE_H, NODE_W, planNote, shortTime } from "../../integrations/hermes/ui/graph-layout";

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

/** Where an edge's straight run (between the turns inside the first and last gap) passes through a card box. */
function crossings(l: ReturnType<typeof layoutGraph>, from: string, to: string): string[] {
	const edge = l.edges.find(e => e.from === from && e.to === to);
	assert.ok(edge?.routeY !== undefined, `${from} → ${to} is routed`);
	const a = l.nodes.find(n => n.card.id === from);
	const b = l.nodes.find(n => n.card.id === to);
	assert.ok(a && b);
	const x1 = a.x + NODE_W;
	const x2 = b.x;
	return l.nodes.filter(n => n.card.id !== from && n.card.id !== to && n.x < x2 && n.x + NODE_W > x1 && edge.routeY !== undefined && edge.routeY >= n.y && edge.routeY <= n.y + NODE_H).map(n => n.card.id);
}

test("an edge that skips a column is routed between the cards it passes, not through them", () => {
	// a → b → c → d is the spine; a → d skips b's and c's columns, and a column of three cards sits right in its way.
	const l = layoutGraph(
		board([
			["a", "b"],
			["b", "c"],
			["c", "d"],
			["a", "d"],
			["a", "m1"],
			["a", "m2"],
			["m1", "d"],
			["m2", "d"],
		]),
		false,
	);
	const layer = Object.fromEntries(l.nodes.map(n => [n.card.id, n.layer]));
	assert.ok(layer.d - layer.a >= 3, "a → d skips columns");
	assert.deepEqual(crossings(l, "a", "d"), []);
	for (const [from, to] of [["a", "d"]] as const) {
		const e = l.edges.find(x => x.from === from && x.to === to);
		assert.ok(e?.routeY !== undefined && e.routeY >= 0 && e.routeY <= l.height, "the run stays inside the canvas");
		assert.match(e.d, /^M[\d.]+ [\d.]+ C.* L.* C/, "a curve in, a straight run, a curve out");
	}
	// Edges between neighbouring columns keep the plain curve.
	assert.equal(l.edges.find(e => e.from === "a" && e.to === "b")?.routeY, undefined);
});

test("several skipping edges over the same stretch run on different rows and none crosses a card", () => {
	const l = layoutGraph(
		board([
			["r", "x1"],
			["x1", "x2"],
			["x2", "s1"],
			["x2", "s2"],
			["x2", "s3"],
			["r", "s1"],
			["r", "s2"],
			["r", "s3"],
		]),
		false,
	);
	const rows = ["s1", "s2", "s3"].map(t => {
		assert.deepEqual(crossings(l, "r", t), [], `r → ${t}`);
		return l.edges.find(e => e.from === "r" && e.to === t)?.routeY;
	});
	assert.equal(new Set(rows).size, 3, `three different rows (${rows.join(", ")})`);
	for (const y of rows) assert.ok(y !== undefined && y >= 0 && y <= l.height);
});

test("a skipping edge with the cards of the column packed tightly goes above or below them", () => {
	// Every column is as tall as the tallest, so the only free rows are the 14px gaps between cards, and above and below.
	const l = layoutGraph(
		board([
			["a", "b"],
			["a", "c"],
			["a", "e"],
			["b", "m"],
			["c", "m"],
			["e", "m"],
			["m", "z"],
			["a", "z"],
		]),
		false,
	);
	assert.deepEqual(crossings(l, "a", "z"), []);
});

test("clipToWidth cuts by rendered width: narrow letters fit more, wide ones fewer, and short titles are kept", () => {
	const width = (s: string): number => Array.from(s).reduce((w, ch) => w + (ch === "i" || ch === "l" ? 3 : ch === "W" ? 14 : 7), 0);
	assert.equal(clipToWidth("short", 100, width), "short");
	const narrow = clipToWidth("illlllllllllllllllllllllllllllllllllll", 100, width);
	const wide = clipToWidth("WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW", 100, width);
	assert.ok(width(narrow) <= 100 && width(wide) <= 100, "both fit");
	assert.ok(narrow.endsWith("…") && wide.endsWith("…"));
	assert.ok(narrow.length > wide.length * 2, `a width cut keeps more narrow letters (${narrow.length}) than wide ones (${wide.length})`);
	assert.equal(clipToWidth("WWWW", 5, width), "…", "nothing but the ellipsis fits");
	assert.equal(clipToWidth("fix the build ", 70, width).includes(" …"), false, "no space before the ellipsis");
});

test("planNote names what holds a card's task: blocked, held, scheduled; nothing when it runs or is done", () => {
	const titles: Record<string, string> = { up: "Upstream", up2: "Other" };
	const titleOf = (id: string): string => titles[id] ?? id;
	const withPlan = (plan: Partial<NonNullable<GraphCard["plan"]>>): GraphCard => ({ ...card("c"), plan: { state: null, after: [], blockedBy: [], ...plan } });
	const clock = (ms: number): string => `t${ms}`;
	assert.equal(planNote(card("c"), titleOf), null, "no planner data");
	assert.equal(planNote(withPlan({ state: "running" }), titleOf), null);
	const blocked = planNote(withPlan({ state: "blocked", after: ["up", "up2"], blockedBy: ["up", "up2"] }), titleOf, clock);
	assert.deepEqual([blocked?.label, blocked?.tone], ["blocked · 2 to finish", "blocked"]);
	assert.match(blocked?.detail ?? "", /until Upstream, Other finish/);
	assert.match(planNote(withPlan({ state: "blocked", blockedBy: ["up"] }), titleOf)?.detail ?? "", /until Upstream finishes$/);
	const held = planNote(withPlan({ state: "held", reason: "rate-limit anthropic", until: 5 }), titleOf, clock);
	assert.deepEqual([held?.label, held?.detail], ["held · rate-limit anthropic", "Held by Switchyard: rate-limit anthropic until t5"]);
	assert.equal(planNote(withPlan({ state: "held", reason: "rate-limit fake until 21:37", until: 5 }), titleOf, clock)?.detail, "Held by Switchyard: rate-limit fake until 21:37", "the reason's own end time is not repeated");
	assert.equal(planNote(withPlan({ state: "held", reason: "rate-limit fake until 21:37" }), titleOf, clock)?.label, "held · rate-limit fake", "the label leaves the time to the tooltip");
	assert.equal(planNote(withPlan({ state: "scheduled", until: 9 }), titleOf, clock)?.label, "scheduled · t9");
	assert.equal(planNote(withPlan({ state: "interrupted" }), titleOf)?.tone, "interrupted");
});

test("shortTime shows the clock for today and the day with it for another day", () => {
	const noon = new Date(2026, 10, 9, 12, 0).getTime();
	const today = shortTime(new Date(2026, 10, 9, 14, 5).getTime(), noon);
	assert.match(today, /^\d{1,2}[:.]05/, today);
	assert.doesNotMatch(today, /[A-Za-z]{3} \d/, "today has no date");
	assert.match(shortTime(new Date(2026, 10, 12, 9, 30).getTime(), noon), /12/, "another day carries the date");
});
