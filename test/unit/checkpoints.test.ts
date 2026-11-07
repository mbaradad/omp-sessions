import assert from "node:assert/strict";
import { test } from "node:test";
import { findPrompt, lastPrompt, planCheckpoint } from "../../src/shared/checkpoints";
import type { FileChange } from "../../src/shared/protocol";

const user = (text: string, attribution?: string) => ({ role: "user", content: [{ type: "text", text }], ...(attribution ? { attribution } : {}) });
const call = (...ids: string[]) => ({ role: "assistant", content: ids.map(id => ({ type: "toolCall", id, name: "edit" })) });
const change = (toolCallId: string, timestamp: number, ...files: Array<[string, string | null, string | null]>): FileChange => ({
	toolCallId,
	toolName: "edit",
	timestamp,
	files: files.map(([path, before, after]) => ({ path, op: before === null ? "create" : after === null ? "delete" : "update", before, after })),
});

const messages = [user("first"), call("c1"), user("second"), call("c2", "c3"), user("nudge", "agent"), call("c4"), user("second")];

test("finds the last prompt with that text; agent-authored messages are never checkpoints", () => {
	assert.equal(findPrompt(messages, "second"), 6);
	assert.equal(findPrompt(messages, "  first \n"), 0);
	assert.equal(findPrompt(messages, "nudge"), -1);
	assert.equal(lastPrompt(messages), 6);
	assert.equal(lastPrompt([user("x"), call("c"), user("auto", "agent")]), 0);
});

test("a truncated text matches by its first 200 characters", () => {
	const long = "x".repeat(300);
	assert.equal(findPrompt([user(long)], long.slice(0, 250)), 0);
});

test("restores every file changed after the prompt to its content before the first change", () => {
	const changes = [change("c1", 1, ["/a", "a0", "a1"]), change("c2", 2, ["/a", "a1", "a2"], ["/new", null, "n1"]), change("c3", 3, ["/a", "a2", "a3"]), change("c4", 4, ["/b", "b0", null])];
	const plan = planCheckpoint(messages, changes, 2);
	assert.deepEqual(
		plan.files.sort((x, y) => x.path.localeCompare(y.path)),
		[
			{ path: "/a", before: "a1", after: "a3" },
			{ path: "/b", before: "b0", after: null },
			{ path: "/new", before: null, after: "n1" },
		],
	);
	assert.deepEqual(planCheckpoint(messages, changes, 6).files, [], "nothing after the last prompt");
});

test("files edited back to their original content are left alone", () => {
	const plan = planCheckpoint([user("p"), call("c1", "c2")], [change("c1", 1, ["/a", "a0", "a1"]), change("c2", 2, ["/a", "a1", "a0"])], 0);
	assert.deepEqual(plan.files, []);
});
