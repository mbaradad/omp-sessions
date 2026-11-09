// Session sounds on the omp Sessions page: when a polled session finishes its turn or starts waiting for input,
// the cue Hermes Desktop plays for its own turns (src/shared/completion-sound.ts). A header toggle mutes them;
// the choice is kept in this browser's localStorage.
import { DEFAULT_COMPLETION_SOUND, DEFAULT_INPUT_SOUND, playSound, unlockAudioOnGesture } from "../../../src/shared/completion-sound";
import { AlertTracker, claimAlerts, cueFor, pageStorage } from "../../../src/shared/session-alerts";
import type { Session } from "./api";

const MUTED_KEY = "omp.sound.muted";

export function soundMuted(): boolean {
	return pageStorage()?.getItem(MUTED_KEY) === "1";
}

export function setSoundMuted(muted: boolean): void {
	try {
		if (muted) pageStorage()?.setItem(MUTED_KEY, "1");
		else pageStorage()?.removeItem(MUTED_KEY);
	} catch {
		/* storage full or blocked: this page only */
	}
	// Unmuting is a click: it unlocks audio, and the cue tells what will play.
	if (!muted) playSound(DEFAULT_COMPLETION_SOUND);
}

/** Watches one page's polled sessions; `observe` each fresh list. */
export class SessionSounds {
	private readonly tracker = new AlertTracker();

	constructor() {
		unlockAudioOnGesture();
	}

	observe(sessions: readonly Session[]): void {
		const seen = this.tracker.observe(sessions);
		if (!seen.length || soundMuted()) return;
		// The page may be open twice (two tabs, the dashboard and Desktop on one origin): one plays.
		const kind = cueFor(claimAlerts(pageStorage(), seen));
		if (kind) playSound(kind === "input" ? DEFAULT_INPUT_SOUND : DEFAULT_COMPLETION_SOUND);
	}
}
