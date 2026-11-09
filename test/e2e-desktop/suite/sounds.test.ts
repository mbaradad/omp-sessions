// Session sounds in a real VS Code (test/e2e-desktop/run.mjs, SWITCHYARD_E2E_SUITES=sounds, usually with
// SWITCHYARD_E2E_FAKE_OMP=1): an AO session finishes a turn, and the extension asks an open Switchyard webview to play
// the cue. The webviews acknowledge each cue with the state of their Web Audio context and the number of voices
// they started (`OmpApi.onDidPlaySound`), which is how this suite sees the play path run. Covers: no webview open,
// the Sessions Board visible and hidden-but-retained, board and chat open together (one plays), the settings (None,
// volume 0), a question, the Test Completion Sound command (quick pick), and a planner task's finish and failure.
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { sessionReport } from "../../../src/ao/report";
import type { OmpApi } from "../../../src/ext/api";
import { soundClaimsDir } from "../../../src/ext/sound-claims";
import { ensurePlanner } from "../../../src/planner/client";
import { SOUND_VARIANTS, type SoundPlayedMessage } from "../../../src/shared/completion-sound";

const REPO = fs.realpathSync(process.env.SWITCHYARD_E2E_REPO ?? "");
const SHOTS = process.env.SWITCHYARD_E2E_SHOTS ?? "";

async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(200);
	}
}

function shot(name: string): void {
	if (!SHOTS || !process.env.DISPLAY) return;
	execFileSync("python3", ["-c", "import os,sys; from PIL import ImageGrab; ImageGrab.grab(xdisplay=os.environ['DISPLAY']).save(sys.argv[1])", path.join(SHOTS, `${name}.png`)], { timeout: 20_000 });
}

/** A real key press on the X display (XTEST): the first user gesture in the window, which releases the browser's hold on webview audio. */
function pressKey(): void {
	const script = [
		"import ctypes",
		"x = ctypes.CDLL('libX11.so.6'); t = ctypes.CDLL('libXtst.so.6')",
		"x.XOpenDisplay.restype = ctypes.c_void_p; x.XStringToKeysym.restype = ctypes.c_ulong",
		"x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]; x.XFlush.argtypes = [ctypes.c_void_p]",
		"t.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]",
		"d = x.XOpenDisplay(None); kc = x.XKeysymToKeycode(d, x.XStringToKeysym(b'Pause'))",
		"t.XTestFakeKeyEvent(d, kc, 1, 0); t.XTestFakeKeyEvent(d, kc, 0, 0); x.XFlush(d)",
	].join("\n");
	execFileSync("python3", ["-c", script], { timeout: 20_000 });
}

type Webview = { onWebviewMessage(m: unknown): Promise<void> };

const config = () => vscode.workspace.getConfiguration("switchyard");
const setting = (key: string, value: unknown) => config().update(key, value, vscode.ConfigurationTarget.Global);

describe("Session sounds", () => {
	let api: OmpApi;
	let id = "";
	const acks: SoundPlayedMessage[] = [];
	let lastFinish = 0;
	const status = () => api.sessions.get(id)?.status;

	/** A prompt for the scripted omp (test/fake-omp-acp.mjs; `slow` keeps the turn open long enough to be seen): returns once the session went working → idle. */
	async function turn(script: string): Promise<void> {
		await waitFor("idle before the turn", () => status() === "idle");
		// A cue of one kind for one session sounds at most once per 5 s (src/ext/sounds.ts SAME_EVENT_MS: a session's finish and its task's finish are one event).
		await sleep(Math.max(0, lastFinish + 5500 - Date.now()));
		const ao = await api.ao.client(false);
		let finished = false;
		const sub = api.sessions.onDidTransition(({ meta, from }) => {
			if (meta.id === id && from === "working" && meta.status === "idle") finished = true;
		});
		try {
			await ao.sendMessage(id, { text: `slow 700\n${script}` });
			await waitFor("working → idle", () => finished, 60_000);
			lastFinish = Date.now();
		} finally {
			sub.dispose();
		}
	}

	/** The acknowledgements that arrive in the next `ms` (cues are posted right when the transition lands). */
	async function acksDuring(ms: number, run: () => Promise<void>): Promise<SoundPlayedMessage[]> {
		const from = acks.length;
		await run();
		await sleep(ms);
		return acks.slice(from);
	}

	before(async () => {
		const ext = vscode.extensions.getExtension<OmpApi>("mbaradad.switchyard");
		assert.ok(ext, "extension present");
		api = await ext.activate();
		api.onDidPlaySound(a => acks.push(a));
		await waitFor("first session list", () => api.sessions.loaded);
		for (const key of ["sound.completion", "sound.input", "sound.volume"]) await setting(key, undefined);
		id = await api.sessions.launch({ cwd: REPO, title: "sounds" });
		await waitFor("session idle", () => status() === "idle", 120_000);
	});

	after(async () => {
		for (const key of ["sound.completion", "sound.input", "sound.volume"]) await setting(key, undefined);
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
	});

	it("with no Switchyard webview open nothing plays, and the test command says why", async () => {
		const asked: string[] = [];
		const real = vscode.window.showWarningMessage;
		(vscode.window as { showWarningMessage: unknown }).showWarningMessage = async (message: string) => {
			asked.push(message);
			return undefined;
		};
		try {
			await vscode.commands.executeCommand("switchyard.testSound");
		} finally {
			(vscode.window as { showWarningMessage: unknown }).showWarningMessage = real;
		}
		assert.equal(asked.length, 1);
		assert.match(asked[0], /plays its sounds in a Switchyard chat or the Sessions Board/);
		const got = await acksDuring(3000, () => turn("echo first turn, no webview"));
		assert.deepEqual(got, [], "no webview, no cue");
	});

	it("the browser holds webview audio until a first gesture: the cue is dropped (not queued) and the person is told once", async () => {
		await vscode.commands.executeCommand("switchyard.board");
		await sleep(3000);
		const told: string[] = [];
		const real = vscode.window.showInformationMessage;
		(vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (message: string) => {
			// The finish notification is an information message too.
			if (/sound could not play/.test(message)) told.push(message);
			return undefined;
		};
		let got: SoundPlayedMessage[];
		try {
			got = await acksDuring(3000, () => turn("echo before any gesture"));
		} finally {
			(vscode.window as { showInformationMessage: unknown }).showInformationMessage = real;
		}
		assert.equal(got.length, 1, JSON.stringify(got));
		assert.deepEqual({ played: got[0].played, state: got[0].state, voices: got[0].voices }, { played: false, state: "suspended", voices: 0 }, "no gesture yet in this window: the context is held and nothing is scheduled");
		assert.equal(told.length, 1, "told once");
		assert.match(told[0], /clicked or pressed a key in the window once/);
	});

	it("after a key press in the window, a finished turn plays the default completion cue in the open Sessions Board (the play path runs)", async () => {
		pressKey();
		await sleep(1000);
		const got = await acksDuring(4000, () => turn("echo second turn"));
		assert.equal(got.length, 1, JSON.stringify(got));
		assert.equal(got[0].variant, "Two-note comfort");
		assert.equal(got[0].volume, 1);
		assert.equal(got[0].played, true, `a running Web Audio context took the cue: ${JSON.stringify(got[0])}`);
		assert.equal(got[0].state, "running");
		assert.ok(got[0].voices > 0, `voices started: ${got[0].voices}`);
		console.log(`      audio context state in the board webview: ${got[0].state}, voices: ${got[0].voices}`);
		shot("sounds-1-board-visible");
		// Claimed under the AO turn's id (stable for every window), not the per-client updatedAt.
		const claims = fs.readdirSync(soundClaimsDir()).filter(f => f.startsWith(`${id}.complete.`));
		assert.ok(claims.length >= 1, `claim files: ${claims.join(", ")}`);
		const turnId = api.sessions.get(id)?.turnId;
		assert.ok(turnId, "the session record carries its latest turn id");
		assert.ok(claims.includes(`${id}.complete.${turnId}`.replace(/[^\w.-]/g, "_")), `claim key uses the turn: ${claims.join(", ")} vs ${turnId}`);
	});

	it("a hidden board (retainContextWhenHidden) still plays", async () => {
		const boardTab = vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.input instanceof vscode.TabInputWebview && /board/.test(t.input.viewType));
		assert.ok(boardTab, "board tab");
		const column = boardTab.group.viewColumn;
		const doc = await vscode.workspace.openTextDocument({ content: "covers the board\n" });
		await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
		await sleep(1000);
		const tab = vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.input instanceof vscode.TabInputWebview && /board/.test(t.input.viewType));
		assert.equal(tab?.isActive, false, "the board is behind the text editor");
		shot("sounds-2-board-hidden");
		const got = await acksDuring(4000, () => turn("echo third turn, board hidden"));
		assert.equal(got.length, 1, JSON.stringify(got));
		assert.equal(got[0].played, true, JSON.stringify(got[0]));
		assert.ok(got[0].voices > 0);
	});

	it("a chat and the board open together: one cue, not two; a chat the browser still holds silent hands the cue to the board", async () => {
		const panel = api.openPanel(id, "editor");
		assert.ok(panel, "chat opened");
		await waitFor("chat visible", () => panel.isVisible, 10_000);
		await sleep(3000);
		const got = await acksDuring(4000, () => turn("echo fourth turn, chat and board"));
		// The visible chat is tried first; its frame has had no key press of its own, so it answers that its audio is held, and the board plays.
		assert.deepEqual(
			got.map(a => ({ played: a.played, state: a.state })),
			[
				{ played: false, state: "suspended" },
				{ played: true, state: "running" },
			],
			JSON.stringify(got),
		);
		shot("sounds-3-chat-and-board");
		// Once the chat has had a key press too, it plays and the board stays quiet.
		panel.reveal();
		await sleep(1500);
		pressKey();
		await sleep(1000);
		const next = await acksDuring(4000, () => turn("echo fifth turn, chat released"));
		assert.deepEqual(
			next.map(a => ({ played: a.played, state: a.state })),
			[{ played: true, state: "running" }],
			JSON.stringify(next),
		);
	});

	it("settings: None and volume 0 are silent; the volume reaches the webview", async () => {
		await setting("sound.completion", "None");
		assert.deepEqual(await acksDuring(3000, () => turn("echo silent by None")), []);
		await setting("sound.completion", "Glass ping");
		await setting("sound.volume", 0);
		assert.deepEqual(await acksDuring(3000, () => turn("echo silent by volume")), []);
		await setting("sound.volume", 0.5);
		const got = await acksDuring(4000, () => turn("echo audible at half volume"));
		assert.equal(got.length, 1, JSON.stringify(got));
		assert.equal(got[0].variant, "Glass ping");
		assert.equal(got[0].volume, 0.5);
		assert.equal(got[0].played, true, JSON.stringify(got[0]));
	});

	it("a question plays the input cue, then answering and finishing plays the completion cue", async () => {
		await setting("sound.volume", 1);
		await setting("sound.input", "Soft marimba");
		await setting("sound.completion", "Two-note comfort");
		const ao = await api.ao.client(false);
		const panel = api.openPanel(id, "editor");
		assert.ok(panel);
		const got = await acksDuring(4000, async () => {
			await waitFor("idle", () => status() === "idle");
			await ao.sendMessage(id, { text: "ask Which one? | a | b\nslow 1500" });
			await waitFor("a question waiting", () => status() === "waiting", 30_000);
		});
		console.log(`      question acks: ${JSON.stringify(got)}; claims: ${fs.readdirSync(soundClaimsDir()).join(",")}; turnId: ${api.sessions.get(id)?.turnId}; status: ${status()}`);
		assert.equal(got.length, 1, JSON.stringify(got));
		assert.equal(got[0].variant, "Soft marimba", "the input cue");
		const question = sessionReport(api.sessions.model(id)!).question;
		assert.ok(question, "the question is waiting");
		const done = await acksDuring(4000, async () => {
			await (panel as unknown as Webview).onWebviewMessage({ type: "uiResponse", res: { id: question.id, value: "a" } });
			await waitFor("idle after the answer", () => status() === "idle", 60_000);
		});
		assert.equal(done.length, 1, JSON.stringify(done));
		assert.equal(done[0].variant, "Two-note comfort", "the completion cue");
	});

	it("Test Completion Sound: the quick pick plays the current cue, ↓ plays the next, Enter keeps it", async () => {
		await setting("sound.completion", "Two-note comfort");
		const got: SoundPlayedMessage[] = [];
		const sub = api.onDidPlaySound(a => got.push(a));
		try {
			void vscode.commands.executeCommand("switchyard.testSound");
			await waitFor("the current cue previewed", () => got.some(a => a.variant === "Two-note comfort" && a.played), 10_000);
			await sleep(800);
			shot("sounds-4-test-quickpick");
			await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
			const next = SOUND_VARIANTS[SOUND_VARIANTS.indexOf("Two-note comfort") + 1];
			await waitFor(`the next cue (${next}) previewed`, () => got.some(a => a.variant === next && a.played), 10_000);
			await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
			await waitFor("the setting kept", () => config().get("sound.completion") === next, 10_000);
		} finally {
			sub.dispose();
		}
	});

	describe("planner tasks", () => {
		before(async () => {
			await setting("sound.completion", "Two-note comfort");
			await setting("sound.input", "Glass ping");
			assert.ok(await ensurePlanner(path.join(vscode.extensions.getExtension("mbaradad.switchyard")?.extensionPath ?? "", "out", "planner.js")), "the planner is running (isolated SWITCHYARD_HOME)");
		});

		it("a queued task's finish sounds once (the session's finish and the task's finish are one event)", async () => {
			await setting("sound.completion", "Two-note comfort");
			const got = await acksDuring(6000, async () => {
				await waitFor("idle", () => status() === "idle");
				await api.sessions.editQueue(id, [{ op: "add", title: "sound task", notes: "echo task done" }]);
				await waitFor("the task queued", () => (api.sessions.get(id)?.queue?.total ?? 0) >= 1, 30_000);
				await api.sessions.editQueue(id, [{ op: "run" }]);
				await waitFor("the task done", () => api.sessions.get(id)?.queue?.done === 1, 90_000);
			});
			assert.equal(got.length, 1, JSON.stringify(got));
			assert.equal(got[0].variant, "Two-note comfort");
		});

		it("a task whose turn fails sounds the input cue", async () => {
			await setting("sound.completion", "None");
			const got = await acksDuring(8000, async () => {
				await waitFor("idle", () => status() === "idle");
				await api.sessions.editQueue(id, [{ op: "add", title: "failing task", notes: "error boom" }]);
				await waitFor("the task queued", () => (api.sessions.get(id)?.queue?.total ?? 0) >= 2, 30_000);
				await api.sessions.editQueue(id, [{ op: "run" }]);
				await waitFor("the task failed", () => (api.sessions.get(id)?.queue?.failed ?? 0) >= 1, 90_000);
			});
			assert.ok(got.some(a => a.variant === "Glass ping" && a.played), `the input cue sounded: ${JSON.stringify(got)}`);
			assert.ok(!got.some(a => a.variant === "Two-note comfort"), "completion is off");
		});
	});
});
