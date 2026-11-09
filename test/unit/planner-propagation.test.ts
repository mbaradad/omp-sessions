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
	assert.match(prompts[1], /Changed files: x\.txt/);
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
