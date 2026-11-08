import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMeta, UiRequest } from "../../src/shared/protocol";
import type { SessionInfo } from "../../src/shared/server-protocol";
import { HOST_CRASHED } from "../../src/shared/health";
import { agentState, dialogAnswer, lastReply } from "../../src/shared/session-report";

const meta = (status: SessionMeta["status"]): SessionMeta => ({ id: "s1", cwd: "/r", title: "t", status, pid: 1, socket: "", createdAt: 0, updatedAt: 0, changedFiles: 0 });
const queue = (q: Partial<SessionInfo["queue"]> = {}): SessionInfo["queue"] => ({ pending: 0, running: 0, done: 0, total: 0, autoRun: false, ...q });

test("agentState: what an orchestrating agent should wait for", () => {
	assert.equal(agentState({ meta: meta("waiting"), queue: queue() }), "needs_input");
	assert.equal(agentState({ meta: meta("idle"), queue: queue() }), "idle");
	// The queue continues on its own: not done yet.
	assert.equal(agentState({ meta: meta("idle"), queue: queue({ pending: 2, autoRun: true }) }), "working");
	// Pending tasks with auto-run off and no schedule wait for a person: settled.
	assert.equal(agentState({ meta: meta("idle"), queue: queue({ pending: 1 }) }), "idle");
	assert.equal(agentState({ meta: meta("idle"), queue: queue({ pending: 1, startAt: 5 }) }, 10), "queued");
	// A start time still ahead: nothing happens until then.
	assert.equal(agentState({ meta: meta("idle"), queue: queue({ pending: 1, startAt: 50 }) }, 10), "scheduled");
	assert.equal(agentState({ meta: meta("stopped"), queue: queue({ pending: 1, startAt: 50 }) }, 10), "scheduled");
	assert.equal(agentState({ meta: meta("stopped"), queue: queue({ pending: 1, autoRun: true }) }), "queued");
	assert.equal(agentState({ meta: meta("stopped"), queue: queue({ pending: 1 }) }), "stopped");
	assert.equal(agentState({ meta: meta("idle"), queue: queue({ pending: 1, autoRun: true }), waiting: { position: 1 } }), "queued");
	// A crash or reboot cut work short: blocked until someone restarts it.
	assert.equal(agentState({ meta: meta("stopped"), queue: queue({ pending: 2, interrupted: 1 }) }), "interrupted");
	assert.equal(agentState({ meta: meta("idle"), queue: queue({ pending: 1, interrupted: 1 }) }), "interrupted");
	assert.equal(agentState({ meta: { ...meta("stopped"), exitReason: HOST_CRASHED }, queue: queue() }), "interrupted");
	// A start time set after the interruption is a person's decision: it is scheduled (the server starts it then).
	assert.equal(agentState({ meta: meta("stopped"), queue: queue({ pending: 1, interrupted: 1, startAt: 50 }) }, 10), "scheduled");
	assert.equal(agentState({ meta: { ...meta("stopped"), exitReason: HOST_CRASHED }, queue: queue({ pending: 1, startAt: 50 }) }, 10), "scheduled");
});

test("lastReply takes the newest assistant text from snapshot or transcript entries", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "old" }] },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "text", text: "new" }] } },
		{ role: "toolResult", content: [{ type: "text", text: "output" }] },
		{ role: "user", content: "thanks" },
	];
	assert.equal(lastReply(messages), "new");
	assert.equal(lastReply([{ role: "user", content: "hi" }]), undefined);
	assert.equal(lastReply([{ role: "assistant", content: "x".repeat(50) }], 10), "xxxxxxxxxx\n… (clipped)");
});

test("dialogAnswer turns command-line answers into ui_response payloads", () => {
	const select: UiRequest = { type: "extension_ui_request", id: "a", method: "select", title: "Allow tool: bash", options: ["Approve", "Deny"] };
	assert.deepEqual(dialogAnswer(select, "2"), { res: { value: "Deny" } });
	assert.deepEqual(dialogAnswer(select, "approve"), { res: { value: "Approve" } });
	assert.ok("error" in dialogAnswer(select, "3"));
	const confirm: UiRequest = { type: "extension_ui_request", id: "b", method: "confirm", title: "Sure?" };
	assert.deepEqual(dialogAnswer(confirm, "Yes"), { res: { confirmed: true } });
	assert.ok("error" in dialogAnswer(confirm, "maybe"));
	const input: UiRequest = { type: "extension_ui_request", id: "c", method: "input", title: "Branch", prefill: "main" };
	assert.deepEqual(dialogAnswer(input, ""), { res: { value: "main" } });
	const ask: UiRequest = {
		type: "extension_ui_request",
		id: "d",
		method: "ask",
		questions: [
			{ id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multi: true },
			{ id: "q2", question: "Why?", options: [{ label: "X" }] },
		],
	};
	assert.deepEqual(dialogAnswer(ask, "1,3 | because"), {
		res: {
			answers: [
				{ id: "q1", selectedOptions: ["A", "C"] },
				{ id: "q2", selectedOptions: [], customInput: "because" },
			],
		},
	});
	assert.ok("error" in dialogAnswer(ask, "1"));
});
