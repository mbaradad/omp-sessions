import assert from "node:assert/strict";
import { test } from "node:test";
import { hermesOrigin, isHermesTag, kanbanUrl, originLabel, showCardCommand } from "../../src/shared/hermes-origin";

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

test("labels, plain tags, dashboard URL and terminal command", () => {
	const o = { board: "lightscale", card: "t_1a2b" };
	assert.equal(originLabel(o), "Hermes · lightscale · t_1a2b");
	assert.equal(originLabel({}), "Hermes");
	assert.deepEqual(["hermes", "hermes:lightscale", "card:t_1a2b", "bug"].filter(t => !isHermesTag(t, o)), ["bug"]);
	assert.deepEqual(["hermes", "card:x"].filter(t => !isHermesTag(t, {})), ["card:x"], "card tags stay when not the lane's");
	assert.equal(kanbanUrl("http://localhost:9119/"), "http://localhost:9119/kanban");
	assert.equal(kanbanUrl(" https://h.example/hermes "), "https://h.example/hermes/kanban");
	assert.equal(showCardCommand("/home/me/.local/bin/hermes", { ...o }, "linux"), "/home/me/.local/bin/hermes kanban --board lightscale show t_1a2b");
	assert.equal(showCardCommand("hermes", { card: "it's" }, "darwin"), "hermes kanban show 'it'\\''s'");
	// Native Windows: a PowerShell command; the path and values are double-quoted with `, " and $ escaped.
	assert.equal(showCardCommand("C:\\Users\\Me Too\\AppData\\Local\\hermes\\bin\\hermes.exe", { ...o }, "win32"), '& "C:\\Users\\Me Too\\AppData\\Local\\hermes\\bin\\hermes.exe" kanban --board "lightscale" show "t_1a2b"');
	assert.equal(showCardCommand("hermes", { board: "a$b", card: 'x"`y' }, "win32"), '& "hermes" kanban --board "a`$b" show "x`"``y"');
});
