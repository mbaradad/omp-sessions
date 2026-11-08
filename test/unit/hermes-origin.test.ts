import assert from "node:assert/strict";
import { test } from "node:test";
import { hermesOrigin, isHermesTag, kanbanUrl, showCardArgs } from "../../src/shared/hermes-origin";

test("hermesOrigin: lane tags give board and card; `hermes` alone is a Hermes chat; others nothing", () => {
	assert.deepEqual(hermesOrigin(["hermes", "hermes:lightscale", "card:t_1a2b", "bug"]), { board: "lightscale", card: "t_1a2b" });
	assert.deepEqual(hermesOrigin(["review", "hermes"]), {});
	assert.deepEqual(hermesOrigin(["hermes:ops", "card:t_9"]), { board: "ops", card: "t_9" }, "the board tag alone marks it");
	assert.equal(hermesOrigin(["card:t_9"]), undefined, "a card tag alone could be anything");
	assert.equal(hermesOrigin(["bug", "hermes-docs"]), undefined);
	assert.equal(hermesOrigin([]), undefined);
	assert.equal(hermesOrigin(undefined), undefined);
	assert.equal(hermesOrigin(["hermes:"])?.board, undefined);
});

test("plain tags and dashboard URL", () => {
	const o = { board: "lightscale", card: "t_1a2b" };
	assert.deepEqual(["hermes", "hermes:lightscale", "card:t_1a2b", "bug"].filter(t => !isHermesTag(t, o)), ["bug"]);
	assert.deepEqual(["hermes", "card:x"].filter(t => !isHermesTag(t, {})), ["card:x"], "card tags stay when not the lane's");
	assert.equal(kanbanUrl("http://localhost:9119/"), "http://localhost:9119/kanban");
	assert.equal(kanbanUrl(" https://h.example/hermes "), "https://h.example/hermes/kanban");
});

test("showCardArgs: plain ids become arguments; anything a shell or hermes could read differently is refused", () => {
	assert.deepEqual(showCardArgs({ board: "lightscale", card: "t_1a2b" }), ["kanban", "--board", "lightscale", "show", "t_1a2b"]);
	assert.deepEqual(showCardArgs({ card: "t_9.x:y" }), ["kanban", "show", "t_9.x:y"]);
	for (const card of ["x”;calc;”", "a\\';calc;#", "it's", "--help", "a b", "x$(id)", "a&b", ""]) assert.equal(showCardArgs({ card }), undefined, card);
	assert.equal(showCardArgs({ board: "a;b", card: "t_1" }), undefined);
});
