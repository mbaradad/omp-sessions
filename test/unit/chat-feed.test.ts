import assert from "node:assert/strict";
import { test } from "node:test";
import type { AoActivity, AoConversation, AoMessage, AoTurn } from "../../src/ao/client";
import { ChatFeed, replyFor, toolNameOf, toolResultOf } from "../../src/ext/chat-feed";
import type { ToWebview } from "../../src/shared/webview";

const T = "2026-11-09T15:00:00Z";

const turn = (id: string, state: AoTurn["state"], t: Partial<AoTurn> = {}): AoTurn => ({ id, state, requestedAt: T, hasHumanPrompt: true, ...t });
const msg = (seq: number, role: AoMessage["role"], text: string, turnId: string, m: Partial<AoMessage> = {}): AoMessage => ({
	kind: "message",
	id: `m${seq}`,
	sequence: seq,
	revision: 0,
	role,
	origin: role === "user" ? "human" : "provider",
	text,
	editAvailable: false,
	streaming: false,
	createdAt: T,
	turnId,
	...m,
});
const act = (seq: number, a: Partial<AoActivity>): AoActivity => ({ kind: "activity", id: `a${seq}`, sequence: seq, revision: 0, activityKind: "command", status: "running", summary: "", createdAt: T, ...a });
const conv = (c: Partial<AoConversation>): AoConversation => ({
	activities: [],
	branchedFromEarlierMessage: false,
	continueTurnId: "",
	controller: "ready",
	conversationId: "c1",
	hasMoreBefore: false,
	latestSequence: 1,
	messages: [],
	mode: "chat",
	nativeForkAvailableAfterSequence: 0,
	sessionId: "repo-1",
	settings: {},
	turns: [],
	...c,
});

const events = (posts: ToWebview[]) => posts.flatMap(p => (p.type === "event" ? [p.ev] : []));
const types = (posts: ToWebview[]) => posts.map(p => (p.type === "event" ? p.ev.type : p.type));

test("streamed answer: live updates while AO streams, one final message, busy edges", () => {
	const feed = new ChatFeed();
	const first = feed.reset(conv({ turns: [turn("t1", "running")], messages: [msg(1, "user", "hi", "t1"), msg(2, "assistant", "Hel", "t1", { streaming: true, revision: 1 })], latestSequence: 2, controller: "busy" }));
	assert.equal(first.messages.length, 2);
	const update = feed.apply(conv({ turns: [turn("t1", "running")], messages: [msg(2, "assistant", "Hello", "t1", { streaming: true, revision: 2 })], latestSequence: 2, controller: "busy" }));
	assert.deepEqual(types(update), ["message_update"]);
	assert.equal(((events(update)[0].message as { content: Array<{ text: string }> }).content[0]).text, "Hello");
	// Same revision again (a refetch triggered by an unrelated row): nothing to send.
	assert.deepEqual(feed.apply(conv({ turns: [turn("t1", "running")], messages: [msg(2, "assistant", "Hello", "t1", { streaming: true, revision: 2 })], controller: "busy" })), []);
	const done = feed.apply(conv({ turns: [turn("t1", "completed")], messages: [msg(2, "assistant", "Hello there", "t1", { revision: 3 })], latestSequence: 2 }));
	assert.deepEqual(types(done), ["message_end", "session_settled"]);
});

test("a queued prompt stays in the queue chips until its turn runs, then shows before that turn's reply", () => {
	const feed = new ChatFeed();
	const page = conv({
		turns: [turn("t1", "running"), turn("t2", "queued")],
		messages: [msg(1, "user", "first", "t1"), msg(2, "user", "second", "t2"), msg(3, "assistant", "working on first", "t1", { streaming: true })],
		latestSequence: 3,
		controller: "busy",
	});
	const snap = feed.reset(page);
	assert.deepEqual(
		snap.messages.map(m => (m as { content: Array<{ text: string }> }).content[0].text),
		["first", "working on first"],
	);
	assert.deepEqual(feed.queued(), [{ turnId: "t2", text: "second" }]);
	assert.deepEqual(feed.state().queuedMessages, { steering: [], followUp: ["second"] });
	// Rows of open turns can still change: the next tail fetch starts below them.
	assert.equal(feed.floor(), 0);

	feed.apply(conv({ turns: [turn("t1", "completed"), turn("t2", "running")], messages: [msg(3, "assistant", "first done", "t1"), msg(4, "assistant", "on second", "t2", { streaming: true })], latestSequence: 4 }));
	assert.deepEqual(feed.queued(), []);
	// After a reload the queued prompt sits right before its own turn's first reply, not where AO wrote it.
	const reloaded = new ChatFeed().reset(
		conv({ turns: [turn("t1", "completed"), turn("t2", "running")], messages: [msg(1, "user", "first", "t1"), msg(2, "user", "second", "t2"), msg(3, "assistant", "first done", "t1"), msg(4, "assistant", "on second", "t2", { streaming: true })] }),
	);
	assert.deepEqual(
		reloaded.messages.map(m => (m as { content: Array<{ text: string }> }).content[0].text),
		["first", "first done", "second", "on second"],
	);
});

test("a queued prompt withdrawn before it ran leaves no trace in the transcript", () => {
	const feed = new ChatFeed();
	feed.reset(conv({ turns: [turn("t1", "running"), turn("t2", "queued")], messages: [msg(1, "user", "first", "t1"), msg(2, "user", "second", "t2")], controller: "busy" }));
	const posts = feed.apply(conv({ turns: [turn("t1", "running"), turn("t2", "cancelled", { completedAt: T })], messages: [msg(2, "user", "second", "t2")], controller: "busy" }));
	assert.deepEqual(posts, []);
	assert.deepEqual(feed.queued(), []);
});

test("tool activity: card starts, streams output, ends with omp's own result and details", () => {
	const feed = new ChatFeed();
	feed.reset(conv({ turns: [turn("t1", "running")], messages: [msg(1, "user", "run it", "t1")], controller: "busy" }));
	const running = act(2, { turnId: "t1", summary: "$ ls", detail: { toolKind: "execute", input: { command: "ls" }, command: "ls", output: "a\n" } });
	const start = feed.apply(conv({ turns: [turn("t1", "running")], activities: [running], controller: "busy" }));
	assert.deepEqual(types(start), ["message_end", "tool_execution_start", "tool_execution_update"]);
	assert.equal(events(start)[1].toolName, "bash");
	const output = JSON.stringify({ content: [{ type: "text", text: "a\nb\n" }], details: { wallTimeMs: 3 } });
	const end = feed.apply(conv({ turns: [turn("t1", "running")], activities: [{ ...running, revision: 1, status: "failed", detail: { toolKind: "execute", input: { command: "ls" }, command: "ls", output, exitCode: 2 } }], controller: "busy" }));
	const result = events(end).find(e => (e.message as { role?: string })?.role === "toolResult")?.message as Record<string, unknown>;
	assert.deepEqual(result.content, [{ type: "text", text: "a\nb\n" }]);
	assert.deepEqual(result.details, { wallTimeMs: 3, exitCode: 2 });
	assert.equal(result.isError, true);
	// A finished tool is never reported twice.
	assert.equal(events(feed.apply(conv({ turns: [turn("t1", "completed")], activities: [{ ...running, revision: 2, status: "failed" }] }))).filter(e => (e.message as { role?: string })?.role === "toolResult").length, 0);
});

test("omp tool names come back from ACP kind and omp's arguments", () => {
	const name = (toolKind: string, input: Record<string, unknown>, activityKind: AoActivity["activityKind"] = "mcp_tool") => toolNameOf(act(1, { activityKind, detail: { toolKind, input } }));
	assert.equal(name("read", { path: "a.ts" }), "read");
	assert.equal(name("edit", { path: "a.ts", content: "x" }, "file_change"), "write");
	assert.equal(name("edit", { input: "[a.ts#AB12]\nPUT 1.=1:\n+x" }, "file_change"), "edit");
	assert.equal(name("search", { pattern: "foo\\(" }), "grep");
	assert.equal(name("search", { pattern: "src/**/*.ts" }), "glob");
	assert.equal(name("fetch", { query: "acp spec" }), "web_search");
	assert.equal(name("other", { questions: [] }), "ask");
	assert.equal(name("other", { tasks: [{}] }), "task");
});

test("omp's todo tool, which AO files as reasoning, renders as a todo card; real reasoning as thinking", () => {
	const todo = act(1, { activityKind: "reasoning", status: "completed", summary: "Updating todos", detail: { toolKind: "think", input: { ops: [{ op: "init" }] }, output: "" } });
	const thought = act(2, { activityKind: "reasoning", status: "completed", summary: "Reasoning", detail: { text: "let me think" } });
	const [card, , thinking] = new ChatFeed().reset(conv({ activities: [todo, thought] })).messages as Array<{ content?: Array<Record<string, unknown>> }>;
	assert.equal(card.content?.[0].type, "toolCall");
	assert.equal(card.content?.[0].name, "todo");
	assert.deepEqual(thinking.content, [{ type: "thinking", thinking: "let me think" }]);
});

test("truncated output falls back to ACP content without the repeated command header", () => {
	const a = act(1, { status: "completed", detail: { toolKind: "execute", command: "ls", output: '{"content":[{"te', outputTruncated: true, content: [{ type: "content", content: { type: "text", text: "$ ls" } }, { type: "content", content: { type: "text", text: "a" } }, { type: "content", content: { type: "text", text: "a" } }] } });
	assert.deepEqual(toolResultOf(a).content, [{ type: "text", text: "a" }]);
});

test("file_change activity carries inline diffs keyed by the tool call", () => {
	const feed = new ChatFeed();
	const edit = act(2, { activityKind: "file_change", status: "completed", turnId: "t1", summary: "Adding subtract", detail: { toolKind: "edit", input: { input: "[calc.py#0F46]" }, files: [{ path: "/w/calc.py", oldText: "a\n", newText: "a\nb\n" }] } });
	const snap = feed.reset(conv({ turns: [turn("t1", "completed")], activities: [edit] }));
	assert.equal(snap.diffs.a2["/w/calc.py"].added, 1);
	assert.deepEqual(feed.fileTexts("a2"), [{ path: "/w/calc.py", oldText: "a\n", newText: "a\nb\n" }]);
});

test("approval: a select dialog naming the tool, Dismiss rejects, resolution closes it", () => {
	const feed = new ChatFeed();
	const decisions = [
		{ id: "allow_once", label: "Allow once", kind: "allow_once" },
		{ id: "allow_always", label: "Always allow", kind: "allow_always" },
		{ id: "reject_once", label: "Reject", kind: "reject_once" },
	];
	const pending = act(2, { activityKind: "approval", status: "pending", turnId: "t1", requestId: "acp-request:x:1", summary: "ls", detail: { decisions, input: { command: "ls" }, toolKind: "execute", subjectKind: "command" } });
	const tool = act(3, { turnId: "t1", status: "pending", summary: "$ ls", detail: { toolKind: "execute", input: { command: "ls" }, command: "ls" } });
	const snap = feed.reset(conv({ turns: [turn("t1", "running")], activities: [pending, tool], controller: "busy" }));
	assert.equal(snap.pendingUi.length, 1);
	assert.equal(snap.pendingUi[0].title, "Allow bash: ls");
	assert.deepEqual(snap.pendingUi[0].options, ["Allow once", "Always allow", "Reject"]);
	const req = feed.request("acp-request:x:1");
	assert.ok(req);
	assert.deepEqual(replyFor(req, { value: "Always allow" }), { kind: "approval", decisionId: "allow_always" });
	assert.deepEqual(replyFor(req, { cancelled: true }), { kind: "approval", decisionId: "reject_once" });
	const closed = feed.apply(conv({ turns: [turn("t1", "running")], activities: [{ ...pending, revision: 1, status: "resolved" }], controller: "busy" }));
	assert.deepEqual(closed, [{ type: "uiResolved", id: "acp-request:x:1" }]);
	assert.equal(feed.request("acp-request:x:1"), undefined);
});

test("omp's ask: an ask dialog whose answers become the elicitation's form content", () => {
	const feed = new ChatFeed();
	const schema = {
		type: "object",
		properties: {
			q0: { title: "Which color?", description: "Color", type: "string", oneOf: [{ const: "red", title: "Red" }, { const: "blue", title: "Blue" }] },
			q0__other: { title: "Other (type your own)", type: "string" },
			q1: { title: "Which sizes?", type: "array", items: { anyOf: [{ const: "S", title: "S" }, { const: "L", title: "L" }] } },
			q1__other: { title: "Other (type your own)", type: "string" },
		},
	};
	const ask = act(2, { activityKind: "user_input", status: "pending", requestId: "req-ask", summary: "Answer 2 questions", detail: { inputMode: "form", message: "Answer 2 questions", schema } });
	const [ui] = feed.reset(conv({ turns: [turn("t1", "running")], activities: [ask] })).pendingUi;
	assert.equal(ui.method, "ask");
	assert.deepEqual(ui.questions, [
		{ id: "q0", header: "Color", question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }], multi: false },
		{ id: "q1", question: "Which sizes?", options: [{ label: "S" }, { label: "L" }], multi: true },
	]);
	const req = feed.request("req-ask");
	assert.ok(req);
	assert.deepEqual(
		replyFor(req, {
			answers: [
				{ id: "q0", selectedOptions: ["Blue"] },
				{ id: "q1", selectedOptions: ["S", "L"], customInput: "XL" },
			],
		}),
		{ kind: "input", action: "accept", content: { q0: "blue", q1: ["S", "L"], q1__other: "XL" } },
	);
	assert.deepEqual(replyFor(req, { cancelled: true }), { kind: "input", action: "decline" });
});

test("steers show as the user's words; failures and interrupts as notices", () => {
	const feed = new ChatFeed();
	const snap = feed.reset(
		conv({
			turns: [turn("t1", "interrupted", { startedAt: T }), turn("t2", "failed", { errorMessage: "model overloaded" })],
			messages: [msg(1, "user", "go", "t1")],
			activities: [act(2, { activityKind: "system", status: "completed", turnId: "t1", summary: "Steered", detail: { event: "steer", text: "use tabs", origin: "human" } })],
		}),
	);
	assert.deepEqual(snap.messages.slice(1), [
		{ role: "user", content: [{ type: "text", text: "use tabs" }], timestamp: Date.parse(T) },
		{ role: "notice", level: "warning", message: "Interrupted" },
		{ role: "notice", level: "error", message: "⚠ model overloaded" },
	]);
});
