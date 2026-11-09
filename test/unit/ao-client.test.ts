import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AoClient, AoError } from "../../src/ao/client";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });

/** A run file naming this (live) process on `port`, and a fetch that is a daemon on `port` only. */
function daemonOn(port: number, requests: string[]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-client-test-"));
	const runFile = path.join(dir, "running.json");
	fs.writeFileSync(runFile, JSON.stringify({ pid: process.pid, port }));
	const fetch = async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		requests.push(`${url.port}${url.pathname}`);
		if (url.port !== String(port)) throw refused();
		if (url.pathname === "/healthz") return json({ status: "ok", service: "agent-orchestrator-daemon", pid: process.pid });
		if (url.pathname === "/readyz") return json({ status: "ready", service: "agent-orchestrator-daemon", pid: process.pid });
		return json({ sessions: [] });
	};
	return { runFile, fetch, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a daemon that moved: parallel failed requests share one rediscovery and are retried on the new address", async () => {
	const requests: string[] = [];
	const d = daemonOn(4242, requests);
	try {
		const ao = new AoClient({ baseUrl: "http://127.0.0.1:4141", fetch: d.fetch }, { runFile: d.runFile, fetch: d.fetch });
		const results = await Promise.all(Array.from({ length: 6 }, () => ao.listSessions()));
		assert.equal(results.length, 6);
		assert.equal(ao.baseUrl, "http://127.0.0.1:4242");
		// One /healthz and one /readyz probe for six failures, not six each.
		assert.equal(requests.filter(r => r === "4242/healthz").length, 1);
		assert.equal(requests.filter(r => r === "4242/readyz").length, 1);
		// The shared probe is released: a later failure probes again.
		requests.length = 0;
		await ao.rediscover();
		assert.equal(requests.filter(r => r === "4242/healthz").length, 1);
	} finally {
		d.cleanup();
	}
});

test("no daemon anywhere: parallel requests fail DAEMON_UNREACHABLE, with one probe", async () => {
	const requests: string[] = [];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-client-test-"));
	try {
		const fetch = async (input: RequestInfo | URL): Promise<Response> => {
			requests.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
			throw refused();
		};
		const ao = new AoClient({ baseUrl: "http://127.0.0.1:4141", fetch }, { runFile: path.join(dir, "none.json"), port: 4343, fetch });
		const errors = await Promise.all(Array.from({ length: 6 }, () => ao.listSessions().then(() => undefined, (e: unknown) => e)));
		for (const e of errors) assert.ok(e instanceof AoError && e.code === "DAEMON_UNREACHABLE" && e.status === 0);
		assert.equal(requests.filter(r => r === "/healthz").length, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
