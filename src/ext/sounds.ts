// Session sounds in VS Code: a cue when a session finishes its turn or needs input. The extension host may run
// on a remote machine (WSL, SSH), so it never plays audio itself: an open omp webview (chat or Sessions Board,
// which run on the person's computer) synthesizes the cue (src/shared/completion-sound.ts). VS Code has no API
// for extensions to play its accessibility signals, so with no omp webview open nothing sounds.
import * as vscode from "vscode";
import { DEFAULT_COMPLETION_SOUND, DEFAULT_INPUT_SOUND, type PlaySoundMessage, SOUND_VARIANTS, type SoundPlayedMessage, type SoundVariant, soundVariant, soundVolume } from "../shared/completion-sound";
import { type AlertKind, alertFor, alertKey, taskAlertFor } from "../shared/session-alerts";
import type { OmpApi } from "./api";
import type { ChatPanel } from "./panel";
import { claimSound, soundClaimsDir } from "./sound-claims";

/** An omp webview that can play a cue. */
export interface SoundSink {
	readonly visible: boolean;
	/** Resolves false when the webview could not take the message (disposed, not live). */
	post(msg: PlaySoundMessage): Thenable<boolean>;
}

const sinks = new Set<SoundSink>();
const playedEmitter = new vscode.EventEmitter<SoundPlayedMessage>();
/** A webview played (or could not play) a cue: what it reports back. The desktop e2e reads these through `OmpApi.onDidPlaySound`. */
export const onDidPlaySound = playedEmitter.event;

let toldAboutAutoplay = false;

/** Called with a webview's acknowledgement of a cue. */
export function reportSoundPlayed(msg: SoundPlayedMessage): void {
	playedEmitter.fire(msg);
	// The browser engine holds a page's audio until the person has interacted with the window (autoplay policy): say so once.
	if (!msg.played && msg.state === "suspended" && !toldAboutAutoplay) {
		toldAboutAutoplay = true;
		void vscode.window.showInformationMessage("Switchyard's sound could not play yet: VS Code's webviews stay silent until you have clicked or pressed a key in the window once. It works from then on.");
	}
}

/** Offers a webview for playing cues until the returned disposable runs (with the webview). */
export function addSoundSink(sink: SoundSink): vscode.Disposable {
	sinks.add(sink);
	return { dispose: () => sinks.delete(sink) };
}

/** A chat (editor tab or side bar) plays cues while it is open. */
export function addChatSoundSink(panel: ChatPanel): void {
	const sink = addSoundSink({
		get visible() {
			return panel.isVisible;
		},
		post: msg => panel.surface.webview.postMessage(msg),
	});
	panel.onDidDispose(() => sink.dispose());
}

const SETTING: Record<AlertKind, { key: string; fallback: SoundVariant }> = {
	complete: { key: "sound.completion", fallback: DEFAULT_COMPLETION_SOUND },
	input: { key: "sound.input", fallback: DEFAULT_INPUT_SOUND },
};

function configured(kind: AlertKind): SoundVariant {
	const s = SETTING[kind];
	return soundVariant(vscode.workspace.getConfiguration("switchyard").get(s.key), s.fallback);
}

/** Plays in one webview only (two open omp webviews must not both sound): visible ones first. */
async function play(variant: SoundVariant): Promise<boolean> {
	const volume = soundVolume(vscode.workspace.getConfiguration("switchyard").get("sound.volume"));
	const ordered = [...sinks].sort((a, b) => Number(b.visible) - Number(a.visible));
	for (const sink of ordered) {
		if (await sink.post({ type: "sound", variant, volume }).then(ok => ok, () => false)) return true;
	}
	return false;
}

/** Lets the person listen to every cue (↑↓) and keep one for finished turns or for questions. */
async function audition(api: OmpApi, kind: AlertKind): Promise<void> {
	if (!sinks.size) {
		const open = await vscode.window.showWarningMessage(
			"Switchyard plays its sounds in a Switchyard chat or the Sessions Board (VS Code has no API for extensions to play sounds). Open one, then test again.",
			"Open Sessions Board",
		);
		if (open) {
			await vscode.commands.executeCommand("switchyard.board");
			await audition(api, kind);
		}
		return;
	}
	const current = configured(kind);
	const other: AlertKind = kind === "complete" ? "input" : "complete";
	const switchButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon(kind === "complete" ? "bell-dot" : "pass"), tooltip: other === "input" ? "Needs-input sound…" : "Completion sound…" };
	const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { variant: SoundVariant }>();
	qp.title = kind === "complete" ? "Switchyard: sound when a session finishes" : "Switchyard: sound when a session needs input";
	qp.placeholder = "↑↓ to listen, Enter to keep";
	qp.buttons = [switchButton];
	qp.items = SOUND_VARIANTS.map(variant => ({ label: variant, variant, description: variant === current ? "current" : variant === SETTING[kind].fallback ? "default" : undefined }));
	qp.activeItems = qp.items.filter(i => i.variant === current);
	let switching = false;
	qp.onDidChangeActive(([item]) => void (item && play(item.variant)));
	qp.onDidTriggerButton(() => {
		switching = true;
		qp.hide();
	});
	qp.onDidAccept(() => {
		const item = qp.selectedItems[0];
		qp.hide();
		if (item && item.variant !== current) void vscode.workspace.getConfiguration("switchyard").update(SETTING[kind].key, item.variant, vscode.ConfigurationTarget.Global);
	});
	qp.onDidHide(() => {
		qp.dispose();
		if (switching) void audition(api, other);
	});
	qp.show();
	void play(current);
}

/** A session's finish and its planner task's finish are one event: a cue of the same kind within this window sounds once. */
const SAME_EVENT_MS = 5_000;

export function registerSounds(api: OmpApi): void {
	const { sessions } = api;
	const claims = soundClaimsDir();
	const recent = new Map<string, number>();
	/** Plays the cue for `kind` in this window unless it is off, nothing can play it, or another window or source already did. */
	const cue = (kind: AlertKind, sessionId: string, claimKey: string) => {
		const variant = configured(kind);
		// A window that would stay silent (cue off, no omp webview) must not claim the cue from one that sounds.
		if (variant === "None" || soundVolume(vscode.workspace.getConfiguration("switchyard").get("sound.volume")) === 0 || !sinks.size) return;
		const now = Date.now();
		const key = `${sessionId}.${kind}`;
		if (now - (recent.get(key) ?? 0) < SAME_EVENT_MS) return;
		recent.set(key, now);
		if (claimSound(claims, claimKey)) void play(variant);
	};
	api.context.subscriptions.push(
		vscode.commands.registerCommand("switchyard.testSound", () => audition(api, "complete")),
		sessions.onDidTransition(({ meta, from }) => {
			const kind = alertFor(from, meta.status);
			if (kind && sessions.notifies(meta)) cue(kind, meta.id, alertKey(meta.id, kind, meta.turnId, meta.updatedAt));
		}),
		// The planner's tasks add what AO's states do not show: a run that failed or was cut short.
		sessions.onDidTaskTransition(({ task, sessionId, from }) => {
			const kind = taskAlertFor(from, task.state);
			const meta = sessionId ? sessions.get(sessionId) : undefined;
			if (kind && meta && sessions.notifies(meta)) cue(kind, meta.id, alertKey(meta.id, kind, task.turn ?? `task.${task.id}.${task.finishedAt ?? ""}`));
		}),
	);
}
