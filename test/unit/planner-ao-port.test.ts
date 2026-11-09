// The AoPort over a stubbed AO HTTP surface: what the planner asks AO for, and how it reads the answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AoClient } from "../../src/ao/client";
import { aoPort } from "../../src/planner/ao-port";

test("the model list is only what this machine can run: models of unconfigured providers are left out (G36)", async () => {
	const body = {
		configuredProviders: ["anthropic", "openai-codex"],
		models: [
			{ id: "anthropic/claude-haiku-4-5", provider: "anthropic" },
			{ id: "openai-codex/gpt-5", provider: "openai-codex" },
			{ id: "nvidia/01-ai/yi-large", provider: "nvidia" },
			{ id: "kilo/anthropic/claude-3-haiku", provider: "kilo" },
		],
	};
	const fetchStub: typeof fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	const port = aoPort(new AoClient({ baseUrl: "http://127.0.0.1:1", fetch: fetchStub }));
	assert.deepEqual(await port.models(), ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5"]);
	// No configured providers reported (an AO that doesn't say): nothing is filtered out.
	body.configuredProviders = [];
	assert.equal((await port.models()).length, 4);
});
