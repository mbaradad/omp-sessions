// Permission modes: the host runs omp with `--approval-mode always-ask` and answers its approval
// selects by the session's mode, switchable live (also for prompts already waiting).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { PLAN_PROMPT_PREFIX } from "../../src/shared/permissions";
import { launch } from "./harness";

const launchArgs = (h: { dir: string }) => JSON.parse(fs.readFileSync(path.join(h.dir, "launch.json"), "utf8")).ompArgs as string[];

test("starting mode comes from the launch flag; omp always sees --approval-mode always-ask", async t => {
	const h = await launch(t, { args: ["--omp-arg", "--approval-mode", "--omp-arg", "write", "--omp-arg", "--yolo"] });
	const { snapshot } = await h.connect();
	assert.equal(snapshot.meta.permissionMode, "edits");
	const argv = h.fakeEntries().find(e => e.kind === "argv")?.argv ?? [];
	assert.equal(argv.filter(a => a === "--approval-mode").length, 1);
	assert.equal(argv[argv.indexOf("--approval-mode") + 1], "always-ask");
	assert.ok(!argv.includes("--yolo") && !argv.includes("write"), `argv: ${argv.join(" ")}`);
});

test("no flag and no omp setting: auto approves every tool without asking", async t => {
	const h = await launch(t);
	const { client: c, snapshot } = await h.connect();
	assert.equal(snapshot.meta.permissionMode, "auto");
	const from = c.mark();
	await c.prompt("write a.txt hi");
	assert.equal(fs.readFileSync(path.join(h.cwd, "a.txt"), "utf8"), "hi\n");
	assert.ok(!c.msgs.slice(from).some(m => m.t === "event" && m.ev.type === "extension_ui_request"), "approval never reached the client");
	assert.ok(!c.msgs.slice(from).some(m => m.t === "meta" && m.meta.status === "waiting"));
});

test("ask forwards the approval; switching to edits answers the waiting prompt and persists the mode", async t => {
	const h = await launch(t, { args: ["--omp-arg", "--approval-mode", "--omp-arg", "ask"] });
	const { client: c } = await h.connect();
	let from = c.mark();
	c.send({ t: "rpc", cmd: { id: "p1", type: "prompt", message: "write a.txt hi" } });
	const req = await c.event("extension_ui_request", ev => ev.method === "select", from);
	assert.match(String(req.title), /^Allow tool: write/);
	await c.waitFor("meta", m => m.meta.status === "waiting", from);

	from = c.mark();
	c.send({ t: "mode", mode: "edits" });
	await c.waitFor("ui_resolved", m => m.id === req.id, from);
	await c.waitFor("meta", m => m.meta.permissionMode === "edits", from);
	await c.event("prompt_result", () => true, from);
	assert.equal(fs.readFileSync(path.join(h.cwd, "a.txt"), "utf8"), "hi\n");
	assert.deepEqual(h.fakeCommands("extension_ui_response").map(r => r.value), ["Approve"]);
	const notice = await c.event("notice", () => true, from);
	assert.match(String(notice.message), /^Permission mode: Edits/);
	const args = launchArgs(h);
	assert.equal(args[args.indexOf("--approval-mode") + 1], "edits");

	// Edits still asks before commands.
	from = c.mark();
	c.send({ t: "rpc", cmd: { id: "p2", type: "prompt", message: "slow 50" } });
	const bash = await c.event("extension_ui_request", ev => ev.method === "select", from);
	assert.match(String(bash.title), /^Allow tool: bash/);
	c.send({ t: "ui_response", res: { id: String(bash.id), value: "Deny" } });
	await c.event("prompt_result", () => true, from);
});

test("plan refuses file edits and prefixes prompts; a resume keeps the mode", async t => {
	const h = await launch(t, { args: ["--omp-arg", "--approval-mode", "--omp-arg", "plan"] });
	const { client: c, snapshot } = await h.connect();
	assert.equal(snapshot.meta.permissionMode, "plan");
	const from = c.mark();
	await c.prompt("write a.txt hi");
	assert.ok(!fs.existsSync(path.join(h.cwd, "a.txt")), "edit refused");
	assert.deepEqual(h.fakeCommands("extension_ui_response").map(r => r.value), ["Deny"]);
	assert.ok(!c.msgs.slice(from).some(m => m.t === "event" && m.ev.type === "extension_ui_request"));
	assert.deepEqual(h.fakeCommands("prompt").map(p => p.message), [`${PLAN_PROMPT_PREFIX}write a.txt hi`]);

	c.send({ t: "mode", mode: "auto" });
	await c.waitFor("meta", m => m.meta.permissionMode === "auto");
	c.send({ t: "stop" });
	await c.waitFor("meta", m => m.meta.status === "stopped");
	await h.start(["--resume", h.meta().ompSessionFile ?? "", ...launchArgs(h).flatMap(a => ["--omp-arg", a])]);
	const again = await h.connect();
	assert.equal(again.snapshot.meta.permissionMode, "auto");
});
