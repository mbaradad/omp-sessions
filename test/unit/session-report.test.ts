import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMeta } from "../../src/shared/protocol";
import { agentState } from "../../src/shared/session-report";

type Queue = NonNullable<SessionMeta["queue"]>;
const meta = (status: SessionMeta["status"]): SessionMeta => ({ id: "s1", cwd: "/r", title: "t", status, pid: 1, socket: "", createdAt: 0, updatedAt: 0, changedFiles: 0 });
const queue = (q: Partial<Queue> = {}): Queue => ({ pending: 0, running: 0, done: 0, total: 0, autoRun: false, ...q });

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
	// A crash or reboot cut work short: blocked until someone restarts it.
	assert.equal(agentState({ meta: meta("stopped"), queue: queue({ pending: 2, interrupted: 1 }) }), "interrupted");
	assert.equal(agentState({ meta: meta("idle"), queue: queue({ pending: 1, interrupted: 1 }) }), "interrupted");
	// A start time set after the interruption is a person's decision: it is scheduled.
	assert.equal(agentState({ meta: meta("stopped"), queue: queue({ pending: 1, interrupted: 1, startAt: 50 }) }, 10), "scheduled");
});
