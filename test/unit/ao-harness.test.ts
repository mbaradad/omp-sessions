import assert from "node:assert/strict";
import { test } from "node:test";
import type { AoClient } from "../../src/ao/client";
import { type AoHarnessInfo, HarnessError, availableHarnesses, isOmpHarness, resolveHarness } from "../../src/ao/harness";

const h = (id: string, authStatus: AoHarnessInfo["authStatus"] = "authorized", usageCount = 0, installed = true): AoHarnessInfo => ({ id, label: id, authStatus, installed, usageCount });
const both = [h("claude-code", "authorized", 9), h("codex", "unknown"), h("omp", "authorized", 2)];

test("resolveHarness: explicit, then Switchyard's default, then the project's worker harness", () => {
	assert.deepEqual(resolveHarness({ explicit: "codex", config: "omp", project: "claude-code", harnesses: both }), { harness: "codex", source: "explicit", reason: "asked for" });
	assert.equal(resolveHarness({ config: "claude-code", project: "omp", harnesses: both }).source, "config");
	assert.equal(resolveHarness({ config: " ", project: "claude-code", harnesses: both }).harness, "claude-code", "a blank default is no default");
	assert.deepEqual([resolveHarness({ project: "claude-code", harnesses: both }).harness, resolveHarness({ project: "claude-code", harnesses: both }).source], ["claude-code", "project"]);
});

test("resolveHarness: AO's default: the only authorized one; several: omp when authorized, else the most used", () => {
	assert.deepEqual(resolveHarness({ harnesses: [h("claude-code"), h("omp", "unauthorized")] }).harness, "claude-code");
	assert.equal(resolveHarness({ harnesses: [h("claude-code"), h("omp", "unauthorized")] }).source, "only");
	const several = resolveHarness({ harnesses: both });
	assert.deepEqual([several.harness, several.source], ["omp", "omp"], "omp even though claude-code has more sessions");
	const noOmp = resolveHarness({ harnesses: [h("codex", "authorized", 1), h("claude-code", "authorized", 5), h("omp", "unknown")] });
	assert.deepEqual([noOmp.harness, noOmp.source], ["claude-code", "usage"]);
	assert.match(noOmp.reason, /most used.*5 sessions/);
	// A tie keeps AO's order.
	assert.equal(resolveHarness({ harnesses: [h("codex"), h("claude-code")] }).harness, "codex");
});

test("resolveHarness: none authorized falls back to the installed ones; none at all is an error", () => {
	const installed = resolveHarness({ harnesses: [h("claude-code", "unknown", 0, false), h("pi", "unknown", 0, true)] });
	assert.deepEqual([installed.harness, installed.source], ["pi", "only"]);
	assert.match(installed.reason, /installed \(none is authorized\)/);
	assert.throws(() => resolveHarness({ harnesses: [h("claude-code", "unknown", 0, false)] }), (err: unknown) => err instanceof HarnessError && /no authorized or installed chat harness.*claude-code \(unknown\)/.test(err.message));
});

test("resolveHarness refuses what is not one of AO's chat harnesses, naming where it came from and listing the available ones", () => {
	assert.throws(() => resolveHarness({ explicit: "aider", harnesses: both }), /^Error: "aider" is not one of AO's chat harnesses; available: claude-code, codex \(unknown\), omp$/);
	assert.throws(() => resolveHarness({ config: "nope", harnesses: both }), /"nope" \(Switchyard's default: switchyard config set harness <id>\|none\) is not one of AO's chat harnesses/);
	assert.throws(() => resolveHarness({ project: "aider", harnesses: both }), /"aider" \(the AO project's worker.agent\)/);
});

test("availableHarnesses: AO's chat harnesses in AO's order, with the catalog's auth status, install state and usage", async () => {
	const client = {
		settings: async () => ({ chatHarnesses: ["omp", "claude-code", "hermes"] }),
		agents: async () => ({
			supported: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized", usageCount: 4, lastUsedAt: "2026-11-01T00:00:00Z" },
				{ id: "omp", label: "OMP", authStatus: "authorized" },
				{ id: "aider", label: "Aider", authStatus: "authorized" },
			],
			installed: [{ id: "omp", label: "OMP" }],
			authorized: [],
		}),
	} as unknown as AoClient;
	assert.deepEqual(await availableHarnesses(client), [
		{ id: "omp", label: "OMP", authStatus: "authorized", installed: true, usageCount: 0 },
		{ id: "claude-code", label: "Claude Code", authStatus: "authorized", installed: false, usageCount: 4, lastUsedAt: "2026-11-01T00:00:00Z" },
		{ id: "hermes", label: "hermes", authStatus: "unknown", installed: false, usageCount: 0 },
	]);
});

test("isOmpHarness: a session with no recorded harness is omp", () => {
	assert.equal(isOmpHarness(undefined), true);
	assert.equal(isOmpHarness("omp"), true);
	assert.equal(isOmpHarness("claude-code"), false);
});
