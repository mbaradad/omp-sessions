import assert from "node:assert/strict";
import { test } from "node:test";
import { type AoHarnessInfo, resolveHarness } from "../../src/ao/harness";
import { harnessPickItems, shouldAskHarness } from "../../src/ext/harness-choice";

const h = (id: string, authStatus: AoHarnessInfo["authStatus"], usageCount = 0, label = id): AoHarnessInfo => ({ id, label, authStatus, installed: true, usageCount });
const several = [h("claude-code", "authorized", 5, "Claude Code"), h("omp", "authorized", 2), h("codex", "unauthorized", 9)];

test("shouldAskHarness: asks when AO's default is a guess among several authorized harnesses", () => {
	assert.equal(shouldAskHarness(resolveHarness({ harnesses: several }), several), true);
	const noOmp = [h("claude-code", "authorized", 1), h("codex", "authorized", 3)];
	const choice = resolveHarness({ harnesses: noOmp });
	assert.equal(choice.source, "usage");
	assert.equal(shouldAskHarness(choice, noOmp), true);
});

test("shouldAskHarness: never asks when someone chose or there is nothing to choose from", () => {
	assert.equal(shouldAskHarness(resolveHarness({ config: "codex", harnesses: several }), several), false);
	assert.equal(shouldAskHarness(resolveHarness({ project: "claude-code", harnesses: several }), several), false);
	assert.equal(shouldAskHarness(resolveHarness({ explicit: "omp", harnesses: several }), several), false);
	const one = [h("claude-code", "authorized"), h("omp", "unauthorized")];
	assert.equal(shouldAskHarness(resolveHarness({ harnesses: one }), one), false);
	// None authorized: AO's default over the installed ones, still not a choice to offer.
	const none = [h("omp", "unauthorized"), h("codex", "unknown")];
	assert.equal(shouldAskHarness(resolveHarness({ harnesses: none }), none), false);
});

test("harnessPickItems: authorized harnesses only, the default first and labelled", () => {
	const items = harnessPickItems(several, { harness: "omp" });
	assert.deepEqual(
		items.map(i => [i.harness, i.label, i.description, i.isDefault]),
		[
			["omp", "omp", "default · 2 sessions", true],
			["claude-code", "Claude Code (claude-code)", "5 sessions", false],
		],
	);
});

test("harnessPickItems: a harness with no sessions has only its default mark", () => {
	const items = harnessPickItems([h("omp", "authorized", 0), h("codex", "authorized", 1)], { harness: "codex" });
	assert.deepEqual(
		items.map(i => [i.harness, i.description]),
		[
			["codex", "default · 1 session"],
			["omp", ""],
		],
	);
});
