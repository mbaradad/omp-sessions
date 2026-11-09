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
