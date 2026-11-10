// package.json's contributions agree with each other: every Switchyard command has a title, every menu entry
// points at a contributed command and a declared view, and the Orchestrators view is gated by its setting.
import assert from "node:assert/strict";
import { test } from "node:test";
import manifest from "../../package.json" with { type: "json" };

interface MenuEntry {
	command?: string;
	when?: string;
}

const contributes = manifest.contributes;
const commands = new Set(contributes.commands.map(c => c.command));
const views = new Set(Object.values(contributes.views).flatMap(list => list.map(v => v.id)));

test("every contributed command has a title and a category; ids are unique", () => {
	assert.equal(commands.size, contributes.commands.length, "duplicate command ids");
	for (const c of contributes.commands) {
		assert.ok(c.title?.trim(), `${c.command} has no title`);
		assert.ok(c.category, `${c.command} has no category`);
	}
});

test("every menu entry names a contributed Switchyard command and, when it says `view ==`, a declared view", () => {
	for (const [menu, entries] of Object.entries(contributes.menus as Record<string, MenuEntry[]>)) {
		for (const e of entries) {
			if (e.command?.startsWith("switchyard.")) assert.ok(commands.has(e.command), `${menu}: ${e.command} is not contributed`);
			const view = e.when && /\bview == (switchyard\.[\w.]+)/.exec(e.when)?.[1];
			if (view) assert.ok(views.has(view), `${menu}: ${e.command} names the unknown view ${view}`);
		}
	}
});

test("the Orchestrators view follows Sessions, is gated by its setting and has its commands in the menus", () => {
	const ids = contributes.views.switchyard.map(v => v.id);
	assert.equal(ids.indexOf("switchyard.orchestrators"), ids.indexOf("switchyard.sessions") + 1);
	const view = contributes.views.switchyard.find(v => v.id === "switchyard.orchestrators");
	assert.equal(view?.when, "config.switchyard.orchestrator.showView");
	assert.equal((contributes.configuration.properties as Record<string, { default?: unknown }>)["switchyard.orchestrator.showView"]?.default, true);
	assert.ok(contributes.viewsWelcome.some(w => w.view === "switchyard.orchestrators"));
	const inView = new Set((contributes.menus as Record<string, MenuEntry[]>)["view/title"].concat((contributes.menus as Record<string, MenuEntry[]>)["view/item/context"]).filter(e => e.when?.includes("view == switchyard.orchestrators")).map(e => e.command));
	for (const id of ["submit", "steer", "openChat", "configure", "restart", "stop", "openInDashboard"]) assert.ok(inView.has(`switchyard.orchestrator.${id}`), id);
	// The palette hides the commands that only make sense with a tree node.
	const hidden = new Set((contributes.menus as Record<string, MenuEntry[]>).commandPalette.filter(e => e.when === "false").map(e => e.command));
	assert.ok(hidden.has("switchyard.orchestrator.openSessionChat") && hidden.has("switchyard.orchestrator.editSetting"));
});
