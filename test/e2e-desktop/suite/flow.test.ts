// The end-to-end flow in a real VS Code, against an isolated AO daemon running the real omp (run.mjs runs it in
// two VS Code instances with the planner staying up in between):
//   phase 1: start a session in Ask mode, chat with it, approve a command, switch to Auto, queue three tasks
//            from the composer (`/queue`) and run the queue; VS Code then closes while the tasks are open;
//   (run.mjs: the planner finishes the three tasks with no VS Code running);
//   phase 2: a new VS Code window finds the tasks done, undoes the last prompt (the files of that turn go
//            away, the others stay), and redoes it (they come back).
// State between the phases is SWITCHYARD_E2E_STATE (JSON). Screenshots go to SWITCHYARD_E2E_SHOTS.
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { sessionReport } from "../../../src/ao/report";
import type { OmpApi } from "../../../src/ext/api";
import { ensurePlanner } from "../../../src/planner/client";
import type { ChatPanel } from "../../../src/ext/panel";

const REPO = fs.realpathSync(process.env.SWITCHYARD_E2E_REPO ?? "");
const SHOTS = process.env.SWITCHYARD_E2E_SHOTS ?? "";
const STATE = process.env.SWITCHYARD_E2E_STATE ?? "";
const PHASE = process.env.SWITCHYARD_E2E_PHASE ?? "1";

async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 180_000): Promise<T> {
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

/** The webview handlers are private; the composer and the dialogs are driven by the messages the webview posts. */
type Webview = { onWebviewMessage(m: unknown): Promise<void> };

interface FlowState {
	id: string;
	cwd: string;
}

describe(`Switchyard flow, phase ${PHASE}`, () => {
	let api: OmpApi;

	before(async () => {
		const ext = vscode.extensions.getExtension<OmpApi>("mbaradad.switchyard");
		assert.ok(ext, "extension present");
		api = await ext.activate();
	});

	if (PHASE === "1") {
		it("start a session in Ask mode, chat, and approve a command from the chat", async () => {
			const id = await api.sessions.launch({ cwd: REPO, title: "flow", mode: "ask" });
			await waitFor("session idle", () => api.sessions.get(id)?.status === "idle");
			const cwd = api.sessions.get(id)?.cwd ?? "";
			fs.writeFileSync(STATE, JSON.stringify({ id, cwd } satisfies FlowState));
			const panel = api.openPanel(id, "editor");
			assert.ok(panel, "chat opened");
			await panel.sendPrompt("Run the shell command: touch approved.txt . Then reply with exactly: APPROVED-OK");
			// Ask mode: the command waits for a person. The question is the chat's approval card.
			const model = await waitFor("an approval waiting", () => {
				const m = api.sessions.model(id);
				return m && /^Allow tool/.test(sessionReport(m).question?.title ?? "") ? m : undefined;
			});
			const question = sessionReport(model).question;
			assert.ok(question, "a question is waiting");
			assert.match(question.title, /touch approved\.txt/);
			assert.equal(api.sessions.get(id)?.status, "waiting");
			assert.ok(!fs.existsSync(path.join(cwd, "approved.txt")), "nothing ran before the approval");
			await sleep(1500);
			shot("flow-1-approval");
			await (panel as unknown as Webview).onWebviewMessage({ type: "uiResponse", res: { id: question.id, value: "Approve" } });
			await waitFor("idle after the approval", () => api.sessions.get(id)?.status === "idle");
			assert.ok(fs.existsSync(path.join(cwd, "approved.txt")), "the approved command ran");
			const reply = sessionReport(api.sessions.model(id)!).reply;
			assert.match(reply ?? "", /APPROVED-OK/);
			await sleep(1000);
			shot("flow-1-chat-reply");
		});

		it("queue three tasks from the composer and run the queue; they are still open when VS Code closes", async () => {
			const { id, cwd } = JSON.parse(fs.readFileSync(STATE, "utf8")) as FlowState;
			// The planner is the user service that starts on demand; the run pins SWITCHYARD_NO_SERVER, which also keeps this window from starting it.
			assert.ok(await ensurePlanner(path.join(vscode.extensions.getExtension("mbaradad.switchyard")?.extensionPath ?? "", "out", "planner.js")), "the planner is running (isolated SWITCHYARD_HOME)");
			await vscode.commands.executeCommand("switchyard.setPermissionMode", id, "auto");
			await waitFor("auto mode", () => api.sessions.get(id)?.permissionMode === "auto", 60_000);
			const panel = api.openPanel(id, "editor");
			assert.ok(panel, "chat open");
			for (const letter of ["a", "b", "c"]) await panel.sendPrompt(`/queue task ${letter.toUpperCase()}: write ${letter}.txt\nCreate ${letter}.txt in the working directory containing exactly: ${letter}`);
			await waitFor("three queued tasks", () => (api.sessions.get(id)?.queue?.total ?? 0) >= 3, 30_000);
			await api.sessions.editQueue(id, [{ op: "run" }]);
			await waitFor("the first task running", () => (api.sessions.get(id)?.queue?.running ?? 0) + (api.sessions.get(id)?.queue?.done ?? 0) >= 1, 120_000);
			assert.ok(!fs.existsSync(path.join(cwd, "c.txt")), "the last task has not run yet when the window closes");
			shot("flow-2-queue-running");
		});
	} else {
		it("a new window finds the three tasks done, undoes the last prompt and redoes it", async () => {
			const { id, cwd } = JSON.parse(fs.readFileSync(STATE, "utf8")) as FlowState;
			await waitFor("the session in the new window", () => api.sessions.get(id), 60_000);
			await waitFor("three tasks done", () => api.sessions.get(id)?.queue?.done === 3, 60_000);
			for (const letter of ["a", "b", "c"]) assert.equal(fs.readFileSync(path.join(cwd, `${letter}.txt`), "utf8").trim(), letter, `${letter}.txt written while VS Code was closed`);
			await vscode.commands.executeCommand("switchyard.tasks.focus");
			await sleep(2000);
			shot("flow-3-tasks-done");
			// Undo asks first in a modal VS Code refuses to show under test: answer it as the person would (Undo), and keep what it said.
			const realWarning = vscode.window.showWarningMessage;
			const asked: string[] = [];
			(vscode.window as { showWarningMessage: unknown }).showWarningMessage = async (message: string, _options: unknown, ...items: string[]) => {
				asked.push(message);
				return items[0];
			};
			let undone: unknown;
			try {
				undone = await vscode.commands.executeCommand("switchyard.undo", id);
			} finally {
				(vscode.window as { showWarningMessage: unknown }).showWarningMessage = realWarning;
			}
			assert.deepEqual(asked, ["Undo the last prompt?"]);
			assert.ok(undone, "undo resolved with omp's result");
			await waitFor("c.txt gone after undo", () => !fs.existsSync(path.join(cwd, "c.txt")), 120_000);
			assert.ok(fs.existsSync(path.join(cwd, "a.txt")) && fs.existsSync(path.join(cwd, "b.txt")), "earlier tasks' files stay");
			shot("flow-4-undone");
			await vscode.commands.executeCommand("switchyard.redo", id);
			await waitFor("c.txt back after redo", () => fs.existsSync(path.join(cwd, "c.txt")), 120_000);
			assert.equal(fs.readFileSync(path.join(cwd, "c.txt"), "utf8").trim(), "c");
		});
	}
});
