// The planner against a real, isolated AO daemon (test/ao-fixture.mjs) running the scripted ACP fake
// (test/fake-omp-acp.mjs): a graph A → (B, C) where B and C run in parallel after A with A's result
// in their prompt, a planner restart while B and C run (nothing dispatched twice), a lane whose second
// task continues the first one's AO session, and a scheduled start.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AoClient } from "../../src/ao/client";
import { aoPort } from "../../src/planner/ao-port";
import { Planner } from "../../src/planner/planner";
import { loadPlan } from "../../src/planner/store";
import type { Task } from "../../src/planner/types";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";

let ao: AoFixture;
let client: AoClient;
let repo: string;
let projectId: string;
let dir: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	client = await AoClient.connect({ env: { ...process.env, ...ao.clientEnv } });
	repo = ao.scratchRepo();
	projectId = await ao.createProject(repo);
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-it-"));
});

/** Every planner a test started: stopped after the file even when an assertion failed. */
const planners: Planner[] = [];

after(async () => {
	for (const p of planners) p.stop();
	await ao?.stop();
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function startPlanner(file: string): Planner {
	const p = new Planner({ file, initial: loadPlan(file), connect: async () => aoPort(client), pollMs: 500, log: (...a) => process.env.PLANNER_TEST_LOG && console.log(...a) });
	planners.push(p);
	p.start();
	return p;
}

async function until<T>(what: string, fn: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${ao.daemonLog().split("\n").slice(-15).join("\n")}`);
		await sleep(50);
	}
}

const task = (p: Planner, title: string) => p.state.tasks.find(t => t.title === title) as Task;

async function userPrompts(session: string): Promise<string[]> {
	return (await client.getConversation(session)).messages.filter(m => m.role === "user").map(m => m.text);
}

async function assistantText(session: string): Promise<string> {
	return (await client.getConversation(session)).messages
		.filter(m => m.role === "assistant")
		.map(m => m.text)
		.join("\n");
}

test("graph A → (B, C): B and C run in parallel after A with its result; a restart mid-run dispatches nothing twice", { skip }, async () => {
	const file = path.join(dir, "graph.json");
	let p = startPlanner(file);
	p.setConfig({ maxConcurrent: 2 });
	p.edit([
		{ op: "add", ref: "a", task: { title: "A", notes: "echo alpha-result", options: { project: projectId } } },
		{ op: "add", ref: "b", task: { title: "B", notes: "slow 2500\necho beta", after: ["@a"], options: { project: projectId } } },
		{ op: "add", ref: "c", task: { title: "C", notes: "slow 2500\necho gamma", after: ["@a"], options: { cwd: repo } } },
	]);
	await until("A done", () => task(p, "A").status === "done");
	assert.match(await assistantText(task(p, "A").session as string), /alpha-result/);
	// The summary is A's final reply (the fake echoes the prompt's last line last).
	const summary = task(p, "A").summary as string;
	assert.ok(summary);
	// Both children start once A is done, and run at the same time.
	await until("B and C running", () => task(p, "B").run?.phase === "sent" && task(p, "C").run?.phase === "sent");
	const sessions = { b: task(p, "B").run?.session as string, c: task(p, "C").run?.session as string };
	assert.notEqual(sessions.b, sessions.c);
	assert.ok((await userPrompts(sessions.b))[0].includes(`### A\n${summary}`));
	// The planner goes away while B and C run, and comes back from its file.
	p.stop();
	await sleep(500);
	p = startPlanner(file);
	await until("B and C done", () => task(p, "B").status === "done" && task(p, "C").status === "done");
	assert.match(await assistantText(sessions.b), /beta/);
	assert.match(await assistantText(sessions.c), /gamma/);
	// Exactly three sessions, one prompt each.
	const mine = (await client.listSessions()).sessions.filter(s => ["A", "B", "C"].includes(s.displayName ?? ""));
	assert.equal(mine.length, 3);
	for (const s of mine) assert.equal((await userPrompts(s.id)).length, 1);
	assert.equal(task(p, "C").session, sessions.c);
});

test("a lane continues its session; a scheduled task waits for its time", { skip }, async () => {
	const file = path.join(dir, "lane.json");
	const p = startPlanner(file);
	const startAt = Date.now() + 3000;
	p.edit([
		{ op: "lane.add", id: "l_00000000b1", title: "lane", defaults: { project: projectId } },
		{ op: "add", task: { title: "first", notes: "echo one", lane: "l_00000000b1" } },
		{ op: "add", task: { title: "second", notes: "echo two", lane: "l_00000000b1" } },
		{ op: "add", task: { title: "later", notes: "echo late", startAt, options: { project: projectId } } },
	]);
	assert.equal(p.view().tasks.find(t => t.title === "later")?.state, "scheduled");
	await until("lane done", () => task(p, "second").status === "done");
	assert.equal(task(p, "second").session, task(p, "first").session);
	assert.equal((await userPrompts(task(p, "first").session as string)).length, 2);
	await until("later done", () => task(p, "later").status === "done");
	assert.ok((task(p, "later").startedAt ?? 0) >= startAt);
	p.stop();
});

test("graph propagation on a real AO daemon: children branch from the parent's commit; a later parent change reaches the finished child", { skip }, async () => {
	const file = path.join(dir, "propagation.json");
	const p = startPlanner(file);
	p.setConfig({ maxConcurrent: 0 });
	const options = { project: projectId };
	p.edit([
		{ op: "add", ref: "a", task: { title: "PA", notes: "write x.txt A1\necho a-done", options } },
		{ op: "add", task: { title: "PB", notes: "echo b-done", after: ["@a"], options } },
	]);
	await until("PB done", () => task(p, "PB").status === "done");
	const a = task(p, "PA");
	const b = task(p, "PB");
	assert.equal(b.git?.branch, `switchyard/${b.id}`);
	assert.equal(fs.readFileSync(path.join(b.git?.worktree as string, "x.txt"), "utf8").trim(), "A1");
	assert.equal(b.sync?.[a.id]?.state, "in-sync");
	// A runs again with a different file content: B (finished) gets it merged and is marked, not re-run.
	p.edit([{ op: "update", id: a.id, notes: "write x.txt A2\necho a-again" }, { op: "requeue", id: a.id }]);
	const aFile = path.join(a.git?.worktree as string, "x.txt");
	await until("A done again", () => task(p, "PA").status === "done" && fs.readFileSync(aFile, "utf8").trim() === "A2");
	await until("B marked", () => task(p, "PB").sync?.[a.id]?.state === "upstream-changed");
	assert.equal(fs.readFileSync(path.join(b.git?.worktree as string, "x.txt"), "utf8").trim(), "A2");
	assert.equal((await userPrompts(task(p, "PB").session as string)).length, 1);
	assert.equal(task(p, "PB").session, b.session);
});
