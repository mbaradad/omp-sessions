// The AO-backed non-chat surfaces in a real VS Code, against an isolated AO daemon running real omp
// (test/e2e-desktop/views.mjs). Reads the views' state through the API `activate` returns, drives them
// through their commands, and checks AO's side through its HTTP API. Screenshots go to SWITCHYARD_E2E_SHOTS.
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import type { AoClient } from "../../../src/ao/client";
import type { OmpApi } from "../../../src/ext/api";
import type { Node } from "../../../src/ext/tree";
import { writeLauncherSettings } from "../../../src/shared/launch";
import { pairingLink, type PairingStatus } from "../../../src/shared/phone-pairing";
import type { SessionMeta } from "../../../src/shared/protocol";

const REPO = fs.realpathSync(process.env.SWITCHYARD_E2E_REPO ?? "");
const SHOTS = process.env.SWITCHYARD_E2E_SHOTS ?? "";

/** Polls `fn` until truthy: AO state lands through its change stream, with no promise the suite can await. */
async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(250);
	}
}

/** Screenshot of the whole X display (Pillow's XCB grab), for the report. */
function shot(name: string): void {
	if (!SHOTS || !process.env.DISPLAY) return;
	const file = path.join(SHOTS, `${name}.png`);
	execFileSync("python3", ["-c", "import os,sys; from PIL import ImageGrab; ImageGrab.grab(xdisplay=os.environ['DISPLAY']).save(sys.argv[1])", file], { timeout: 20_000 });
}

/** Lets VS Code paint before a screenshot: rendering has no completion signal an extension can await. */
const settle = (ms = 1500) => sleep(ms);

describe("AO views", () => {
	let api: OmpApi;
	let ao: AoClient;
	let id = "";
	const meta = (): SessionMeta | undefined => api.sessions.get(id);

	before(async () => {
		const ext = vscode.extensions.getExtension<OmpApi>("mbaradad.omp-sessions");
		assert.ok(ext, "extension present");
		api = await ext.activate();
		ao = await api.ao.client(false);
	});

	it("connects to the AO daemon from its run file and loads the session list", async () => {
		await waitFor("first session list", () => api.sessions.loaded);
		assert.equal(ao.baseUrl, process.env.SWITCHYARD_E2E_AO_URL);
		assert.deepEqual(api.sessions.all(), [], "fresh daemon: no sessions");
		await vscode.commands.executeCommand("omp.sessions.focus");
	});

	it("omp.newSession starts an omp Chat session in an AO project for the workspace's repository", async () => {
		await vscode.commands.executeCommand("omp.newSession", REPO);
		const created = await waitFor("the new session", () => api.sessions.all()[0]);
		id = created.id;
		const view = await ao.getSession(id);
		assert.equal(view.harness, "omp");
		assert.equal(view.mode, "chat");
		const projects = await ao.listProjects();
		const project = projects.find(p => p.id === view.projectId);
		assert.equal(project && fs.realpathSync(project.path), REPO, "project = the workspace's git root");
		await waitFor("session idle", () => meta()?.status === "idle");
		const m = meta();
		assert.ok(m && m.cwd.includes(path.join("worktrees", view.projectId ?? "")), `runs in AO's worktree: ${m?.cwd}`);
		assert.ok(m && api.sessions.inWorkspace(m), "a worktree of the workspace repo counts as in the workspace");
	});

	it("the Sessions tree groups it under the repository with its status", async () => {
		const roots = await api.sessionTree.getChildren();
		const project = roots.find((n): n is Extract<Node, { kind: "project" }> => n.kind === "project" && fs.realpathSync(n.root) === REPO);
		assert.ok(project, `project node for ${REPO}: ${JSON.stringify(roots.map(r => r.kind))}`);
		assert.ok(project.sessions.some(s => s.id === id));
		const item = api.sessionTree.getTreeItem(project);
		assert.match(String(item.description), /1 session/);
	});

	it("a finished turn while the chat is not in view: working → idle, unread badge, last reply, cost", async () => {
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
		const seen: string[] = [];
		const sub = api.sessions.onDidTransition(({ meta: m, from }) => {
			if (m.id === id) seen.push(`${from}→${m.status}`);
		});
		try {
			await ao.sendMessage(id, { text: "Reply with exactly: PONG" });
			await waitFor("working", () => meta()?.status === "working", 60_000);
			shot("1-tree-working");
			await waitFor("idle again", () => meta()?.status === "idle" && seen.includes("working→idle"), 180_000);
		} finally {
			sub.dispose();
		}
		assert.ok(api.isUnread(id), "marked unread");
		assert.ok((api.sessionsView.badge?.value ?? 0) >= 1, "activity badge");
		await waitFor("last reply", () => meta()?.lastText?.includes("PONG"), 30_000);
		await settle();
		shot("2-tree-finished-unread");
	});

	it("files the agent changed show under the session (its AO worktree vs the base branch)", async () => {
		await ao.sendMessage(id, { text: "Create a file named hello.txt in the current directory containing the single line: hi. Then append the line 'bye' to README.md. Then reply DONE." });
		await waitFor("working", () => meta()?.status === "working", 60_000);
		await waitFor("idle", () => meta()?.status === "idle", 180_000);
		await waitFor("changed-file count", () => (meta()?.changedFiles ?? 0) >= 2, 30_000).catch(async err => {
			const manifest = await ao.workspaceManifest(id).catch(e => String(e));
			throw new Error(`${String(err)}; meta.changedFiles=${meta()?.changedFiles}, model files=${JSON.stringify(api.sessions.model(id)?.changedFiles)}, manifest=${JSON.stringify(typeof manifest === "string" ? manifest : { stale: manifest.stale, refreshing: manifest.refreshing, degraded: manifest.degraded, files: manifest.files.map(f => `${f.path}:${f.status}`) })}`);
		});
		const node = api.sessionTree.findSession(id);
		assert.ok(node, "session node");
		const files = await api.sessionTree.getChildren(node);
		const names = files.flatMap(f => (f.kind === "file" ? [`${path.basename(f.file)}:${f.op}`] : []));
		assert.ok(names.includes("hello.txt:create") && names.includes("README.md:update"), JSON.stringify(names));
		assert.equal(meta()?.changedFiles, files.length);
		await api.sessionsView.reveal(node, { expand: true, select: true });
		await settle();
		shot("3-tree-changed-files");
	});

	it("rename goes to AO and the tree", async () => {
		await api.sessions.rename(id, "views smoke");
		assert.equal((await ao.getSession(id)).displayName, "views smoke");
		await waitFor("renamed record", () => meta()?.title === "views smoke", 10_000);
	});

	it("pin: organize.json and AO's own pin", async () => {
		await vscode.commands.executeCommand("omp.organize.pin", id);
		assert.equal(api.organize.session(id).pinned, true);
		await waitFor("AO pin", async () => (await ao.getSession(id)).isPinned, 10_000);
		const roots = await api.sessionTree.getChildren();
		assert.ok(roots.some(n => n.kind === "section" && n.section === "pinned"), "Pinned section");
	});

	it("the Sessions Board opens with the session's card", async () => {
		await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
		await vscode.commands.executeCommand("omp.board");
		await vscode.commands.executeCommand("workbench.action.maximizeEditorHideSidebar");
		await settle(4000);
		shot("4-board");
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
		await vscode.commands.executeCommand("omp.sessions.focus");
	});

	it("parent-change propagation: a conflicted edge is needs-input (tree, board column); upstream-changed offers Re-run", async () => {
		// The planner's plan is faked here (the real engine is the planner slice's); everything else is the extension.
		const lane = { id, autoRun: true, createdAt: 1, pending: 0, running: 0, done: 1, failed: 0, total: 1 };
		const task = (sync: "conflict" | "upstream-changed") => ({ id: "t1", title: "child", subtasks: [], status: "done", createdAt: 1, state: "done", lane: id, after: ["p1"], sync: { p1: { state: sync, at: 1 } } });
		const edits: unknown[] = [];
		let plan: unknown = { rev: 1, lanes: [lane], tasks: [task("conflict")], recurring: [], status: {} };
		const changed = new vscode.EventEmitter<void>();
		const sub = api.sessions.usePlan({ get plan() { return plan as never; }, onDidChange: changed.event, edit: async ops => void edits.push(...ops) });
		try {
			await waitFor("conflict shown as needs-input", () => meta()?.status === "waiting" && meta()?.queue?.sync?.state === "conflict", 10_000);
			await vscode.commands.executeCommand("omp.board");
			await vscode.commands.executeCommand("workbench.action.maximizeEditorHideSidebar");
			await settle(3000);
			shot("4b-board-conflict");
			plan = { rev: 2, lanes: [lane], tasks: [task("upstream-changed")], recurring: [], status: {} };
			changed.fire();
			await waitFor("back to idle with upstream-changed", () => meta()?.status === "idle" && meta()?.queue?.sync?.state === "upstream-changed", 10_000);
			await settle(2000);
			shot("4c-board-upstream-changed");
			assert.equal(await api.sessions.rerunWithParentChanges(id), 1);
			assert.deepEqual(edits, [{ op: "requeue", id: "t1" }]);
		} finally {
			sub.dispose();
			changed.dispose();
			await vscode.commands.executeCommand("workbench.action.closeAllEditors");
			await vscode.commands.executeCommand("omp.sessions.focus");
		}
	});

	it("stop (exit-agent) and resume (resume-agent) keep the session", async () => {
		await vscode.commands.executeCommand("omp.stopSession", id);
		await waitFor("stopped", () => meta()?.status === "stopped", 60_000);
		assert.equal((await ao.getSession(id)).activity.state, "exited");
		assert.equal((await ao.getSession(id)).isTerminated, false);
		await settle();
		shot("5-tree-stopped");
		await vscode.commands.executeCommand("omp.resumeSession", id);
		await waitFor("resumed", () => meta()?.status === "idle", 120_000);
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
	});

	it("Set Permission Mode: Auto restarts the idle agent with AO bypass-permissions; Plan is omp's live mode option", async () => {
		await vscode.commands.executeCommand("omp.setPermissionMode", id, "auto");
		const conv = await ao.getConversation(id, { limit: 1 });
		assert.equal(conv.settings.approvalMode, "bypass-permissions");
		await waitFor("auto mode", () => meta()?.permissionMode === "auto", 60_000);
		await vscode.commands.executeCommand("omp.setPermissionMode", id, "plan");
		const { data } = await ao.api.GET("/api/v1/sessions/{sessionId}/conversation/config-options", { params: { path: { sessionId: id } } });
		const mode = (data as { options?: Array<{ id: string; currentValue?: string }> } | undefined)?.options?.find(o => o.id === "mode");
		assert.equal(mode?.currentValue, "plan", JSON.stringify(data));
	});

	it("the default permission mode applies to new sessions (AO approvalMode at spawn)", async () => {
		writeLauncherSettings({ mode: "edits" });
		const before = new Set(api.sessions.all().map(m => m.id));
		await vscode.commands.executeCommand("omp.newSession", REPO);
		const other = await waitFor("second session", () => api.sessions.all().find(m => !before.has(m.id)));
		await waitFor("second session idle", () => api.sessions.get(other.id)?.status === "idle");
		assert.equal((await ao.getConversation(other.id, { limit: 1 })).settings.approvalMode, "accept-edits");
		assert.equal(api.sessions.get(other.id)?.permissionMode, "edits");
		writeLauncherSettings({ mode: undefined });
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
		await api.sessions.remove(other.id);
		await waitFor("second session removed", () => !api.sessions.get(other.id), 30_000);
	});

	it("New Session on Branch: an existing free branch is checked out, a new name is made from the default branch", async () => {
		const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		git(REPO, "branch", "side");
		const made: string[] = [];
		try {
			for (const branch of ["side", "brand-new"]) {
				const newId = await api.sessions.launch({ cwd: REPO, title: `on ${branch}`, branch });
				made.push(newId);
				const wt = await waitFor(`${branch} session folder`, () => api.sessions.get(newId)?.cwd || undefined, 30_000);
				assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), branch);
			}
		} finally {
			for (const m of made) {
				await api.sessions.stop(m).catch(() => undefined);
				await api.sessions.remove(m).catch(() => undefined);
			}
		}
	});

	it("Doctor reports the AO daemon, AO's readiness of omp, the planner and the sessions", async () => {
		await vscode.commands.executeCommand("omp.copyDiagnostics");
		const report = await vscode.env.clipboard.readText();
		assert.match(report, new RegExp(`AO daemon running at ${(process.env.SWITCHYARD_E2E_AO_URL ?? "").replace(/[.]/g, "\\.")}`));
		assert.match(report, /AO can run omp/);
		assert.match(report, /## Planner/);
		assert.match(report, /views smoke \(repo-1\)/);
		await vscode.commands.executeCommand("omp.doctor");
		await settle(3000);
		shot("8-doctor");
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
	});

	it("the usage dashboard opens (cost from AO conversations, transcripts by workspace)", async () => {
		await vscode.commands.executeCommand("omp.dashboard");
		await settle(5000);
		shot("9-dashboard");
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
	});

	it("Connect Phone: AO pairing code (aomobile://pair, offer v2) and turning it off", async () => {
		const { response } = await ao.api.POST("/api/v1/mobile/enable-lan-only");
		assert.ok(response.ok, `enable-lan-only: HTTP ${response.status}`);
		const { data } = await ao.api.GET("/api/v1/mobile/status");
		const status = data as PairingStatus;
		const link = pairingLink(status) ?? "";
		assert.ok(link.startsWith("aomobile://pair#"), link);
		const offer = JSON.parse(Buffer.from(link.slice(link.indexOf("#") + 1), "base64url").toString("utf8"));
		assert.equal(offer.v, 2);
		assert.equal(offer.token, status.password);
		assert.ok(offer.endpoints.length > 0);
		// Already on: the command shows the code without asking how to connect.
		await vscode.commands.executeCommand("omp.remote.connectPhone");
		await settle(3000);
		shot("6-connect-phone");
		await vscode.commands.executeCommand("omp.remote.disable");
		const after = (await ao.api.GET("/api/v1/mobile/status")).data as PairingStatus;
		assert.equal(after.enabled, false);
	});

	it("remove: AO keeps a session whose worktree has uncommitted changes, deletes it once they're gone", async () => {
		const cwd = meta()?.cwd ?? "";
		await api.sessions.stop(id);
		await assert.rejects(api.sessions.remove(id), (err: Error) => /uncommitted changes/.test(err.message) && err.message.includes(cwd));
		await waitFor("terminated, still listed", () => meta()?.status === "stopped", 30_000);
		execFileSync("git", ["checkout", "--", "."], { cwd });
		execFileSync("git", ["clean", "-fdq"], { cwd });
		await api.sessions.remove(id);
		await waitFor("gone from the list", () => !meta(), 30_000);
		const { sessions } = await ao.listSessions();
		assert.ok(!sessions.some(s => s.id === id));
		await settle();
		shot("7-tree-empty");
	});
});
