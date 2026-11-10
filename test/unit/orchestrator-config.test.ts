import assert from "node:assert/strict";
import { test } from "node:test";
import { applyConfigPatch } from "../../src/ao/orchestrator";

const base = {
	defaultBranch: "main",
	env: { A: "1" },
	autoReview: true,
	orchestrator: { agent: "omp", agentConfig: { model: "anthropic/claude-sonnet-4-5", permissions: "bypass-permissions" } },
	orchestratorRules: "Be careful.",
	worker: { agent: "codex" },
};

test("applyConfigPatch keeps every setting the patch does not name", () => {
	const next = applyConfigPatch(base, { rules: "Review everything." });
	assert.deepEqual(next, { ...base, orchestratorRules: "Review everything." });
	// The input is never mutated: it is the config AO returned.
	assert.equal(base.orchestratorRules, "Be careful.");
});

test("harness, model, effort and permissions each change alone inside the orchestrator role", () => {
	assert.deepEqual(applyConfigPatch(base, { harness: "claude-code" }).orchestrator, { agent: "claude-code", agentConfig: { model: "anthropic/claude-sonnet-4-5", permissions: "bypass-permissions" } });
	assert.deepEqual(applyConfigPatch(base, { model: "gpt-5" }).orchestrator?.agentConfig, { model: "gpt-5", permissions: "bypass-permissions" });
	assert.deepEqual(applyConfigPatch(base, { effort: "high" }).orchestrator?.agentConfig, { model: "anthropic/claude-sonnet-4-5", permissions: "bypass-permissions", effort: "high" });
	// `null` clears one, `undefined` leaves it.
	assert.deepEqual(applyConfigPatch(base, { model: null, effort: undefined }).orchestrator, { agent: "omp", agentConfig: { permissions: "bypass-permissions" } });
});

test("clearing the last field of a role removes the role", () => {
	const only = { orchestrator: { agent: "omp" }, worker: { agent: "codex", agentConfig: { model: "m" } } };
	assert.equal("orchestrator" in applyConfigPatch(only, { harness: null }), false);
	assert.deepEqual(applyConfigPatch(only, { workerModel: null }).worker, { agent: "codex" });
	assert.equal("worker" in applyConfigPatch(only, { workerHarness: null, workerModel: null }), false);
});

test("a role that did not exist is created by the first field set", () => {
	assert.deepEqual(applyConfigPatch({}, { harness: "omp" }), { orchestrator: { agent: "omp" } });
	assert.deepEqual(applyConfigPatch({}, { permissions: "auto" }), { orchestrator: { agentConfig: { permissions: "auto" } } });
	assert.deepEqual(applyConfigPatch({}, { workerHarness: "codex", workerModel: "m" }), { worker: { agent: "codex", agentConfig: { model: "m" } } });
});

test("rules: text is trimmed, empty or null removes them, the file is separate", () => {
	assert.equal(applyConfigPatch(base, { rules: "  new  " }).orchestratorRules, "new");
	assert.equal("orchestratorRules" in applyConfigPatch(base, { rules: "   " }), false);
	assert.equal("orchestratorRules" in applyConfigPatch(base, { rules: null }), false);
	assert.equal(applyConfigPatch(base, { rulesFile: "docs/orch.md" }).orchestratorRulesFile, "docs/orch.md");
	assert.equal(applyConfigPatch({ ...base, orchestratorRulesFile: "x.md" }, { rulesFile: null }).orchestratorRulesFile, undefined);
});

test("review switches are booleans; null removes them", () => {
	assert.equal(applyConfigPatch(base, { autoReview: false }).autoReview, false);
	assert.equal("autoReview" in applyConfigPatch(base, { autoReview: null }), false);
	assert.equal(applyConfigPatch(base, { workersRequestReview: true }).workersRequestReview, true);
});
