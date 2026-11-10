// The Orchestrators view's decisions (src/ext/orchestrator-core.ts): which projects get a node, what the rows say,
// which project a command means, and what a brief is.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestratorInfo, OrchestratorWorker } from "../../src/ao/orchestrator";
import type { PrFacts } from "../../src/shared/pr-review";
import { UNSET, briefOf, briefPreview, chooseProject, isSettingKey, orchestratorDescription, orchestratorStatus, projectEntries, projectIdFrom, replyLine, settingRows, settingText, workerDescription, workersSummary } from "../../src/ext/orchestrator-core";

const pr = (p: Partial<PrFacts> = {}): PrFacts => ({ number: 12, url: "https://example.test/pull/12", state: "open", ci: "passing", review: "approved", mergeability: "mergeable", reviewComments: false, updatedAt: "2026-11-09T10:00:00Z", ...p });

const worker = (w: Partial<OrchestratorWorker> = {}): OrchestratorWorker => ({ id: "w-1", title: "fix the parser", state: "working", displayStatus: "Working", prs: [], createdAt: 1, updatedAt: 2, ...w });

const info = (o: Partial<OrchestratorInfo> = {}): OrchestratorInfo => ({
	id: "orch-1",
	projectId: "app",
	projectName: "app",
	projectPath: "/work/app",
	harness: "claude-code",
	mode: "chat",
	state: "idle",
	displayStatus: "Idle",
	active: true,
	createdAt: 1,
	updatedAt: 2,
	config: {},
	workers: [],
	counts: { workers: 0, working: 0, needsInput: 0, idle: 0, stopped: 0, openPrs: 0 },
	...o,
});

test("projectEntries: the window's projects first (with or without an orchestrator), then the other projects' orchestrators", () => {
	const a = info({ projectId: "a", projectName: "a", projectPath: "/w/a", id: "o-a", config: { harness: "omp" } });
	const b = info({ projectId: "b", projectName: "b", projectPath: "/w/b", id: "o-b" });
	const mine = [{ id: "c", name: "c", path: "/w/c" }, { id: "a", name: "a", path: "/w/a" }, { id: "c", name: "c", path: "/w/c" }];
	const entries = projectEntries([a, b], mine, new Map([["c", { model: "m" }]]));
	assert.deepEqual(entries.map(e => [e.project.id, e.orchestrator?.id, e.inWorkspace]), [["c", undefined, true], ["a", "o-a", true], ["b", "o-b", false]]);
	assert.deepEqual(entries[0].config, { model: "m" }, "a project without an orchestrator shows the settings its first one starts with");
	assert.deepEqual(entries[1].config, { harness: "omp" }, "with one, the settings it was read with");
	assert.deepEqual(projectEntries([], [], new Map()), []);
});

test("orchestratorDescription: state, workers, workers needing input, open PRs, harness", () => {
	const counts = { workers: 3, working: 1, needsInput: 0, idle: 2, stopped: 0, openPrs: 2 };
	assert.equal(orchestratorDescription(info({ counts })), "idle · 3 workers · 2 open PRs · claude-code");
	assert.equal(orchestratorDescription(info({ counts: { ...counts, workers: 1, openPrs: 1, needsInput: 1 }, state: "working" })), "working · 1 worker · 1 needs input · 1 open PR · claude-code");
	assert.equal(orchestratorDescription(info({ state: "needs_input", harness: undefined })), "needs input · no workers");
	assert.equal(orchestratorDescription(info({ active: false, state: "idle" })), "stopped · no workers · claude-code");
	assert.equal(orchestratorStatus(info({ active: false })), "stopped");
	assert.equal(orchestratorStatus(info({ state: "queued" })), "idle");
});

test("workersSummary and workerDescription: state, branch and the first PR's chip", () => {
	assert.equal(workersSummary({ workers: 5, working: 1, needsInput: 2, idle: 1, stopped: 1, openPrs: 0 }), "1 working · 2 need input · 1 idle · 1 stopped");
	assert.equal(workersSummary({ workers: 0, working: 0, needsInput: 0, idle: 0, stopped: 0, openPrs: 0 }), "");
	assert.equal(workerDescription(worker()), "working");
	assert.equal(workerDescription(worker({ state: "idle", branch: "fix-parser", prs: [pr()] })), "idle · ⎇ fix-parser · #12 open · CI passing · approved · mergeable");
	assert.equal(workerDescription(worker({ state: "needs_input", prs: [pr({ ci: "failing", review: "none", mergeability: "unknown" }), pr({ number: 13 })] })), "needs input · #12 open · CI failing (+1)");
	assert.equal(workerDescription(worker({ state: "stopped", prs: [pr({ state: "merged" })] })), "stopped · #12 merged");
});

test("settingRows: every setting in a fixed order, AO's default where unset, rules by their first line", () => {
	const rows = settingRows({ harness: "claude-code", permissions: "bypass-permissions", rules: "Always ask for review.\nNever force-push.\n\nKeep PRs small.", autoReview: false, workersRequestReview: true });
	assert.deepEqual(rows.map(r => r.key), ["harness", "model", "effort", "permissions", "rules", "rulesFile", "workerHarness", "workerModel", "workersRequestReview", "autoReview"]);
	const by = new Map(rows.map(r => [r.key, r]));
	assert.deepEqual(by.get("harness"), { key: "harness", label: "Harness", value: "claude-code", set: true });
	assert.deepEqual(by.get("model"), { key: "model", label: "Model", value: UNSET, set: false });
	assert.equal(by.get("rules")?.value, "Always ask for review. (+2 lines)");
	assert.equal(by.get("autoReview")?.value, "off");
	assert.equal(by.get("workersRequestReview")?.value, "on");
	assert.equal(settingText("rules", { rules: "x".repeat(80) }), `${"x".repeat(59)}…`);
	assert.equal(settingText("rules", { rules: "one\ntwo" }), "one (+1 line)");
	assert.equal(settingText("model", {}), undefined);
	assert.equal(isSettingKey("rulesFile"), true);
	assert.equal(isSettingKey("projectId"), false);
	assert.equal(isSettingKey(undefined), false);
});

test("projectIdFrom: an id, or a node that carries one", () => {
	assert.equal(projectIdFrom("app"), "app");
	assert.equal(projectIdFrom("  app "), "app");
	assert.equal(projectIdFrom({ kind: "orchWorker", projectId: "app", sessionId: "w-1" }), "app");
	assert.equal(projectIdFrom({ kind: "orchMessage", projectId: "" }), undefined);
	assert.equal(projectIdFrom(""), undefined);
	assert.equal(projectIdFrom(undefined), undefined);
	assert.equal(projectIdFrom({ kind: "session", meta: {} }), undefined);
});

test("chooseProject: the argument, else the window's project, else a pick (the window's projects when there are several, AO's otherwise)", () => {
	assert.deepEqual(chooseProject({ projectId: "n" }, ["w"], ["w", "n"]), { kind: "project", id: "n" });
	assert.deepEqual(chooseProject(undefined, ["w", "w"], ["w", "x"]), { kind: "project", id: "w" });
	assert.deepEqual(chooseProject(undefined, ["w1", "w2"], ["w1", "w2", "x"]), { kind: "pick", ids: ["w1", "w2"] });
	assert.deepEqual(chooseProject(undefined, [], ["x", "y", "x"]), { kind: "pick", ids: ["x", "y"] });
	assert.deepEqual(chooseProject(undefined, [], []), { kind: "none" });
});

test("briefOf and briefPreview: a brief is trimmed, never empty, and says how long it is", () => {
	assert.equal(briefOf("  Move billing to the new API\n", "The file"), "Move billing to the new API");
	assert.throws(() => briefOf(" \n\t", "The selection"), /The selection is empty/);
	assert.equal(briefPreview("Migrate billing\n\nstep 1\nstep 2"), "Migrate billing\n(4 lines, 30 characters)");
	assert.equal(briefPreview("x"), "x\n(1 line, 1 character)");
	assert.equal(briefPreview("y".repeat(100)).split("\n")[0], `${"y".repeat(79)}…`);
});

test("replyLine: one line, clipped", () => {
	assert.equal(replyLine("Started two workers.\n\nWaiting for CI."), "Started two workers. Waiting for CI.");
	assert.equal(replyLine("z".repeat(150)), `${"z".repeat(99)}…`);
});
