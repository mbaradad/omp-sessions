import assert from "node:assert/strict";
import { test } from "node:test";
import type { AoConversation, AoSessionView } from "../../src/ao/client";
import { type AoSessionModel, sessionModel } from "../../src/ao/model";
import { approvalModeFor, laneQueue, launchFlags, metaOf, permissionModeOf, statusOf } from "../../src/ext/session-view";
import type { LaneView, PlanView, TaskView } from "../../src/planner/types";
import { PERMISSION_MODES } from "../../src/shared/permissions";
import { pairingLink, pairingPending, pairingReady, reachSummary } from "../../src/shared/phone-pairing";

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
	displayName: "fix the parser",
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

const model = (m: Partial<AoSessionModel> = {}): AoSessionModel => ({ ...sessionModel(view()), ...m });

test("statusOf: the five view statuses; queued/scheduled/interrupted read as idle (their detail is elsewhere)", () => {
	assert.equal(statusOf("starting"), "starting");
	assert.equal(statusOf("working"), "working");
	assert.equal(statusOf("needs_input"), "waiting");
	assert.equal(statusOf("stopped"), "stopped");
	for (const s of ["idle", "queued", "scheduled", "interrupted"] as const) assert.equal(statusOf(s), "idle");
});

test("permission modes survive the trip to AO settings and back", () => {
	for (const mode of PERMISSION_MODES) {
		const { approvalMode, plan } = approvalModeFor(mode);
		assert.equal(permissionModeOf({ approvalMode, planMode: plan }), mode, mode);
	}
	// AO's own `auto` launches omp like accept-edits (`--approval-mode write`).
	assert.equal(permissionModeOf({ approvalMode: "auto" }), "edits");
	assert.equal(permissionModeOf({}), undefined);
});

test("launchFlags: model, thinking and mode from old omp arguments; everything else is reported as ignored", () => {
	assert.deepEqual(launchFlags(["--model", "anthropic/sonnet", "--thinking=high", "--approval-mode", "plan", "--no-lsp", "--max-time", "1h"]), {
		model: "anthropic/sonnet",
		effort: "high",
		mode: "plan",
		ignored: ["--no-lsp", "--max-time", "1h"],
	});
	assert.deepEqual(launchFlags(["--approval-mode=yolo"]).ignored, ["--approval-mode yolo"]);
	assert.deepEqual(launchFlags([]), { ignored: [] });
});

test("metaOf: the record the tree and board read", () => {
	const meta = metaOf(model({ state: "working", cost: 0.25, model: "anthropic/sonnet", changedFiles: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }] }), "/ao/worktrees/repo/repo-1", {
		aoSessionId: "repo-1",
		ompSessionId: "abc",
		sessionFile: "/home/u/.omp/agent/sessions/x/abc.jsonl",
	});
	assert.equal(meta.id, "repo-1");
	assert.equal(meta.title, "fix the parser");
	assert.equal(meta.status, "working");
	assert.equal(meta.cwd, "/ao/worktrees/repo/repo-1");
	assert.equal(meta.cost, 0.25);
	assert.equal(meta.changedFiles, 1);
	assert.equal(meta.ompSessionFile, "/home/u/.omp/agent/sessions/x/abc.jsonl");
	assert.equal(meta.exitCode, undefined);
});

test("metaOf: a stop with a reason is an error exit (red icon, exit notification); a plain stop is not", () => {
	assert.equal(metaOf(model({ state: "stopped", exitReason: "provisioning failed" }), "").exitCode, 1);
	assert.equal(metaOf(model({ state: "stopped" }), "").exitCode, undefined);
	// An interrupted turn keeps its reason but is not an exit.
	const interrupted = metaOf(model({ state: "interrupted", exitReason: "The daemon lost this turn while it ran." }), "");
	assert.equal(interrupted.status, "idle");
	assert.equal(interrupted.exitCode, undefined);
	assert.equal(interrupted.exitReason, "The daemon lost this turn while it ran.");
});

test("metaOf: last reply clipped for tooltips; a provider that needs a login is an auth problem; the mode comes from the conversation", () => {
	const conversation = { settings: { approvalMode: "bypass-permissions" }, account: { authenticationState: "required", reauthReason: "token expired" } } as unknown as AoConversation;
	const meta = metaOf(model({ reply: "x".repeat(700), conversation }), "");
	assert.equal(meta.lastText?.length, 601);
	assert.ok(meta.lastText?.endsWith("…"));
	assert.equal(meta.authProblem, "token expired");
	assert.equal(meta.permissionMode, "auto");
});

const lan = { kind: "lan", host: "192.168.1.20", port: 3011, secure: false };
const tunnel = { kind: "tunnel", host: "abc.trycloudflare.com", port: 443, secure: true };

test("pairingLink: AO's v2 offer with every endpoint, base64url in the fragment", () => {
	const link = pairingLink({ enabled: true, hostId: "h_1", password: "pw-123", endpoints: [lan, tunnel] }) ?? "";
	assert.ok(link.startsWith("aomobile://pair#"));
	const fragment = link.slice(link.indexOf("#") + 1);
	assert.doesNotMatch(fragment, /[+/=]/);
	assert.deepEqual(JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")), { v: 2, hostId: "h_1", name: "192.168.1.20", platform: "", endpoints: [lan, tunnel], token: "pw-123" });
});

test("laneQueue: a session's queue summary from the planner lanes that continue it", () => {
	const lane = (l: Partial<LaneView>): LaneView => ({ id: "l_1", autoRun: true, createdAt: 1, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...l });
	const task = (t: Partial<TaskView>): TaskView => ({ id: "t", title: "t", subtasks: [], status: "pending", createdAt: 5, state: "waiting", ...t });
	const plan = {
		rev: 1,
		lanes: [lane({ id: "repo-1", pending: 2, done: 1, total: 3 }), lane({ id: "l_2", session: "repo-1", autoRun: false, startAt: 9000, pending: 1, total: 1 }), lane({ id: "l_3", session: "repo-2", pending: 4, total: 4 })],
		tasks: [task({ id: "a", lane: "repo-1", position: 2, createdAt: 7 }), task({ id: "b", lane: "repo-1", state: "interrupted" }), task({ id: "c", lane: "l_2", state: "scheduled", waitUntil: 8000 }), task({ id: "d", lane: "l_3", position: 1 })],
		recurring: [],
		status: {} as PlanView["status"],
	} satisfies PlanView;
	assert.deepEqual(laneQueue(plan, "repo-1"), { pending: 3, running: 0, done: 1, total: 4, autoRun: true, startAt: 8000, interrupted: 1, waiting: { position: 2, since: 7 } });
	assert.equal(laneQueue(plan, "repo-9"), undefined);
	assert.equal(laneQueue(undefined, "repo-1"), undefined);
});

test("laneQueue: dependencies map planner task ids to sessions; failed tasks are counted", () => {
	const lane = (l: Partial<LaneView>): LaneView => ({ id: "l_1", autoRun: true, createdAt: 1, pending: 0, running: 0, done: 0, failed: 0, total: 0, ...l });
	const task = (t: Partial<TaskView>): TaskView => ({ id: "t", title: "t", subtasks: [], status: "pending", createdAt: 5, state: "waiting", ...t });
	const plan = {
		rev: 1,
		lanes: [lane({ id: "repo-2", pending: 1, total: 1 }), lane({ id: "l_a", session: "repo-1", failed: 1, total: 1 })],
		tasks: [
			task({ id: "b", lane: "repo-2", state: "blocked", after: ["a", "free"], blockedBy: ["a"] }),
			task({ id: "a", lane: "l_a", status: "failed", state: "failed" }),
			task({ id: "free", session: "repo-9", status: "done", state: "done" }),
		],
		recurring: [],
		status: {} as PlanView["status"],
	} satisfies PlanView;
	assert.deepEqual(laneQueue(plan, "repo-2")?.after, ["repo-1", "repo-9"]);
	assert.deepEqual(laneQueue(plan, "repo-2")?.blockedBy, ["repo-1"]);
	assert.equal(laneQueue(plan, "repo-1")?.failed, 1);
	assert.equal(laneQueue(plan, "repo-1")?.after, undefined);
});

test("pairing readiness: no code without an address or a password; pending while the tunnel starts", () => {
	assert.equal(pairingLink({ enabled: true, password: "pw", endpoints: [] }), undefined);
	assert.equal(pairingReady({ enabled: false, password: "pw", endpoints: [lan] }), false);
	assert.equal(pairingReady({ enabled: true, password: "", endpoints: [lan] }), false);
	assert.equal(pairingPending({ enabled: true, endpoints: [] }), true);
	assert.equal(pairingPending({ enabled: true, endpoints: [lan], tunnel: { supported: true, running: true, ready: false } }), true);
	assert.equal(pairingPending({ enabled: true, endpoints: [lan], noPublicTunnel: true, tunnel: { supported: true, running: false, ready: false } }), false);
	assert.equal(pairingPending({ enabled: true, endpoints: [lan], tunnel: { supported: true, running: true, ready: false, lastError: "no network" } }), false);
	assert.equal(reachSummary({ enabled: true, endpoints: [lan], tunnel: { supported: false, running: false, ready: false } }), "this network · no public tunnel: cloudflared isn't installed");
	assert.equal(reachSummary({ enabled: true, endpoints: [lan, tunnel] }), "this network · anywhere (Cloudflare tunnel)");
});
