// The Switchyard Overview in a real VS Code, against an isolated AO daemon and a real planner (run.mjs, usually
// SWITCHYARD_E2E_SUITES=overview with SWITCHYARD_E2E_FAKE_OMP=1: the scripted omp, no tokens). Sets up work of every
// kind through the planner and AO (a session asking a question, one working, a queued task, a scheduled queue, a
// task that waits for it, tasks held by a provider limit, spend against a budget, an orchestrator), opens the
// Overview, the Sessions Board and the Task Graph and takes screenshots (SWITCHYARD_E2E_SHOTS) for a person to look at.
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import type { OmpApi } from "../../../src/ext/api";
import { resolveProject, submitTask } from "../../../src/ao/orchestrator";
import { type PlannerClient, ensurePlanner, stopPlanner } from "../../../src/planner/client";
import type { PlanOp, PlanView, TaskView } from "../../../src/planner/types";

const REPO = fs.realpathSync(process.env.SWITCHYARD_E2E_REPO ?? "");
const EXT_PATH = vscode.extensions.getExtension("mbaradad.switchyard")?.extensionPath ?? "";
const SHOTS = process.env.SWITCHYARD_E2E_SHOTS ?? "";
const HOUR = 3_600_000;
/** Models of the scripted omp's demo catalog (FAKE_OMP_DEMO=1): the planner refuses a model the catalog doesn't list. */
const OPUS = "anthropic/claude-opus-4-5";
const CODEX = "openai/gpt-5.1-codex";

async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(250);
	}
}

function shot(name: string): void {
	if (!SHOTS || !process.env.DISPLAY) return;
	execFileSync("python3", ["-c", "import os,sys; from PIL import ImageGrab; ImageGrab.grab(xdisplay=os.environ['DISPLAY']).save(sys.argv[1])", path.join(SHOTS, `${name}.png`)], { timeout: 20_000 });
}

/** Lets VS Code paint before a screenshot: rendering has no completion signal an extension can await. */
const settle = (ms = 2500) => sleep(ms);

/** A real mouse click on the X display (XTEST), for what the extension API cannot reach inside a webview. */
function click(x: number, y: number): void {
	const script = [
		"import ctypes",
		"x = ctypes.CDLL('libX11.so.6'); t = ctypes.CDLL('libXtst.so.6')",
		"x.XOpenDisplay.restype = ctypes.c_void_p; x.XFlush.argtypes = [ctypes.c_void_p]",
		"t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]",
		"t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]",
		`d = x.XOpenDisplay(None); t.XTestFakeMotionEvent(d, -1, ${x}, ${y}, 0); t.XTestFakeButtonEvent(d, 1, 1, 0); t.XTestFakeButtonEvent(d, 1, 0, 0); x.XFlush(d)`,
	].join("\n");
	if (process.env.DISPLAY) execFileSync("python3", ["-c", script], { timeout: 20_000 });
}

describe("Switchyard Overview", () => {
	let api: OmpApi;
	let planner: PlannerClient;
	const sessions: string[] = [];

	const plan = (): Promise<PlanView> => planner.request("plan", {});
	const byTitle = (p: PlanView, title: string): TaskView | undefined => p.tasks.find(t => t.title === title);
	const edit = (ops: PlanOp[]) => planner.request("edit", { ops });
	const waitPlan = (what: string, pred: (p: PlanView) => boolean, timeoutMs?: number) =>
		waitFor(what, async () => {
			const p = await plan();
			return pred(p) ? p : undefined;
		}, timeoutMs);

	before(async () => {
		const ext = vscode.extensions.getExtension<OmpApi>("mbaradad.switchyard");
		assert.ok(ext, "extension present");
		api = await ext.activate();
		const started = await ensurePlanner(path.join(EXT_PATH, "out", "planner.js"));
		assert.ok(started, "the planner started (isolated SWITCHYARD_HOME)");
		planner = started;
		await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
	});

	after(async () => {
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
		const p = await plan();
		await edit(p.tasks.map((t): PlanOp => ({ op: "remove", id: t.id })).concat(p.lanes.map((l): PlanOp => ({ op: "lane.remove", id: l.id })))).catch(() => undefined);
		await planner.request("scheduler", { set: { maxConcurrent: 0, budget: {} }, clearLimits: true }).catch(() => undefined);
		planner.close();
		await stopPlanner();
	});

	/** A session of the repository, idle. */
	async function launch(title: string): Promise<string> {
		const id = await api.sessions.launch({ cwd: REPO, title });
		sessions.push(id);
		await waitFor(`${title} idle`, () => api.sessions.get(id)?.status === "idle", 120_000);
		return id;
	}

	it("sets up what the page shows: questions, running work, a schedule, a dependency, holds and spend", async () => {
		const ao = await api.ao.client(false);
		const up = await launch("Billing API");
		const down = await launch("Release notes");
		const asking = await launch("Migrate database");
		const indexer = await launch("Rebuild search index");
		await ao.sendMessage(asking, { text: "ask Run the production migration now? | yes | no" });
		await ao.sendMessage(indexer, { text: "slow 600000" });
		await waitFor("the question", () => api.sessions.get(asking)?.status === "waiting");
		await waitFor("the index rebuild working", () => api.sessions.get(indexer)?.status === "working");

		// Spend against the budget, then a provider limit: the task that hit it and the next one on that provider are held.
		await planner.request("scheduler", { set: { budget: { day: 1, week: 5 } } });
		await edit([{ op: "add", task: { title: "Weekly report", notes: "cost 0.55\necho report-ready", options: { cwd: REPO, model: CODEX } } }]);
		await waitPlan("the spend to show", p => byTitle(p, "Weekly report")?.status === "done" && p.status.spend.some(s => s.window === "day" && s.spent > 0.4), 180_000);
		await edit([{ op: "add", task: { title: "Summarize the changelog", notes: "limited 7200 overview-e2e\necho summary", options: { cwd: REPO, model: OPUS } } }]);
		await waitPlan("the provider limit to hold the task that hit it", p => byTitle(p, "Summarize the changelog")?.state === "held" && p.status.limits.some(l => l.provider === "anthropic"), 180_000);
		await edit([{ op: "add", task: { title: "Draft the launch email", notes: "echo draft", options: { cwd: REPO, model: OPUS } } }]);
		await waitPlan("the next task on that provider held", p => byTitle(p, "Draft the launch email")?.state === "held", 60_000);

		// One slot: a task runs, two more wait for it; a queue starts later, and the task after it waits for it.
		await planner.request("scheduler", { set: { maxConcurrent: 1 } });
		await edit([
			{ op: "add", task: { title: "Rotate API keys", notes: "slow 600000", options: { cwd: REPO, model: CODEX } } },
			{ op: "add", task: { title: "Update the docs index", notes: "echo docs", options: { cwd: REPO, model: CODEX } } },
			{ op: "add", task: { title: "Archive old logs", notes: "echo logs", priority: "low", options: { cwd: REPO, model: CODEX } } },
			{ op: "lane.add", id: up, session: up, title: "Billing API", autoRun: false },
			{ op: "lane.add", id: down, session: down, title: "Release notes", autoRun: false },
			{ op: "add", ref: "build", task: { title: "Build the billing endpoints", lane: up } },
			{ op: "add", task: { title: "Write the release notes", lane: down, after: ["@build"] } },
			{ op: "lane.startAt", id: up, at: Date.now() + 2 * HOUR + 10 * 60_000 },
		]);
		const p = await waitPlan(
			"every kind of state",
			x => x.tasks.some(t => t.state === "running") && x.tasks.filter(t => t.state === "waiting").length >= 2 && byTitle(x, "Build the billing endpoints")?.state === "scheduled" && byTitle(x, "Write the release notes")?.state === "blocked",
			180_000,
		);
		assert.equal(p.status.held, 2);
		assert.ok(p.status.limits.some(l => l.provider === "anthropic" && l.until > Date.now()));

		// An orchestrator for the repository's project (its chat is an ordinary session).
		const project = await resolveProject(ao, REPO, "/");
		const sent = await submitTask(ao, project, "Reply with one word.");
		// The Orchestrators view is not on screen here, so its store only reads AO when asked.
		await waitFor("the orchestrator", async () => {
			await api.orchestrators.refresh();
			return api.orchestrators.entry(project.id)?.orchestrator;
		}, 90_000);
		sessions.push(sent.orchestrator);
	});

	it("Switchyard: Open Overview opens one editor tab and shows the same page again", async () => {
		await vscode.commands.executeCommand("switchyard.overview");
		await waitFor("the Overview tab", () => vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.label === "Switchyard Overview"));
		await vscode.commands.executeCommand("workbench.action.maximizeEditorHideSidebar");
		await settle(4000);
		shot("ov-1-overview");
		// Zoomed out so the whole page fits one screenshot: the sections that sit below the fold of this window.
		for (let i = 0; i < 3; i++) await vscode.commands.executeCommand("workbench.action.zoomOut");
		await settle(3000);
		shot("ov-1b-overview-zoomed-out");
		await vscode.commands.executeCommand("workbench.action.zoomReset");
		await vscode.commands.executeCommand("switchyard.overview");
		const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.label === "Switchyard Overview");
		assert.equal(tabs.length, 1, "a second Open Overview reveals the tab instead of opening another");
	});

	it("the Sessions Board and the Task Graph carry the planner state too", async () => {
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
		await vscode.commands.executeCommand("switchyard.board");
		await vscode.commands.executeCommand("workbench.action.maximizeEditorHideSidebar");
		await settle(4000);
		shot("ov-2-board");
		// The graph toggle lives inside the webview, out of the extension API's reach: a real click at its place in the header (screenshot only).
		click(1216, 149);
		await settle(3000);
		shot("ov-2b-board-graph");
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
		await vscode.commands.executeCommand("switchyard.tasks.showGraph");
		await vscode.commands.executeCommand("workbench.action.maximizeEditorHideSidebar");
		await settle(4000);
		shot("ov-3-task-graph");
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
	});

	it("Clear provider limit, the command behind the page's Clear limit button, releases the held tasks", async () => {
		const before = await plan();
		assert.ok(before.status.limits.some(l => l.provider === "anthropic" && l.until > Date.now()));
		await vscode.commands.executeCommand("switchyard.scheduler.clearLimits", "anthropic");
		await waitPlan("the limit cleared and its tasks released", p => !p.status.limits.some(l => l.provider === "anthropic" && l.until > Date.now()), 30_000);
	});
});
