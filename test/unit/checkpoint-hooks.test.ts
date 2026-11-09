import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AoClient } from "../../src/ao/client";
import { checkpointHooks } from "../../src/planner/checkpoint-hooks";
import { type CheckpointPrompt, type CheckpointResult, aoCheckpointDir, readState, writeState } from "../../src/shared/checkpoints";

/** A store with `prompts` (id, text, active) and a fake AO whose conversation has one turn per prompt (turn id t<n>). */
function setup(prompts: Array<[string, boolean]>, answer?: (command: string) => Partial<CheckpointResult>) {
	process.env.SWITCHYARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-hooks-"));
	const dir = aoCheckpointDir("s-1");
	const now = Date.now();
	const list: CheckpointPrompt[] = prompts.map(([text, active], i) => ({ id: `e${i + 1}`, text, at: now, active, files: 0 }));
	writeState(dir, { version: 1, ompSessionId: "o", cwd: "/w", updatedAt: now, prompts: list, redo: [] });
	const sent: string[] = [];
	const iso = new Date(now).toISOString();
	const ao = {
		getSession: async () => ({ isTerminated: false, status: "idle", provisionState: "ready", activity: { state: "idle" } }),
		getConversation: async () => ({
			controller: "ready",
			activities: [],
			turns: prompts.map((_, i) => ({ id: `t${i + 1}`, state: "completed", requestedAt: iso })),
			messages: prompts.map(([text], i) => ({ kind: "message", role: "user", turnId: `t${i + 1}`, text })),
		}),
		sendMessage: async (_id: string, body: { text: string }) => {
			sent.push(body.text);
			const state = readState(dir);
			if (state) writeState(dir, { ...state, last: { op: "undo", ok: true, at: Date.now(), message: "Undone.", restored: [], failed: [], merged: [], conflicts: [], ...answer?.(body.text) } });
		},
	} as unknown as AoClient;
	return { hooks: checkpointHooks(async () => ao), sent };
}

test("undone: true only for a finished task whose turn omp rewound", async () => {
	const { hooks } = setup([["first", true], ["second", false]]);
	assert.equal(await hooks.undone({ session: "s-1", turn: "t2" }), true);
	assert.equal(await hooks.undone({ session: "s-1", turn: "t1" }), false);
	assert.equal(await hooks.undone({ session: "s-1" }), false, "no turn recorded");
	assert.equal(await hooks.undone({ session: "other", turn: "t2" }), false, "no checkpoint state for that session");
});

test("rewind undoes the task's turn when it is the session's last prompt", async () => {
	const { hooks, sent } = setup([["first", true], ["second", true]]);
	await hooks.rewind({ session: "s-1", turn: "t2" });
	assert.deepEqual(sent, ["/undo e2"]);
});

test("rewind refuses what would also undo a later prompt, an unknown session and a refused undo; an already undone turn is done", async () => {
	const later = setup([["first", true], ["second", true]]);
	await assert.rejects(later.hooks.rewind({ session: "s-1", turn: "t1" }), /would also undo 1 later prompt/);
	assert.deepEqual(later.sent, []);
	await assert.rejects(later.hooks.rewind({ session: "nope", turn: "t1" }), /no checkpoints/);
	await assert.rejects(later.hooks.rewind({ session: "s-1" }), /no recorded session and turn/);

	const undone = setup([["first", true], ["second", false]]);
	await undone.hooks.rewind({ session: "s-1", turn: "t2" });
	assert.deepEqual(undone.sent, [], "nothing to send: the attempt is already undone");

	const refused = setup([["only", true]], () => ({ ok: false, message: "Nothing undone: a.txt changed since omp edited it, and the changes overlap.", conflicts: ["/w/a.txt", "/w/b/c.ts"] }));
	await assert.rejects(refused.hooks.rewind({ session: "s-1", turn: "t1" }), /changes overlap.*Conflicting files: \/w\/a\.txt, \/w\/b\/c\.ts/);
	assert.deepEqual(refused.sent, ["/undo e1"], "never sent with --force");
});
