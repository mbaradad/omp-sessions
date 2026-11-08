// The `omp-sessions` command itself (the bundled cli.js next to server.js and host.js) against a temp
// data home and the fake omp: --version, unknown flags, `status` (never starts the server, exits 1 when
// degraded), a scheduled `new --at` showing in `ls` and `status`, stop/abort exit codes, models and the
// default model, the folder link.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import type { SessionMeta } from "../../src/shared/protocol";
import { ServerClient, serviceUnitText } from "../../src/shared/server-client";
import { alive, isRecord } from "./harness";

const CLI_JS = process.env.OMP_TEST_CLI_JS ?? "";
const FAKE_OMP = process.env.OMP_TEST_FAKE_OMP ?? "";

let root = "";
let home = "";
let cwd = "";

function cli(...args: string[]): { status: number; stdout: string; stderr: string } {
	return cliIn(undefined, ...args);
}

/** `cli` with `input` on stdin. */
function cliIn(input: string | undefined, ...args: string[]): { status: number; stdout: string; stderr: string } {
	const r = spawnSync(process.execPath, [CLI_JS, ...args], {
		cwd,
		input,
		encoding: "utf8",
		timeout: 30_000,
		// No OMP_SESSIONS_NO_SERVICE: a data home other than ~/.omp/vscode alone must keep the service untouched.
		env: { ...process.env, HOME: root, OMP_VSCODE_HOME: home, OMP_SESSIONS_NO_SERVICE: "", NO_COLOR: "1", FAKE_OMP_SESSIONS: path.join(root, "fake-sessions") },
	});
	return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function json(...args: string[]): { status: number; data: unknown } {
	const r = cli(...args);
	try {
		return { status: r.status, data: JSON.parse(r.stdout) };
	} catch {
		throw new Error(`omp-sessions ${args.join(" ")} printed no JSON (exit ${r.status}): ${r.stdout}${r.stderr}`);
	}
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-cli-"));
	home = path.join(root, "state");
	cwd = path.join(root, "work");
	for (const d of [home, cwd, path.join(root, "fake-sessions")]) fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(path.join(home, "launcher.json"), JSON.stringify({ ompPath: FAKE_OMP }));
	process.env.OMP_VSCODE_HOME = home;
});

after(() => {
	cli("server", "stop");
	for (const id of fs.existsSync(path.join(home, "sessions")) ? fs.readdirSync(path.join(home, "sessions")) : []) {
		try {
			const m: SessionMeta = JSON.parse(fs.readFileSync(path.join(home, "sessions", id, "meta.json"), "utf8"));
			for (const pid of [m.pid, m.ompPid ?? 0]) if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
		} catch {
			/* no meta */
		}
	}
	fs.rmSync(root, { recursive: true, force: true });
});

test("cli: --version, unknown flags and missing values are usage errors", () => {
	assert.match(cli("--version").stdout, /^omp-sessions \S+\n/);
	assert.match(cli("-v").stdout, /^omp-sessions \S+\n/);
	const v = json("version", "--json");
	assert.ok(isRecord(v.data) && typeof v.data.cli === "string" && v.data.server === null);
	const bogus = cli("ls", "--bogus");
	assert.equal(bogus.status, 2);
	assert.match(bogus.stderr, /--bogus/);
	assert.equal(cli("new", cwd, "--title", "--json").status, 2, "a value flag doesn't swallow the next flag");
	assert.equal(cli("new", cwd, "--task", "x", "--at", "25:99").status, 2);
	assert.equal(cli("new", cwd, "--task", "x", "--at", "2020-01-01T08:00:00Z").status, 2, "a past time");
	assert.equal(cli("nope").status, 2);
});

test("cli: status reports without starting the server and exits 1 while it is down", async () => {
	const s = json("status", "--json");
	assert.equal(s.status, 1);
	assert.ok(isRecord(s.data) && isRecord(s.data.server) && isRecord(s.data.omp) && Array.isArray(s.data.problems));
	assert.equal(s.data.ok, false);
	assert.equal(s.data.server.running, false);
	assert.equal(s.data.omp.path, FAKE_OMP);
	assert.equal(s.data.home, home);
	assert.equal(await ServerClient.connect(500), undefined, "status started no server");
});

test("cli: a session scheduled with new --at shows in ls and status; stop unqueues it; abort/stop on it then fail", () => {
	const created = json("new", cwd, "--task", "echo later", "--at", "+2h", "--json");
	assert.equal(created.status, 0);
	assert.ok(isRecord(created.data) && typeof created.data.id === "string" && typeof created.data.startAt === "number");
	const id = created.data.id;

	const listed = json("ls", "--json");
	assert.ok(Array.isArray(listed.data) && listed.data.some(i => isRecord(i) && isRecord(i.meta) && i.meta.id === id), "listed without --all");
	assert.match(cli("ls").stdout, new RegExp(id.slice(0, 8)));
	const ids = (data: unknown) => (Array.isArray(data) ? data.flatMap(i => (isRecord(i) && isRecord(i.meta) ? [i.meta.id] : [])) : undefined);
	assert.deepEqual(ids(json("ls", "--project", path.basename(cwd), "--json").data), [id]);
	assert.deepEqual(ids(json("ls", "--project", "elsewhere", "--json").data), []);

	const s = json("status", "--json");
	assert.equal(s.status, 0, JSON.stringify(s.data));
	assert.ok(isRecord(s.data) && isRecord(s.data.server) && isRecord(s.data.sessions) && isRecord(s.data.tasks));
	assert.equal(s.data.ok, true);
	assert.equal(s.data.server.running, true, "the earlier command started it on demand");
	assert.equal(s.data.sessions.total, 1);
	assert.equal(s.data.tasks.pending, 1);

	assert.equal(cli("stop", id).status, 0, "stopping a scheduled session cancels its start");
	const unqueued = json("ls", "--all", "--json").data;
	assert.ok(Array.isArray(unqueued) && unqueued.some(i => isRecord(i) && isRecord(i.meta) && i.meta.id === id && i.state === "stopped"), "no longer scheduled");
	assert.equal(cli("stop", id).status, 1, "nothing left to stop");
	assert.equal(cli("abort", id).status, 1);
});

test("cli: models come from omp; the default model is marked; a stopped session's model is set for its resume", () => {
	const listed = json("models", "--json");
	assert.ok(isRecord(listed.data) && Array.isArray(listed.data.models));
	assert.ok(listed.data.models.some(m => isRecord(m) && m.selector === "fake/fake-model"));
	assert.equal(listed.data.default, null);
	assert.equal(cli("config", "set", "model", "not-a-selector").status, 2);
	assert.equal(cli("config", "set", "model", "fake/fake-mini").status, 0);
	assert.equal(json("config", "get", "model", "--json").data, "fake/fake-mini");
	assert.equal(cli("config", "set", "model", "nope/nope").status, 1, "omp doesn't list it");
	assert.equal(json("config", "get", "model", "--json").data, "fake/fake-mini", "refused: unchanged");
	assert.equal(cli("config", "set", "model", "nope/nope", "--force").status, 0);
	assert.equal(json("config", "get", "model", "--json").data, "nope/nope");
	assert.equal(cli("config", "set", "model", "fake/fake-mini").status, 0);
	const marked = json("models", "mini", "--json").data;
	assert.ok(isRecord(marked) && Array.isArray(marked.models) && marked.models.length === 1 && isRecord(marked.models[0]) && marked.models[0].default === true);

	const created = json("new", cwd, "--task", "echo later", "--at", "+3h", "--json").data;
	assert.ok(isRecord(created) && typeof created.id === "string");
	const set = json("model", created.id, "fake/fake-model", "--json").data;
	assert.ok(isRecord(set) && set.applied === "next-resume");
	const shown = json("model", created.id, "--json").data;
	assert.ok(isRecord(shown) && shown.model === "fake/fake-model" && shown.running === false);
});

test("cli: vscode --folder links exactly that folder", () => {
	const r = json("vscode", "--folder", cwd, "--json");
	assert.equal(r.status, 0);
	assert.ok(isRecord(r.data) && typeof r.data.url === "string");
	assert.equal(r.data.folder, cwd);
	assert.match(r.data.url, /^vscode:\/\/file\//);
	assert.equal(cli("vscode", "--folder", path.join(root, "missing"), "--json").status, 1);
});

test("cli: vscode --authority links over that remote even when no window of it was recorded; a bad one is refused", () => {
	const r = json("vscode", "--folder", cwd, "--authority", "ssh-remote+box", "--json");
	assert.equal(r.status, 0);
	assert.ok(isRecord(r.data) && typeof r.data.url === "string");
	assert.ok(r.data.url.startsWith("vscode://vscode-remote/ssh-remote+box/"), r.data.url);
	assert.equal(r.data.authority, "ssh-remote+box");
	assert.equal(cli("vscode", "--folder", cwd, "--authority", "box/../x").status, 2);
});

/** A session's `show` state as `ls --all --json` lists it. */
function stateOf(id: string): unknown {
	const listed = json("ls", "--all", "--json").data;
	return Array.isArray(listed) ? listed.find(i => isRecord(i) && isRecord(i.meta) && i.meta.id === id)?.state : undefined;
}

function listedIds(...args: string[]): string[] {
	const data = json("ls", ...args, "--json").data;
	return Array.isArray(data) ? data.flatMap(i => (isRecord(i) && isRecord(i.meta) && typeof i.meta.id === "string" ? [i.meta.id] : [])) : [];
}

function newScheduled(task: string): string {
	const created = json("new", cwd, "--task", task, "--at", "+4h", "--json").data;
	assert.ok(isRecord(created) && typeof created.id === "string");
	return created.id;
}

test("cli: queue add - takes stdin's first line as the title and the rest as notes; --notes too", () => {
	const id = newScheduled("seed");
	const added = cliIn("Fix the build\n\nStep one\n  step two\n", "queue", id, "add", "-", "--json");
	assert.equal(added.status, 0, added.stderr);
	const q: unknown = JSON.parse(added.stdout);
	assert.ok(isRecord(q) && Array.isArray(q.tasks));
	assert.deepEqual([q.tasks[1]?.title, q.tasks[1]?.notes], ["Fix the build", "Step one\n  step two"]);
	const flagged = json("queue", id, "add", "Short", "--notes", "line a", "--json").data;
	assert.ok(isRecord(flagged) && Array.isArray(flagged.tasks) && isRecord(flagged.tasks[2]));
	assert.deepEqual([flagged.tasks[2].title, flagged.tasks[2].notes], ["Short", "line a"]);
	assert.equal(cliIn("x", "queue", id, "add", "-", "--notes", "-").status, 2, "only one of them reads stdin");
	assert.equal(cli("stop", id).status, 0);
});

test("cli: wait exits 5 while scheduled and 4 once interrupted; board and ls --state show it; rescheduling clears it", { timeout: 90_000 }, () => {
	const id = newScheduled("echo again");
	assert.equal(cli("wait", id, "--timeout", "30").status, 5);
	// The host died while the task ran (crash, reboot): queue.json still says running.
	const file = path.join(home, "sessions", id, "queue.json");
	const q = JSON.parse(fs.readFileSync(file, "utf8"));
	Object.assign(q.tasks[0], { status: "running", startedAt: Date.now() });
	q.autoRun = false;
	delete q.startAt;
	fs.writeFileSync(file, JSON.stringify(q));
	assert.equal(cli("wait", id, "--timeout", "30").status, 4);
	assert.equal(stateOf(id), "interrupted");
	const board = json("board", "--json").data;
	assert.ok(isRecord(board) && Array.isArray(board.columns));
	const column = board.columns.find(col => isRecord(col) && Array.isArray(col.sessions) && col.sessions.some(s => isRecord(s) && isRecord(s.meta) && s.meta.id === id));
	assert.ok(isRecord(column) && column.id === "interrupted", "board shows it (no --all needed)");
	assert.ok(listedIds("--state", "interrupted").includes(id));
	assert.ok(!listedIds("--state", "stopped").includes(id), "interrupted is not stopped");

	const rescheduled = json("queue", id, "at", "+1h", "--json").data;
	assert.ok(isRecord(rescheduled) && Array.isArray(rescheduled.tasks) && isRecord(rescheduled.tasks[0]));
	assert.equal(rescheduled.tasks[0].interrupted, undefined);
	assert.equal(stateOf(id), "scheduled");
	assert.equal(cli("wait", id, "--timeout", "30").status, 5);
	const sched = json("sched", "--json").data;
	assert.ok(isRecord(sched) && typeof sched.scheduled === "number" && sched.scheduled >= 1);
	assert.ok(listedIds("--state", "scheduled").includes(id));
	assert.ok(!listedIds("--state", "stopped").includes(id), "scheduled is not stopped");
	assert.equal(cli("stop", id).status, 0);
});

test("cli: send --wait exits 3 on a question and answer takes it at once; ls --state stopped lists the finished session", { timeout: 90_000 }, () => {
	const created = json("new", cwd, "--json").data;
	assert.ok(isRecord(created) && typeof created.id === "string" && created.started === true);
	const id = created.id;
	const sent = cli("send", id, "ask", "--wait");
	assert.equal(sent.status, 3, sent.stderr);
	const answered = cli("answer", id, "1", "--json");
	assert.equal(answered.status, 0, answered.stderr);
	const done = json("wait", id, "--timeout", "30", "--json");
	assert.equal(done.status, 0);
	assert.ok(isRecord(done.data) && typeof done.data.reply === "string" && done.data.reply.includes("alpha"), JSON.stringify(done.data));
	assert.equal(cli("stop", id).status, 0);
	const scheduled = newScheduled("still ahead");
	const stopped = listedIds("--state", "stopped");
	assert.ok(stopped.includes(id));
	assert.ok(!stopped.includes(scheduled));
	assert.equal(cli("stop", scheduled).status, 0);
});

test("cli: help <command> and <command> --help print only that command's usage", () => {
	const full = cli("help");
	const queue = cli("help", "queue");
	assert.equal(queue.status, 0);
	assert.equal(cli("queue", "--help").stdout, queue.stdout);
	assert.equal(cli("q", "--help").stdout, queue.stdout, "aliases too");
	assert.ok(queue.stdout.includes("queue <session> add") && !queue.stdout.includes("remote on"));
	assert.ok(queue.stdout.length < full.stdout.length / 4);
	assert.equal(cli("--help").stdout, full.stdout);
	assert.equal(cli("help", "nope").status, 2);
});

test("cli: the first on-demand start installs the user service once; a temp data home never does", { skip: process.platform !== "linux" }, async () => {
	const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-svc-"));
	const bin = path.join(userHome, "bin");
	const calls = path.join(userHome, "systemctl.log");
	fs.mkdirSync(bin);
	// Records the calls and succeeds without starting anything: the CLI then spawns the server itself.
	fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nexit 0\n`, { mode: 0o755 });
	const state = path.join(userHome, ".omp", "vscode");
	fs.mkdirSync(state, { recursive: true });
	fs.writeFileSync(path.join(state, "launcher.json"), JSON.stringify({ ompPath: FAKE_OMP }));
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, NO_COLOR: "1", FAKE_OMP_SESSIONS: path.join(userHome, "fake") };
	delete env.OMP_VSCODE_HOME;
	delete env.OMP_SESSIONS_NO_SERVICE;
	delete env.ELECTRON_RUN_AS_NODE;
	const run = (...args: string[]) => spawnSync(process.execPath, [CLI_JS, ...args], { cwd, encoding: "utf8", timeout: 30_000, env });
	const unit = path.join(userHome, ".config", "systemd", "user", "omp-sessions.service");
	try {
		const first = run("ls");
		assert.equal(first.status, 0, first.stderr);
		assert.ok(fs.existsSync(unit), "unit written");
		assert.match(first.stderr, /installed the server as a systemd user service/);
		assert.match(fs.readFileSync(calls, "utf8"), /enable --now omp-sessions\.service/);
		const second = run("ls");
		assert.equal(second.status, 0);
		assert.equal(fs.readFileSync(calls, "utf8").match(/enable --now omp-sessions\.service/g)?.length, 1, "installed once");
		const s = JSON.parse(run("status", "--json").stdout);
		assert.ok(isRecord(s) && isRecord(s.service) && s.service.installed === true && s.service.servesThisHome === true);
		// The other tests' temp data home never touched the (fake) user's units.
		assert.equal(fs.existsSync(path.join(root, ".config", "systemd")), false);
	} finally {
		run("server", "stop");
		fs.rmSync(userHome, { recursive: true, force: true });
	}
});

test("cli: service off, OMP_SESSIONS_NO_SERVICE and VS Code's runtime never install the service; a unit whose node is gone is re-pointed", { skip: process.platform !== "linux", timeout: 90_000 }, () => {
	const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-svc-"));
	const bin = path.join(userHome, "bin");
	const calls = path.join(userHome, "systemctl.log");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nexit 0\n`, { mode: 0o755 });
	const state = path.join(userHome, ".omp", "vscode");
	fs.mkdirSync(state, { recursive: true });
	fs.writeFileSync(path.join(state, "launcher.json"), JSON.stringify({ ompPath: FAKE_OMP, service: "off" }));
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, NO_COLOR: "1", FAKE_OMP_SESSIONS: path.join(userHome, "fake") };
	delete env.OMP_VSCODE_HOME;
	delete env.OMP_SESSIONS_NO_SERVICE;
	delete env.ELECTRON_RUN_AS_NODE;
	const run = (extra: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [CLI_JS, ...args], { cwd, encoding: "utf8", timeout: 30_000, env: { ...env, ...extra } });
	const status = (extra: NodeJS.ProcessEnv = {}): Record<string, unknown> => {
		const s: unknown = JSON.parse(run(extra, "status", "--json").stdout);
		assert.ok(isRecord(s) && isRecord(s.service));
		return s.service;
	};
	const unit = path.join(userHome, ".config", "systemd", "user", "omp-sessions.service");
	try {
		assert.equal(run({}, "ls").status, 0);
		assert.equal(fs.existsSync(unit), false, "service off");
		assert.deepEqual([status().autoInstall, status().noAutoInstall], [false, "service off"]);
		run({}, "server", "stop");

		assert.equal(run({}, "config", "set", "service", "on").status, 0);
		assert.equal(run({ OMP_SESSIONS_NO_SERVICE: "1" }, "ls").status, 0);
		assert.equal(fs.existsSync(unit), false, "OMP_SESSIONS_NO_SERVICE");
		run({}, "server", "stop");
		// The extension's launcher sets ELECTRON_RUN_AS_NODE when it runs the CLI with VS Code's own node.
		assert.equal(run({ ELECTRON_RUN_AS_NODE: "1" }, "ls").status, 0);
		assert.equal(fs.existsSync(unit), false, "VS Code's runtime moves with updates");
		run({}, "server", "stop");
		assert.equal(status().autoInstall, true);

		// A unit from a VS Code that has since updated: its node is gone.
		const gone = path.join(userHome, "vscode-server", "Stable-old", "node");
		fs.mkdirSync(path.dirname(unit), { recursive: true });
		fs.writeFileSync(unit, serviceUnitText("systemd", gone, path.join(path.dirname(CLI_JS), "server.js"), ["ELECTRON_RUN_AS_NODE=1"]));
		const broken = status();
		assert.deepEqual([broken.node, broken.nodeExists], [gone, false]);
		assert.equal(run({}, "status").status, 1, "a problem");
		const repaired = run({}, "ls");
		assert.equal(repaired.status, 0, repaired.stderr);
		assert.ok(fs.readFileSync(unit, "utf8").includes(JSON.stringify(process.execPath)), "re-pointed at a node that exists");
		assert.equal(status().nodeExists, true);
	} finally {
		run({}, "server", "stop");
		fs.rmSync(userHome, { recursive: true, force: true });
	}
});
