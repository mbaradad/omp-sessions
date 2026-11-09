// The CLI (the bundled cli.js; still `omp-sessions` until the rename pass, with planner.js beside it) against an isolated AO
// daemon running the scripted ACP fake (test/ao-fixture.mjs): the skills/omp-sessions/SKILL.md
// contract — `new --json`, `wait` exit codes 0/3/4/5/124, `show --json`, `answer [--question]`,
// `send [--steer]`, `stop`/`resume`, `ls` filters, queued and scheduled tasks through the planner.
import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { AoClient } from "../../src/ao/client";
import { type AoFixture, aoAvailable, startAoFixture } from "../ao-fixture.mjs";

const skip = aoAvailable() ? false : "ao not installed (set OMP_TEST_AO_BIN)";
const CLI_JS = process.env.OMP_TEST_CLI_JS ?? "";

let ao: AoFixture;
let client: AoClient;
/** The isolated HOME the CLI runs under (omp's agent folder is in it). */
let fakeHome: string;
let repo: string;
let home: string;
let env: NodeJS.ProcessEnv;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	repo = ao.scratchRepo("cli-repo");
	home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-it-"));
	// Own planner and Switchyard state, and an isolated HOME with XDG_* under it (CONTRACT.md "Isolated HOME"): the CLI
	// must never touch the real launcher, skill, Hermes plugin or user services. The fixture's AO is found through discovery.
	fakeHome = path.join(home, "home");
	fs.mkdirSync(fakeHome, { recursive: true });
	const xdg = { XDG_CONFIG_HOME: path.join(fakeHome, ".config"), XDG_DATA_HOME: path.join(fakeHome, ".local", "share"), XDG_STATE_HOME: path.join(fakeHome, ".local", "state"), XDG_CACHE_HOME: path.join(fakeHome, ".cache") };
	env = { ...process.env, ...ao.stackEnv, HOME: fakeHome, ...xdg, OMP_VSCODE_HOME: path.join(home, "state"), SWITCHYARD_HOME: path.join(home, "switchyard"), NO_COLOR: "1" };
	assert.equal(cli("config", "set", "service", "off").status, 0);
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
});

after(async () => {
	if (skip) return;
	cli("server", "stop");
	// Chat hosts and their fake omp outlive the daemon by design: end every session through the API first.
	const { sessions } = await client.listSessions({}).catch(() => ({ sessions: [] }));
	await Promise.all(sessions.map(s => client.killSession(s.id).catch(() => undefined)));
	await ao?.stop();
	fs.rmSync(home, { recursive: true, force: true });
});

function cli(...args: string[]): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [CLI_JS, ...args], { cwd: repo, env, encoding: "utf8", input: "", timeout: 120_000 });
}

/** What the commands print with --json, as far as these tests read it (an absent field fails the test as it is read). */
interface Printed {
	id: string;
	started: boolean;
	title: string;
	cwd: string;
	startAt?: number;
	state: string;
	reply: string;
	mode?: string;
	tags: string[];
	changedFiles: number;
	queue: { pending: number; done: number };
	question: { id: string; kind: string; options: string[]; questions: Array<{ options: string[] }> };
	answered: boolean;
	sent: boolean;
	running: boolean;
	ao: { running: boolean; url: string };
	server: { running: boolean };
	omp: { readiness: string };
}

type Listed = Array<{ meta: { id: string } }>;

/** `cli(...args)` with its stdout parsed as JSON (a list for `ls`, `stop`, `resume`). */
function json<T = Printed>(...args: string[]): { status: number | null; data: T; stderr: string } {
	const r = cli(...args);
	let data: T;
	try {
		// The test reads the fields it asserts; a wrong shape fails those assertions.
		data = JSON.parse(r.stdout) as T;
	} catch {
		assert.fail(`${args.join(" ")} printed no JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
	}
	return { status: r.status, data, stderr: r.stderr };
}

/** A started session (the fake's script as its prompt). */
function started(script: string, ...flags: string[]): string {
	const r = json("new", repo, "-p", script, ...flags, "--json");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.data.started, true);
	assert.equal(typeof r.data.title, "string");
	assert.ok(r.data.cwd.startsWith(ao.dataDir), `AO runs the session in its worktree: ${r.data.cwd}`);
	return r.data.id;
}

/**
 * A session that asks before bash, started through AO directly: the fake omp asks as omp does for AO's `default` approval.
 * `new` starts sessions in AO's bypass with the Switchyard extension's gate deciding (D11), and the fake has no gate.
 */
async function startedAsking(script: string): Promise<string> {
	const project = await client.projectForFolder(repo);
	const res = await client.spawnSession({ harness: "omp", mode: "chat", kind: "worker", approvalMode: "default", projectId: project?.id, prompt: script });
	return res.session.id;
}

/** The files Switchyard's omp extension and shim leave on a machine that has them (the gate is what makes ask, edits and plan enforceable). */
function installGate(): void {
	// The fixture points omp at its own agent folder (PI_CODING_AGENT_DIR); the CLI looks where omp does.
	const dir = path.join(env.PI_CODING_AGENT_DIR ?? path.join(fakeHome, ".omp", "agent"), "extensions", "switchyard");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "mode.js"), "// test gate\n");
	fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "switchyard", omp: { extensions: ["./mode.js"] } })}\n`);
}

test("cli: usage errors exit 2; status says what runs and never starts the planner", { skip }, () => {
	assert.match(cli("--version").stdout, /^omp-sessions \S+/);
	assert.equal(cli("ls", "--bogus").status, 2);
	assert.equal(cli("new", repo, "--title", "--json").status, 2, "a value flag doesn't swallow the next flag");
	assert.equal(cli("new", repo, "--task", "x", "--at", "2020-01-01T08:00:00Z").status, 2, "a past time");
	assert.equal(cli("nope").status, 2);
	const s = json("status", "--json");
	assert.equal(s.status, 1, "the planner is down");
	assert.equal(s.data.ao.running, true);
	assert.equal(s.data.ao.url, ao.baseUrl);
	const hib = json<{ ao: { chatHibernation?: boolean }; notes: string[]; problems: string[] }>("status", "--json").data;
	assert.equal(hib.ao.chatHibernation, false, "AO starts with chat hibernation off");
	assert.ok(hib.notes.some(n => /chat-hibernation/.test(n)), "the note carries the one-line fix");
	assert.ok(!hib.problems.some(p => /hibernation/.test(p)), "off is a note, not a problem");
	assert.equal(s.data.server.running, false);
	assert.equal(typeof s.data.omp.readiness, "string", "AO's readiness of the omp agent (unknown until AO probed it)");
	assert.equal(json("server", "status", "--json").data.running, false, "status started no planner");
});

test("cli: new → wait 0 with the reply; show --json; ls finds it by project and state", { skip }, () => {
	const id = started("echo Hello from the fake", "--title", "greeting", "--mode", "auto");
	const w = json("wait", id, "--timeout", "60s", "--json");
	assert.equal(w.status, 0, w.stderr);
	assert.equal(w.data.state, "idle");
	assert.equal(w.data.reply, "Hello from the fake");
	assert.equal(w.data.title, "greeting");
	assert.equal(w.data.mode, "auto");
	for (const k of ["id", "title", "cwd", "tags", "changedFiles", "queue", "createdAt", "updatedAt"]) assert.ok(k in w.data, k);
	const project = path.basename(repo);
	const ids = (...f: string[]) => json<Listed>("ls", ...f, "--json").data.map(i => i.meta.id);
	assert.ok(ids("--project", project).includes(id));
	assert.ok(ids("--state", "idle").includes(id));
	assert.ok(!ids("--state", "working").includes(id));
	assert.ok(!ids("--project", "elsewhere").includes(id));
});

test("cli: an approval → wait 3 with the question; answer --question refuses another one; answer resumes", { skip }, async () => {
	// AO's default approval for omp asks before bash.
	const id = await startedAsking("bash touch approved.txt\nwrite note.txt hi\necho done after approval");
	const w = json("wait", id, "--timeout", "60s", "--json");
	assert.equal(w.status, 3, w.stderr);
	assert.equal(w.data.state, "needs_input");
	assert.equal(w.data.question.kind, "select", "tool approvals are select questions, as before");
	assert.ok(w.data.question.options.includes("Allow once"), JSON.stringify(w.data.question));
	assert.equal(cli("answer", id, "--question", "not-this-one", "1").status, 1);
	assert.equal(cli("answer", id, "maybe").status, 2, "not one of the decisions");
	const a = json("answer", id, "--question", w.data.question.id, "Allow once", "--json");
	assert.equal(a.status, 0, a.stderr);
	assert.equal(a.data.answered, true);
	const done = json("wait", id, "--timeout", "60s", "--json");
	assert.equal(done.status, 0, done.stderr);
	assert.equal(done.data.reply, "done after approval");
	assert.equal(fs.readFileSync(path.join(done.data.cwd, "note.txt"), "utf8"), "hi", "omp worked in the session's worktree");
	assert.equal(done.data.changedFiles, 1, "the workspace's changed files");
});

test("cli: omp's ask → kind ask; send --wait streams; stop → wait 4; resume → idle", { skip }, () => {
	const id = started("echo ready", "--mode", "auto");
	assert.equal(cli("wait", id, "--timeout", "60s").status, 0);
	assert.equal(json("send", id, "ask Ship it? | yes | no", "--json").data.sent, true);
	const w = json("wait", id, "--timeout", "60s", "--json");
	assert.equal(w.status, 3);
	// One question: its options, as `options` (kind select) or under `questions` (kind ask).
	assert.deepEqual(w.data.question.options ?? w.data.question.questions?.[0]?.options, ["yes", "no"]);
	assert.equal(cli("answer", id, "2").status, 0);
	assert.equal(json("wait", id, "--timeout", "60s", "--json").data.reply, "chose no");
	const streamed = cli("send", id, "echo streamed reply", "--wait");
	assert.equal(streamed.status, 0, streamed.stderr);
	assert.match(streamed.stdout, /streamed reply/);
	const stop = json<Array<{ stopped: boolean }>>("stop", id, "--json");
	assert.equal(stop.status, 0);
	assert.equal(stop.data[0].stopped, true);
	assert.equal(cli("stop", id).status, 1, "already stopped");
	assert.equal(cli("wait", id, "--timeout", "30s").status, 4);
	assert.equal(json<Array<{ started: boolean }>>("resume", id, "--json").data[0].started, true);
	assert.equal(json("wait", id, "--timeout", "60s", "--json").data.state, "idle");
});

test("cli: wait exits 124 while it works; abort ends the turn", { skip }, () => {
	const id = started("slow 20000", "--mode", "auto");
	assert.equal(cli("wait", id, "--timeout", "2s").status, 124);
	// A follow-up queued behind the running turn: AO discards it on abort (G41), the CLI hands it back.
	assert.equal(json("send", id, "echo queued reply", "--json").data.sent, true);
	const aborted = json<{ aborted: boolean; discarded: Array<{ text: string }> }>("abort", id, "--json");
	assert.equal(aborted.status, 0, aborted.stderr);
	assert.equal(aborted.data.aborted, true);
	assert.deepEqual(aborted.data.discarded.map(d => d.text), ["echo queued reply"]);
	assert.notEqual(cli("wait", id, "--timeout", "30s").status, 124);
	assert.equal(cli("abort", id).status, 1, "nothing to abort");
});

test("cli: new --task --at is scheduled (wait 5); the planner runs it once the start is cleared", { skip, timeout: 180_000 }, () => {
	const created = json("new", repo, "--task", "echo queued work done", "--at", "+2h", "--mode", "auto", "--tag", "it", "--json");
	assert.equal(created.status, 0, created.stderr);
	const id = created.data.id;
	assert.equal(typeof created.data.startAt, "number");
	const shown = json("show", id, "--json").data;
	assert.equal(shown.state, "scheduled");
	assert.deepEqual(shown.tags, ["it"]);
	assert.equal(shown.queue.pending, 1);
	assert.equal(cli("wait", id, "--timeout", "10s").status, 5);
	assert.ok(json<Listed>("ls", "--tag", "it", "--json").data.some(i => i.meta.id === id));
	assert.equal(cli("queue", id, "at", "off").status, 0);
	assert.equal(cli("queue", id, "start").status, 0);
	const w = json("wait", id, "--timeout", "120s", "--json");
	assert.equal(w.status, 0, JSON.stringify(w.data));
	assert.equal(w.data.queue.done, 1);
	assert.match(w.data.reply, /queued work done/);
});

test("cli: new --task --after waits for the other session; queue after refuses itself and clears with off; ls --json keeps meta.permissionMode and lastText", { skip, timeout: 180_000 }, () => {
	// A waits for its start time, so B's dependency can't finish by accident; the planner wraps task titles, so the fake echoes them whole.
	const a = json("new", repo, "--task", "echo A ran", "--at", "+2h", "--mode", "auto", "--json");
	assert.equal(a.status, 0, a.stderr);
	const b = json("new", repo, "--task", "echo B ran", "--after", a.data.id, "--mode", "auto", "--json");
	assert.equal(b.status, 0, b.stderr);
	assert.equal(json("show", b.data.id, "--json").data.state, "queued", "blocked behind A");
	assert.equal(cli("queue", b.data.id, "after", b.data.id).status, 1, "a queue can't wait for itself");
	assert.equal(cli("wait", b.data.id, "--timeout", "3s").status, 124, "still waiting");
	assert.equal(cli("queue", a.data.id, "at", "off").status, 0);
	assert.equal(cli("queue", a.data.id, "start").status, 0);
	const done = json("wait", b.data.id, "--timeout", "120s", "--json");
	assert.equal(done.status, 0, JSON.stringify(done.data));
	assert.match(done.data.reply, /echo B ran/);
	assert.equal(json("show", a.data.id, "--json").data.queue.done, 1, "A ran first");
	assert.equal(json("queue", b.data.id, "after", "off", "--json").status, 0);
	type Meta = { meta: { id: string; permissionMode?: string; lastText?: string } };
	const listed = json<Meta[]>("ls", "--all", "--json").data.find(i => i.meta.id === b.data.id);
	assert.equal(listed?.meta.permissionMode, "auto");
	assert.match(listed?.meta.lastText ?? "", /echo B ran/);
});

test("cli: complete/uncomplete mark a session (✓ in ls and show); queue requeue runs the last task again", { skip, timeout: 180_000 }, () => {
	const created = json("new", repo, "--task", "echo once", "--mode", "auto", "--json");
	assert.equal(created.status, 0, created.stderr);
	const id = created.data.id;
	assert.equal(cli("wait", id, "--timeout", "60s").status, 0);
	type Marked = { id: string; completed: boolean; completedAt?: number; changed: boolean };
	const first = json<Marked>("complete", id, "--json");
	assert.equal(first.status, 0, first.stderr);
	assert.deepEqual([first.data.completed, first.data.changed, typeof first.data.completedAt], [true, true, "number"]);
	assert.equal(json<Marked>("complete", id, "--json").data.changed, false, "already marked");
	assert.equal(json<{ completed: boolean }>("show", id, "--json").data.completed, true);
	assert.match(cli("ls", "--all").stdout, new RegExp(`${id}.*✓`));
	assert.equal(json<{ completed: boolean; changed: boolean }>("uncomplete", id, "--json").data.completed, false);
	assert.equal(json<{ completed: boolean }>("show", id, "--json").data.completed, false);
	// A session that never had a task can be marked too.
	const bare = json("new", repo, "-p", "echo bare", "--mode", "auto", "--json").data.id;
	assert.equal(json<Marked>("complete", bare, "--json").data.completed, true);

	type Queue = { tasks: Array<{ startedAt?: number }> };
	const startedBefore = json<Queue>("queue", id, "--json").data.tasks[0].startedAt ?? 0;
	assert.ok(startedBefore > 0);
	assert.equal(cli("queue", id, "requeue").status, 0);
	assert.equal(cli("wait", id, "--timeout", "60s").status, 0);
	const startedAfter = json<Queue>("queue", id, "--json").data.tasks[0].startedAt ?? 0;
	assert.ok(startedAfter > startedBefore, "the task ran again");
});

test("cli: sched budget, usage and limits are set through the planner; --usage spare needs --task", { skip }, () => {
	type Status = { budget?: Record<string, number>; usage: { holdAtPercent: number; spareBelowPercent: number }; limits: unknown[] };
	assert.equal(json<Status>("sched", "budget", "day", "5", "--json").data.budget?.day, 5);
	assert.equal(json<Status>("sched", "budget", "hour", "1.5", "--json").data.budget?.day, 5, "setting one window keeps the others");
	assert.equal(json<Status>("sched", "budget", "day", "off", "--json").data.budget?.day, undefined);
	const usage = json<Status>("sched", "usage", "spare", "40", "--json").data.usage;
	assert.equal(usage.spareBelowPercent, 40);
	assert.ok(Array.isArray(json<Status>("sched", "limits", "--json").data.limits));
	assert.equal(cli("sched", "budget", "year", "5").status, 2);
	assert.equal(cli("sched", "usage", "hold", "250").status, 2);
	assert.equal(cli("new", repo, "-p", "echo x", "--usage", "spare").status, 2);
	const spare = json("new", repo, "--task", "echo spare work", "--usage", "spare", "--mode", "auto", "--json");
	assert.equal(spare.status, 0, spare.stderr);
	assert.equal(cli("wait", spare.data.id, "--timeout", "60s").status, 0, "no usage window is full: a spare task runs");
});

test("cli: plan status lists the graph's edges with their sync state; plan sync takes a task or session", { skip, timeout: 180_000 }, () => {
	// The notes are the fake's script (the planner wraps the title). A session the CLI created has no planner-seeded branch, so its edge may carry no sync state yet (asked planner).
	const a = json("new", repo, "--task", "PA", "--notes", "write x.txt A1\necho a-done", "--mode", "auto", "--json");
	assert.equal(a.status, 0, a.stderr);
	const b = json("new", repo, "--task", "PB", "--notes", "echo b-done", "--after", a.data.id, "--mode", "auto", "--json");
	assert.equal(b.status, 0, b.stderr);
	const done = json("wait", b.data.id, "--timeout", "120s", "--json");
	assert.equal(done.status, 0, JSON.stringify(done.data));
	type Edge = { parent: string; parentSession?: string; child: string; childSession?: string; state: string };
	const status = json<{ edges: Edge[] }>("plan", "status", "--json");
	assert.equal(status.status, 0, status.stderr);
	const mine = json<{ edges: Edge[] }>("plan", "status", "--json", "--", b.data.id).data.edges;
	for (const e of mine) assert.ok([e.parentSession, e.childSession].includes(b.data.id));
	const synced = json<{ task: string; synced: string[]; rerun: boolean; edges: Edge[] }>("plan", "sync", "--json", "--", b.data.id);
	assert.equal(synced.status, 0, synced.stderr);
	assert.equal(synced.data.synced.length, 1, "B's one parent");
	assert.equal(typeof synced.data.task, "string");
	assert.equal(synced.data.rerun, false, "no --rerun");
	assert.equal(cli("plan", "status", "--", "no-such-thing").status, 1);
	assert.equal(cli("plan", "sync", "--", "no-such-thing").status, 1);
	assert.equal(cli("plan", "bogus").status, 2);
});

test("cli: the error texts and exit codes the Hermes plugin matches; tags are on the entry and in meta", { skip }, async () => {
	const missing = cli("show", "--json", "--", "no-such-session-1");
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /no session matches/);
	const id = started("echo tagged", "--mode", "auto", "--tag", "hermes:proj", "--tag", "card:t_1");
	assert.equal(cli("wait", id, "--timeout", "60s").status, 0);
	type Entry = { tags?: string[]; meta: { id: string; tags?: string[] } };
	const entry = json<Entry[]>("ls", "--all", "--json").data.find(i => i.meta.id === id);
	assert.deepEqual(entry?.tags, ["hermes:proj", "card:t_1"]);
	assert.deepEqual(entry?.meta.tags, ["hermes:proj", "card:t_1"]);
	// Nothing waits: answering says so (exit 1); a stale --question says the question changed.
	const idle = cli("answer", id, "--", "yes");
	assert.equal(idle.status, 1);
	assert.match(idle.stderr, /question changed|not waiting for an answer|no question is waiting/i);
	// A real question: the wrong id → "question changed" (1); an answer that doesn't fit → 2.
	const asking = await startedAsking("bash touch q.txt");
	const w = json("wait", asking, "--timeout", "60s", "--json");
	assert.equal(w.status, 3);
	const moved = cli("answer", asking, `--question=nope`, "--", "yes");
	assert.equal(moved.status, 1);
	assert.match(moved.stderr, /question changed/i);
	assert.equal(cli("answer", asking, `--question=${w.data.question.id}`, "--", "maybe").status, 2);
	assert.equal(cli("answer", asking, `--question=${w.data.question.id}`, "--", "reject").status, 0);
});

test("cli: new --worktree auto|always reports the worktree; never/--no-worktree is refused before a session exists; archive/unarchive --json", { skip, timeout: 120_000 }, () => {
	const before = json<Array<{ meta: { id: string } }>>("ls", "--all", "--json").data.length;
	type Worktree = { id: string; worktree?: { path: string; repo: string; branch?: string } };
	const made = json<Worktree>("new", repo, "-p", "echo wt", "--worktree=always", "--mode", "auto", "--json");
	assert.equal(made.status, 0, made.stderr);
	assert.equal(made.data.worktree?.repo, fs.realpathSync(repo));
	assert.ok(made.data.worktree?.path.startsWith(ao.dataDir), "AO's worktree, not the checkout");
	assert.equal(cli("new", repo, "-p", "echo x", "--worktree=auto").status, 0);
	for (const refused of [["--no-worktree"], ["--worktree=never"]]) {
		const r = cli("new", repo, "-p", "echo x", ...refused);
		assert.equal(r.status, 1, refused.join(" "));
		assert.match(r.stderr, /its own worktree/);
	}
	assert.equal(cli("new", repo, "-p", "echo x", "--worktree=sometimes").status, 2);
	assert.equal(cli("new", repo, "-p", "echo x", "--worktree=auto", "--no-worktree").status, 2);
	const unusable = cli("new", repo, "-p", "echo x", "--model", "nowhere/not-a-model");
	assert.equal(unusable.status, 1, "a model omp can't use fails before AO creates a session (it would leave a terminated one)");
	assert.match(unusable.stderr, /model/);
	assert.equal(json<unknown[]>("ls", "--all", "--json").data.length, before + 2, "a refused start creates nothing");
	type Archived = { id: string; archived: boolean; changed: boolean };
	const id = made.data.id;
	assert.deepEqual(json<Archived>("archive", id, "--json").data, { id, archived: true, changed: true });
	assert.deepEqual(json<Archived>("archive", id, "--json").data, { id, archived: true, changed: false });
	assert.deepEqual(json<Archived>("unarchive", id, "--json").data, { id, archived: false, changed: true });
});

test("cli: --mode ask|edits|plan needs the omp extension; the mode file is what show and ls report; mode switches it live; omp flags after -- need the shim", { skip, timeout: 180_000 }, () => {
	// No extension on this machine: nothing would ask, so ask, edits and plan are refused before a session exists.
	const before = json<Listed>("ls", "--all", "--json").data.length;
	const refused = cli("new", repo, "-p", "echo x", "--mode", "ask");
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /omp extension/);
	assert.equal(cli("new", repo, "-p", "echo x", "--mode", "auto").status, 0, "auto needs no gate");
	assert.equal(cli("new", repo, "-p", "echo x", "--", "--advisor", "x").status, 1, "no shim to apply omp flags");
	assert.equal(json<Listed>("ls", "--all", "--json").data.length, before + 1, "a refused start creates nothing");
	const status = json<{ omp: { extension: { installed: boolean }; shim: { installed: boolean } } }>("status", "--json").data;
	assert.equal(status.omp.extension.installed, false);
	assert.equal(status.omp.shim.installed, false);

	installGate();
	type Entry = { mode?: string; meta: { id: string; permissionMode?: string } };
	const id = started("echo hello", "--mode", "ask");
	assert.equal(fs.readFileSync(path.join(home, "switchyard", "sessions", id, "mode"), "utf8").trim(), "ask", "the file the gate reads");
	assert.equal(cli("wait", id, "--timeout", "60s").status, 0);
	assert.equal(json("show", id, "--json").data.mode, "ask");
	const listed = json<Entry[]>("ls", "--all", "--json").data.find(e => e.meta.id === id);
	assert.equal(listed?.meta.permissionMode, "ask", "ask is exact now: it is what the file says");
	assert.equal(listed?.mode, "ask");
	assert.equal(cli("mode", id, "edits").status, 0);
	assert.equal(fs.readFileSync(path.join(home, "switchyard", "sessions", id, "mode"), "utf8").trim(), "edits", "switched live: the next tool call reads it");
	assert.equal(json("show", id, "--json").data.mode, "edits");

	// Flags after -- reach omp only through the shim on the AO daemon's PATH. This daemon was not started that way, so
	// the CLI refuses instead of writing flags that would be ignored (the omp-args file itself is src/ao/spawn.ts's).
	fs.mkdirSync(path.join(home, "switchyard", "bin"), { recursive: true });
	fs.writeFileSync(path.join(home, "switchyard", "bin", "omp"), "#!/bin/sh\n# switchyard-omp-shim test\n");
	const flagged = cli("new", repo, "-p", "echo flagged", "--mode", "auto", "--json", "--", "--advisor", "plan");
	assert.equal(flagged.status, 1);
	assert.match(flagged.stderr, /first on its PATH/);
	const shim = json<{ omp: { shim: { installed: boolean; onDaemonPath?: boolean } }; problems: string[] }>("status", "--json").data;
	assert.equal(shim.omp.shim.installed, true);
	assert.equal(shim.omp.shim.onDaemonPath, false);
	assert.ok(shim.problems.some(p => /first on its PATH/.test(p)));
});
