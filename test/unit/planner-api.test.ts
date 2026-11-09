// The planner's socket API: a plan event for a change reaches the client before the response to the request
// that made it, so a client's cached plan is never older than the answer it just got.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { test } from "node:test";
import { createApiServer } from "../../src/planner/api";
import { emptyState } from "../../src/planner/engine";
import { Planner } from "../../src/planner/planner";
import type { PlannerEvent, PlannerResponse } from "../../src/planner/types";
import { FakeAo, git, scratchRepo, tempPlan, until } from "./planner-fake-ao";

test("the plan event of an edit arrives before the edit's response (rev included), for every quick edit in a row", async t => {
	const ao = new FakeAo();
	const planner = new Planner({ connect: async () => ao, file: tempPlan(t), userDefaults: () => ({}) });
	const sock = path.join(path.dirname(tempPlan(t)), "api.sock");
	const server = createApiServer({ planner, info: () => ({ pid: 0, version: "t", root: "", startedAt: 0, api: 1 }), shutdown: () => {} });
	await new Promise<void>(resolve => server.listen(sock, resolve));
	t.after(() => server.close());
	const conn = net.createConnection(sock);
	t.after(() => conn.destroy());
	const lines: Array<PlannerResponse | PlannerEvent> = [];
	let buffer = "";
	conn.on("data", d => {
		buffer += String(d);
		for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
			lines.push(JSON.parse(buffer.slice(0, i)));
			buffer = buffer.slice(i + 1);
		}
	});
	await new Promise<void>(resolve => conn.once("connect", resolve));
	conn.write(`${JSON.stringify({ id: 1, op: "subscribe", args: { topic: "plan" } })}\n`);
	const waitFor = async (pred: () => boolean) => {
		for (let i = 0; i < 200 && !pred(); i++) await new Promise(r => setTimeout(r, 10));
		assert.ok(pred(), "timed out");
	};
	await waitFor(() => lines.some(l => "event" in l));
	for (let n = 1; n <= 3; n++) {
		const id = 10 + n;
		conn.write(`${JSON.stringify({ id, op: "edit", args: { ops: [{ op: "add", task: { title: `t${n}` } }] } })}\n`);
		await waitFor(() => lines.some(l => "ok" in l && l.id === id));
		const response = lines.findIndex(l => "ok" in l && l.id === id);
		const res = lines[response] as Extract<PlannerResponse, { ok: true }>;
		const rev = (res.result as { rev: number }).rev;
		const plan = lines.findIndex(l => "event" in l && l.event === "plan" && l.plan.rev >= rev);
		assert.ok(plan >= 0 && plan < response, `edit ${n}: the plan event (rev ≥ ${rev}) came ${plan < 0 ? "never" : "after"} the response`);
	}
});

test("branch.clean answers after the cleanup: the plan event with the shrunk list comes before the response", async t => {
	const ao = new FakeAo();
	// A kept branch with work of its own; the planner keeps it at connect. A person then merges it by hand.
	const repo = scratchRepo(t);
	git(repo, "checkout", "-q", "-b", "switchyard/work");
	fs.writeFileSync(path.join(repo, "w.txt"), "w\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "work");
	git(repo, "checkout", "-q", "main");
	const initial = { ...emptyState(), keptBranches: [{ repo, branch: "switchyard/work", task: "T", taskId: "t1", why: "it has commits no other branch has", at: 1 }] };
	const planner = new Planner({ connect: async () => ao, file: tempPlan(t), initial, userDefaults: () => ({}) });
	planner.start();
	t.after(() => planner.stop());
	await new Promise(r => setTimeout(r, 500));
	assert.equal(planner.view().keptBranches.length, 1, "kept while it has unmerged work");
	git(repo, "merge", "-q", "--no-edit", "switchyard/work");
	const sock = path.join(path.dirname(tempPlan(t)), "api2.sock");
	const server = createApiServer({ planner, info: () => ({ pid: 0, version: "t", root: "", startedAt: 0, api: 1 }), shutdown: () => {} });
	await new Promise<void>(resolve => server.listen(sock, resolve));
	t.after(() => server.close());
	const conn = net.createConnection(sock);
	t.after(() => conn.destroy());
	const lines: Array<PlannerResponse | PlannerEvent> = [];
	let buffer = "";
	conn.on("data", d => {
		buffer += String(d);
		for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
			lines.push(JSON.parse(buffer.slice(0, i)));
			buffer = buffer.slice(i + 1);
		}
	});
	await new Promise<void>(resolve => conn.once("connect", resolve));
	conn.write(`${JSON.stringify({ id: 1, op: "subscribe", args: { topic: "plan" } })}\n`);
	await until("subscribed", () => lines.some(l => "event" in l));
	conn.write(`${JSON.stringify({ id: 2, op: "edit", args: { ops: [{ op: "branch.clean" }] } })}\n`);
	await until("answered", () => lines.some(l => "ok" in l && l.id === 2));
	const response = lines.findIndex(l => "ok" in l && l.id === 2);
	const shrunk = lines.findIndex(l => "event" in l && l.event === "plan" && l.plan.keptBranches.length === 0);
	assert.ok(shrunk >= 0 && shrunk < response, "the plan without the kept branch came before the response");
});
