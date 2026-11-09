import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AoClient, AoConversation } from "../../src/ao/client";
import { gateStatus } from "../../src/ao/gate";
import { ompExtensionDir } from "../../src/shared/omp-extension-install";
import { gateDecision, readMode, writeMode } from "../../src/shared/session-mode";
import { setSessionMode } from "../../src/shared/session-mode-ops";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ao-mode-test-"));

test("the mode file: one word per session, atomic, anything else reads as no mode (a session AO's own UI started)", () => {
	const home = tmp();
	try {
		assert.equal(readMode("repo-1", home), undefined);
		writeMode("repo-1", "edits", home);
		assert.equal(fs.readFileSync(path.join(home, "sessions", "repo-1", "mode"), "utf8"), "edits\n");
		assert.equal(readMode("repo-1", home), "edits");
		writeMode("repo-1", "plan", home);
		assert.equal(readMode("repo-1", home), "plan");
		assert.deepEqual(fs.readdirSync(path.join(home, "sessions", "repo-1")), ["mode"], "no temp file left behind");
		fs.writeFileSync(path.join(home, "sessions", "repo-1", "mode"), "yolo\n");
		assert.equal(readMode("repo-1", home), undefined);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("gateDecision: what each mode lets through, asks about and refuses", () => {
	assert.equal(gateDecision("auto", "edit"), "allow");
	assert.equal(gateDecision("ask", "edit"), "ask");
	assert.equal(gateDecision("ask", "bash"), "ask");
	assert.equal(gateDecision("ask", "read"), "allow", "omp's read-only tools never ask");
	assert.equal(gateDecision("edits", "edit"), "allow");
	assert.equal(gateDecision("edits", "bash"), "ask");
	assert.equal(gateDecision("plan", "edit"), "block");
	assert.equal(gateDecision("plan", "edit", false, true), "allow", "omp's own plan file");
	// A subagent can't ask anyone: edits run unless the mode is plan, commands run.
	assert.equal(gateDecision("ask", "edit", true), "allow");
	assert.equal(gateDecision("ask", "bash", true), "allow");
	assert.equal(gateDecision("plan", "edit", true), "block");
});

/** A client that records what setSessionMode does; the conversation holds the pending activities it is given. */
function fakeAo(activities: AoConversation["activities"]) {
	const calls: string[] = [];
	const conversation = { activities, turns: [{ id: "t1", state: "running" }], messages: [] } as unknown as AoConversation;
	const ao = {
		getConversation: async () => conversation,
		setConfigOption: async (_id: string, config: string, body: { value: string }) => void calls.push(`option ${config}=${body.value}`),
		resolveInput: async (_id: string, requestId: string, body: { action: string }) => void calls.push(`${body.action} ${requestId}`),
	};
	return { ao: ao as unknown as AoClient, calls };
}
const pending = (requestId: string, message: string): AoConversation["activities"][number] => ({ activityKind: "user_input", requestId, status: "pending", turnId: "t1", detail: { message } }) as unknown as AoConversation["activities"][number];

test("setSessionMode: writes the file, sets omp's plan option only when plan changes, declines the gate's old questions only", async () => {
	const home = tmp();
	const saved = process.env.SWITCHYARD_HOME;
	process.env.SWITCHYARD_HOME = home;
	try {
		writeMode("repo-1", "ask", home);
		// One gate question ("Allow tool: ...") and one of the agent's own questions: only the gate's is declined.
		const { ao, calls } = fakeAo([pending("r-gate", "Allow tool: bash: rm -rf x"), pending("r-agent", "Which branch should I use?")]);
		assert.deepEqual(await setSessionMode(ao, "repo-1", "plan"), { previous: "ask" });
		assert.equal(readMode("repo-1", home), "plan");
		assert.deepEqual(calls, ["option mode=plan", "decline r-gate"]);
		// plan -> edits: back to omp's default; edits -> auto: no option change, nothing to decline.
		const back = fakeAo([]);
		assert.deepEqual(await setSessionMode(back.ao, "repo-1", "edits"), { previous: "plan" });
		assert.deepEqual(back.calls, ["option mode=default"]);
		const same = fakeAo([]);
		await setSessionMode(same.ao, "repo-1", "auto");
		assert.deepEqual(same.calls, []);
		assert.equal(readMode("repo-1", home), "auto");
	} finally {
		if (saved === undefined) delete process.env.SWITCHYARD_HOME;
		else process.env.SWITCHYARD_HOME = saved;
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("gateStatus: the gate counts only when omp's package lists and ships mode.js; the shim only when it is ours", () => {
	const root = tmp();
	const omp = { home: path.join(root, "user"), env: {} as NodeJS.ProcessEnv };
	const switchyard = path.join(root, "switchyard");
	try {
		const dir = ompExtensionDir(omp);
		const none = gateStatus({ omp, home: switchyard });
		assert.deepEqual({ gate: none.gate, shim: none.shim }, { gate: false, shim: false });
		assert.equal(none.extensionDir, dir);
		// Listed but the module is missing, then present but not listed: neither is the gate.
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "switchyard", omp: { extensions: ["./mode.js"] } }));
		assert.equal(gateStatus({ omp, home: switchyard }).gate, false);
		fs.writeFileSync(path.join(dir, "mode.js"), "export default () => {};\n");
		assert.equal(gateStatus({ omp, home: switchyard }).gate, true);
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "switchyard", omp: { extensions: ["./checkpoints.js"] } }));
		assert.equal(gateStatus({ omp, home: switchyard }).gate, false);
		fs.writeFileSync(path.join(dir, "package.json"), "not json");
		assert.equal(gateStatus({ omp, home: switchyard }).gate, false);
		// The shim: ours (marker) or somebody's own omp in that folder.
		fs.mkdirSync(path.join(switchyard, "bin"), { recursive: true });
		fs.writeFileSync(path.join(switchyard, "bin", "omp"), "#!/bin/sh\n# switchyard-omp-shim\nexec omp \"$@\"\n");
		assert.equal(gateStatus({ omp, home: switchyard }).shim, true);
		fs.writeFileSync(path.join(switchyard, "bin", "omp"), "#!/bin/sh\nexec /usr/bin/omp \"$@\"\n");
		assert.equal(gateStatus({ omp, home: switchyard }).shim, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
