// Session host ↔ client protocol against the scripted fake omp: snapshots, streaming, file
// change tracking, reconnects, dialogs, client-side bash, notes, renames, aborts.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { EMPTY_BLOB } from "../../src/shared/protocol";
import { alive, isRecord, launch, textOf } from "./harness";

test("hello → snapshot with meta, state and empty mirror once omp is ready", async t => {
	const h = await launch(t);
	const { snapshot: s } = await h.connect();
	assert.equal(s.meta.id, h.id);
	assert.equal(s.meta.status, "idle");
	assert.equal(s.meta.cwd, h.cwd);
	assert.equal(s.meta.title, "New session");
	assert.equal(s.meta.model, "fake/fake-model");
	assert.equal(s.meta.socket, h.socket);
	assert.equal(s.meta.changedFiles, 0);
	assert.ok(alive(s.meta.pid), "host alive");
	assert.ok(alive(s.meta.ompPid), "omp alive");
	assert.ok(s.meta.ompSessionFile?.startsWith(h.sessions), "session file under FAKE_OMP_SESSIONS");
	assert.ok(fs.existsSync(s.meta.ompSessionFile ?? ""));
	assert.deepEqual(s.messages, []);
	assert.equal(s.inflight, null);
	assert.deepEqual(s.runningTools, []);
	assert.deepEqual(s.pendingUi, []);
	assert.deepEqual(s.commands, []);
	assert.deepEqual(s.changes, []);
	assert.ok(isRecord(s.state));
	assert.deepEqual(s.state.model, { provider: "fake", id: "fake-model", name: "Fake Model", contextWindow: 200000, reasoning: true });
	assert.equal(s.state.thinkingLevel, "medium");
	assert.equal(s.state.isStreaming, false);
	assert.ok(isRecord(s.state.contextUsage));
	assert.equal(s.state.contextUsage.contextWindow, 200000);

	const argv = h.fakeEntries().find(e => e.kind === "argv")?.argv ?? [];
	assert.equal(argv[argv.indexOf("--mode") + 1], "rpc-ui");
	assert.equal(argv[argv.indexOf("--cwd") + 1], h.cwd);
	assert.equal(argv[argv.indexOf("--config") + 1], path.join(h.dir, "omp-overlay.yml"));
	assert.ok(!argv.includes("--resume"));
	assert.deepEqual(h.fakeCommands("negotiate_protocol").map(c => c.protocolVersion), [2]);
	assert.deepEqual(h.fakeCommands("set_ask_dialog").map(c => c.enabled), [true]);
	assert.equal(h.fakeCommands("set_subagent_subscription").length, 1);
});

test("prompt `echo` streams events; status goes working → idle; title, lastText, cost follow", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const from = c.mark();
	const result = await c.prompt("echo hello world");
	assert.equal(result.status, "completed");
	assert.equal(result.sessionSettled, true);

	const updates = c.msgs.slice(from).flatMap(m => (m.t === "event" && m.ev.type === "message_update" ? [m.ev] : []));
	assert.ok(updates.length >= 2, "streamed in chunks");
	assert.ok(updates.every(u => typeof u.messageId === "string"));
	const end = await c.event("message_end", ev => isRecord(ev.message) && ev.message.role === "assistant", from);
	assert.equal(textOf(end.message), "hello world");
	assert.equal(end.messageId, updates[0].messageId);

	const statuses = c.msgs.slice(from).flatMap(m => (m.t === "meta" ? [m.meta.status] : []));
	assert.ok(statuses.includes("working"), `statuses: ${statuses}`);
	const idle = await c.waitFor("meta", m => m.meta.status === "idle" && m.meta.lastText === "hello world", from);
	assert.equal(idle.meta.title, "echo hello world");
	// meta.cost is read from the transcript shortly after the turn (src/shared/cost.ts).
	await c.waitFor("meta", m => (m.meta.cost ?? 0) > 0, from);
	// The prompt prefix is only a local placeholder: sent to omp, it would block omp's own titles.
	assert.deepEqual(h.fakeCommands("set_session_name"), []);
});

test("omp's generated title replaces the placeholder; an explicit --title is given to omp instead", async t => {
	const auto = await launch(t, { env: { FAKE_OMP_AUTO_TITLE: "1" } });
	const { client: c } = await auto.connect();
	await c.prompt("echo name me");
	await c.waitFor("meta", m => m.meta.title === "Auto: echo name me");
	assert.deepEqual(auto.fakeCommands("set_session_name"), []);

	const titled = await launch(t, { env: { FAKE_OMP_AUTO_TITLE: "1" }, args: ["--title", "Chosen"] });
	const { client: c2 } = await titled.connect();
	await c2.prompt("echo hi");
	await c2.rpc({ id: "sync", type: "get_state" });
	assert.deepEqual(
		titled.fakeCommands("set_session_name").map(x => x.name),
		["Chosen"],
	);
	assert.equal(titled.meta().title, "Chosen");
});

test("`write` then `edit` produce change frames with stored before/after blobs", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const file = path.join(h.cwd, "src", "a.txt");
	const blob = (hash: string | null) => (hash === null || hash === EMPTY_BLOB ? hash : fs.readFileSync(path.join(h.dir, "blobs", hash), "utf8"));

	let from = c.mark();
	await c.prompt("write src/a.txt hello world");
	const created = (await c.waitFor("change", () => true, from)).change;
	assert.equal(created.toolName, "write");
	assert.deepEqual(
		created.files.map(f => [f.path, f.op, f.before]),
		[[file, "create", null]],
	);
	assert.equal(blob(created.files[0].after), "hello world\n");

	from = c.mark();
	await c.prompt("edit src/a.txt world => there");
	const updated = (await c.waitFor("change", () => true, from)).change;
	assert.equal(updated.toolName, "edit");
	assert.equal(updated.files.length, 1);
	assert.equal(updated.files[0].op, "update");
	assert.equal(updated.files[0].before, created.files[0].after);
	assert.equal(blob(updated.files[0].after), "hello there\n");
	assert.equal(fs.readFileSync(file, "utf8"), "hello there\n");

	const toolEnd = await c.event("tool_execution_end", ev => ev.toolName === "edit", from);
	assert.ok(isRecord(toolEnd.result) && isRecord(toolEnd.result.details));
	assert.equal(toolEnd.result.details.diff, "-1|hello world\n+1|hello there");

	const persisted = fs
		.readFileSync(path.join(h.dir, "changes.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l));
	assert.deepEqual(persisted, [created, updated]);
	await c.waitFor("meta", m => m.meta.changedFiles === 1);

	const { snapshot } = await h.connect("second");
	assert.deepEqual(snapshot.changes, [created, updated]);
});

test("reconnect mid-turn: snapshot carries running tool and inflight message, turn completes", async t => {
	const h = await launch(t, { env: { FAKE_OMP_DELAY: "150" } });
	const { client: c1 } = await h.connect("first");
	const from = c1.mark();
	c1.send({ t: "rpc", cmd: { id: "slow", type: "prompt", message: "slow 1500" } });
	await c1.event("tool_execution_update", () => true, from);
	await c1.close();

	const { client: c2, snapshot: s2 } = await h.connect("second");
	assert.equal(s2.meta.status, "working");
	assert.equal(s2.runningTools.length, 1);
	const tool = s2.runningTools[0];
	assert.equal(tool.toolName, "bash");
	assert.deepEqual(tool.args, { command: "sleep 1.5" });
	assert.ok(isRecord(tool.partialResult), "partial result mirrored");
	await c2.event("prompt_result");
	const end = await c2.event("message_end", ev => textOf(ev.message) === "slept 1500ms");
	assert.ok(end);
	await c2.waitFor("meta", m => m.meta.status === "idle");

	// Mid-stream: the partially streamed assistant message is the snapshot's inflight.
	const mark = c2.mark();
	c2.send({ t: "rpc", cmd: { id: "e", type: "prompt", message: "echo one two three four five six" } });
	const update = await c2.event("message_update", ev => isRecord(ev.message) && ev.message.role === "assistant", mark);
	const { client: c3, snapshot: s3 } = await h.connect("third");
	assert.ok(s3.inflight, "inflight present");
	assert.equal(s3.inflight.messageId, update.messageId);
	assert.ok(isRecord(s3.inflight.message) && s3.inflight.message.role === "assistant");
	const done = await c3.event("message_end", ev => ev.messageId === update.messageId);
	assert.equal(textOf(done.message), "one two three four five six");
	await c3.event("prompt_result");

	const { snapshot: s4 } = await h.connect("fourth");
	assert.equal(s4.inflight, null);
	assert.deepEqual(s4.runningTools, []);
	assert.deepEqual(
		s4.messages.map(m => (isRecord(m) ? m.role : undefined)),
		["user", "assistant", "toolResult", "assistant", "user", "assistant"],
	);
});

test("ask dialog: status waiting, pendingUi for late clients, ui_response resolves everywhere", async t => {
	const h = await launch(t);
	const { client: c1 } = await h.connect("first");
	const from = c1.mark();
	c1.send({ t: "rpc", cmd: { id: "ask", type: "prompt", message: "ask" } });
	await c1.waitFor("meta", m => m.meta.status === "waiting", from);

	const { client: c2, snapshot } = await h.connect("second");
	assert.equal(snapshot.meta.status, "waiting");
	assert.equal(snapshot.pendingUi.length, 1);
	const req = snapshot.pendingUi[0];
	assert.equal(req.method, "ask");
	assert.deepEqual(req.questions, [{ id: "q1", question: "Pick one", options: [{ label: "alpha" }, { label: "beta" }] }]);
	assert.deepEqual(
		snapshot.runningTools.map(r => r.toolName),
		["ask"],
	);

	c2.send({ t: "ui_response", res: { id: req.id, answers: [{ id: "q1", selectedOptions: ["beta"] }] } });
	await c1.waitFor("ui_resolved", m => m.id === req.id);
	await c2.waitFor("ui_resolved", m => m.id === req.id);
	const end = await c1.event("message_end", ev => textOf(ev.message) === "chose beta", from);
	assert.ok(end);
	await c1.event("prompt_result", () => true, from);
	await c1.waitFor("meta", m => m.meta.status === "idle", from);
	assert.deepEqual(
		h.fakeCommands("extension_ui_response").map(r => [r.id, r.answers]),
		[[req.id, [{ id: "q1", selectedOptions: ["beta"] }]]],
	);
	const { snapshot: after } = await h.connect("third");
	assert.deepEqual(after.pendingUi, []);
});

test("client `bash` rpc: response routed back by id and a bashExecution lands in the mirror", async t => {
	const h = await launch(t);
	const { client: c1 } = await h.connect();
	const res = await c1.rpc({ id: "b1", type: "bash", command: "printf 'out-%s\\n' $((1+1)); pwd; exit 3" });
	assert.equal(res.success, true);
	// `pwd` prints the physical path (macOS: /var → /private/var).
	assert.deepEqual(res.data, { output: `out-2\n${fs.realpathSync(h.cwd)}\n`, exitCode: 3, cancelled: false });
	await c1.close();

	const { snapshot } = await h.connect("second");
	const bash = snapshot.messages.find(m => isRecord(m) && m.role === "bashExecution");
	assert.ok(isRecord(bash));
	assert.equal(bash.command, "printf 'out-%s\\n' $((1+1)); pwd; exit 3");
	assert.equal(bash.output, `out-2\n${fs.realpathSync(h.cwd)}\n`);
	assert.equal(bash.exitCode, 3);
});

test("note is mirrored as a notice; rename updates meta title and omp session name", async t => {
	const h = await launch(t);
	const { client: c1 } = await h.connect();
	c1.send({ t: "note", level: "warning", message: "heads up", markdown: true });
	const from = c1.mark();
	c1.send({ t: "rename", title: "My title" });
	const meta = await c1.waitFor("meta", m => m.meta.title === "My title", from);
	assert.equal(meta.meta.title, "My title");
	// get_state round trip: everything sent before it has been handled by the host.
	await c1.rpc({ id: "sync", type: "get_state" });
	assert.deepEqual(
		h.fakeCommands("set_session_name").map(c => c.name),
		["My title"],
	);

	const { snapshot } = await h.connect("second");
	assert.equal(snapshot.meta.title, "My title");
	const notice = snapshot.messages.find(m => isRecord(m) && m.role === "notice");
	assert.ok(isRecord(notice));
	assert.equal(notice.level, "warning");
	assert.equal(notice.message, "heads up");
	assert.equal(notice.markdown, true);
});

test("abort stops a running tool: aborted prompt_result, idle, no running tools", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const from = c.mark();
	c.send({ t: "rpc", cmd: { id: "slow", type: "prompt", message: "slow 10000" } });
	await c.event("tool_execution_update", () => true, from);
	const res = await c.rpc({ id: "stop-it", type: "abort" });
	assert.equal(res.success, true);
	const result = await c.event("prompt_result", () => true, from, 3000);
	assert.equal(result.status, "aborted");
	const last = await c.event("message_end", ev => isRecord(ev.message) && ev.message.stopReason === "aborted", from);
	assert.ok(last);
	await c.waitFor("meta", m => m.meta.status === "idle", from);
	const { snapshot } = await h.connect("second");
	assert.deepEqual(snapshot.runningTools, []);
	assert.equal(snapshot.inflight, null);
});

test("unknown rpc command → error response with the client's id restored", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const res = await c.rpc({ id: "u1", type: "definitely_not_a_command" });
	assert.equal(res.success, false);
	assert.equal(res.id, "u1");
	assert.match(String(res.error), /Unknown command/);
});

test("slash command: command_output mirrored, agent not invoked", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const from = c.mark();
	const res = await c.rpc({ id: "s1", type: "prompt", message: "/session" });
	assert.deepEqual(res.data, { agentInvoked: false });
	const out = await c.event("command_output", () => true, from);
	assert.match(String(out.text), /fake \/session/);
	await c.rpc({ id: "sync", type: "get_state" });
	const { snapshot } = await h.connect("second");
	assert.equal(snapshot.meta.title, "New session", "slash commands don't title the session");
	assert.ok(snapshot.messages.some(m => isRecord(m) && m.role === "commandOutput"));
});

test("new_session resets the mirror and points meta at the new transcript", async t => {
	const h = await launch(t);
	const { client: c, snapshot } = await h.connect();
	await c.prompt("echo before");
	const oldFile = snapshot.meta.ompSessionFile;
	assert.ok(oldFile);
	const from = c.mark();
	const res = await c.rpc({ id: "n1", type: "new_session" });
	assert.equal(res.success, true);
	const reset = await c.waitFor("reset", () => true, from);
	assert.deepEqual(reset.messages, []);
	const meta = await c.waitFor("meta", m => m.meta.ompSessionFile !== oldFile, from);
	assert.ok(meta.meta.ompSessionFile?.startsWith(h.sessions));
});

test("protocol v2 rpc_chunk frames are reassembled (multi-byte text split across chunks)", async t => {
	const h = await launch(t, { env: { FAKE_OMP_CHUNK_BYTES: "97" } });
	const { client: c, snapshot } = await h.connect();
	assert.equal(snapshot.meta.model, "fake/fake-model", "chunked get_state reassembled");
	const text = "héllo wörld ✓ ".repeat(20).trim();
	const from = c.mark();
	await c.prompt(`echo ${text}`);
	const end = await c.event("message_end", ev => isRecord(ev.message) && ev.message.role === "assistant", from);
	assert.equal(textOf(end.message), text);
});

test("aborting while an ask dialog is open cancels it: ui_resolved, idle, no pendingUi", async t => {
	const h = await launch(t);
	const { client: c } = await h.connect();
	const from = c.mark();
	c.send({ t: "rpc", cmd: { id: "ask", type: "prompt", message: "ask" } });
	await c.waitFor("meta", m => m.meta.status === "waiting", from);
	await c.rpc({ id: "a1", type: "abort" });
	await c.waitFor("ui_resolved", () => true, from);
	const result = await c.event("prompt_result", () => true, from);
	assert.equal(result.status, "aborted");
	await c.waitFor("meta", m => m.meta.status === "idle", from);
	const { snapshot } = await h.connect("second");
	assert.deepEqual(snapshot.pendingUi, []);
});

test(
	"fast edit: file changed before the host sees tool_execution_start still records the change from details.oldText",
	async t => {
		const h = await launch(t, { env: { FAKE_OMP_TOOL_DELAY: "0" } });
		const { client: c } = await h.connect();
		fs.writeFileSync(path.join(h.cwd, "b.txt"), "one\ntwo\n");
		const from = c.mark();
		await c.prompt("edit b.txt two => TWO");
		await c.rpc({ id: "sync", type: "get_state" });
		const change = c.msgs.slice(from).find(m => m.t === "change");
		assert.ok(change, "change frame emitted");
		assert.equal(change.change.files[0].op, "update");
		assert.equal(fs.readFileSync(path.join(h.dir, "blobs", change.change.files[0].before ?? ""), "utf8"), "one\ntwo\n");
	},
);
