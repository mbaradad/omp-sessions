import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AoClient, AoConfigOptions } from "../../src/ao/client";
import { daemonEnv } from "../../src/ao/daemon";
import { spawnSwitchyardSession } from "../../src/ao/spawn";

const choices = (...values: string[]) => values.map(value => ({ value, name: value }));
/** The levels depend on the model, as in omp: haiku has no `low`. */
const thinkingLevels = (model: string) => (model === "anthropic/haiku" ? ["off", "high"] : ["off", "low", "high"]);
const configOptions = (current: { model?: string; thinking?: string; mode?: string } = {}): AoConfigOptions => ({
	options: [
		{ id: "mode", name: "Mode", type: "select", currentValue: current.mode ?? "default", choices: choices("default", "plan") },
		{ id: "model", name: "Model", type: "select", currentValue: current.model ?? "anthropic/opus", choices: choices("anthropic/opus", "anthropic/haiku", "zai/glm-4.5") },
		{ id: "thinking", name: "Thinking", type: "select", currentValue: current.thinking ?? "high", choices: choices(...thinkingLevels(current.model ?? "anthropic/opus")) },
	],
});

/** Records every call the helper makes on the client; what AO answers is fixed, so only the helper's behaviour is under test. */
function fakeAo(opts: { catalog?: string[]; ready?: boolean; turns?: number } = {}) {
	const calls: string[] = [];
	const state = { model: "anthropic/opus", thinking: "high", mode: "default" };
	const sent: unknown[] = [];
	const spawns: Record<string, unknown>[] = [];
	const fake = {
		agentModels: async () => (calls.push("agentModels"), { models: (opts.catalog ?? ["anthropic/opus", "anthropic/haiku", "zai/glm-4.5"]).map(id => ({ id })) }),
		projectForFolder: async (dir: string) => (calls.push(`projectForFolder ${dir}`), dir.includes("outside") ? undefined : { id: "repo", path: dir, name: "repo", kind: "single_repo", sessionPrefix: "repo", folderMissing: false }),
		spawnSession: async (body: Record<string, unknown>) => (calls.push("spawnSession"), spawns.push(body), { session: { id: "repo-1" }, promptBytes: 0, systemPromptBytes: 0 }),
		configOptions: async () => (calls.push("configOptions"), configOptions(state)),
		exitAgent: async () => void calls.push("exitAgent"),
		resumeAgent: async () => void calls.push("resumeAgent"),
		getConversation: async () => (calls.push("getConversation"), { controller: opts.ready === false ? "connecting" : "ready", turns: Array.from({ length: opts.turns ?? 0 }, (_, i) => ({ id: `t${i}` })) }),
		setConfigOption: async (_id: string, key: "model" | "thinking" | "mode", body: { value?: string }) => (calls.push(`setConfigOption ${key}=${body.value}`), (state[key] = body.value ?? state[key]), configOptions(state)),
		killSession: async () => void calls.push("killSession"),
		deleteSession: async () => void calls.push("deleteSession"),
		sendMessage: async (_id: string, body: unknown) => (calls.push("sendMessage"), sent.push(body), { duplicate: false, state: "running" as const, turnId: "t1" }),
	};
	// The helper uses only these methods of AoClient; the fake has exactly them.
	return { ao: fake as unknown as AoClient, calls, sent, spawns };
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "ao-spawn-test-"));
const sessionFile = (home: string, name: string) => path.join(home, "sessions", "repo-1", name);

test("spawnSwitchyardSession: bypass launch with no prompt or model, then the mode file, options, and the prompt last", async () => {
	const home = tmpHome();
	try {
		const { ao, calls, sent, spawns } = fakeAo();
		const out = await spawnSwitchyardSession(ao, { dir: "/work/repo", displayName: "fix it", branch: "feature/fix-it", model: "anthropic/haiku", thinking: "off", mode: "edits", prompt: "do it", clientRequestId: "rq-1", clientMessageId: "m-1", home });
		// AO gets the bypass launch (the extension's gate is the only one), no prompt, no model; the ids and the branch are the caller's.
		assert.deepEqual(spawns, [{ harness: "omp", mode: "chat", kind: "worker", approvalMode: "bypass-permissions", clientRequestId: "rq-1", projectId: "repo", displayName: "fix it", branch: "feature/fix-it" }]);
		assert.deepEqual(calls, ["agentModels", "projectForFolder /work/repo", "spawnSession", "configOptions", "setConfigOption model=anthropic/haiku", "configOptions", "setConfigOption thinking=off", "sendMessage"]);
		assert.deepEqual(sent, [{ text: "do it", clientMessageId: "m-1" }]);
		assert.equal(fs.readFileSync(sessionFile(home, "mode"), "utf8"), "edits\n");
		assert.equal(fs.existsSync(sessionFile(home, "omp-args")), false);
		assert.equal(out.session.id, "repo-1");
		assert.equal(out.project?.id, "repo");
		assert.equal(out.sent?.turnId, "t1");
		assert.deepEqual([out.clientRequestId, out.clientMessageId], ["rq-1", "m-1"]);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession: defaults to auto, generates ids, leaves a promptless session waiting, standalone outside git", async () => {
	const home = tmpHome();
	try {
		const { ao, calls, spawns } = fakeAo();
		const out = await spawnSwitchyardSession(ao, { dir: "/outside/git", home });
		assert.equal(fs.readFileSync(sessionFile(home, "mode"), "utf8"), "auto\n");
		assert.equal("projectId" in spawns[0], false);
		assert.equal(out.project, undefined);
		assert.match(out.clientRequestId, /^[0-9a-f-]{36}$/);
		assert.equal(out.clientMessageId, undefined);
		assert.equal(out.sent, undefined);
		// Nothing to send, nothing to set: only the spawn and a look at the options.
		assert.deepEqual(calls, ["projectForFolder /outside/git", "spawnSession", "configOptions"]);
		// With a prompt and no id, one is generated for the message too.
		const withPrompt = await spawnSwitchyardSession(fakeAo().ao, { prompt: "hi", home });
		assert.match(withPrompt.clientMessageId ?? "", /^[0-9a-f-]{36}$/);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession: plan mode sets omp's own plan option; options already current are not set again", async () => {
	const home = tmpHome();
	try {
		const { ao, calls } = fakeAo();
		await spawnSwitchyardSession(ao, { mode: "plan", model: "anthropic/opus", thinking: "high", home });
		// The fake session already runs opus at high thinking: only plan is a change.
		assert.deepEqual(calls.filter(c => c.startsWith("setConfigOption")), ["setConfigOption mode=plan"]);
		assert.equal(fs.readFileSync(sessionFile(home, "mode"), "utf8"), "plan\n");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession: an unknown model never creates a session; one only this session lacks removes it", async () => {
	const home = tmpHome();
	try {
		// In no catalog: refused before anything exists.
		const none = fakeAo();
		await assert.rejects(spawnSwitchyardSession(none.ao, { model: "nope/model", home }), /Unknown omp model "nope\/model" \(not in AO's model catalog\)/);
		assert.equal(none.calls.includes("spawnSession"), false);
		// In the catalog but not offered by this session (unconfigured provider): the session made for the check is removed, no prompt sent.
		const some = fakeAo({ catalog: ["anthropic/opus", "venice/other"] });
		await assert.rejects(spawnSwitchyardSession(some.ao, { model: "venice/other", prompt: "hi", home }), /this session offers: anthropic\/opus, anthropic\/haiku, zai\/glm-4\.5/);
		assert.deepEqual(some.calls.slice(-3), ["getConversation", "killSession", "deleteSession"]);
		assert.equal(some.calls.includes("sendMessage"), false);
		assert.equal(fs.existsSync(sessionFile(home, "mode")), false, "no mode file for a session that was removed");
		// Same for an unknown thinking level.
		const thinking = fakeAo();
		await assert.rejects(spawnSwitchyardSession(thinking.ao, { thinking: "ludicrous", home }), /Unknown thinking level "ludicrous"; omp offers: off, low, high/);
		assert.deepEqual(thinking.calls.slice(-3), ["getConversation", "killSession", "deleteSession"]);
		// The levels a model offers depend on the model: haiku has no `low`, checked after the model is set.
		const dependent = fakeAo();
		await assert.rejects(spawnSwitchyardSession(dependent.ao, { model: "anthropic/haiku", thinking: "low", home }), /Unknown thinking level "low" for anthropic\/haiku; omp offers: off, high/);
		assert.deepEqual(dependent.calls.slice(-3), ["getConversation", "killSession", "deleteSession"]);
		assert.equal(fs.existsSync(path.join(home, "sessions", "repo-1")), false, "the state files of the removed session are gone too");
		// A session that already has turns (a retry after a crash found the earlier call's session) is never deleted.
		const existing = fakeAo({ turns: 2 });
		await assert.rejects(spawnSwitchyardSession(existing.ao, { thinking: "ludicrous", clientRequestId: "same", home }), /Unknown thinking level/);
		assert.equal(existing.calls.includes("killSession") || existing.calls.includes("deleteSession"), false);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession: extra omp arguments are written for the shim and the agent restarts before the options are set", async () => {
	const home = tmpHome();
	try {
		const { ao, calls } = fakeAo();
		await spawnSwitchyardSession(ao, { ompArgs: ["--advisor", "--plan-yolo"], thinking: "low", prompt: "go", home });
		assert.equal(fs.readFileSync(sessionFile(home, "omp-args"), "utf8"), "--advisor --plan-yolo\n");
		// Restart first (a relaunch resets omp's live options), then set them, then the prompt.
		assert.deepEqual(calls.slice(calls.indexOf("exitAgent")), ["exitAgent", "resumeAgent", "getConversation", "configOptions", "setConfigOption thinking=low", "sendMessage"]);
		// An argument with whitespace is written as a JSON array (the shim reads words or an array); an empty one is refused.
		const spaced = tmpHome();
		await spawnSwitchyardSession(fakeAo().ao, { ompArgs: ["--profile", "work space", "--advisor"], home: spaced });
		assert.equal(fs.readFileSync(sessionFile(spaced, "omp-args"), "utf8"), '["--profile","work space","--advisor"]\n');
		fs.rmSync(spaced, { recursive: true, force: true });
		await assert.rejects(spawnSwitchyardSession(fakeAo().ao, { ompArgs: [""], home }), /an omp argument is empty/);
		// An agent that never comes back: the session is removed and the error says why.
		const stuck = fakeAo({ ready: false });
		await assert.rejects(spawnSwitchyardSession(stuck.ao, { ompArgs: ["--advisor"], readyTimeoutMs: 1200, home }), /did not come back/);
		assert.deepEqual(stuck.calls.slice(-3), ["getConversation", "killSession", "deleteSession"]);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession: the caller's setMode runs after the restart and the options, before the prompt; the helper writes no mode file then", async () => {
	const home = tmpHome();
	try {
		const { ao, calls } = fakeAo();
		const asked: string[] = [];
		await spawnSwitchyardSession(ao, {
			ompArgs: ["--advisor"],
			model: "anthropic/haiku",
			thinking: "off",
			mode: "plan",
			prompt: "go",
			home,
			// checkpoints' setSessionMode: writes the file and sets omp's plan option itself.
			setMode: async (id, mode) => void (asked.push(`${id}=${mode}`), calls.push(`setMode ${mode}`)),
		});
		assert.deepEqual(asked, ["repo-1=plan"]);
		// Restart first (it resets omp's live options), then model and thinking, then the mode, then the prompt.
		assert.deepEqual(calls.slice(calls.indexOf("exitAgent")), ["exitAgent", "resumeAgent", "getConversation", "configOptions", "setConfigOption model=anthropic/haiku", "configOptions", "setConfigOption thinking=off", "setMode plan", "sendMessage"]);
		// The hook owns the file and the plan option: the helper wrote no mode file and set no plan option of its own.
		assert.equal(fs.existsSync(sessionFile(home, "mode")), false);
		assert.equal(calls.includes("setConfigOption mode=plan"), false);

		// Without a hook, plan is applied after the restart too, not before it.
		const plain = fakeAo();
		await spawnSwitchyardSession(plain.ao, { ompArgs: ["--advisor"], mode: "plan", home });
		assert.deepEqual(plain.calls.slice(plain.calls.indexOf("exitAgent")), ["exitAgent", "resumeAgent", "getConversation", "configOptions", "setConfigOption mode=plan"]);
		assert.equal(fs.readFileSync(sessionFile(home, "mode"), "utf8"), "plan\n");

		// A hook that fails: no prompt is sent and the session is removed.
		const failing = fakeAo();
		await assert.rejects(spawnSwitchyardSession(failing.ao, { prompt: "go", home, setMode: async () => Promise.reject(new Error("gate unavailable")) }), /gate unavailable/);
		assert.deepEqual(failing.calls.slice(-3), ["getConversation", "killSession", "deleteSession"]);
		assert.equal(failing.calls.includes("sendMessage"), false);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("daemonEnv: the Switchyard omp shim's folder goes first on the PATH of a daemon we start, only when it exists", () => {
	const home = tmpHome();
	try {
		const env = { PATH: "/usr/bin:/bin", SWITCHYARD_HOME: home, HOME: "/h", AO_BIN: "/x/ao", SECRET: "no" };
		const without = daemonEnv(env, "/r/running.json");
		assert.equal(without.PATH, "/usr/bin:/bin");
		assert.equal(without.AO_BIN, undefined);
		assert.equal(without.SECRET, undefined);
		fs.mkdirSync(path.join(home, "bin"), { recursive: true });
		fs.writeFileSync(path.join(home, "bin", "omp"), "#!/bin/sh\n");
		const withShim = daemonEnv(env, "/r/running.json");
		assert.equal(withShim.PATH, `${path.join(home, "bin")}${path.delimiter}/usr/bin:/bin`);
		// Not added twice when it is already there.
		assert.equal(daemonEnv({ ...env, PATH: withShim.PATH }, "/r/running.json").PATH, withShim.PATH);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
