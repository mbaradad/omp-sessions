import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AoClient } from "../../src/ao/client";
import { applyChatHibernation, getChatHibernation } from "../../src/ao/daemon";
import { readHibernationSetting } from "../../src/ao/native";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ao-hib-test-"));

/** A daemon whose in-memory chatHibernationEnabled starts at `initial`; records the PATCHes it gets. */
function fakeAo(initial: boolean) {
	let enabled = initial;
	const calls: string[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input, init);
		const url = new URL(request.url);
		const body = request.method === "PATCH" ? ((await request.json()) as { enabled: boolean }) : undefined;
		calls.push(`${request.method} ${url.pathname}${body ? ` ${JSON.stringify(body)}` : ""}`);
		if (request.method === "PATCH") enabled = body?.enabled ?? enabled;
		return new Response(JSON.stringify(request.method === "GET" ? { chatHibernationEnabled: enabled } : {}), { status: 200, headers: { "content-type": "application/json" } });
	};
	return { fetch, calls, state: () => enabled };
}

test("readHibernationSetting: only \"on\" and \"off\" in config.json mean something; absent means leave AO alone", () => {
	const home = tmp();
	try {
		assert.equal(readHibernationSetting(home), undefined, "no file");
		const write = (text: string) => fs.writeFileSync(path.join(home, "config.json"), text);
		write('{"hibernation":"on"}');
		assert.equal(readHibernationSetting(home), true);
		write('{"model":"x","hibernation":"off"}');
		assert.equal(readHibernationSetting(home), false);
		for (const other of ['{"hibernation":true}', '{"hibernation":"yes"}', '{"hibernation":null}', "{}", "[]", "null", "not json", ""]) {
			write(other);
			assert.equal(readHibernationSetting(home), undefined, other);
		}
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("applyChatHibernation: reads first, writes only when it differs", async () => {
	const off = fakeAo(false);
	assert.deepEqual(await applyChatHibernation("http://127.0.0.1:1", true, { fetch: off.fetch }), { enabled: true, changed: true });
	assert.deepEqual(off.calls, ["GET /api/v1/settings", 'PATCH /api/v1/settings/chat-hibernation {"enabled":true}']);
	assert.equal(off.state(), true);
	// Already as wanted: no PATCH.
	assert.deepEqual(await applyChatHibernation("http://127.0.0.1:1", true, { fetch: off.fetch }), { enabled: true, changed: false });
	assert.equal(off.calls.filter(c => c.startsWith("PATCH")).length, 1);
	assert.equal(await getChatHibernation("http://127.0.0.1:1", { fetch: off.fetch }), true);
	// And turning it off again.
	assert.deepEqual(await applyChatHibernation("http://127.0.0.1:1", false, { fetch: off.fetch }), { enabled: false, changed: true });
});

test("AoClient.applyChatHibernation: follows config.json when no value is given, does nothing without one", async () => {
	const home = tmp();
	const saved = process.env.SWITCHYARD_HOME;
	process.env.SWITCHYARD_HOME = home;
	try {
		const daemon = fakeAo(false);
		const ao = new AoClient({ baseUrl: "http://127.0.0.1:1", fetch: daemon.fetch });
		// No key: AO is left alone, not even read.
		assert.equal(await ao.applyChatHibernation(), undefined);
		assert.deepEqual(daemon.calls, []);
		// "on" in config.json, AO off (it boots off): applied. A reconnect after it is already on: nothing to write.
		fs.writeFileSync(path.join(home, "config.json"), '{"hibernation":"on"}');
		assert.deepEqual(await ao.applyChatHibernation(), { enabled: true, changed: true });
		assert.deepEqual(await ao.applyChatHibernation(), { enabled: true, changed: false });
		// The daemon restarted: its in-memory flag is off again, and the next call puts it back.
		const restarted = fakeAo(false);
		const again = new AoClient({ baseUrl: "http://127.0.0.1:1", fetch: restarted.fetch });
		assert.deepEqual(await again.applyChatHibernation(), { enabled: true, changed: true });
		// An explicit value wins over the file.
		assert.deepEqual(await again.applyChatHibernation(false), { enabled: false, changed: true });
		assert.equal(restarted.state(), false);
	} finally {
		if (saved === undefined) delete process.env.SWITCHYARD_HOME;
		else process.env.SWITCHYARD_HOME = saved;
		fs.rmSync(home, { recursive: true, force: true });
	}
});
