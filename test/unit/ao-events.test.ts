import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { type AoEvent, type AoStreamStatus, SseParser, subscribeEvents } from "../../src/ao/events";

test("SseParser: frames split anywhere, CRLF/CR/LF, comments, multi-line data, id-only frames", () => {
	const p = new SseParser();
	const text = "\uFEFF: hello\r\nid: 1\r\nevent: session_updated\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\nevent: heartbeat\ndata: {}\n\nid: 7\n\nretry: 50\rdata:x\r\r";
	const frames = [];
	// One character at a time: every split point, including between CR and LF.
	for (const ch of text) frames.push(...p.feed(ch));
	assert.deepEqual(frames, [
		{ id: "1", event: "session_updated", data: '{"a":\n1}' },
		{ event: "heartbeat", data: "{}" },
		{ id: "7", event: "message", data: "" },
		{ event: "message", data: "x", retry: 50 },
	]);
});

interface Connection {
	url: string;
	lastEventId?: string;
	res: http.ServerResponse;
}

/** An SSE endpoint the test drives connection by connection. */
async function fakeDaemon(): Promise<{ base: string; next(): Promise<Connection>; close(): Promise<void> }> {
	const waiting: Array<(c: Connection) => void> = [];
	const queued: Connection[] = [];
	const server = http.createServer((req, res) => {
		const c: Connection = { url: req.url ?? "", res, ...(typeof req.headers["last-event-id"] === "string" && { lastEventId: req.headers["last-event-id"] }) };
		const w = waiting.shift();
		if (w) w(c);
		else queued.push(c);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${port}`,
		next: () => {
			const c = queued.shift();
			if (c) return Promise.resolve(c);
			const { promise, resolve } = Promise.withResolvers<Connection>();
			waiting.push(resolve);
			return promise;
		},
		close: () => {
			server.closeAllConnections();
			return new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

const open = (res: http.ServerResponse, after: number) => {
	res.writeHead(200, { "content-type": "text/event-stream", "x-ao-event-after": String(after) });
	res.flushHeaders();
};
const frame = (seq: number, sessionId = "repo-1") => `id: ${seq}\nevent: session_updated\ndata: ${JSON.stringify({ seq, projectId: "repo", sessionId, type: "session_updated", payload: { id: sessionId }, createdAt: "2026-11-09T15:00:00Z" })}\n\n`;

function collector() {
	const events: AoEvent[] = [];
	const statuses: AoStreamStatus[] = [];
	const waiters: Array<{ until: () => boolean; resolve: () => void }> = [];
	const check = () => {
		for (const w of [...waiters]) if (w.until()) waiters.splice(waiters.indexOf(w), 1), w.resolve();
	};
	return {
		events,
		statuses,
		onEvent: (e: AoEvent) => (events.push(e), check()),
		onStatus: (s: AoStreamStatus) => (statuses.push(s), check()),
		until(cond: () => boolean): Promise<void> {
			if (cond()) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ until: cond, resolve });
			return promise;
		},
	};
}

test("subscribeEvents: resumes after the last event with Last-Event-ID and drops replayed duplicates", async () => {
	const daemon = await fakeDaemon();
	const c = collector();
	const sub = subscribeEvents({ baseUrl: daemon.base, onEvent: c.onEvent, onStatus: c.onStatus, backoff: { initialMs: 5, maxMs: 5 }, random: () => 0 });
	try {
		const first = await daemon.next();
		assert.equal(first.url, "/api/v1/events?after=latest");
		assert.equal(first.lastEventId, undefined);
		open(first.res, 5);
		first.res.write("id: 5\nevent: cursor\ndata: {}\n\n");
		first.res.write(frame(6) + frame(7));
		await c.until(() => c.events.length === 2);
		assert.equal(sub.lastEventId, 7);
		first.res.destroy();

		const second = await daemon.next();
		assert.equal(second.url, "/api/v1/events?after=latest");
		assert.equal(second.lastEventId, "7");
		open(second.res, 7);
		// The server may overlap; heartbeats carry no id and change nothing.
		second.res.write(frame(7) + "event: heartbeat\ndata: {}\n\n" + frame(8));
		await c.until(() => c.events.length === 3);
		assert.deepEqual(c.events.map(e => e.seq), [6, 7, 8]);
		const opens = c.statuses.filter(s => s.state === "open");
		assert.deepEqual(opens, [
			{ state: "open", cursor: 5, resumed: false, reset: false },
			{ state: "open", cursor: 7, resumed: true, reset: false },
		]);
		assert.ok(c.statuses.some(s => s.state === "retrying"));
	} finally {
		sub.close();
		await daemon.close();
	}
});

test("subscribeEvents: a daemon whose log no longer has our cursor reports reset and is followed from its cursor", async () => {
	const daemon = await fakeDaemon();
	const c = collector();
	const sub = subscribeEvents({ baseUrl: daemon.base, after: 40, onEvent: c.onEvent, onStatus: c.onStatus, backoff: { initialMs: 5, maxMs: 5 }, random: () => 0 });
	try {
		const first = await daemon.next();
		// An explicit start cursor goes in the query.
		assert.equal(first.url, "/api/v1/events?after=40");
		assert.equal(first.lastEventId, undefined);
		open(first.res, 40);
		first.res.write(frame(41));
		await c.until(() => c.events.length === 1);
		first.res.destroy();

		// The daemon's data was reset: its head is behind us, and it says so in X-AO-Event-After.
		const second = await daemon.next();
		assert.equal(second.lastEventId, "41");
		open(second.res, 2);
		second.res.write(frame(3));
		await c.until(() => c.events.length === 2);
		assert.deepEqual(c.events.map(e => e.seq), [41, 3]);
		assert.deepEqual(c.statuses.filter(s => s.state === "open").at(-1), { state: "open", cursor: 2, resumed: false, reset: true });
		assert.equal(sub.lastEventId, 3);
	} finally {
		sub.close();
		await daemon.close();
	}
});

test("subscribeEvents: a silent stream is dropped and reopened; HTTP errors retry; close stops it", async () => {
	const daemon = await fakeDaemon();
	const c = collector();
	const sub = subscribeEvents({ baseUrl: daemon.base, onEvent: c.onEvent, onStatus: c.onStatus, idleTimeoutMs: 100, backoff: { initialMs: 5, maxMs: 5 }, random: () => 0 });
	try {
		const first = await daemon.next();
		open(first.res, 9);
		first.res.write("id: 9\nevent: cursor\ndata: {}\n\n");
		// Nothing more: no heartbeat within idleTimeoutMs.
		const second = await daemon.next();
		assert.equal(second.lastEventId, "9");
		second.res.writeHead(500, { "content-type": "application/json" }).end('{"code":"INTERNAL"}');
		const third = await daemon.next();
		assert.equal(third.lastEventId, "9");
		const retries = c.statuses.filter(s => s.state === "retrying");
		assert.match(retries[0].state === "retrying" ? retries[0].error : "", /no data for 100 ms/);
		assert.match(retries[1].state === "retrying" ? retries[1].error : "", /HTTP 500/);
		third.res.writeHead(503).end();
		await c.until(() => c.statuses.filter(s => s.state === "retrying").length === 3);
		sub.close();
		await c.until(() => c.statuses.at(-1)?.state === "closed");
	} finally {
		sub.close();
		await daemon.close();
	}
});
