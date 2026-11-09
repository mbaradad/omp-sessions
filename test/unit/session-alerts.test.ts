import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import manifest from "../../package.json" with { type: "json" };
import { DEFAULT_COMPLETION_SOUND, DEFAULT_INPUT_SOUND, SOUND_VARIANTS, playSound, soundVariant, soundVolume } from "../../src/shared/completion-sound";
import { AlertTracker, alertFor, alertKey, claimAlerts, cueFor, taskAlertFor } from "../../src/shared/session-alerts";
import { claimSound } from "../../src/ext/sound-claims";

test("alertFor: a working session going idle completes; entering needs input asks; nothing else sounds", () => {
	assert.equal(alertFor("working", "idle"), "complete");
	assert.equal(alertFor("working", "needs_input"), "input");
	assert.equal(alertFor("idle", "waiting"), "input");
	assert.equal(alertFor("starting", "needs_input"), "input");
	// A question answered and the turn goes on, or a question re-reported, is not news.
	assert.equal(alertFor("needs_input", "waiting"), undefined);
	assert.equal(alertFor("waiting", "waiting"), undefined);
	assert.equal(alertFor("needs_input", "idle"), undefined);
	// Starting up idle, stopping, queueing for a slot, being interrupted: no turn finished.
	assert.equal(alertFor("starting", "idle"), undefined);
	assert.equal(alertFor("working", "stopped"), undefined);
	assert.equal(alertFor("working", "queued"), undefined);
	assert.equal(alertFor("working", "interrupted"), undefined);
	assert.equal(alertFor("idle", "working"), undefined);
	// First sighting.
	assert.equal(alertFor(undefined, "idle"), undefined);
	assert.equal(alertFor(undefined, "needs_input"), undefined);
});

test("AlertTracker: the first snapshot is the baseline; later ones report transitions with a shared key", () => {
	const t = new AlertTracker();
	assert.deepEqual(t.observe([{ id: "a", state: "working", updatedAt: 1 }, { id: "b", state: "needs_input", updatedAt: 1 }]), []);
	assert.deepEqual(
		t.observe([
			{ id: "a", state: "idle", updatedAt: 5 },
			{ id: "b", state: "needs_input", updatedAt: 6 },
			{ id: "c", state: "needs_input", updatedAt: 6 },
		]),
		[{ id: "a", kind: "complete", key: "a.complete.5" }],
	);
	// A session that left the list and comes back is a first sighting again.
	assert.deepEqual(t.observe([{ id: "b", state: "working" }]), []);
	assert.deepEqual(t.observe([{ id: "a", state: "needs_input" }, { id: "b", state: "needs_input" }]), [{ id: "b", kind: "input", key: "b.input." }]);
});

test("cueFor: one cue per batch, a question outranks a finish", () => {
	assert.equal(cueFor([]), undefined);
	assert.equal(cueFor([{ id: "a", kind: "complete", key: "k1" }]), "complete");
	assert.equal(
		cueFor([
			{ id: "a", kind: "complete", key: "k1" },
			{ id: "b", kind: "input", key: "k2" },
		]),
		"input",
	);
});

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
	const m = new Map<string, string>();
	return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

test("claimAlerts: two pages of one origin play each change once; claims expire", () => {
	const storage = memoryStorage();
	const a = { id: "s", kind: "complete" as const, key: "s.complete.5" };
	const b = { id: "t", kind: "input" as const, key: "t.input.7" };
	assert.deepEqual(claimAlerts(storage, [a], 1000), [a]);
	// The other tab polls the same change later, plus one nobody played yet.
	assert.deepEqual(claimAlerts(storage, [a, b], 3000), [b]);
	assert.deepEqual(claimAlerts(storage, [a], 1000 + 61_000), [a]);
	// No storage (or a broken one): every alert is kept rather than silenced.
	assert.deepEqual(claimAlerts(undefined, [a], 0), [a]);
	const broken = { getItem: () => "{not json", setItem: () => {} };
	assert.deepEqual(claimAlerts(broken, [a], 0), [a]);
});

test("claimSound: only the first VS Code window claims a cue key", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sound-claims-test-"));
	try {
		assert.equal(claimSound(dir, "s1.complete.100", 1000), true);
		assert.equal(claimSound(dir, "s1.complete.100", 1001), false);
		assert.equal(claimSound(dir, "s1.input.100", 1001), true);
		// Stale claims are swept by the next claim.
		const stale = path.join(dir, "old.complete.1");
		fs.writeFileSync(stale, "");
		const past = new Date(Date.now() - 120_000);
		fs.utimesSync(stale, past, past);
		assert.equal(claimSound(dir, "s2.complete.5"), true);
		assert.equal(fs.existsSync(stale), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("sound settings: package.json lists every cue, defaults match Hermes's; bad values fall back", () => {
	const props = manifest.contributes.configuration.properties as Record<string, { enum?: string[]; default?: unknown }>;
	assert.deepEqual(props["switchyard.sound.completion"].enum, [...SOUND_VARIANTS]);
	assert.deepEqual(props["switchyard.sound.input"].enum, [...SOUND_VARIANTS]);
	assert.equal(props["switchyard.sound.completion"].default, DEFAULT_COMPLETION_SOUND);
	assert.equal(DEFAULT_COMPLETION_SOUND, "Two-note comfort");
	assert.equal(props["switchyard.sound.input"].default, DEFAULT_INPUT_SOUND);
	assert.equal(soundVariant("Glass ping", DEFAULT_COMPLETION_SOUND), "Glass ping");
	assert.equal(soundVariant("Ding", DEFAULT_COMPLETION_SOUND), DEFAULT_COMPLETION_SOUND);
	assert.equal(soundVolume(0.4), 0.4);
	assert.equal(soundVolume(7), 1);
	assert.equal(soundVolume(-1), 0);
	assert.equal(soundVolume("loud"), 1);
	// Outside a browser nothing plays (and nothing throws).
	assert.equal(playSound(DEFAULT_COMPLETION_SOUND), false);
	assert.equal(playSound("None"), false);
});

test("taskAlertFor: a finished run completes; a failed or crash-interrupted run needs a person; nothing else sounds", () => {
	assert.equal(taskAlertFor("running", "done"), "complete");
	assert.equal(taskAlertFor("running", "failed"), "input");
	assert.equal(taskAlertFor("running", "interrupted"), "input");
	assert.equal(taskAlertFor("running", "waiting"), undefined);
	assert.equal(taskAlertFor("waiting", "running"), undefined);
	assert.equal(taskAlertFor("waiting", "done"), undefined);
	assert.equal(taskAlertFor(undefined, "failed"), undefined);
});

test("alertKey: the turn makes the key, the same for clients that saw the change at different moments; updatedAt only when no turn is known", () => {
	// Two tabs: the first saw working→idle at updatedAt 5, the second first saw idle at 9 (a later event): same turn, same key.
	const a = new AlertTracker();
	const b = new AlertTracker();
	a.observe([{ id: "s", state: "working", turnId: "t1", updatedAt: 4 }]);
	b.observe([{ id: "s", state: "working", turnId: "t1", updatedAt: 4 }]);
	const first = a.observe([{ id: "s", state: "idle", turnId: "t1", updatedAt: 5 }]);
	const second = b.observe([{ id: "s", state: "idle", turnId: "t1", updatedAt: 9 }]);
	assert.equal(first[0].key, "s.complete.t1");
	assert.equal(second[0].key, first[0].key);
	// With a shared storage only one of the two plays.
	const storage = memoryStorage();
	assert.equal(claimAlerts(storage, first, 1000).length, 1);
	assert.equal(claimAlerts(storage, second, 1500).length, 0);
	// The next turn is a new event; a question is keyed by its own id.
	assert.equal(alertKey("s", "complete", "t2", 11), "s.complete.t2");
	assert.equal(alertKey("s", "input", "req-1", 12), "s.input.req-1");
	assert.equal(alertKey("s", "complete", undefined, 11), "s.complete.11");
	assert.equal(alertKey("s", "complete", null, null), "s.complete.");
	// A planner task event for the same turn derives the session's key: a window that heard the task first and
	// one that heard the session first claim one key (src/ext/sounds.ts passes task.turn).
	assert.equal(alertKey("s", taskAlertFor("running", "done")!, "t1"), first[0].key);
});
