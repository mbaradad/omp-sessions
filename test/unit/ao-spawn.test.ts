import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { AoClient, AoConfigOptions } from "../../src/ao/client";
import { daemonEnv } from "../../src/ao/daemon";
import { spawnSwitchyardSession } from "../../src/ao/spawn";
import { ompExtensionDir } from "../../src/shared/omp-extension-install";

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
/** AO's chat harnesses and their auth status in the fakes: by default omp and claude-code are authorized (omp is then the default). */
type FakeHarnesses = Record<string, "authorized" | "unknown" | "unauthorized">;
const HARNESSES: FakeHarnesses = { "claude-code": "authorized", codex: "unknown", omp: "authorized" };

function fakeAo(opts: { catalog?: string[]; catalogSteps?: { models: string[]; refreshState?: "idle" | "queued" | "refreshing" | "error" }[]; ready?: boolean; turns?: number; harnesses?: FakeHarnesses; worker?: string; modes?: string[] } = {}) {
	let catalogCalls = 0;
	const calls: string[] = [];
	const harnesses = opts.harnesses ?? HARNESSES;
	const catalogOf: string[] = [];
	const state = { model: "anthropic/opus", thinking: "high", mode: "default" };
	const sent: unknown[] = [];
	const spawns: Record<string, unknown>[] = [];
	const fake = {
		// What the harness is resolved from: read-only, not recorded in `calls`.
		settings: async () => ({ chatHarnesses: Object.keys(harnesses) }),
		agents: async () => {
			const supported = Object.entries(harnesses).map(([id, authStatus]) => ({ id, label: id, authStatus }));
			return { supported, installed: supported, authorized: supported.filter(a => a.authStatus === "authorized") };
		},
		chatPermissionModes: async () => opts.modes,
		unavailableChatHarnesses: async () => new Map<string, string>(),
		getProject: async (id: string) => ({ id, name: id, path: "/repo", kind: "single_repo", folderMissing: false, defaultBranch: "main", repo: "", config: opts.worker ? { worker: { agent: opts.worker } } : {} }),
		agentModels: async (harness: string) => {
			calls.push("agentModels");
			catalogOf.push(harness);
			const step = opts.catalogSteps?.[Math.min(catalogCalls++, opts.catalogSteps.length - 1)];
			return { models: (step?.models ?? opts.catalog ?? ["anthropic/opus", "anthropic/haiku", "zai/glm-4.5"]).map(id => ({ id })), ...(step?.refreshState && { refreshState: step.refreshState }) };
		},
		// Only a lookup that may register the project is recorded (the harness lookup passes create: false).
		projectForFolder: async (dir: string, o?: { create?: boolean }) => (o?.create !== false && calls.push(`projectForFolder ${dir}`), dir.includes("outside") ? undefined : { id: "repo", path: dir, name: "repo", kind: "single_repo", sessionPrefix: "repo", folderMissing: false }),
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
	return { ao: fake as unknown as AoClient, calls, sent, spawns, catalogOf };
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "ao-spawn-test-"));
const sessionFile = (home: string, name: string) => path.join(home, "sessions", "repo-1", name);

const strays: string[] = [];
after(() => {
	for (const dir of strays) fs.rmSync(dir, { recursive: true, force: true });
});
/** omp's agent folder of a temp "user home", with or without the Switchyard gate package installed in it (G46). */
function ompHome(installed: boolean): { omp: { home: string; env: NodeJS.ProcessEnv } } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "ao-spawn-omp-"));
	strays.push(home);
	const omp = { home, env: {} as NodeJS.ProcessEnv };
	if (installed) {
		const dir = ompExtensionDir(omp);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "switchyard", omp: { extensions: ["./mode.js"] } }));
		fs.writeFileSync(path.join(dir, "mode.js"), "export default () => {};\n");
	}
	return { omp };
}
/** The gate is installed: what the mode tests assume. */
const gate = ompHome(true);

test("spawnSwitchyardSession fails closed: a mode other than auto is refused, before anything exists in AO, when the gate is not installed", async () => {
	const home = tmpHome();
	try {
		const missing = ompHome(false);
		for (const mode of ["ask", "edits", "plan"] as const) {
			const { ao, calls } = fakeAo();
			await assert.rejects(spawnSwitchyardSession(ao, { mode, prompt: "go", home, gate: missing }), /Permission mode "(ask|edits|plan)" needs the Switchyard permission gate.*switchyard omp-extension install/s);
			assert.deepEqual(calls, [], `${mode}: no AO call was made, no session created`);
		}
		assert.equal(fs.existsSync(path.join(home, "sessions")), false, "no mode file or omp-args written");
		// A package that lists the gate but does not ship it is not a gate either.
		const hollow = ompHome(false);
		const dir = ompExtensionDir(hollow.omp);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ omp: { extensions: ["./mode.js"] } }));
		await assert.rejects(spawnSwitchyardSession(fakeAo().ao, { mode: "ask", home, gate: hollow }), /needs the Switchyard permission gate/);
		// `auto` (the default) never needs it: AO's bypass is what the person asked for.
		const auto = fakeAo();
		await spawnSwitchyardSession(auto.ao, { prompt: "go", home, gate: missing });
		assert.ok(auto.calls.includes("sendMessage"));
		assert.equal(fs.readFileSync(path.join(home, "sessions", "repo-1", "mode"), "utf8"), "auto\n");
		// With the gate installed every mode goes through.
		const { ao } = fakeAo();
		await spawnSwitchyardSession(ao, { mode: "ask", home, gate });
		assert.equal(fs.readFileSync(path.join(home, "sessions", "repo-1", "mode"), "utf8"), "ask\n");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession: bypass launch with no prompt or model, then the mode file, options, and the prompt last", async () => {
	const home = tmpHome();
	try {
		const { ao, calls, sent, spawns } = fakeAo();
		const out = await spawnSwitchyardSession(ao, { dir: "/work/repo", displayName: "fix it", branch: "feature/fix-it", model: "anthropic/haiku", thinking: "off", mode: "edits", prompt: "do it", clientRequestId: "rq-1", clientMessageId: "m-1", home, gate });
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
		await spawnSwitchyardSession(ao, { mode: "plan", model: "anthropic/opus", thinking: "high", home, gate });
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
			gate,
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
		await spawnSwitchyardSession(plain.ao, { ompArgs: ["--advisor"], mode: "plan", home, gate });
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

test("spawnSwitchyardSession: a fresh daemon's empty, still-refreshing model catalog is waited out, not read as 'unknown model'", async () => {
	const home = tmpHome();
	try {
		// What a daemon that just started answers: no models while omp lists them in the background, then the catalog.
		const fresh = fakeAo({ catalogSteps: [{ models: [], refreshState: "refreshing" }, { models: [], refreshState: "refreshing" }, { models: ["anthropic/opus", "anthropic/haiku"], refreshState: "idle" }] });
		await spawnSwitchyardSession(fresh.ao, { model: "anthropic/haiku", home, catalogWaitMs: 400 });
		assert.equal(fresh.calls.filter(c => c === "agentModels").length, 3, "asked until it settled");
		assert.ok(fresh.calls.includes("spawnSession"));
		// A catalog that is already partly filled but still refreshing, and lacks the model for now.
		const partial = fakeAo({ catalogSteps: [{ models: ["anthropic/opus"], refreshState: "refreshing" }, { models: ["anthropic/opus", "anthropic/haiku"], refreshState: "idle" }] });
		await spawnSwitchyardSession(partial.ao, { model: "anthropic/haiku", home, catalogWaitMs: 400 });
		assert.equal(partial.calls.filter(c => c === "agentModels").length, 2);
		// Settled WITHOUT the model: refused at once, no waiting, nothing created.
		const settled = fakeAo({ catalogSteps: [{ models: ["anthropic/opus"], refreshState: "idle" }] });
		await assert.rejects(spawnSwitchyardSession(settled.ao, { model: "nope/model", home, catalogWaitMs: 400 }), /Unknown omp model "nope\/model"/);
		assert.equal(settled.calls.filter(c => c === "agentModels").length, 1);
		assert.equal(settled.calls.includes("spawnSession"), false);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession: a catalog that never settles skips the pre-check; the session's own options still reject a bad model", async () => {
	const home = tmpHome();
	try {
		const stuck = { models: [], refreshState: "refreshing" as const };
		// A valid model: let AO and the session's options decide.
		const ok = fakeAo({ catalogSteps: [stuck] });
		await spawnSwitchyardSession(ok.ao, { model: "anthropic/haiku", home, catalogWaitMs: 40 });
		assert.ok(ok.calls.includes("spawnSession"), "not rejected for an empty catalog");
		// A bad one: it is the session's config options (step 4) that refuse it, and the session made for the check is removed.
		const bad = fakeAo({ catalogSteps: [stuck] });
		await assert.rejects(spawnSwitchyardSession(bad.ao, { model: "nope/model", prompt: "hi", home, catalogWaitMs: 40 }), /this session offers: anthropic\/opus/);
		assert.deepEqual(bad.calls.slice(-3), ["getConversation", "killSession", "deleteSession"]);
		assert.equal(bad.calls.includes("sendMessage"), false);
		// An unreadable catalog is skipped too (as before).
		const gone = fakeAo({ catalogSteps: [stuck] });
		(gone.ao as unknown as { agentModels: () => Promise<never> }).agentModels = () => Promise.reject(new Error("offline"));
		await spawnSwitchyardSession(gone.ao, { model: "anthropic/haiku", home, catalogWaitMs: 40 });
		assert.ok(gone.calls.includes("spawnSession"));
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession resolves the harness: explicit, then Switchyard's default, then the project's worker harness, then AO's default", async () => {
	const home = tmpHome();
	try {
		const harnessOf = async (opts: Parameters<typeof spawnSwitchyardSession>[1], ao = fakeAo()) => {
			const res = await spawnSwitchyardSession(ao.ao, { home, dir: "/repo", ...opts });
			assert.equal(ao.spawns[0].harness, res.harness, "the session is spawned with the resolved harness");
			return [res.harness, res.harnessSource];
		};
		assert.deepEqual(await harnessOf({ harness: "claude-code", defaultHarness: "omp" }, fakeAo({ worker: "codex" })), ["claude-code", "explicit"]);
		assert.deepEqual(await harnessOf({ defaultHarness: "codex" }, fakeAo({ worker: "omp" })), ["codex", "config"]);
		assert.deepEqual(await harnessOf({ defaultHarness: null }, fakeAo({ worker: "claude-code" })), ["claude-code", "project"]);
		assert.deepEqual(await harnessOf({ defaultHarness: null }), ["omp", "omp"], "several authorized: omp");
		// config.json's `harness` is Switchyard's default when the caller passes none.
		fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ harness: "codex" }));
		assert.deepEqual(await harnessOf({}, fakeAo({ worker: "omp" })), ["codex", "config"]);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession refuses a harness AO can't chat with, listing the available ones, before anything exists", async () => {
	const home = tmpHome();
	try {
		for (const harness of ["aider", "nope"]) {
			const { ao, calls } = fakeAo();
			await assert.rejects(spawnSwitchyardSession(ao, { home, harness, prompt: "go" }), new RegExp(`"${harness}" is not one of AO's chat harnesses; available: claude-code, codex \\(unknown\\), omp`));
			assert.deepEqual(calls, [], "no session created");
		}
		const { ao } = fakeAo({ worker: "aider" });
		await assert.rejects(spawnSwitchyardSession(ao, { home, dir: "/repo", defaultHarness: null }), /"aider" \(the AO project's worker.agent\) is not one of AO's chat harnesses/);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession for another harness: AO's approval mode, model and effort in the request, no omp steps, no mode file; plan and omp flags are omp-only", async () => {
	const home = tmpHome();
	try {
		const { ao, calls, spawns, sent, catalogOf } = fakeAo({ catalog: ["claude-opus-5"] });
		const res = await spawnSwitchyardSession(ao, { home, harness: "claude-code", mode: "edits", model: "claude-opus-5", thinking: "high", defaultModel: "anthropic/opus", prompt: "go", clientRequestId: "rq" });
		assert.equal(res.harness, "claude-code");
		assert.deepEqual(spawns, [{ harness: "claude-code", mode: "chat", kind: "worker", approvalMode: "accept-edits", clientRequestId: "rq", model: "claude-opus-5", effort: "high" }]);
		assert.deepEqual(catalogOf, ["claude-code"], "the model is checked against the harness's own catalog");
		assert.deepEqual(calls, ["agentModels", "spawnSession", "sendMessage"], "no config options, no restart, no omp mode");
		assert.equal(sent.length, 1);
		assert.equal(fs.existsSync(sessionFile(home, "mode")), false, "no mode file: the gate is omp's");
		// The mode mapping: ask → default, auto → bypass-permissions; the config's (omp) default model is not applied.
		for (const [mode, approvalMode] of [["ask", "default"], ["auto", "bypass-permissions"]] as const) {
			const f = fakeAo();
			await spawnSwitchyardSession(f.ao, { home, harness: "claude-code", mode, defaultModel: "anthropic/opus" });
			assert.equal(f.spawns[0].approvalMode, approvalMode);
			assert.equal("model" in f.spawns[0], false);
		}
		// The gate is not needed for another harness: ask starts without it.
		const nogate = fakeAo();
		await spawnSwitchyardSession(nogate.ao, { home, harness: "claude-code", mode: "ask", gate: ompHome(false) });
		const refused = fakeAo();
		await assert.rejects(spawnSwitchyardSession(refused.ao, { home, harness: "claude-code", mode: "plan" }), /Permission mode "plan" is omp-only.*runs claude-code/);
		await assert.rejects(spawnSwitchyardSession(refused.ao, { home, harness: "claude-code", ompArgs: ["--profile", "work"] }), /Extra omp arguments \(--profile work\) is omp-only/);
		assert.deepEqual(refused.calls, []);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession: config.json's default model goes to omp sessions only", async () => {
	const home = tmpHome();
	try {
		fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ model: "anthropic/haiku" }));
		const omp = fakeAo();
		await spawnSwitchyardSession(omp.ao, { home, harness: "omp", gate });
		assert.ok(omp.calls.includes("setConfigOption model=anthropic/haiku"));
		const other = fakeAo();
		await spawnSwitchyardSession(other.ao, { home, harness: "claude-code" });
		assert.equal("model" in other.spawns[0], false);
		assert.equal(other.calls.includes("agentModels"), false);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("spawnSwitchyardSession: a harness that can't run the mode asked for is refused; a default mode gives way to the nearest one AO offers", async () => {
	const home = tmpHome();
	try {
		const kimi = { harnesses: { kimi: "authorized" as const }, modes: ["default"] };
		const asked = fakeAo(kimi);
		await assert.rejects(spawnSwitchyardSession(asked.ao, { home, harness: "kimi", mode: "auto" }), /Permission mode "auto" \(AO bypass-permissions\) is not available for kimi; AO runs it in: ask \(AO default\)/);
		assert.deepEqual(asked.calls, []);
		const defaulted = fakeAo(kimi);
		const res = await spawnSwitchyardSession(defaulted.ao, { home, harness: "kimi", defaultMode: null });
		assert.deepEqual([defaulted.spawns[0].approvalMode, res.mode], ["default", "ask"]);
		// A default `plan` (omp's) starts another harness in ask.
		const plan = fakeAo();
		assert.equal((await spawnSwitchyardSession(plan.ao, { home, harness: "claude-code", defaultMode: "plan" })).mode, "ask");
		assert.equal(plan.spawns[0].approvalMode, "default");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
