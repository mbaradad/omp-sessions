// Requeue and reschedule from cards (PARKED §3) on the real stack: the planner service process on an isolated AO
// daemon running the scripted fake omp. The edits are the ones the clients send: the board's Run now / Requeue /
// Schedule / Unschedule (src/kanban/board.ts `queueOpsFor` and the `schedule` queue op, through the planner's
// `queue` op as SessionQueues does), and the planner ops themselves (`requeue`, `abort`). The planner's own
// clock moves a scheduled start forward, so nothing waits in real time for a start.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { queueOpsFor } from "../../src/kanban/board";
import type { PlanView, QueueView, TaskView } from "../../src/planner/types";
import { parseStartTime } from "../../src/planner/when";
import { type AoFixture, skipWithoutAo as skip, startAoFixture } from "../ao-fixture.mjs";
import { type PlannerFixture, startPlannerFixture } from "../planner-fixture.mjs";

let ao: AoFixture;
let planner: PlannerFixture;
let project: string;

before(async () => {
	if (skip) return;
	ao = await startAoFixture();
	planner = await startPlannerFixture({ ao, usage: false, retryBaseMs: 100, pollMs: 200 });
	project = await ao.createProject(ao.scratchRepo());
});

after(async () => {
	await planner?.stop();
	await ao?.stop();
});

const task = (plan: PlanView, title: string): TaskView => {
	const t = plan.tasks.find(x => x.title === title);
	assert.ok(t, `task ${title} in the plan`);
	return t;
};
const lane = (plan: PlanView, id: string) => {
	const l = plan.lanes.find(x => x.id === id);
	assert.ok(l, `lane ${id}`);
	return l;
};
/** session/prompt requests the fake received whose text contains `marker`: how often the task was dispatched. */
const prompts = (marker: string): number => ao.fakeOmpFrames().filter(f => f.dir === "in" && f.msg?.method === "session/prompt" && JSON.stringify(f.msg.params.prompt).includes(marker)).length;
const queue = (id: string): Promise<QueueView> => planner.call("getQueue", { id });

test("board path: schedule, reschedule, unschedule, Run now, Requeue a failed task, Requeue keeps a schedule", { skip, timeout: 120_000 }, async () => {
	const L = "l_0000000rq01";
	await planner.call("edit", { ops: [{ op: "lane.add", id: L, title: "Card", autoRun: false, defaults: { project } }] });
	// The fake fails the task every time it runs (a JSON-RPC error); the planner pauses the queue on a failure.
	await planner.call("queue", { id: L, ops: [{ op: "add", title: "boom", notes: "error internal boom-board" }] });
	let q = await queue(L);
	assert.deepEqual([q.autoRun, q.startAt, q.tasks[0].status], [false, undefined, "pending"]);

	// Schedule (the board's "In 2 hours" preset parses with the shared parser), then reschedule to another time.
	const first = parseStartTime("+2h");
	await planner.call("queue", { id: L, ops: [{ op: "schedule", at: first }] });
	q = await queue(L);
	assert.equal(q.startAt, first);
	assert.equal(task(await planner.plan(), "boom").state, "scheduled");
	const second = parseStartTime("+30m");
	await planner.call("queue", { id: L, ops: [{ op: "schedule", at: second }] });
	assert.equal((await queue(L)).startAt, second, "rescheduled");

	// Unschedule: paused, the task waits for someone to run it.
	await planner.call("queue", { id: L, ops: [{ op: "schedule", at: null }] });
	let plan = await planner.plan();
	assert.deepEqual([lane(plan, L).startAt, lane(plan, L).autoRun, task(plan, "boom").state], [undefined, false, "paused"]);
	assert.equal(prompts("boom-board"), 0);

	// Schedule again, then Run now: the start is dropped and the task runs.
	await planner.call("queue", { id: L, ops: [{ op: "schedule", at: parseStartTime("+3h") }] });
	q = await queue(L);
	const runOps = queueOpsFor("run", { queue: { pending: 1, running: 0, done: 0, total: 1, autoRun: q.autoRun }, startAt: q.startAt }, q.tasks.some(t => t.status === "pending"));
	assert.deepEqual(runOps, [{ op: "run" }]);
	await planner.call("queue", { id: L, ops: runOps });
	plan = await planner.waitFor(p => task(p, "boom").status === "failed", { what: "the task failed after Run now" });
	assert.deepEqual([lane(plan, L).startAt, lane(plan, L).autoRun], [undefined, false], "a failure pauses the queue");
	assert.match(task(plan, "boom").summary ?? "", /boom-board/);
	assert.equal(prompts("boom-board"), 1);

	// Requeue: the failed task goes back to pending, the queue is re-armed, the task is dispatched again.
	const requeueOps = queueOpsFor("requeue", { queue: { pending: 0, running: 0, done: 0, total: 1, failed: 1, autoRun: false }, startAt: undefined }, false);
	assert.deepEqual(requeueOps, [{ op: "requeue" }]);
	await planner.call("queue", { id: L, ops: requeueOps });
	await planner.waitFor(p => prompts("boom-board") === 2 && task(p, "boom").status === "failed", { what: "the task ran a second time" });

	// Requeue with a start time set keeps it: the task is scheduled, not dispatched.
	await planner.call("queue", { id: L, ops: [{ op: "schedule", at: parseStartTime("+1h") }] });
	await planner.call("queue", { id: L, ops: [{ op: "requeue" }] });
	plan = await planner.plan();
	assert.deepEqual([task(plan, "boom").state, lane(plan, L).autoRun, typeof lane(plan, L).startAt], ["scheduled", false, "number"]);
	assert.equal(prompts("boom-board"), 2, "not dispatched before its time");
	// The planner's clock reaches the start: now it runs.
	planner.advanceClock(2 * 3_600_000);
	await planner.waitFor(() => prompts("boom-board") === 3, { what: "the requeued task ran at its start time" });
});

test("planner ops: abort stops a running task and pauses it; requeue runs it again; requeue refuses a running task", { skip, timeout: 120_000 }, async () => {
	await planner.call("edit", { ops: [{ op: "add", task: { title: "slow-one", notes: "slow 20000\necho slow-finished", options: { project } } }] });
	let plan = await planner.waitFor(p => task(p, "slow-one").status === "running" && prompts("slow-finished") === 1, { what: "the slow task running" });
	await assert.rejects(planner.call("edit", { ops: [{ op: "requeue", id: task(plan, "slow-one").id }] }), /running|abort/);
	await planner.call("edit", { ops: [{ op: "abort", id: task(plan, "slow-one").id }] });
	plan = await planner.waitFor(p => task(p, "slow-one").status !== "running", { what: "the aborted task to settle" });
	assert.equal(task(plan, "slow-one").state, "paused", "an abort pauses, it is not retried");
	assert.equal(prompts("slow-finished"), 1);
	await planner.call("edit", { ops: [{ op: "requeue", id: task(plan, "slow-one").id }] });
	await planner.waitFor(() => prompts("slow-finished") === 2, { what: "the requeued task dispatched again" });
	// Leave nothing running.
	plan = await planner.plan();
	await planner.call("edit", { ops: [{ op: "abort", id: task(plan, "slow-one").id }] });
	await planner.waitFor(p => task(p, "slow-one").status !== "running", { what: "the slow task stopped" });
});
