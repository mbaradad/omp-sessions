// The conversation side of checkpoints: `branch` rewinds onto a new transcript file and
// `switch_session` back to the old file is the redo; the host must follow both (meta + mirror).
// Also omp's realtime-voice frames, which reach clients as plain events.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord, launch, textOf } from "./harness";

test("branch rewinds to before a prompt; switch_session to the old transcript brings the turn back", async t => {
	const h = await launch(t);
	const { client: c, snapshot } = await h.connect();
	await c.prompt("echo one");
	await c.prompt("echo two");
	const before = snapshot.meta.ompSessionFile ?? "";
	assert.ok(before, "transcript file known");
	const branchable = await c.rpc({ id: "b1", type: "get_branch_messages" });
	const entries = isRecord(branchable.data) && Array.isArray(branchable.data.messages) ? branchable.data.messages.filter(isRecord) : [];
	const second = entries.find(e => e.text === "echo two");
	assert.ok(second, "second prompt is branchable");

	let from = c.mark();
	const res = await c.rpc({ id: "b2", type: "branch", entryId: String(second.entryId) });
	assert.equal(res.success, true);
	const rewound = await c.waitFor("reset", () => true, from);
	assert.deepEqual(rewound.messages.map(textOf).filter(Boolean), ["echo one", "one"]);
	const branchedFile = (await c.waitFor("meta", m => m.meta.ompSessionFile !== before, from)).meta.ompSessionFile;
	assert.ok(branchedFile && branchedFile !== before);

	from = c.mark();
	const back = await c.rpc({ id: "s1", type: "switch_session", sessionPath: before });
	assert.equal(back.success, true, String(back.error));
	const restored = await c.waitFor("reset", m => m.messages.some(x => textOf(x) === "two"), from);
	assert.deepEqual(restored.messages.map(textOf).filter(Boolean), ["echo one", "one", "echo two", "two"]);
	await c.waitFor("meta", m => m.meta.ompSessionFile === before, from);
});

test("live voice frames reach clients in order and live_stop ends the session", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const from = c.mark();
	const started = await c.rpc({ id: "v1", type: "live_start", voice: "maple" });
	assert.deepEqual(started.data, { voice: "maple" });
	await c.event("live_transcript", ev => ev.role === "assistant", from);
	const stopped = await c.rpc({ id: "v2", type: "live_stop" });
	assert.equal(stopped.success, true);
	await c.event("live_end", () => true, from);
	const phases = c.msgs.slice(from).flatMap(m => (m.t === "event" && m.ev.type === "live_phase" ? [m.ev.phase] : []));
	assert.deepEqual(phases.slice(0, 2), ["connecting", "listening"]);
	assert.ok(phases.includes("speaking"));
});
