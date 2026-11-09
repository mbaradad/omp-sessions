// Graph propagation (GRAPH-PROPAGATION.md) with real git: an in-memory AO that gives every project
// session its own worktree, agents simulated by editing files in those worktrees. Covers the rules:
// children start from their parent's commit, later parent changes flow to working / finished children,
// conflicts abort cleanly and become a resolve run (or `conflict`), restarts apply a pending merge once.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { FakeAo, byTitle, git, scratchRepo, start, tempPlan, until } from "./planner-fake-ao";
import type { Planner } from "../../src/planner/planner";
import type { Task } from "../../src/planner/types";

interface Rig {
	repo: string;
	ao: FakeAo;
	file: string;
	p: Planner;
}

/** Plan A → (B, C) in a scratch repo; A writes x.txt = "A1" and finishes; returns once B and C run. */
async function graph(t: TestContext): Promise<Rig> {
	const repo = scratchRepo(t);
	const ao = new FakeAo(repo);
	const file = tempPlan(t);
	const p = start(file, ao);
	t.after(() => p.stop());
	p.setConfig({ maxConcurrent: 0 });
	const opts = { cwd: repo };
	p.edit([
		{ op: "add", ref: "a", task: { title: "A", options: opts } },
		{ op: "add", task: { title: "B", after: ["@a"], options: opts } },
		{ op: "add", task: { title: "C", after: ["@a"], options: opts } },
	]);
	const a = await sentSession(p, "A");
	write(ao, a, "x.txt", "A1\n");
	ao.finishTurn(a, "completed", "A edited x.txt");
	await until("B and C running", () => sent(p, "B") && sent(p, "C"));
	return { repo, ao, file, p };
}

const sent = (p: Planner, title: string): string | undefined => {
	const run = byTitle(p, title).run;
	return run?.phase === "sent" ? run.session : undefined;
};

async function sentSession(p: Planner, title: string): Promise<string> {
	return until(`${title} sent`, () => sent(p, title));
}

function write(ao: FakeAo, session: string, name: string, text: string): void {
	fs.writeFileSync(path.join(ao.worktreeOf(session), name), text);
}

const read = (ao: FakeAo, session: string, name: string): string => fs.readFileSync(path.join(ao.worktreeOf(session), name), "utf8");
const merges = (repo: string, branch: string): number => git(repo, "log", "--merges", "--format=%H", branch).split("\n").filter(Boolean).length;
const mergeHead = (worktree: string): boolean => {
	try {
		git(worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD");
		return true;
	} catch {
		return false;
	}
};

/** Re-runs A (a person requeued it) and has it write `text` to x.txt. */
async function reRunA(rig: Rig, text: string): Promise<void> {
	const a = byTitle(rig.p, "A");
	rig.p.edit([{ op: "requeue", id: a.id }]);
	const session = await sentSession(rig.p, "A");
	assert.equal(session, a.session, "a requeued task continues its own session");
	write(rig.ao, session, "x.txt", text);
	rig.ao.finishTurn(session, "completed", "A edited x.txt again");
	await until("A done again", () => byTitle(rig.p, "A").status === "done");
}

test("children start from the parent's commit (committed for it), each in its own worktree", async t => {
	const { repo, ao, p } = await graph(t);
	const a = byTitle(p, "A");
	const b = byTitle(p, "B");
	const c = byTitle(p, "C");
	assert.equal(git(repo, "log", "-1", "--format=%s", a.git?.branch as string), "switchyard: A");
	assert.match(git(repo, "log", "-1", "--format=%B", a.git?.branch as string), /Switchyard-Task: /);
	assert.equal(b.git?.branch, `switchyard/${b.id}`);
	assert.notEqual(b.git?.worktree, c.git?.worktree);
	assert.equal(read(ao, b.run?.session as string, "x.txt"), "A1\n");
	assert.equal(read(ao, c.run?.session as string, "x.txt"), "A1\n");
	assert.deepEqual(
		[b.sync?.[a.id]?.state, b.sync?.[a.id]?.head === a.git?.head],
		["in-sync", true],
	);
});

test("a later change to the parent: the working child merges after its turn and is prompted, the finished one is marked upstream-changed", async t => {
	const rig = await graph(t);
	const { repo, ao, p } = rig;
	const a = byTitle(p, "A");
	const bSession = sent(p, "B") as string;
	const cSession = sent(p, "C") as string;
	ao.finishTurn(cSession, "completed", "C done");
	await until("C done", () => byTitle(p, "C").status === "done");
	await reRunA(rig, "A2\n");
	// C (finished): merged, not re-run.
	await until("C merged", () => byTitle(p, "C").sync?.[a.id]?.state === "upstream-changed");
	assert.equal(read(ao, cSession, "x.txt"), "A2\n");
	assert.equal(byTitle(p, "C").status, "done");
	// B (working): nothing touched mid-turn, the change waits.
	assert.equal(byTitle(p, "B").sync?.[a.id]?.state, "pending");
	assert.equal(read(ao, bSession, "x.txt"), "A1\n");
	// B's turn ends: merge, then a follow-up run in its own session that names the upstream change.
	ao.finishTurn(bSession, "completed", "B done");
	await until("B follow-up sent", () => byTitle(p, "B").status === "running" && byTitle(p, "B").run?.via === "send" && sent(p, "B"));
	assert.equal(read(ao, bSession, "x.txt"), "A2\n");
	const prompts = ao.sessions.get(bSession)?.conv.messages.filter(m => m.role === "user").map(m => m.text) ?? [];
	assert.equal(prompts.length, 2);
	assert.match(prompts[1], /Upstream task "A" changed/);
	assert.match(prompts[1], /Changed files: M x\.txt/);
	assert.equal(merges(repo, byTitle(p, "B").git?.branch as string), 1);
	assert.equal(merges(repo, byTitle(p, "C").git?.branch as string), 1);
});

test("a conflict aborts the merge cleanly and the child gets a resolve run; its merge resolves the edge", async t => {
	const rig = await graph(t);
	const { ao, p } = rig;
	const a = byTitle(p, "A");
	const bSession = sent(p, "B") as string;
	write(ao, bSession, "x.txt", "B-version\n");
	ao.finishTurn(bSession, "completed", "B edited x.txt");
	await until("B done", () => byTitle(p, "B").status === "done");
	await reRunA(rig, "A2\n");
	await until("B resolve run", () => byTitle(p, "B").status === "running" && byTitle(p, "B").run?.via === "send" && sent(p, "B"));
	const wt = ao.worktreeOf(bSession);
	assert.equal(mergeHead(wt), false);
	assert.equal(git(wt, "status", "--porcelain"), "");
	assert.equal(read(ao, bSession, "x.txt"), "B-version\n");
	assert.equal(byTitle(p, "B").sync?.[a.id]?.state, "resolving");
	const prompt = ao.sessions.get(bSession)?.conv.messages.filter(m => m.role === "user").pop()?.text ?? "";
	assert.match(prompt, /conflicts with yours in x\.txt/);
	assert.match(prompt, /git merge /);
	// The agent resolves it as asked.
	const parentBranch = a.git?.branch as string;
	try {
		git(wt, "merge", "--no-edit", parentBranch);
	} catch {
		/* conflicts expected */
	}
	fs.writeFileSync(path.join(wt, "x.txt"), "A2+B\n");
	git(wt, "add", "-A");
	git(wt, "commit", "-qm", "resolve");
	ao.finishTurn(bSession, "completed", "resolved");
	await until("edge merged", () => byTitle(p, "B").sync?.[a.id]?.state === "merged");
	assert.equal(byTitle(p, "B").status, "done");
	assert.equal(mergeHead(wt), false);
});

test("a resolve run that doesn't merge leaves the edge as conflict (no MERGE_HEAD, work kept)", async t => {
	const rig = await graph(t);
	const { ao, p } = rig;
	const a = byTitle(p, "A");
	const bSession = sent(p, "B") as string;
	write(ao, bSession, "x.txt", "B-version\n");
	ao.finishTurn(bSession, "completed", "B edited x.txt");
	await until("B done", () => byTitle(p, "B").status === "done");
	await reRunA(rig, "A2\n");
	await until("B resolve run", () => byTitle(p, "B").status === "running" && sent(p, "B"));
	ao.finishTurn(bSession, "completed", "could not");
	await until("edge conflict", () => byTitle(p, "B").sync?.[a.id]?.state === "conflict");
	const wt = ao.worktreeOf(bSession);
	assert.equal(mergeHead(wt), false);
	assert.equal(read(ao, bSession, "x.txt"), "B-version\n");
	assert.deepEqual(byTitle(p, "B").sync?.[a.id]?.files, ["x.txt"]);
	assert.equal(byTitle(p, "B").status, "done");
});

test("a planner restart with a merge pending applies it exactly once", async t => {
	const rig = await graph(t);
	const { repo, ao, file } = rig;
	const a = byTitle(rig.p, "A");
	ao.finishTurn(sent(rig.p, "C") as string, "completed", "C done");
	await until("C done", () => byTitle(rig.p, "C").status === "done");
	await reRunA(rig, "A2\n");
	await until("C merged", () => byTitle(rig.p, "C").sync?.[a.id]?.state === "upstream-changed");
	assert.equal(byTitle(rig.p, "B").sync?.[a.id]?.state, "pending");
	rig.p.stop();
	const p2 = start(file, ao);
	t.after(() => p2.stop());
	const bSession = byTitle(p2, "B").run?.session as string;
	assert.equal(byTitle(p2, "B").sync?.[a.id]?.state, "pending");
	ao.finishTurn(bSession, "completed", "B done");
	await until("B follow-up sent", () => byTitle(p2, "B").run?.via === "send" && sent(p2, "B"));
	const bBranch = byTitle(p2, "B").git?.branch as string;
	assert.equal(merges(repo, bBranch), 1);
	assert.equal(merges(repo, byTitle(p2, "C").git?.branch as string), 1);
	const prompts = ao.sessions.get(bSession)?.conv.messages.filter(m => m.role === "user").map(m => m.text) ?? [];
	assert.equal(prompts.length, 2);
	assert.equal((prompts[1].match(/Upstream task "A" changed/g) ?? []).length, 1);
	const states = (x: Task) => Object.values(x.sync ?? {}).map(e => e.state);
	assert.deepEqual(states(byTitle(p2, "B")), ["merged"]);
});

test("two tasks starting in the same new folder register its project once", async t => {
	const repo = scratchRepo(t);
	const ao = new FakeAo(repo);
	ao.registerDelayMs = 200;
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.setConfig({ maxConcurrent: 0 });
	p.edit([
		{ op: "add", task: { title: "one", options: { cwd: repo } } },
		{ op: "add", task: { title: "two", options: { cwd: repo } } },
	]);
	await until("both sent", () => sent(p, "one") && sent(p, "two"));
	assert.equal(ao.created, 2);
});

test("every propagation step is an event; `rerun` runs a finished child once more with only the upstream note and settles the edge", async t => {
	const rig = await graph(t);
	const { ao, p } = rig;
	const a = byTitle(p, "A");
	const steps: string[] = [];
	p.onChange(c => {
		if (!c.sync) return;
		const title = byTitle(p, "A").id === c.sync.child ? "A" : p.state.tasks.find(x => x.id === c.sync?.child)?.title;
		steps.push(`${title}:${c.sync.from ?? "-"}>${c.sync.to}`);
	});
	const bSession = sent(p, "B") as string;
	const cSession = sent(p, "C") as string;
	ao.finishTurn(cSession, "completed", "C done");
	await until("C done", () => byTitle(p, "C").status === "done");
	await reRunA(rig, "A2\n");
	await until("C marked", () => byTitle(p, "C").sync?.[a.id]?.state === "upstream-changed");
	assert.deepEqual(steps.filter(s => s.startsWith("C:")), ["C:in-sync>pending", "C:pending>upstream-changed"]);
	assert.deepEqual(steps.filter(s => s.startsWith("B:")), ["B:in-sync>pending"]);
	// B is still working; finish it so the test ends clean, then re-run C on demand.
	ao.finishTurn(bSession, "completed", "B done");
	p.edit([{ op: "rerun", id: byTitle(p, "C").id }]);
	await until("C re-run sent", () => byTitle(p, "C").status === "running" && byTitle(p, "C").run?.via === "send" && sent(p, "C"));
	const prompt = ao.sessions.get(cSession)?.conv.messages.filter(m => m.role === "user").pop()?.text ?? "";
	assert.match(prompt, /^\[Follow-up on your task\] C/);
	assert.match(prompt, /Upstream task "A" changed/);
	assert.doesNotMatch(prompt, /Results of the tasks/, "not the whole task again");
	ao.finishTurn(cSession, "completed", "C rechecked");
	await until("edge settled", () => byTitle(p, "C").sync?.[a.id]?.state === "merged");
	assert.equal(byTitle(p, "C").status, "done");
	assert.ok(steps.includes("C:upstream-changed>merged"));
});

test("a child in a session a client spawned earlier gets its parent's work merged in before the prompt; sessions stand for tasks in after/sync", async t => {
	const repo = scratchRepo(t);
	const ao = new FakeAo(repo);
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "add", task: { title: "A", options: { cwd: repo } } }]);
	const aSession = await sentSession(p, "A");
	write(ao, aSession, "x.txt", "A1\n");
	ao.finishTurn(aSession, "completed", "A edited x.txt");
	await until("A done", () => byTitle(p, "A").status === "done");
	// The CLI's `new --task`: the session exists (idle, from the default branch) before the task does.
	const { session } = await ao.spawn({ harness: "omp", projectId: "p", clientRequestId: "pre-spawned" });
	assert.equal(fs.readFileSync(path.join(ao.worktreeOf(session), "x.txt"), "utf8"), "base\n");
	await p.queue(session, [{ op: "add", title: "C" }, { op: "after", ids: [aSession] }, { op: "autoRun", value: true }]);
	assert.deepEqual(byTitle(p, "C").after, [byTitle(p, "A").id], "a session id names the task that ran in it");
	await until("C sent", () => sent(p, "C"));
	const c = byTitle(p, "C");
	assert.equal(read(ao, session, "x.txt"), "A1\n");
	assert.equal(c.git?.branch, ao.sessions.get(session)?.branch);
	assert.equal(c.sync?.[byTitle(p, "A").id]?.state, "merged");
	const prompt = ao.sessions.get(session)?.conv.messages.filter(m => m.role === "user").pop()?.text ?? "";
	assert.match(prompt, /Upstream task "A" changed/);
	assert.match(prompt, /### A\nA edited x\.txt/);
	assert.equal(merges(repo, c.git?.branch as string), 1);
	ao.finishTurn(session, "completed", "C done");
	await until("C done", () => byTitle(p, "C").status === "done");
	// Later changes to A reach C as for any child; `sync` takes the session id too.
	p.edit([{ op: "update", id: aSession, notes: "again" }, { op: "requeue", id: aSession }]);
	await sentSession(p, "A");
	write(ao, aSession, "x.txt", "A2\n");
	ao.finishTurn(aSession, "completed", "A again");
	await until("C marked", () => byTitle(p, "C").sync?.[byTitle(p, "A").id]?.state === "upstream-changed");
	assert.equal(read(ao, session, "x.txt"), "A2\n");
});

test("`rerun` on a conflict edge asks the agent to merge (edge resolving) and settles it", async t => {
	const rig = await graph(t);
	const { ao, p } = rig;
	const a = byTitle(p, "A");
	const bSession = sent(p, "B") as string;
	write(ao, bSession, "x.txt", "B-version\n");
	ao.finishTurn(bSession, "completed", "B edited x.txt");
	await until("B done", () => byTitle(p, "B").status === "done");
	await reRunA(rig, "A2\n");
	await until("B resolve run", () => byTitle(p, "B").status === "running" && sent(p, "B"));
	ao.finishTurn(bSession, "completed", "could not");
	await until("edge conflict", () => byTitle(p, "B").sync?.[a.id]?.state === "conflict");
	p.edit([{ op: "rerun", id: bSession }]);
	assert.equal(byTitle(p, "B").sync?.[a.id]?.state, "resolving");
	await until("B asked again", () => byTitle(p, "B").status === "running" && byTitle(p, "B").run?.via === "send" && sent(p, "B"));
	const prompt = ao.sessions.get(bSession)?.conv.messages.filter(m => m.role === "user").pop()?.text ?? "";
	assert.match(prompt, /^\[Follow-up on your task\] B/);
	assert.match(prompt, /conflicts with yours in x\.txt/);
	const wt = ao.worktreeOf(bSession);
	try {
		git(wt, "merge", "--no-edit", a.git?.branch as string);
	} catch {
		/* conflicts expected */
	}
	fs.writeFileSync(path.join(wt, "x.txt"), "A2+B\n");
	git(wt, "add", "-A");
	git(wt, "commit", "-qm", "resolve");
	ao.finishTurn(bSession, "completed", "resolved");
	await until("edge merged", () => byTitle(p, "B").sync?.[a.id]?.state === "merged");
});

test("every git task starts on an explicit branch, and a branch AO renames afterwards is followed through the worktree's HEAD", async t => {
	const repo = scratchRepo(t);
	const ao = new FakeAo(repo);
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	p.edit([{ op: "add", ref: "a", task: { title: "A", options: { cwd: repo } } }, { op: "add", task: { title: "B", after: ["@a"], options: { cwd: repo } } }]);
	const aSession = await sentSession(p, "A");
	const a = byTitle(p, "A");
	assert.equal(ao.sessions.get(aSession)?.spawnBody.branch, `switchyard/${a.id}`, "a root task gets its own branch too (AO would rename its own)");
	assert.equal(a.git?.branch, `switchyard/${a.id}`);
	// AO renames the branch after the planner recorded it (the slug of the prompt).
	const wt = ao.worktreeOf(aSession);
	git(wt, "branch", "-m", "ao/a-slug/root");
	write(ao, aSession, "x.txt", "A1\n");
	ao.finishTurn(aSession, "completed", "A edited x.txt");
	await until("B sent", () => sent(p, "B"));
	assert.equal(byTitle(p, "A").git?.branch, "ao/a-slug/root", "the planner follows HEAD, not its cached name");
	assert.equal(read(ao, sent(p, "B") as string, "x.txt"), "A1\n", "the child still got the parent's commit");
	assert.equal(byTitle(p, "B").sync?.[a.id]?.state, "in-sync");
});

test("the `sync` wire op propagates and answers with the edges; the plan view lists every edge with sessions and heads", async t => {
	const rig = await graph(t);
	const { ao, p } = rig;
	const a = byTitle(p, "A");
	const edges = p.view().edges;
	assert.equal(edges.length, 2);
	const toB = edges.find(e => e.child === byTitle(p, "B").id);
	assert.deepEqual([toB?.parent, toB?.parentSession, toB?.childSession, toB?.state, toB?.parentHead === a.git?.head], [a.id, a.session, sent(p, "B"), "in-sync", true]);
	// Somebody committed in A's worktree outside the planner; `sync` (by SESSION id) commits, merges into the idle child and waits.
	const cSession = sent(p, "C") as string;
	ao.finishTurn(cSession, "completed", "C done");
	await until("C done", () => byTitle(p, "C").status === "done");
	write(ao, a.session as string, "x.txt", "A-outside\n");
	const res = await p.syncTask(a.session as string);
	assert.equal(res.task, a.id);
	assert.equal(res.rerun, false);
	const toC = res.edges.find(e => e.child === byTitle(p, "C").id);
	assert.equal(toC?.state, "upstream-changed");
	assert.equal(read(ao, cSession, "x.txt"), "A-outside\n");
	// `--rerun` on the finished child: one more run with the upstream note.
	const rerun = await p.syncTask(cSession, true);
	assert.equal(rerun.rerun, true);
	assert.equal(byTitle(p, "C").status, "pending");
	assert.equal(byTitle(p, "C").followUpOnly, true);
});

test("a graph built through pre-spawned sessions (the CLI's `new --task`): both tasks are tracked in git, B gets A's commit before its first run, later changes flow on", async t => {
	const repo = scratchRepo(t);
	const ao = new FakeAo(repo);
	const p = start(tempPlan(t), ao);
	t.after(() => p.stop());
	const spawned = async (key: string) => (await ao.spawn({ harness: "omp", projectId: "p", clientRequestId: key })).session;
	const sA = await spawned("cli-a");
	const sB = await spawned("cli-b");
	// `new --task` for A, then for B with --after A: a queue call into each session's lane, all in one call.
	await p.queue(sA, [{ op: "add", title: "A" }, { op: "autoRun", value: true }]);
	await p.queue(sB, [{ op: "add", title: "B" }, { op: "after", ids: [sA] }, { op: "autoRun", value: true }]);
	assert.equal(p.view().tasks.find(x => x.title === "B")?.state, "blocked");
	await until("A sent", () => sent(p, "A"));
	const a = byTitle(p, "A");
	assert.equal(a.git?.branch, ao.sessions.get(sA)?.branch, "A is tracked in git although the planner did not spawn it");
	write(ao, sA, "x.txt", "A1\n");
	ao.finishTurn(sA, "completed", "A edited x.txt");
	await until("B sent", () => sent(p, "B"));
	assert.equal(read(ao, sB, "x.txt"), "A1\n", "A's commit is in B's worktree before B's first run");
	assert.equal(p.view().edges.length, 1);
	assert.equal(p.view().edges[0].state, "merged");
	assert.equal(p.view().edges[0].parentSession, sA);
	ao.finishTurn(sB, "completed", "B done");
	await until("B done", () => byTitle(p, "B").status === "done");
	// A again: B (finished) gets the change and is marked, as in any graph.
	p.edit([{ op: "update", id: sA, notes: "again" }, { op: "requeue", id: sA }]);
	await until("A re-sent", () => sent(p, "A"));
	write(ao, sA, "x.txt", "A2\n");
	ao.finishTurn(sA, "completed", "A again");
	await until("B marked", () => byTitle(p, "B").sync?.[a.id]?.state === "upstream-changed");
	assert.equal(read(ao, sB, "x.txt"), "A2\n");
});
