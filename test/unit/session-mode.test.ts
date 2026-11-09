import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import switchyardMode from "../../src/omp-extension/mode";
import { APPROVE, APPROVE_SESSION, DENY, type PermissionMode, gateDecision, readMode, writeMode } from "../../src/shared/session-mode";

type Ctx = ReturnType<typeof ctxWith>["ctx"];
type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: Ctx) => Promise<{ block: true; reason: string } | undefined>;

function setup(withMode?: PermissionMode) {
	process.env.SWITCHYARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-mode-"));
	process.env.AO_SESSION_ID = "proj-1";
	if (withMode) writeMode("proj-1", withMode);
	let handler: Handler | undefined;
	switchyardMode({ on: (_event, h) => void (handler = h) });
	return { handler: handler as Handler | undefined };
}

/** A ctx whose dialog answers with `answers` in turn (a function: decides when asked). */
function ctxWith(answer: (title: string, signal?: AbortSignal) => Promise<string | undefined>, kind: "main" | "sub" = "main") {
	const titles: string[] = [];
	return { titles, ctx: { agent: { kind }, hasUI: true, ui: { select: (title: string, _o: string[], d?: { signal?: AbortSignal }) => (titles.push(title), answer(title, d?.signal)) } } };
}

test("the gate table: what each mode lets through, asks about and refuses", () => {
	const row = (mode: PermissionMode) => ["read", "edit", "write", "bash"].map(t => gateDecision(mode, t));
	assert.deepEqual(row("ask"), ["allow", "ask", "ask", "ask"]);
	assert.deepEqual(row("edits"), ["allow", "allow", "allow", "ask"]);
	assert.deepEqual(row("plan"), ["allow", "block", "block", "ask"]);
	assert.deepEqual(row("auto"), ["allow", "allow", "allow", "allow"]);
	assert.deepEqual(["edit", "bash"].map(t => gateDecision("ask", t, true)), ["allow", "allow"], "a subagent can't be asked");
	assert.equal(gateDecision("plan", "edit", true), "block");
});

test("no mode file: the gate does nothing (a session AO's own UI started)", async () => {
	const { handler } = setup();
	const { ctx, titles } = ctxWith(async () => DENY);
	assert.equal(await handler?.({ toolName: "bash", input: { command: "rm -rf /" } }, ctx), undefined);
	assert.deepEqual(titles, []);
});

test("without AO_SESSION_ID the extension registers nothing", () => {
	process.env.SWITCHYARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-mode-"));
	delete process.env.AO_SESSION_ID;
	let registered = false;
	switchyardMode({ on: () => void (registered = true) });
	assert.equal(registered, false);
});

test("ask mode asks; Approve runs the call, Deny blocks it, approve-for-session stops asking for that tool", async () => {
	const { handler } = setup("ask");
	const answers = [APPROVE, DENY, APPROVE_SESSION];
	const { ctx, titles } = ctxWith(async () => answers.shift());
	const call = (tool: string, input: Record<string, unknown>) => handler?.({ toolName: tool, input }, ctx);
	assert.equal(await call("bash", { command: "ls" }), undefined);
	assert.match((await call("edit", { path: "a.txt" }))?.reason ?? "", /Denied/);
	assert.equal(await call("edit", { path: "a.txt" }), undefined);
	assert.equal(await call("edit", { path: "b.txt" }), undefined, "already approved for the session");
	assert.deepEqual(titles, ["Allow tool: bash: ls", "Allow tool: edit: a.txt", "Allow tool: edit: a.txt"]);
	assert.equal(await call("read", { path: "a.txt" }), undefined, "reads never ask");
});

test("plan mode refuses edits without asking; a switch to edits lets them through at once", async () => {
	const { handler } = setup("plan");
	const { ctx, titles } = ctxWith(async () => DENY);
	assert.match((await handler?.({ toolName: "write", input: { path: "a" } }, ctx))?.reason ?? "", /Plan mode/);
	writeMode("proj-1", "edits");
	assert.equal(await handler?.({ toolName: "write", input: { path: "a" } }, ctx), undefined);
	assert.deepEqual(titles, []);
});

test("a question waiting when the mode is rewritten is withdrawn and the new mode answers it", async () => {
	const { handler } = setup("ask");
	const { ctx } = ctxWith(
		(_title, signal) =>
			new Promise(resolve => {
				signal?.addEventListener("abort", () => resolve(undefined));
				setTimeout(() => writeMode("proj-1", "auto"), 20);
			}),
	);
	const started = Date.now();
	assert.equal(await handler?.({ toolName: "bash", input: { command: "make" } }, ctx), undefined);
	assert.ok(Date.now() - started < 3000);
	assert.equal(readMode("proj-1"), "auto");
});

test("a mode switch from ask to plan withdraws the question and refuses the edit", async () => {
	const { handler } = setup("ask");
	const { ctx } = ctxWith(
		(_title, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")));
				setTimeout(() => writeMode("proj-1", "plan"), 20);
			}),
	);
	assert.match((await handler?.({ toolName: "edit", input: { path: "a" } }, ctx))?.reason ?? "", /Plan mode/);
});
