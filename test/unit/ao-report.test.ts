import assert from "node:assert/strict";
import { test } from "node:test";
import type { AoActivity, AoConfigOptions, AoConversation, AoSessionView, AoTurnSettings } from "../../src/ao/client";
import { approvalModeFor, permissionModeOf, planModeOf, questionOf, reportQuestion, sessionModel, sessionReport } from "../../src/ao/model";

const T = "2026-11-09T15:00:00Z";
const view = (v: Partial<AoSessionView> = {}): AoSessionView => ({
	id: "repo-1",
	activity: { state: "idle", lastActivityAt: T },
	autoInjectCI: true,
	autoInjectReview: true,
	autoReviewEnabled: false,
	chatProviderPreserved: true,
	createdAt: T,
	displayStatus: "Awaiting PR",
	isPinned: false,
	isTerminated: false,
	kanbanColumn: "building",
	kind: "worker",
	lastEventAt: T,
	mode: "chat",
	outputType: "none",
	prs: [],
	status: "idle",
	statusReadiness: "ready",
	terminateOnPrMerge: false,
	updatedAt: T,
	provisionState: "ready",
	...v,
});
const conv = (settings: AoTurnSettings): AoConversation => ({
	activities: [],
	branchedFromEarlierMessage: false,
	continueTurnId: "",
	controller: "ready",
	conversationId: "c1",
	hasMoreBefore: false,
	latestSequence: 0,
	messages: [],
	mode: "chat",
	nativeForkAvailableAfterSequence: 0,
	sessionId: "repo-1",
	settings,
	turns: [],
});
const options = (mode: string): AoConfigOptions => ({ options: [{ id: "model", name: "Model", type: "select", currentValue: "x" }, { id: "mode", name: "Mode", type: "select", currentValue: mode }] });

test("permissionModeOf: how omp runs each AO approval mode (ompacp launches write for accept-edits AND auto, yolo for bypass, no flag for default)", () => {
	assert.equal(permissionModeOf({ approvalMode: "accept-edits" }), "edits");
	assert.equal(permissionModeOf({ approvalMode: "auto" }), "edits");
	assert.equal(permissionModeOf({ approvalMode: "bypass-permissions" }), "auto");
	// `default` launches no flag: omp's own tools.approvalMode decides (G12), so the mode is unknown.
	assert.equal(permissionModeOf({ approvalMode: "default" }), undefined);
	assert.equal(permissionModeOf(undefined), undefined);
	// Plan is omp's live `mode` config option; it wins over the launch mode.
	assert.equal(permissionModeOf({ approvalMode: "bypass-permissions" }, true), "plan");
	assert.equal(permissionModeOf({ approvalMode: "default", planMode: true }), "plan");
});

test("planModeOf: omp's live mode config option", () => {
	assert.equal(planModeOf(options("plan")), true);
	assert.equal(planModeOf(options("default")), false);
	assert.equal(planModeOf({ options: [{ id: "model", name: "Model", type: "select", currentValue: "plan" }] }), false);
});

test("approvalModeFor: the launch setting for a permission mode, the inverse of permissionModeOf", () => {
	assert.equal(approvalModeFor("auto"), "bypass-permissions");
	assert.equal(approvalModeFor("edits"), "accept-edits");
	assert.equal(approvalModeFor("ask"), "default");
	assert.equal(approvalModeFor("plan"), "default");
	// What omp then runs: edits and auto survive the round trip (`ask` and `plan` are not readable back from the launch mode).
	for (const mode of ["edits", "auto"] as const) assert.equal(permissionModeOf({ approvalMode: approvalModeFor(mode) }), mode);
});

test("reportQuestion: omp's ask tool is `ask` even with one question; a plain single-field form is not", () => {
	const form = (properties: Record<string, unknown>) => questionOf({ kind: "activity", id: "a", activityKind: "user_input", status: "pending", summary: "Answer 1 question", revision: 0, sequence: 1, createdAt: T, requestId: "r", detail: { schema: { type: "object", properties } } } satisfies AoActivity);
	// As AO receives omp's `ask` with a single question: q0 plus q0__other.
	const one = form({ q0: { title: "Which color?", type: "string", oneOf: [{ const: "red", title: "red" }, { const: "blue", title: "blue" }] }, q0__other: { title: "Other (type your own)", type: "string" } });
	assert.deepEqual(reportQuestion(one), { id: "r", title: "Answer 1 question", kind: "ask", questions: [{ question: "Which color?", options: ["red", "blue"], multi: false }] });
	// A form with no __other companion stays select / confirm / input.
	assert.equal(reportQuestion(form({ env: { type: "string", enum: ["dev", "prod"] } })).kind, "select");
	assert.equal(reportQuestion(form({ ok: { type: "boolean" } })).kind, "confirm");
	assert.equal(reportQuestion(form({ name: { type: "string" } })).kind, "input");
});

test("reportQuestion: omp's one-line title, the rest as the message", () => {
	const write = questionOf({ kind: "activity", id: "a", activityKind: "approval", status: "pending", summary: "Allow tool: write\nPath: perm.txt\nContent:\nhi", revision: 0, sequence: 1, createdAt: T, requestId: "r", detail: { decisions: [{ id: "allow_once" }, { id: "reject_once" }] } } satisfies AoActivity);
	assert.deepEqual(reportQuestion(write), { id: "r", title: "Allow tool: write", message: "Path: perm.txt\nContent:\nhi", kind: "select", options: ["Allow once", "Reject"] });
	// One line: no message. An existing message is kept when the title has no second line.
	const single = questionOf({ kind: "activity", id: "a", activityKind: "user_input", status: "pending", summary: "Name?", revision: 0, sequence: 1, createdAt: T, requestId: "r", detail: { message: "Pick a name for the branch", schema: { type: "object", properties: { n: { type: "string" } } } } } satisfies AoActivity);
	assert.deepEqual(reportQuestion(single), { id: "r", title: "Name?", message: "Pick a name for the branch", kind: "input" });
});

test("sessionReport: project, branch, and the caller's live mode and changed-file count", () => {
	const model = { ...sessionModel(view({ projectId: "repo", branch: "ao/repo-1/root" }), conv({ approvalMode: "default" })), cwd: "/wt/repo-1" };
	const report = sessionReport(model);
	assert.equal(report.project, "repo");
	assert.equal(report.branch, "ao/repo-1/root");
	assert.equal(report.mode, undefined);
	assert.equal(report.changedFiles, 0);
	// The caller read plan from the config options and the manifest elsewhere.
	const live = sessionReport(model, { mode: permissionModeOf({ approvalMode: "default" }, planModeOf(options("plan"))), changedFiles: 3 });
	assert.equal(live.mode, "plan");
	assert.equal(live.changedFiles, 3);
	// A standalone session has no project or branch.
	const standalone = sessionReport(sessionModel(view(), conv({})));
	assert.ok(!("project" in standalone) && !("branch" in standalone));
});
