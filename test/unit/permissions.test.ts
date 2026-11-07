import assert from "node:assert/strict";
import { test } from "node:test";
import { autoApproval, permissionModeInArgs, withoutApprovalArgs } from "../../src/shared/permissions";

const prompt = (tool: string, options = ["Approve", `Approve ${tool} for this session`, "Deny"]) => ({ id: "r1", method: "select", title: `Allow tool: ${tool}\nPath: a.txt`, options });

test("starting mode: last --approval-mode wins (both spellings), --auto-approve/--yolo only without one", () => {
	assert.equal(permissionModeInArgs(["--approval-mode", "always-ask", "--approval-mode=write"]), "edits");
	assert.equal(permissionModeInArgs(["--yolo"]), "auto");
	assert.equal(permissionModeInArgs(["--auto-approve", "--approval-mode", "plan"]), "plan");
	assert.equal(permissionModeInArgs(["--approval-mode", "always-ask-cached"]), "ask");
	assert.equal(permissionModeInArgs(["--approval-mode", "bogus"]), undefined);
	assert.equal(permissionModeInArgs(["--model", "x"]), undefined);
});

test("approval flags are stripped, everything else kept in order", () => {
	assert.deepEqual(withoutApprovalArgs(["--model", "m", "--approval-mode", "yolo", "--yolo", "--approval-mode=ask", "--auto-approve", "--no-lsp"]), ["--model", "m", "--no-lsp"]);
});

test("each mode's answer to edit vs command approvals", () => {
	const answer = (mode: "ask" | "edits" | "plan" | "auto", tool: string) => autoApproval(mode, prompt(tool))?.value;
	assert.equal(answer("ask", "edit"), undefined);
	assert.equal(answer("ask", "bash"), undefined);
	assert.equal(answer("edits", "write"), "Approve");
	assert.equal(answer("edits", "bash"), undefined);
	assert.equal(answer("plan", "ast_edit"), "Deny");
	assert.equal(answer("plan", "bash"), undefined);
	assert.equal(answer("auto", "bash"), "Approve");
	assert.equal(answer("auto", "mcp__github__create_issue"), "Approve");
});

test("grant-style prompts approve once; unknown shapes and non-approval selects go to the person", () => {
	assert.equal(autoApproval("auto", prompt("write", ["Approve a.txt for this session", "Approve Once", "Deny"]))?.value, "Approve Once");
	assert.equal(autoApproval("auto", prompt("write", ["Yes", "No"])), undefined);
	assert.equal(autoApproval("auto", { id: "x", method: "select", title: "Pick a model", options: ["Approve"] }), undefined);
	assert.equal(autoApproval("auto", { id: "x", method: "confirm", title: "Allow tool: bash" }), undefined);
});
