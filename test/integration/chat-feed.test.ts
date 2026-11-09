// The chat panel's data path against a real, isolated AO daemon running the scripted ACP fake: the same
// loop ChatPanel runs (full read, then a tail read after every `session_updated` event, merged by
// ChatFeed), checked for what the webview would be told. The VS Code side is covered by the e2e suite.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { AoClient, type AoConversation } from "../../src/ao/client";
import { type BtwRecord, askSideQuestion, sideRecords } from "../../src/ext/chat-btw";
import { ChatFeed, replyFor } from "../../src/ext/chat-feed";
import { interruptKeepingQueue, sendResuming } from "../../src/ext/chat-send";
import type { ToWebview } from "../../src/shared/webview";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

let ao: AoFixture;
let client: AoClient;
let projectId: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture({ fakeOmpEnv: { FAKE_OMP_DELAY: "150" } });
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	projectId = await ao.createProject(ao.scratchRepo());
});

after(async () => {
	await ao?.stop();
});

/** One open chat: what ChatPanel does between the daemon and the webview. */
class Follower {
	readonly feed = new ChatFeed();
	readonly posts: ToWebview[] = [];
	private readonly sub;
	private running: Promise<void> | undefined;
	private again = false;
	private closed = false;
	private waiters: Array<() => void> = [];

	constructor(private readonly sessionId: string) {
		this.sub = client.events({
			after: "latest",
			onEvent: ev => {
				if (ev.sessionId === sessionId && ev.type === "session_updated") void this.sync().catch(() => undefined);
			},
		});
	}

	async load(): Promise<void> {
		this.feed.reset(await client.getConversation(this.sessionId, { limit: 500 }));
	}

	/** One tail read at a time; a change that arrives meanwhile runs one more. */
	sync(): Promise<void> {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			do {
				this.again = false;
				if (this.closed) return;
				const floor = this.feed.floor();
				const page: AoConversation = await client.getConversation(this.sessionId, { ...(floor > 0 && { afterSequence: floor }), limit: 500 });
				this.posts.push(...this.feed.apply(page));
				for (const w of this.waiters.splice(0)) w();
			} while (this.again);
		})().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	/** Resolves once `pred` holds for what the follower has seen; re-checked after every sync. */
	async until(what: string, pred: () => boolean, timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		void this.sync().catch(() => undefined);
		while (!pred()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\nposts: ${JSON.stringify(this.posts.map(describe)).slice(0, 2000)}\n${ao.daemonLog().split("\n").slice(-15).join("\n")}`);
			const { promise, resolve } = Promise.withResolvers<void>();
			this.waiters.push(resolve);
			// A missed event must not hang the test: the timer re-reads.
			const timer = setTimeout(() => void this.sync().catch(() => undefined), 1000);
			await promise;
			clearTimeout(timer);
		}
	}

	/** Stops following and waits for a read in flight, so nothing touches the daemon after the test. */
	async close(): Promise<void> {
		this.closed = true;
		this.sub.close();
		await this.running?.catch(() => undefined);
	}
}

function describe(p: ToWebview): string {
	if (p.type !== "event") return p.type;
	const m = p.ev.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
	return `${p.ev.type}${m?.role ? `:${m.role}` : ""}${m?.content?.[0]?.text ? `:${m.content[0].text.slice(0, 30)}` : ""}`;
}

const texts = (messages: unknown[]) => messages.map(m => (m as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "");

async function spawn(name: string, prompt: string) {
	const { session } = await client.spawnSession({ projectId, harness: "omp", mode: "chat", kind: "worker", displayName: name, approvalMode: "default", prompt });
	return session.id;
}

test("chat feed: streams a reply, an approval and an ask answer through the webview's dialogs, and a reload rebuilds the same transcript", { skip }, async () => {
	const id = await spawn("feed approve+ask", ["echo Streaming a scripted reply from the fake omp", "bash touch approved.txt", "ask Ship it? | yes | no"].join("\n"));
	const chat = new Follower(id);
	try {
		await chat.load();
		await chat.until("the approval dialog", () => chat.posts.some(p => p.type === "event" && p.ev.type === "extension_ui_request"));
		const dialog = chat.posts.flatMap(p => (p.type === "event" && p.ev.type === "extension_ui_request" ? [p.ev] : []))[0];
		assert.equal(dialog.method, "select");
		assert.match(String(dialog.title), /^Allow bash: \$ touch approved\.txt/);
		const req = chat.feed.request(String(dialog.id));
		assert.ok(req);
		// The user presses "Allow once" in the webview.
		const reply = replyFor(req, { value: "Allow once" });
		assert.equal(reply?.kind, "approval");
		if (reply?.kind === "approval") await client.resolveApproval(id, req.question.id, reply.decisionId);
		await chat.until("the dialog to close", () => chat.posts.some(p => p.type === "uiResolved" && p.id === dialog.id));

		await chat.until("the ask dialog", () => chat.posts.some(p => p.type === "event" && p.ev.type === "extension_ui_request" && p.ev.method === "ask"));
		const ask = chat.posts.flatMap(p => (p.type === "event" && p.ev.type === "extension_ui_request" && p.ev.method === "ask" ? [p.ev] : []))[0];
		const askReq = chat.feed.request(String(ask.id));
		assert.ok(askReq);
		const answer = replyFor(askReq, { answers: [{ id: "q0", selectedOptions: ["no"] }] });
		assert.deepEqual(answer, { kind: "input", action: "accept", content: { q0: "no" } });
		if (answer?.kind === "input") await client.resolveInput(id, askReq.question.id, { action: answer.action, ...(answer.content && { content: answer.content }) });

		await chat.until("the end of the turn", () => !chat.feed.isBusy() && texts(chat.feed.transcript()).includes("chose no"));
		// Streaming: the reply was announced as updates before its final message.
		const types = chat.posts.map(describe);
		assert.ok(types.some(t => t.startsWith("message_update:assistant")), `live updates in ${types.join(" ")}`);
		assert.ok(types.includes("session_settled"));
		assert.ok(chat.feed.state().contextUsage, "context use from AO's usage");

		// A reload (fresh full read) shows the same conversation as the one built incrementally.
		const reloaded = new ChatFeed().reset(await client.getConversation(id, { limit: 500 }));
		assert.deepEqual(reloaded.messages, chat.feed.transcript());
		assert.equal(reloaded.pendingUi.length, 0);
		const tool = reloaded.messages.find(m => (m as { role?: string }).role === "toolResult") as { toolName?: string; isError?: boolean } | undefined;
		assert.equal(tool?.toolName, "bash");
		assert.equal(tool?.isError, false);
	} finally {
		await chat.close();
	}
});

test("chat feed: a message sent while omp works is steered into the turn and shows as the user's own message", { skip }, async () => {
	const id = await spawn("feed steer", "slow 1500");
	const chat = new Follower(id);
	try {
		await chat.load();
		await chat.until("the running turn", () => chat.feed.isBusy());
		assert.equal((await client.steerOrSend(id, { text: "also say hi", clientMessageId: randomUUID() })).outcome, "steered");
		await chat.until("the steered reply", () => !chat.feed.isBusy() && texts(chat.feed.transcript()).includes("steered: also say hi"));
		const said = texts(chat.feed.transcript());
		assert.ok(said.includes("also say hi"), `the steer in ${JSON.stringify(said)}`);
		assert.equal(said.filter(t => t === "slow 1500").length, 1);
	} finally {
		await chat.close();
	}
});

test("chat feed: interrupt ends the turn with an Interrupted notice and clears the busy state", { skip }, async () => {
	const id = await spawn("feed interrupt", "slow 20000");
	const chat = new Follower(id);
	try {
		await chat.load();
		await chat.until("the running turn", () => chat.feed.isBusy());
		await client.interrupt(id);
		await chat.until("the turn to end", () => !chat.feed.isBusy());
		assert.ok(chat.posts.some(p => p.type === "event" && p.ev.type === "notice" && p.ev.message === "Interrupted"));
		assert.ok(chat.posts.some(p => p.type === "event" && p.ev.type === "session_settled"));
	} finally {
		await chat.close();
	}
});

test("chat feed: a follow-up queued behind the turn is a queue chip until it runs, and a withdrawn one leaves no trace", { skip }, async () => {
	const id = await spawn("feed queue", "slow 2500");
	const chat = new Follower(id);
	try {
		await chat.load();
		await chat.until("the running turn", () => chat.feed.isBusy());
		await client.sendMessage(id, { text: "echo queued one" });
		await client.sendMessage(id, { text: "echo queued two" });
		await chat.until("two queued prompts", () => chat.feed.queued().length === 2);
		assert.deepEqual(
			chat.feed.queued().map(q => q.text),
			["echo queued one", "echo queued two"],
		);
		assert.ok(!texts(chat.feed.transcript()).includes("echo queued one"), "queued prompts are not in the transcript yet");
		assert.deepEqual(chat.feed.state().queuedMessages?.followUp, ["echo queued one", "echo queued two"]);

		await client.cancelQueuedTurn(id, chat.feed.queued()[1].turnId);
		await chat.until("the withdrawn prompt to go", () => chat.feed.queued().length === 1);
		await chat.until("the remaining one to run", () => !chat.feed.isBusy() && texts(chat.feed.transcript()).includes("queued one"));
		const said = texts(chat.feed.transcript());
		assert.ok(said.includes("echo queued one"));
		assert.ok(!said.includes("echo queued two"), `withdrawn prompt hidden in ${JSON.stringify(said)}`);
		assert.equal(chat.feed.queued().length, 0);
	} finally {
		await chat.close();
	}
});

test("chat feed: sending to a chat whose omp died restarts omp and the prompt goes through", { skip }, async () => {
	const id = await spawn("feed resume", "echo before the crash");
	const chat = new Follower(id);
	try {
		await chat.load();
		await chat.until("the first reply", () => texts(chat.feed.transcript()).includes("before the crash"));
		assert.ok(ao.killChatHosts(id) > 0, "a chat host to kill");
		await chat.until("AO to see the agent gone", () => chat.feed.conversation?.controller === "stopped");
		// Plain send fails until the agent is resumed...
		await assert.rejects(client.sendMessage(id, { text: "echo plain" }), { code: "CHAT_CONTROLLER_NOT_READY" });
		// ...what the chat does for the person.
		let resumed = 0;
		await sendResuming(client, id, async () => void (await client.sendMessage(id, { text: "echo after the crash" })), () => resumed++);
		assert.equal(resumed, 1);
		await chat.until("the reply after the crash", () => !chat.feed.isBusy() && texts(chat.feed.transcript()).includes("after the crash"));
	} finally {
		await chat.close();
	}
});

test("/btw: a side question is answered in a forked side chat and the main conversation does not change", { skip }, async () => {
	const id = await spawn("feed btw", "echo main answer");
	const chat = new Follower(id);
	try {
		await chat.load();
		await chat.until("the main reply", () => texts(chat.feed.transcript()).includes("main answer"));
		const turnsBefore = (await client.getConversation(id, { limit: 50 })).turns.length;
		const cards: BtwRecord[] = [];
		const done = await askSideQuestion(client, id, "echo side answer", r => cards.push(r));
		assert.equal(done.status, "done", JSON.stringify(done));
		assert.equal(done.question, "echo side answer");
		assert.equal(done.answer, "side answer");
		assert.equal(cards[0].status, "running", "the card appears before the answer");
		assert.equal((await client.getConversation(id, { limit: 50 })).turns.length, turnsBefore, "no turn in the main conversation");
		// A reload draws the same card again.
		assert.deepEqual((await sideRecords(client, id)).map(r => [r.question, r.answer, r.status]), [["echo side answer", "side answer", "done"]]);
	} finally {
		await chat.close();
	}
});

test("interrupt keeps the follow-ups AO would discard: they are sent again in order and run once each", { skip }, async () => {
	const id = await spawn("feed interrupt queue", "slow 20000");
	const chat = new Follower(id);
	try {
		await chat.load();
		await chat.until("the running turn", () => chat.feed.isBusy());
		await client.sendMessage(id, { text: "echo queued one" });
		await client.sendMessage(id, { text: "echo queued two" });
		await chat.until("two queued prompts", () => chat.feed.queued().length === 2);
		assert.equal(await interruptKeepingQueue(client, id), 2);
		await chat.until("both follow-ups answered", () => !chat.feed.isBusy() && texts(chat.feed.transcript()).includes("queued two"));
		const said = texts(chat.feed.transcript());
		assert.deepEqual(said.filter(t => t.startsWith("echo queued")), ["echo queued one", "echo queued two"], `each follow-up once in ${JSON.stringify(said)}`);
		assert.ok(said.indexOf("queued one") < said.indexOf("queued two"), "in order");
		assert.equal(chat.feed.queued().length, 0);
	} finally {
		await chat.close();
	}
});
