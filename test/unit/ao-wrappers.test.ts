import assert from "node:assert/strict";
import { test } from "node:test";
import { AoClient } from "../../src/ao/client";

interface Seen {
	method: string;
	path: string;
	search: string;
	uploadHeader: string | null;
	body: unknown;
}

/** A client whose fetch records each request and answers `{}` (or `reply`). */
function recording(reply: unknown = {}) {
	const seen: Seen[] = [];
	const fetch = async (input: RequestInfo | URL): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input);
		const url = new URL(request.url);
		const text = await request.text();
		seen.push({ method: request.method, path: url.pathname, search: url.search, uploadHeader: request.headers.get("x-ao-attachment-upload"), body: text ? JSON.parse(text) : undefined });
		return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
	};
	return { ao: new AoClient({ baseUrl: "http://127.0.0.1:1", fetch }), seen };
}

const image = { type: "image", mimeType: "image/png", data: "AAAA" };

test("attachments make a request carry X-AO-Attachment-Upload (spawn, send, steer, steer-or-send); text-only requests do not", async () => {
	const { ao, seen } = recording();
	const attachments = [image] as never;
	await ao.sendMessage("repo-1", { text: "look", attachments });
	await ao.steerOrSend("repo-1", { text: "look", attachments });
	await ao.steer("repo-1", { text: "look", attachments });
	await ao.spawnSession({ harness: "omp", attachments: [{ name: "a.png" }] as never });
	assert.deepEqual(seen.map(s => [s.path, s.uploadHeader]), [
		["/api/v1/sessions/repo-1/conversation/messages", "1"],
		["/api/v1/sessions/repo-1/conversation/steer-or-send", "1"],
		["/api/v1/sessions/repo-1/conversation/steer", "1"],
		["/api/v1/sessions", "1"],
	]);
	seen.length = 0;
	await ao.sendMessage("repo-1", { text: "no image" });
	await ao.sendMessage("repo-1", { text: "empty list", attachments: [] });
	await ao.spawnSession({ harness: "omp" });
	assert.deepEqual(seen.map(s => s.uploadHeader), [null, null, null]);
});

test("chatView, skills and compact hit AO's routes with the right bodies", async () => {
	const { ao, seen } = recording({ skills: [{ name: "compact", description: "Compact", source: "agent" }], tokensBefore: 900, tokensAfter: 100 });
	await ao.chatView("repo-1", "panel-7", true);
	await ao.chatView("repo-1", "panel-7", false);
	assert.deepEqual(await ao.skills("repo-1"), [{ name: "compact", description: "Compact", source: "agent" }]);
	const compacted = await ao.compact("repo-1");
	assert.deepEqual([compacted.tokensBefore, compacted.tokensAfter], [900, 100]);
	assert.deepEqual(
		seen.map(s => [s.method, s.path, s.body]),
		[
			["POST", "/api/v1/sessions/repo-1/chat-view", { viewId: "panel-7", active: true }],
			["POST", "/api/v1/sessions/repo-1/chat-view", { viewId: "panel-7", active: false }],
			["GET", "/api/v1/sessions/repo-1/conversation/skills", undefined],
			["POST", "/api/v1/sessions/repo-1/conversation/compact", undefined],
		],
	);
});

test("interruptWithQueue: AO ends the running turn and every queued one; the prompts that never ran come back in queue order (G41)", async () => {
	const T = "2026-11-09T15:00:00Z";
	const turn = (id: string, state: string) => ({ id, state, requestedAt: T });
	const user = (sequence: number, turnId: string, text: string) => ({ kind: "message", id: `m${sequence}`, sequence, revision: 0, role: "user", origin: "human", text, editAvailable: false, streaming: false, createdAt: T, turnId });
	const snapshot = (turns: unknown[]) => ({ activities: [], branchedFromEarlierMessage: false, continueTurnId: "", controller: "ready", conversationId: "c", hasMoreBefore: false, latestSequence: 9, mode: "chat", nativeForkAvailableAfterSequence: 0, sessionId: "repo-1", settings: {}, messages: [user(1, "t0", "run"), user(2, "t1", "first queued"), user(3, "t2", "second queued")], turns });
	const open = snapshot([turn("t0", "running"), turn("t1", "queued"), turn("t2", "queued")]);
	const ended = snapshot([turn("t0", "interrupted"), turn("t1", "interrupted"), turn("t2", "cancelled")]);
	const reads: unknown[] = [];
	const seen: string[] = [];
	const fetch = async (input: RequestInfo | URL): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input);
		seen.push(`${request.method} ${new URL(request.url).pathname.replace("/api/v1/sessions/repo-1/", "")}`);
		if (request.method === "POST") return new Response(null, { status: 204 });
		return new Response(JSON.stringify(reads.shift()), { status: 200, headers: { "content-type": "application/json" } });
	};
	const ao = new AoClient({ baseUrl: "http://127.0.0.1:1", fetch });
	const GET = "GET conversation";
	const POST = "POST conversation/interrupt";

	// As observed live: the 204 comes back while every turn is still open; AO settles them a moment later.
	reads.push(open, open, open, ended);
	const { discarded } = await ao.interruptWithQueue("repo-1");
	assert.deepEqual(discarded.map(d => [d.turnId, d.text]), [["t1", "first queued"], ["t2", "second queued"]]);
	assert.deepEqual(seen, [GET, POST, GET, GET, GET], "it kept reading until AO had settled the turns");

	// Nothing queued: one read, the interrupt, and no waiting.
	seen.length = 0;
	reads.push(snapshot([turn("t0", "running")]));
	assert.deepEqual((await ao.interruptWithQueue("repo-1")).discarded, []);
	assert.deepEqual(seen, [GET, POST]);

	// A queued prompt that AO started instead of ending went on running: not discarded. t2 was ended.
	seen.length = 0;
	reads.push(open, snapshot([turn("t0", "interrupted"), turn("t1", "running"), turn("t2", "interrupted")]));
	assert.deepEqual((await ao.interruptWithQueue("repo-1")).discarded.map(d => d.turnId), ["t2"]);

	// AO never settles them: the wait ends at the deadline with what had ended by then (nothing), not forever.
	seen.length = 0;
	reads.length = 0;
	reads.push(open, ...Array.from({ length: 40 }, () => open));
	assert.deepEqual((await ao.interruptWithQueue("repo-1", 400)).discarded, []);
});

