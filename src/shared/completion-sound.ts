// Completion and needs-input cues, synthesized with Web Audio (no audio files): the VS Code webviews (chat,
// Sessions Board), the phone app and the Hermes omp Sessions page play them. Browser-only at call time;
// importing it is safe anywhere (the names are what the extension and the tests use).
//
// The presets and the signal path are ported from Hermes Desktop's completion sounds
// (apps/desktop/src/lib/completion-sound.ts and audio-context.ts in NousResearch/hermes-agent), so omp sessions
// sound like Hermes turns finishing. Those files carry this license:
//
//   MIT License
//
//   Copyright (c) 2025 Nous Research
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

/** The cue names, in Hermes's order; "None" is silence. package.json's `omp.sound.*` enums list the same names. */
export const SOUND_VARIANTS = [
	"None",
	"Two-note comfort",
	"Glass ping",
	"Soft marimba",
	"Tri-tone message",
	"Airy whoosh",
	"Discovery cluster",
	"Systems online",
	"IBM terminal",
	"Modem chirp",
	"Wind chimes",
	"Singing bowl",
	"Harp lift",
	"Sonar ping",
	"Music box",
] as const;

export type SoundVariant = (typeof SOUND_VARIANTS)[number];

/** Hermes's default turn-end cue. */
export const DEFAULT_COMPLETION_SOUND: SoundVariant = "Two-note comfort";
/** Needs input: short and brighter than the completion cue, so the two are told apart without looking. */
export const DEFAULT_INPUT_SOUND: SoundVariant = "Glass ping";

export function isSoundVariant(v: unknown): v is SoundVariant {
	return typeof v === "string" && (SOUND_VARIANTS as readonly string[]).includes(v);
}

/** A setting value as a cue: unknown names fall back to `fallback`. */
export function soundVariant(v: unknown, fallback: SoundVariant): SoundVariant {
	return isSoundVariant(v) ? v : fallback;
}

/** A volume setting as a 0–1 gain factor (1 = Hermes's level). */
export function soundVolume(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/** What the VS Code extension posts to an omp webview (chat, Sessions Board) to play a cue there. */
export interface PlaySoundMessage {
	type: "sound";
	variant: SoundVariant;
	volume: number;
}

// ---------- audio context ----------

let ctx: AudioContext | null = null;

/** The page's one AudioContext (created lazily), or null where Web Audio is unavailable. */
function audioContext(): AudioContext | null {
	if (typeof window === "undefined") return null;
	try {
		if (!ctx) {
			if (typeof window.AudioContext !== "function") return null;
			ctx = new window.AudioContext();
		}
		// Autoplay policies leave the context suspended until the page had a user gesture; resuming recovers it then.
		if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
		return ctx;
	} catch {
		return null;
	}
}

let unlockInstalled = false;

/**
 * Resumes the audio context on the page's first pointer or key gesture, so cues that arrive later play even
 * where the browser blocks audio until the person interacted with the page (phones, browsers, VS Code for the Web).
 */
export function unlockAudioOnGesture(): void {
	if (unlockInstalled || typeof window === "undefined") return;
	unlockInstalled = true;
	const events = ["pointerdown", "keydown", "touchend"] as const;
	const unlock = (): void => {
		const ac = audioContext();
		if (!ac) return;
		void ac.resume().then(
			() => {
				if (ac.state === "running") for (const e of events) window.removeEventListener(e, unlock, true);
			},
			() => undefined,
		);
	};
	for (const e of events) window.addEventListener(e, unlock, true);
}

// ---------- voices ----------

interface ToneSpec {
	attack?: number;
	dur: number;
	freq: number;
	gain?: number;
	type?: OscillatorType;
}
interface PluckSpec {
	attack?: number;
	decay: number;
	freqFrom: number;
	freqTo: number;
	gain: number;
	glide?: number;
}
interface BloomSpec {
	attack: number;
	decay: number;
	detune?: number;
	freq: number;
	freqTo?: number;
	gain: number;
	hold?: number;
	type?: OscillatorType;
}
interface NoiseSpec {
	decay: number;
	freq: number;
	gain: number;
	q?: number;
}
interface SweepSpec {
	attack?: number;
	decay: number;
	freqFrom: number;
	freqTo: number;
	gain: number;
	q?: number;
	type?: OscillatorType;
}

// One enveloped oscillator voice: a linear attack into an exponential decay keeps the tail smooth, no click.
function voice(ac: AudioContext, master: GainNode, start: number, s: ToneSpec): void {
	const osc = ac.createOscillator();
	const env = ac.createGain();
	const end = start + s.dur;
	osc.type = s.type ?? "sine";
	osc.frequency.setValueAtTime(s.freq, start);
	env.gain.setValueAtTime(0.0001, start);
	env.gain.exponentialRampToValueAtTime(Math.max(s.gain ?? 0.5, 0.0002), start + (s.attack ?? 0.006));
	env.gain.exponentialRampToValueAtTime(0.0001, end);
	osc.connect(env);
	env.connect(master);
	osc.start(start);
	osc.stop(end + 0.02);
}

// Soft pluck: a brief triangle strike gliding upward.
function pluckVoice(ac: AudioContext, master: GainNode, start: number, s: PluckSpec): void {
	const osc = ac.createOscillator();
	const env = ac.createGain();
	const end = start + s.decay;
	osc.type = "triangle";
	osc.frequency.setValueAtTime(s.freqFrom, start);
	osc.frequency.exponentialRampToValueAtTime(s.freqTo, start + (s.glide ?? 0.16));
	env.gain.setValueAtTime(0.0001, start);
	env.gain.exponentialRampToValueAtTime(Math.max(s.gain, 0.0002), start + (s.attack ?? 0.004));
	env.gain.exponentialRampToValueAtTime(0.0001, end);
	osc.connect(env);
	env.connect(master);
	osc.start(start);
	osc.stop(end + 0.02);
}

// Slow-swell harmonic bloom.
function bloomVoice(ac: AudioContext, master: GainNode, start: number, s: BloomSpec): void {
	const osc = ac.createOscillator();
	const env = ac.createGain();
	const hold = s.hold ?? 0.08;
	const end = start + s.attack + hold + s.decay;
	osc.type = s.type ?? "sine";
	osc.frequency.setValueAtTime(s.freq, start);
	if (s.freqTo) osc.frequency.exponentialRampToValueAtTime(s.freqTo, start + s.attack + hold * 0.6);
	osc.detune.setValueAtTime(s.detune ?? 0, start);
	env.gain.setValueAtTime(0.0001, start);
	env.gain.exponentialRampToValueAtTime(Math.max(s.gain, 0.0002), start + s.attack);
	env.gain.setValueAtTime(Math.max(s.gain, 0.0002), start + s.attack + hold);
	env.gain.exponentialRampToValueAtTime(0.0001, end);
	osc.connect(env);
	env.connect(master);
	osc.start(start);
	osc.stop(end + 0.02);
}

function noiseSource(ac: AudioContext, seconds: number): AudioBufferSourceNode {
	const length = Math.floor(ac.sampleRate * seconds);
	const buffer = ac.createBuffer(1, length, ac.sampleRate);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
	const source = ac.createBufferSource();
	source.buffer = buffer;
	return source;
}

// A whisper of bandpassed noise for airiness.
function airPuff(ac: AudioContext, master: GainNode, start: number, s: NoiseSpec): void {
	const source = noiseSource(ac, 0.12);
	const filter = ac.createBiquadFilter();
	const env = ac.createGain();
	const end = start + s.decay;
	filter.type = "bandpass";
	filter.frequency.setValueAtTime(s.freq, start);
	filter.Q.setValueAtTime(s.q ?? 1.2, start);
	env.gain.setValueAtTime(0.0001, start);
	env.gain.exponentialRampToValueAtTime(Math.max(s.gain, 0.0002), start + 0.018);
	env.gain.exponentialRampToValueAtTime(0.0001, end);
	source.connect(filter);
	filter.connect(env);
	env.connect(master);
	source.start(start);
	source.stop(end + 0.02);
}

// Filtered noise sweep: a soft whoosh.
function whooshVoice(ac: AudioContext, master: GainNode, start: number, s: SweepSpec): void {
	const source = noiseSource(ac, 0.4);
	const filter = ac.createBiquadFilter();
	const env = ac.createGain();
	const end = start + s.decay;
	filter.type = "bandpass";
	filter.frequency.setValueAtTime(s.freqFrom, start);
	filter.frequency.exponentialRampToValueAtTime(s.freqTo, end);
	filter.Q.setValueAtTime(s.q ?? 0.8, start);
	env.gain.setValueAtTime(0.0001, start);
	env.gain.exponentialRampToValueAtTime(Math.max(s.gain, 0.0002), start + 0.03);
	env.gain.exponentialRampToValueAtTime(0.0001, end);
	source.connect(filter);
	filter.connect(env);
	env.connect(master);
	source.start(start);
	source.stop(end + 0.02);
}

// Pitch-sweep chirp.
function sweepVoice(ac: AudioContext, master: GainNode, start: number, s: SweepSpec): void {
	const osc = ac.createOscillator();
	const env = ac.createGain();
	const end = start + s.decay;
	osc.type = s.type ?? "triangle";
	osc.frequency.setValueAtTime(s.freqFrom, start);
	osc.frequency.exponentialRampToValueAtTime(s.freqTo, end - 0.02);
	env.gain.setValueAtTime(0.0001, start);
	env.gain.exponentialRampToValueAtTime(Math.max(s.gain, 0.0002), start + (s.attack ?? 0.003));
	env.gain.exponentialRampToValueAtTime(0.0001, end);
	osc.connect(env);
	env.connect(master);
	osc.start(start);
	osc.stop(end + 0.02);
}

let reverbImpulse: AudioBuffer | null = null;

// A subtle room: the impulse is generated once; each cue gets a fresh convolver.
function makeReverb(ac: AudioContext): ConvolverNode {
	if (!reverbImpulse) {
		const length = Math.floor(ac.sampleRate * 1.6);
		reverbImpulse = ac.createBuffer(2, length, ac.sampleRate);
		for (let channel = 0; channel < 2; channel++) {
			const data = reverbImpulse.getChannelData(channel);
			for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6;
		}
	}
	const convolver = ac.createConvolver();
	convolver.buffer = reverbImpulse;
	return convolver;
}

// Equal-temperament notes, low-mid register so the cues feel warm rather than arcade-y.
const A2 = 110;
const A3 = 220;
const A4 = 440;
const A5 = 880;
const B5 = 987.77;
const C3 = 130.81;
const C4 = 261.63;
const E4 = 329.63;
const E5 = 659.25;
const E6 = 1318.51;
const G4 = 392;
const G5 = 783.99;
const C5 = 523.25;
const C6 = 1046.5;

type Play = (ac: AudioContext, master: GainNode, t0: number) => void;

const PLAYERS: Record<Exclude<SoundVariant, "None">, Play> = {
	"Two-note comfort": (ac, m, t0) => {
		voice(ac, m, t0, { freq: E4, dur: 0.22, gain: 0.05, attack: 0.03 });
		voice(ac, m, t0 + 0.08, { freq: C4, dur: 0.52, gain: 0.07, attack: 0.08 });
		voice(ac, m, t0 + 0.08, { freq: C3, dur: 0.46, gain: 0.02, attack: 0.1 });
	},
	"Glass ping": (ac, m, t0) => {
		voice(ac, m, t0, { freq: C6, dur: 0.55, gain: 0.032, attack: 0.002 });
		voice(ac, m, t0 + 0.01, { freq: E5, dur: 0.42, gain: 0.018, attack: 0.004 });
		airPuff(ac, m, t0, { freq: 3200, gain: 0.004, decay: 0.1, q: 1.4 });
	},
	"Soft marimba": (ac, m, t0) => {
		pluckVoice(ac, m, t0, { freqFrom: E5, freqTo: G5, gain: 0.03, decay: 0.14, glide: 0.08 });
		bloomVoice(ac, m, t0 + 0.04, { freq: C5, gain: 0.028, attack: 0.08, hold: 0.04, decay: 0.62 });
		bloomVoice(ac, m, t0 + 0.06, { freq: G4, gain: 0.014, attack: 0.12, hold: 0.06, decay: 0.55 });
	},
	"Tri-tone message": (ac, m, t0) => {
		voice(ac, m, t0, { freq: C6, dur: 0.14, gain: 0.045, attack: 0.004 });
		voice(ac, m, t0 + 0.1, { freq: A5, dur: 0.16, gain: 0.04, attack: 0.004 });
		voice(ac, m, t0 + 0.2, { freq: G5, dur: 0.22, gain: 0.035, attack: 0.006 });
	},
	"Airy whoosh": (ac, m, t0) => {
		whooshVoice(ac, m, t0, { freqFrom: 4200, freqTo: 900, gain: 0.022, decay: 0.28, q: 0.7 });
		voice(ac, m, t0 + 0.12, { freq: A5, dur: 0.35, gain: 0.02, attack: 0.02 });
	},
	"Discovery cluster": (ac, m, t0) => {
		[-14, -5, 0, 7, 12].forEach((detune, i) => bloomVoice(ac, m, t0 + i * 0.03, { freq: A3, gain: 0.012, attack: 0.38, hold: 0.12, decay: 1.05, detune }));
		bloomVoice(ac, m, t0 + 0.1, { freq: E4, gain: 0.008, attack: 0.45, hold: 0.08, decay: 0.9, detune: 3 });
	},
	"Systems online": (ac, m, t0) => {
		voice(ac, m, t0, { freq: C5, dur: 0.16, gain: 0.04, attack: 0.006 });
		voice(ac, m, t0 + 0.09, { freq: G5, dur: 0.28, gain: 0.042, attack: 0.008 });
		voice(ac, m, t0 + 0.09, { freq: C4, dur: 0.24, gain: 0.012, attack: 0.01 });
	},
	"IBM terminal": (ac, m, t0) => {
		voice(ac, m, t0, { freq: B5, dur: 0.12, gain: 0.038, attack: 0.002, type: "square" });
		voice(ac, m, t0 + 0.14, { freq: E5, dur: 0.1, gain: 0.028, attack: 0.002, type: "square" });
	},
	"Modem chirp": (ac, m, t0) => {
		sweepVoice(ac, m, t0, { freqFrom: 320, freqTo: 2200, gain: 0.024, decay: 0.16, type: "triangle" });
		sweepVoice(ac, m, t0 + 0.1, { freqFrom: 480, freqTo: 1400, gain: 0.014, decay: 0.12, type: "sine" });
	},
	"Wind chimes": (ac, m, t0) => {
		[G5, C6, E5, A5].forEach((freq, i) => voice(ac, m, t0 + i * 0.13, { freq, dur: 0.72, gain: 0.028 - i * 0.003, attack: 0.003 }));
	},
	"Singing bowl": (ac, m, t0) => {
		bloomVoice(ac, m, t0, { freq: A3, gain: 0.022, attack: 0.58, hold: 0.16, decay: 1.35 });
		bloomVoice(ac, m, t0 + 0.08, { freq: E4, gain: 0.01, attack: 0.62, hold: 0.12, decay: 1.2, detune: 4 });
		bloomVoice(ac, m, t0 + 0.14, { freq: A4, gain: 0.006, attack: 0.68, hold: 0.08, decay: 1.05, detune: -3 });
	},
	"Harp lift": (ac, m, t0) => {
		[C5, E5, G5, C6].forEach((freq, i) => voice(ac, m, t0 + i * 0.075, { freq, dur: 0.38, gain: 0.034 - i * 0.004, attack: 0.012 }));
		bloomVoice(ac, m, t0 + 0.2, { freq: C4, gain: 0.01, attack: 0.18, hold: 0.06, decay: 0.7 });
	},
	"Sonar ping": (ac, m, t0) => {
		voice(ac, m, t0, { freq: A2, dur: 0.95, gain: 0.036, attack: 0.008 });
		voice(ac, m, t0 + 0.42, { freq: A3, dur: 0.55, gain: 0.014, attack: 0.01 });
		airPuff(ac, m, t0, { freq: 600, gain: 0.005, decay: 0.2, q: 0.5 });
	},
	"Music box": (ac, m, t0) => {
		[E6, C6, G5, E5].forEach((freq, i) => pluckVoice(ac, m, t0 + i * 0.09, { freqFrom: freq, freqTo: freq * 0.998, gain: 0.02 - i * 0.002, decay: 0.2, glide: 0.06 }));
	},
};

/**
 * Plays a cue at `volume` (0–1, 1 = Hermes's level). Returns whether it was scheduled: false for "None", a zero
 * volume or no Web Audio. A context the browser still holds suspended plays the cue once it resumes.
 */
export function playSound(variant: SoundVariant, volume = 1): boolean {
	if (variant === "None" || volume <= 0) return false;
	const ac = audioContext();
	if (!ac) return false;
	// Voices → master → low-pass → dry + reverb send → out.
	const now = ac.currentTime;
	const master = ac.createGain();
	const tone = ac.createBiquadFilter();
	tone.type = "lowpass";
	tone.frequency.setValueAtTime(3800, now);
	tone.Q.setValueAtTime(0.32, now);
	master.gain.setValueAtTime(0.48 * Math.min(1, volume), now);
	master.connect(tone);
	const dry = ac.createGain();
	dry.gain.setValueAtTime(0.88, now);
	tone.connect(dry);
	dry.connect(ac.destination);
	const wet = ac.createGain();
	wet.gain.setValueAtTime(0.34, now);
	const reverb = makeReverb(ac);
	tone.connect(reverb);
	reverb.connect(wet);
	wet.connect(ac.destination);
	PLAYERS[variant](ac, master, now + 0.01);
	return true;
}
