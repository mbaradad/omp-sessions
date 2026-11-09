// The planner's local API (PLANNER-API.md): newline-delimited JSON over a user-only Unix socket (a
// named pipe on Windows), the same framing as the old omp-sessions server, so ServerClient-style
// clients port as is. `subscribe {topic: "plan"}` streams plan snapshots and task transitions.
import * as net from "node:net";
import * as readline from "node:readline";
import type { Planner } from "./planner";
import type { PlanOp, PlannerConfig, PlannerEvent, PlannerOpName, PlannerOps, PlannerRequest, PlannerResponse, QueueOp } from "./types";

/** Plan snapshots to a subscriber at most this often. */
const PLAN_EVENT_MS = 200;

interface Client {
	sock: net.Socket;
	/** subscribe request ids. */
	subs: Set<number>;
}

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, name: string): string {
	if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
	return v;
}

export interface ApiOptions {
	planner: Planner;
	info: () => PlannerOps["ping"]["result"];
	shutdown: (reason: string) => void;
	log?: (...parts: unknown[]) => void;
}

/** A net.Server answering the planner protocol; the caller listens on the socket. */
export function createApiServer(opts: ApiOptions): net.Server {
	const { planner } = opts;
	const clients = new Set<Client>();
	const send = (c: Client, msg: PlannerResponse | PlannerEvent) => {
		if (!c.sock.destroyed) c.sock.write(`${JSON.stringify(msg)}\n`);
	};
	let planTimer: NodeJS.Timeout | undefined;
	const publishPlan = () => {
		planTimer = undefined;
		const subs = [...clients].filter(c => c.subs.size);
		if (!subs.length) return;
		const plan = planner.view();
		for (const c of subs) for (const id of c.subs) send(c, { id, event: "plan", plan });
	};
	planner.onChange(change => {
		if (change.task) for (const c of clients) for (const id of c.subs) send(c, { id, event: "task", ...change.task });
		if (change.sync) for (const c of clients) for (const id of c.subs) send(c, { id, event: "sync", ...change.sync });
		if (change.plan && !planTimer) planTimer = setTimeout(publishPlan, PLAN_EVENT_MS);
	});

	const handlers: { [K in PlannerOpName]: (args: Record<string, unknown>) => PlannerOps[K]["result"] | Promise<PlannerOps[K]["result"]> } = {
		ping: () => opts.info(),
		plan: a => planner.view(typeof a.lane === "string" ? a.lane : undefined, a.all === true),
		sync: a => planner.syncTask(str(a.id, "id"), a.rerun === true),
		edit: a => planner.edit(Array.isArray(a.ops) ? (a.ops as PlanOp[]) : [], typeof a.rev === "number" ? a.rev : undefined),
		getQueue: a => planner.getQueue(str(a.id, "id")),
		queue: a => planner.queue(str(a.id, "id"), Array.isArray(a.ops) ? (a.ops as QueueOp[]) : []),
		scheduler: a => planner.setConfig(rec(a.set) as Partial<PlannerConfig>, a.clearLimits === true || (Array.isArray(a.clearLimits) && a.clearLimits.every(x => typeof x === "string")) ? (a.clearLimits as true | string[]) : undefined),
		status: () => planner.status(),
		shutdown: () => {
			setTimeout(() => opts.shutdown("shutdown request"), 50);
			return {};
		},
	};

	/** The plan event of this request's change goes out before its response, so a client's cache is never older than the answer. */
	const flushPlan = () => {
		if (!planTimer) return;
		clearTimeout(planTimer);
		publishPlan();
	};

	const onRequest = async (c: Client, req: PlannerRequest) => {
		const { id, op } = req;
		try {
			if (op === "subscribe") {
				if (rec(req.args).topic !== "plan") throw new Error("unknown subscription (topic: plan)");
				c.subs.add(id);
				send(c, { id, ok: true, result: {} });
				send(c, { id, event: "plan", plan: planner.view() });
				return;
			}
			if (!Object.hasOwn(handlers, op)) throw new Error(`unknown operation ${String(op)}`);
			const handler = handlers[op] as (args: Record<string, unknown>) => unknown;
			const result = await handler(rec(req.args));
			flushPlan();
			send(c, { id, ok: true, result });
		} catch (err) {
			send(c, { id, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	};

	return net.createServer(sock => {
		const c: Client = { sock, subs: new Set() };
		clients.add(c);
		const rl = readline.createInterface({ input: sock, crlfDelay: Number.POSITIVE_INFINITY });
		rl.on("error", () => {});
		rl.on("line", line => {
			if (!line.trim()) return;
			let req: PlannerRequest;
			try {
				req = JSON.parse(line) as PlannerRequest;
			} catch {
				return;
			}
			if (typeof req.id !== "number" || typeof req.op !== "string") return;
			void onRequest(c, req);
		});
		const drop = () => clients.delete(c);
		sock.on("close", drop);
		sock.on("error", drop);
	});
}
