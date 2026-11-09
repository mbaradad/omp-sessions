import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type BoardCard,
	type BoardColumn,
	type BoardGroup,
	type BoardLane,
	RANK_STEP,
	adjacentTarget,
	canRerunWithParent,
	buildColumns,
	cyclePriority,
	filterCards,
	planDrop,
	projectsOf,
	rankInsert,
	stepTarget,
	worstSync,
} from "../../src/kanban/board";

const NOW = 1_700_000_000_000;

function card(id: string, extra: Partial<BoardCard> = {}): BoardCard {
	return {
		id,
		title: `Session ${id}`,
		cwd: `/work/${extra.project ?? "app"}`,
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
const lanes: BoardLane[] = [
	{ id: "backlog", name: "Backlog", order: 0 },
	{ id: "doing", name: "In Progress", order: 1 },
	{ id: "done", name: "Done", order: 2 },
];
const groups: BoardGroup[] = [
	{ id: "b", name: "Beta", order: 1 },
	{ id: "a", name: "Alpha", order: 0, color: "red" },
	{ id: "a2", name: "Alpha child 2", parentId: "a", order: 1 },
	{ id: "a1", name: "Alpha child 1", parentId: "a", order: 0 },
	{ id: "a11", name: "Grandchild", parentId: "a1", order: 0 },
];
const ids = (col: BoardColumn | undefined, section = 0): string[] => col?.sections[section]?.cards.map(c => c.id) ?? [];
const byId = (cols: BoardColumn[], id: string) => cols.find(c => c.id === id);

describe("buildColumns", () => {
	test("status: needs input / working / queued / idle / completed / stopped; queued ordered by slot position", () => {
		const cols = buildColumns("status", { lanes, groups }, [
			card("w", { status: "waiting" }),
			card("s", { status: "starting" }),
			card("k", { status: "working" }),
			card("q2", { waiting: { position: 2, since: NOW }, rank: -5 }),
			card("q1", { waiting: { position: 1, since: NOW }, rank: 5 }),
			card("i"),
			card("x", { status: "stopped", waiting: { position: 3, since: NOW } }),
			card("done-idle", { completed: true }),
			card("done-stopped", { status: "stopped", completed: true, rank: -1 }),
			// Activity wins over the marker: it shows where the work is.
			card("done-asking", { status: "waiting", completed: true }),
		]);
		assert.deepEqual(
			cols.map(c => [c.title, ids(c)]),
			[
				["Needs input", ["done-asking", "w"]],
				["Working", ["k", "s"]],
				["Queued", ["q1", "q2"]],
				["Idle", ["i"]],
				["Completed", ["done-stopped", "done-idle"]],
				["Stopped", ["x"]],
			],
		);
		assert.ok(cols.every(c => !c.droppable));
		assert.equal(cols.filter(c => c.queued).length, 1);
	});

	test("sort: every container but Queued follows the chosen order; rank keeps the manual order", () => {
		const cards = [
			card("unsched", { rank: 0, updatedAt: NOW + 5 }),
			card("late", { rank: 1, startAt: NOW + 2000 }),
			card("soon", { rank: 2, startAt: NOW + 1000 }),
			card("q2", { waiting: { position: 2, since: NOW }, startAt: NOW + 10 }),
			card("q1", { waiting: { position: 1, since: NOW }, startAt: NOW + 99 }),
		];
		const byRank = buildColumns("status", { lanes, groups }, cards.map(c => ({ ...c })));
		assert.deepEqual(ids(byId(byRank, "status:idle")), ["unsched", "late", "soon"]);
		assert.equal(byId(byRank, "status:idle")?.sorted, undefined);
		const scheduled = buildColumns("status", { lanes, groups }, cards.map(c => ({ ...c })), "scheduled");
		assert.deepEqual(ids(byId(scheduled, "status:idle")), ["soon", "late", "unsched"]);
		assert.equal(byId(scheduled, "status:idle")?.sorted, true);
		assert.deepEqual(ids(byId(scheduled, "status:queued")), ["q1", "q2"], "Queued stays in start order");
		// Sub-group sections follow the sort too.
		const grouped = buildColumns("group", { lanes, groups }, [card("x", { group: "a1", title: "b" }), card("y", { group: "a1", title: "a", rank: 9 })], "name");
		assert.deepEqual(ids(byId(grouped, "group:a"), 1), ["y", "x"]);
	});

	test("sort completed: marked first by mark time, then most recently finished, ties by id", () => {
		const cols = buildColumns(
			"lane",
			{ lanes, groups },
			[
				card("f-old", { finishedAt: 10 }),
				card("c-old", { completed: true, completedAt: 1 }),
				card("never", { status: "working" }),
				card("c-new", { completed: true, completedAt: 5 }),
				card("f-new", { finishedAt: 20 }),
				card("f-tie-b", { finishedAt: 15 }),
				card("f-tie-a", { finishedAt: 15 }),
			],
			"completed",
		);
		assert.deepEqual(ids(byId(cols, "lane:backlog")), ["c-new", "c-old", "f-new", "f-tie-a", "f-tie-b", "f-old", "never"]);
	});

	test("lane: user lanes in order; unknown/missing lane falls into the first", () => {
		const cols = buildColumns("lane", { lanes, groups }, [card("a", { lane: "done" }), card("b"), card("c", { lane: "gone" }), card("d", { lane: "doing", rank: -1 }), card("e", { lane: "doing", rank: 3 })]);
		assert.deepEqual(
			cols.map(c => [c.value, ids(c)]),
			[
				["backlog", ["b", "c"]],
				["doing", ["d", "e"]],
				["done", ["a"]],
			],
		);
		assert.deepEqual(buildColumns("lane", { lanes: [], groups }, [card("a")]).map(c => c.droppable), [false]);
	});

	test("group: Ungrouped + top-level groups by order; nested sub-groups as sections (depth-first)", () => {
		const cols = buildColumns("group", { lanes, groups }, [card("u"), card("x", { group: "missing" }), card("ta", { group: "a" }), card("c1", { group: "a1" }), card("g", { group: "a11" }), card("tb", { group: "b" })]);
		assert.deepEqual(
			cols.map(c => c.title),
			["Ungrouped", "Alpha", "Beta"],
		);
		assert.deepEqual(ids(cols[0]), ["u", "x"]);
		const alpha = cols[1];
		assert.equal(alpha.color, "red");
		assert.equal(alpha.count, 3);
		assert.deepEqual(
			alpha.sections.map(s => [s.groupId, s.depth, s.ancestors, s.cards.map(c => c.id)]),
			[
				["a", 0, [], ["ta"]],
				["a1", 1, [], ["c1"]],
				["a11", 2, ["group:a/a1"], ["g"]],
				["a2", 1, [], []],
			],
		);
	});

	test("priority: urgent → low", () => {
		const cols = buildColumns("priority", { lanes, groups }, [card("n"), card("u", { priority: "urgent" }), card("l", { priority: "low" })]);
		assert.deepEqual(
			cols.map(c => [c.value, ids(c)]),
			[
				["urgent", ["u"]],
				["high", []],
				["normal", ["n"]],
				["low", ["l"]],
			],
		);
	});

	test("cards sort by rank, then most recently updated", () => {
		const cols = buildColumns("priority", { lanes, groups }, [card("old", { rank: 1, updatedAt: 1 }), card("new", { rank: 1, updatedAt: 2 }), card("first", { rank: 0 })]);
		assert.deepEqual(ids(byId(cols, "priority:normal")), ["first", "new", "old"]);
	});
});

describe("rankInsert", () => {
	const list = [
		{ id: "a", rank: 0 },
		{ id: "b", rank: 1024 },
		{ id: "c", rank: 2048 },
	];
	test("between neighbours: only the moving cards change", () => {
		assert.deepEqual(rankInsert(list, 1, ["x"]), [{ id: "x", rank: 512 }]);
		assert.deepEqual(rankInsert(list, 1, ["x", "y"]), [
			{ id: "x", rank: 1024 / 3 },
			{ id: "y", rank: 2048 / 3 },
		]);
	});
	test("top, bottom and empty containers", () => {
		assert.deepEqual(rankInsert(list, 0, ["x", "y"]), [
			{ id: "x", rank: -2 * RANK_STEP },
			{ id: "y", rank: -RANK_STEP },
		]);
		assert.deepEqual(rankInsert(list, 99, ["x"]), [{ id: "x", rank: 2048 + RANK_STEP }]);
		assert.deepEqual(rankInsert([], 0, ["x", "y"]), [
			{ id: "x", rank: 0 },
			{ id: "y", rank: RANK_STEP },
		]);
	});
	test("no room (ties, inverted, float exhaustion) renumbers the container", () => {
		const tied = [
			{ id: "a", rank: 5 },
			{ id: "b", rank: 5 },
			{ id: "c", rank: 6 },
		];
		assert.deepEqual(rankInsert(tied, 1, ["x"]), [
			{ id: "x", rank: 5 + RANK_STEP },
			{ id: "b", rank: 5 + 2 * RANK_STEP },
			{ id: "c", rank: 5 + 3 * RANK_STEP },
		]);
		const tight = [
			{ id: "a", rank: -NOW },
			{ id: "b", rank: -NOW + 0.0001 },
		];
		const out = rankInsert(tight, 1, ["x"]);
		const order = [...tight.filter(t => !out.some(o => o.id === t.id)), ...out].sort((p, q) => p.rank - q.rank).map(r => r.id);
		assert.deepEqual(order, ["a", "x", "b"]);
	});
});

describe("planDrop", () => {
	test("lane: moving between columns sets lane + rank among the target's cards", () => {
		const cols = buildColumns("lane", { lanes, groups }, [card("a", { rank: 0 }), card("b", { rank: 10, lane: "doing" }), card("c", { rank: 20, lane: "doing" })]);
		assert.deepEqual(planDrop("lane", cols, ["a"], { columnId: "lane:doing", sectionId: "lane:doing", beforeId: "c" }), [{ id: "a", patch: { rank: 15, lane: "doing" } }]);
		assert.deepEqual(planDrop("lane", cols, ["a"], { columnId: "lane:done", sectionId: "lane:done" }), [{ id: "a", patch: { rank: 0, lane: "done" } }]);
	});

	test("reorder within a column changes rank only; multi-select keeps order", () => {
		const cols = buildColumns("lane", { lanes, groups }, [card("a", { rank: 0 }), card("b", { rank: 10 }), card("c", { rank: 20 }), card("d", { rank: 30 })]);
		assert.deepEqual(planDrop("lane", cols, ["d", "a"], { columnId: "lane:backlog", sectionId: "lane:backlog", beforeId: "c" }), [
			{ id: "d", patch: { rank: 10 + 10 / 3 } },
			{ id: "a", patch: { rank: 10 + 20 / 3 } },
		]);
	});

	test("group: dropping into a nested sub-group section sets groupId; Ungrouped clears it", () => {
		const cols = buildColumns("group", { lanes, groups }, [card("u"), card("g", { group: "a1" })]);
		assert.deepEqual(planDrop("group", cols, ["u"], { columnId: "group:a", sectionId: "group:a/a11" }), [{ id: "u", patch: { rank: 0, group: "a11" } }]);
		assert.deepEqual(planDrop("group", cols, ["g"], { columnId: "group:", sectionId: "group:" }), [{ id: "g", patch: { rank: RANK_STEP, group: null } }]);
	});

	test("priority: sets priority", () => {
		const cols = buildColumns("priority", { lanes, groups }, [card("a")]);
		assert.deepEqual(planDrop("priority", cols, ["a"], { columnId: "priority:urgent", sectionId: "priority:urgent" }), [{ id: "a", patch: { rank: 0, priority: "urgent" } }]);
	});

	test("status: rejects moves between columns, allows reorder inside one", () => {
		const cols = buildColumns("status", { lanes, groups }, [card("i", { rank: 0 }), card("j", { rank: 5 }), card("w", { status: "waiting" })]);
		assert.equal(planDrop("status", cols, ["w"], { columnId: "status:idle", sectionId: "status:idle" }), undefined);
		assert.equal(planDrop("status", cols, ["i", "w"], { columnId: "status:idle", sectionId: "status:idle" }), undefined);
		assert.deepEqual(planDrop("status", cols, ["j"], { columnId: "status:idle", sectionId: "status:idle", beforeId: "i" }), [{ id: "j", patch: { rank: -RANK_STEP } }]);
	});

	test("a sorted column has no manual order: drops change fields only, never ranks", () => {
		const sorted = buildColumns("lane", { lanes, groups }, [card("a", { lane: "doing", title: "A" }), card("b", { lane: "doing", title: "B" }), card("c", { lane: "backlog" })], "name");
		assert.deepEqual(planDrop("lane", sorted, ["c"], { columnId: "lane:doing", sectionId: "lane:doing", beforeId: "b" }), [{ id: "c", patch: { lane: "doing" } }]);
		assert.deepEqual(planDrop("lane", sorted, ["b"], { columnId: "lane:doing", sectionId: "lane:doing", beforeId: "a" }), []);
	});

	test("queued: moving up past a higher priority adopts it so the scheduler order matches", () => {
		const q = (id: string, position: number, priority: BoardCard["priority"], rank: number) => card(id, { waiting: { position, since: NOW }, priority, rank });
		const cols = buildColumns("status", { lanes, groups }, [q("u", 1, "urgent", 50), q("h", 2, "high", 0), q("l", 3, "low", 0)]);
		// l before h: between urgent and high → becomes high; ranks are inverted there, so the queue is renumbered from u's rank.
		assert.deepEqual(planDrop("status", cols, ["l"], { columnId: "status:queued", sectionId: "status:queued", beforeId: "h" }), [
			{ id: "l", patch: { rank: 50 + RANK_STEP, priority: "high" } },
			{ id: "h", patch: { rank: 50 + 2 * RANK_STEP } },
		]);
		// u to the end: below low → becomes low.
		const down = planDrop("status", cols, ["u"], { columnId: "status:queued", sectionId: "status:queued" });
		assert.deepEqual(down, [{ id: "u", patch: { rank: RANK_STEP, priority: "low" } }]);
	});

	test("unknown target or card → undefined", () => {
		const cols = buildColumns("lane", { lanes, groups }, [card("a")]);
		assert.equal(planDrop("lane", cols, ["a"], { columnId: "lane:nope", sectionId: "lane:nope" }), undefined);
		assert.equal(planDrop("lane", cols, ["zz"], { columnId: "lane:done", sectionId: "lane:done" }), undefined);
	});
});

describe("keyboard targets", () => {
	const cols = buildColumns("lane", { lanes, groups }, [card("a", { rank: 0 }), card("b", { rank: 1 }), card("c", { rank: 2 }), card("x", { lane: "doing" })]);
	test("Alt+↑/↓ step inside the container; no-op at the edges", () => {
		assert.deepEqual(stepTarget(cols, "b", -1), { columnId: "lane:backlog", sectionId: "lane:backlog", beforeId: "a" });
		assert.deepEqual(stepTarget(cols, "a", 1), { columnId: "lane:backlog", sectionId: "lane:backlog", beforeId: "c" });
		assert.deepEqual(stepTarget(cols, "b", 1), { columnId: "lane:backlog", sectionId: "lane:backlog", beforeId: undefined });
		assert.equal(stepTarget(cols, "a", -1), undefined);
		assert.equal(stepTarget(cols, "c", 1), undefined);
		const down = planDrop("lane", cols, ["a"], stepTarget(cols, "a", 1) ?? { columnId: "", sectionId: "" });
		assert.deepEqual(down, [{ id: "a", patch: { rank: 1.5 } }]);
	});
	test("Alt+←/→ go to the adjacent droppable column at the same index", () => {
		assert.deepEqual(adjacentTarget(cols, "b", 1), { columnId: "lane:doing", sectionId: "lane:doing", beforeId: undefined });
		assert.deepEqual(adjacentTarget(cols, "a", 1), { columnId: "lane:doing", sectionId: "lane:doing", beforeId: "x" });
		assert.equal(adjacentTarget(cols, "a", -1), undefined);
		const status = buildColumns("status", { lanes, groups }, [card("a")]);
		assert.equal(adjacentTarget(status, "a", 1), undefined);
	});
});

describe("cyclePriority", () => {
	test("low → normal → high → urgent → low, and back", () => {
		assert.deepEqual(["low", "normal", "high", "urgent"].map(p => cyclePriority(p as BoardCard["priority"])), ["normal", "high", "urgent", "low"]);
		assert.equal(cyclePriority("low", -1), "urgent");
		assert.equal(cyclePriority("high", -1), "normal");
	});
});

describe("filterCards", () => {
	const cards = [
		card("a", { title: "Fix login bug", tags: ["auth", "urgent-fix"], project: "web" }),
		card("b", { title: "Docs", lastText: "Updated the README", project: "api", cwd: "/work/api" }),
		card("c", { title: "Old", status: "stopped" }),
		card("d", { title: "Shelved", archived: true }),
		card("e", { title: "Shipped", status: "stopped", completed: true }),
	];
	const f = (text: string, showArchived = false, showStopped = false, showCompleted?: boolean) => filterCards(cards, { text, showArchived, showStopped, showCompleted }).map(c => c.id);
	test("archived/stopped/completed toggles", () => {
		assert.deepEqual(f(""), ["a", "b", "e"], "completed sessions show (in their column) even while stopped ones are hidden");
		assert.deepEqual(f("", true, true), ["a", "b", "c", "d", "e"]);
		assert.deepEqual(f("", true, true, false), ["a", "b", "c", "d"]);
		assert.deepEqual(f("completed"), ["e"]);
	});
	test("text, #tag, project: — all tokens must match, case-insensitive", () => {
		assert.deepEqual(f("LOGIN"), ["a"]);
		assert.deepEqual(f("readme"), ["b"]);
		assert.deepEqual(f("#auth"), ["a"]);
		assert.deepEqual(f("#nope"), []);
		assert.deepEqual(f("project:api"), ["b"]);
		assert.deepEqual(f("project:web fix"), ["a"]);
		assert.deepEqual(f("project:web docs"), []);
	});
	test("projectsOf: distinct, sorted", () => {
		assert.deepEqual(projectsOf(cards), ["api", "app", "web"]);
	});
});

describe("edge sync states", () => {
	test("worstSync: conflict outranks upstream-changed, pending, merged, in-sync; none for no edges", () => {
		assert.equal(worstSync([]), undefined);
		assert.equal(worstSync(["in-sync", "merged"]), "merged");
		assert.equal(worstSync(["merged", "pending", "in-sync"]), "pending");
		assert.equal(worstSync(["pending", "upstream-changed", "merged"]), "upstream-changed");
		assert.equal(worstSync(["upstream-changed", "conflict", "pending"]), "conflict");
	});

	test("a conflicted card sits in Needs input, even while idle; a stopped one stays stopped", () => {
		const cols = buildColumns("status", { lanes: [], groups: [] }, [
			card("a", { sync: { state: "conflict", parents: ["p"] } }),
			card("b", { sync: { state: "upstream-changed", parents: ["p"] } }),
			card("c", { status: "stopped", sync: { state: "conflict", parents: ["p"] } }),
		]);
		const ids = (key: string) => cols.find(c => c.id === `status:${key}`)?.sections.flatMap(s => s.cards.map(c => c.id));
		assert.deepEqual(ids("waiting"), ["a"]);
		assert.deepEqual(ids("idle"), ["b"]);
		assert.deepEqual(ids("stopped"), ["c"]);
	});

	test("Re-run with parent changes applies to upstream-changed and conflicted cards only", () => {
		assert.equal(canRerunWithParent(card("a", { sync: { state: "upstream-changed", parents: [] } })), true);
		assert.equal(canRerunWithParent(card("a", { sync: { state: "conflict", parents: [] } })), true);
		for (const state of ["in-sync", "pending", "merged"] as const) assert.equal(canRerunWithParent(card("a", { sync: { state, parents: [] } })), false, state);
		assert.equal(canRerunWithParent(card("a")), false);
	});
});
