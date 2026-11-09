// The planner's socket API: a plan event for a change reaches the client before the response to the request
// that made it, so a client's cached plan is never older than the answer it just got.
import assert from "node:assert/strict";
import * as net from "node:net";
import * as path from "node:path";
import { test } from "node:test";
import { createApiServer } from "../../src/planner/api";
import { Planner } from "../../src/planner/planner";
import type { PlannerEvent, PlannerResponse } from "../../src/planner/types";
import { FakeAo, tempPlan } from "./planner-fake-ao";

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
