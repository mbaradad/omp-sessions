import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type BoardCard, buildColumns, filterCards, statusKey } from "../../src/kanban/board";
import { type GraphCard, SESSION_MARKERS, dependencyGraph, edgeKind, plannerBadge, sessionDag, waitsForLabel } from "../../src/shared/session-graph";

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

describe("edgeKind", () => {
	test("propagation state wins; otherwise a waiting child makes the arrow pending", () => {
		assert.equal(edgeKind("conflict", false), "conflict");
		assert.equal(edgeKind("resolving", false), "conflict");
		assert.equal(edgeKind("upstream-changed", true), "changed");
		assert.equal(edgeKind("pending", false), "pending");
		assert.equal(edgeKind("merged", true), "merged");
		assert.equal(edgeKind("in-sync", true), "pending");
		assert.equal(edgeKind(undefined, false), undefined);
	});
});

describe("plannerBadge", () => {
	const at = new Date(2025, 0, 10, 12, 0).getTime();
	const now = new Date(2025, 0, 10, 9, 0);
	test("nothing while the queue runs, has nothing pending or the planner says nothing", () => {
		assert.equal(plannerBadge(undefined), undefined);
		assert.equal(plannerBadge({ state: "running", pending: 2 }), undefined);
		assert.equal(plannerBadge({ state: "held", pending: 0 }), undefined);
		assert.equal(plannerBadge({ pending: 2 }), undefined);
	});
	test("scheduled says when, held says why and until when, waiting its position", () => {
		const s = plannerBadge({ state: "scheduled", waitUntil: at, pending: 1 }, now);
		assert.equal(s?.label, "Scheduled 12:00");
		assert.equal(s?.short, "12:00");
		const h = plannerBadge({ state: "held", waitReason: "budget day 21.50/20 USD", waitUntil: at, pending: 1 }, now);
		assert.equal(h?.label, "Held");
		assert.equal(h?.title, "budget day 21.50/20 USD until 12:00");
		assert.equal(plannerBadge({ state: "waiting", waiting: { position: 2 }, pending: 1 })?.label, "Queued #2");
		assert.equal(plannerBadge({ state: "blocked", pending: 1 })?.label, "Blocked");
		assert.equal(plannerBadge({ state: "paused", pending: 1 })?.label, "Paused");
	});
	test("interrupted shows even with nothing pending and is the one bad tone", () => {
		const i = plannerBadge({ state: "interrupted", pending: 0 });
		assert.equal(i?.label, "Interrupted");
		assert.equal(i?.tone, "bad");
		assert.equal(plannerBadge({ state: "held", pending: 1 })?.tone, "wait");
	});
});

describe("sessionDag", () => {
	const graphCard = (c: BoardCard): GraphCard => ({ ...c, state: statusKey(c), queue: c.queue });
	test("stripe = session state, badge = planner state, thick arrows, dashed while the child waits", () => {
		const a = card("a", { status: "working", createdAt: NOW });
		const b = card("b", { status: "idle", createdAt: NOW + 1, after: ["a"], blockedBy: ["a"], queue: { ...queue(1), state: "blocked", failed: 2 } });
		const c = card("c", { status: "idle", createdAt: NOW + 2, after: ["b"], sync: { state: "conflict", parents: ["b"], edges: { b: "conflict" } } });
		const { nodes, edges } = sessionDag([a, b, c].map(graphCard), [a, b, c]);
		assert.deepEqual(
			nodes.map(n => n.id),
			["a", "b", "c"],
		);
		const nb = nodes.find(n => n.id === "b");
		assert.deepEqual(nb?.classes, ["s-queued", "blocked"]);
		assert.equal(nb?.sub, "queued · waits for Session a · 2 failed");
		assert.deepEqual(nb?.badge, { text: "blocked", tone: "wait" });
		assert.equal(nodes.find(n => n.id === "a")?.badge, undefined);
		assert.deepEqual(
			edges.map(e => [e.from, e.to, e.classes, e.marker]),
			[
				["a", "b", ["enforced", "pending"], "graph-arrow-pending"],
				["b", "c", ["enforced", "conflict"], "graph-arrow-conflict"],
			],
		);
		for (const e of edges) assert.ok(SESSION_MARKERS.includes(e.marker));
	});
	test("an edge that holds nothing back is plain", () => {
		const { edges } = sessionDag([graphCard(card("a")), graphCard(card("b", { after: ["a"] }))], []);
		assert.deepEqual(edges, [{ from: "a", to: "b", classes: ["enforced"], marker: "graph-arrow" }]);
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
