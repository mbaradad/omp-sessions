// The CLI's side of the planner (PLANNER-API.md): connecting to it (starting it, and installing it as a
// user service the first time, unless `config set service off`), each session lane's summary for
// `ls`/`show`/`wait` (MAPPING D3), and managing the planner service (`omp-sessions server …`).
import * as fs from "node:fs";
import * as path from "node:path";
import { PlannerClient, ensurePlanner, stopPlanner } from "../planner/client";
import { logPath, socketPath } from "../planner/paths";
import { type ServiceKind, installService, serviceKind, serviceUnitPath, uninstallService } from "../planner/service";
import type { PlanView, PlannerOpName, PlannerOps, QueueOp as PlannerQueueOp, QueueView } from "../planner/types";
import type { Priority } from "../shared/organize";
import { readSwitchyardConfig } from "../shared/switchyard-config";

export type QueueOp = PlannerQueueOp;
export type PlannerQueue = QueueView;

/** `out/planner.js`, next to `out/cli.js` (resolved on use: `__dirname` exists only in the CommonJS bundle). */
function plannerScript(): string {
	const script = path.join(__dirname, "planner.js");
	if (!fs.existsSync(script)) throw new Error(`the planner is missing next to the CLI (${script}); reinstall omp-sessions`);
	return script;
}

export interface Planner {
	call<K extends PlannerOpName>(op: K, args: PlannerOps[K]["args"]): Promise<PlannerOps[K]["result"]>;
	close(): void;
}

function wrap(client: PlannerClient): Planner {
	return { call: (op, args) => client.request(op, args), close: () => client.close() };
}

/** The installed unit file of this machine's planner service, if any. */
function installedUnit(): { kind: ServiceKind; file: string } | undefined {
	const kind = serviceKind();
	if (!kind) return undefined;
	const file = serviceUnitPath(kind);
	return fs.existsSync(file) ? { kind, file } : undefined;
}

/**
 * The running planner; with `start`, started when none runs. The first start installs it as a user
 * service (it then survives logouts and reboots) unless `config set service off`, or when this CLI
 * runs on VS Code's own runtime, which VS Code updates replace.
 */
export async function connectPlanner(opts: { start: boolean }): Promise<Planner | undefined> {
	const running = await PlannerClient.connect();
	if (running) return wrap(running);
	if (!opts.start) return undefined;
	const script = plannerScript();
	const vscodeRuntime = !!process.env.ELECTRON_RUN_AS_NODE || !!process.versions.electron;
	if (!installedUnit() && readSwitchyardConfig().service !== "off" && !vscodeRuntime) {
		const r = installService(script);
		if (r) process.stderr.write(`omp-sessions: installed the planner as a ${r.kind} user service (${r.file})${r.ok ? "" : "; it couldn't be started"}. Opt out: omp-sessions server uninstall && omp-sessions config set service off\n`);
	}
	const client = await ensurePlanner(script);
	return client ? wrap(client) : undefined;
}

/** A session lane as `ls`, `show` and `wait` need it (MAPPING D3: the planner's state wins when nothing runs). */
export interface LaneSummary {
	pending: number;
	running: number;
	done: number;
	total: number;
	autoRun: boolean;
	startAt?: number;
	/** When a task was cut short by a crash or restart (epoch ms): it waits for a person. */
	interrupted?: number;
	/** The next task waits for its start time. */
	scheduled?: boolean;
	/** The next task is ready but waits (a slot, usage limits, dependencies); `position` is 1-based in start order, 0 when it isn't waiting for a slot. */
	waiting?: { position: number };
	priority?: Priority;
}

/** Every lane that continues an AO session, by session id. */
export function laneSummaries(plan: PlanView): Map<string, LaneSummary> {
	const out = new Map<string, LaneSummary>();
	for (const lane of plan.lanes) {
		const session = lane.session ?? lane.id;
		const tasks = plan.tasks.filter(t => t.lane === lane.id);
		const next = tasks.find(t => t.status === "pending" || t.status === "running");
		const summary: LaneSummary = { pending: lane.pending, running: lane.running, done: lane.done, total: lane.total, autoRun: lane.autoRun };
		if (lane.startAt !== undefined) summary.startAt = lane.startAt;
		if (lane.priority) summary.priority = lane.priority;
		const cut = tasks.find(t => t.state === "interrupted");
		if (cut) summary.interrupted = cut.interrupted ?? cut.startedAt ?? 0;
		if (next?.state === "scheduled") summary.scheduled = true;
		if (next && (next.state === "waiting" || next.state === "held" || next.state === "blocked")) summary.waiting = { position: next.position ?? 0 };
		out.set(session, summary);
	}
	return out;
}

export async function lanesOf(planner: Planner): Promise<Map<string, LaneSummary>> {
	return laneSummaries(await planner.call("plan", {}));
}

// ---------- the planner service ----------

export interface PlannerInfo {
	pid: number;
	version: string;
	startedAt: number;
}

export interface PlannerServiceState {
	kind: ServiceKind | null;
	installed: boolean;
	file?: string;
	autoInstall: boolean;
}

async function ping(): Promise<PlannerInfo | undefined> {
	const client = await PlannerClient.connect();
	if (!client) return undefined;
	try {
		const { pid, version, startedAt } = await client.request("ping", {}, 3000);
		return { pid, version, startedAt };
	} catch {
		return undefined;
	} finally {
		client.close();
	}
}

/** `omp-sessions server …`: the planner process and its user service. */
export function plannerService() {
	return {
		status: ping,
		async start(): Promise<PlannerInfo> {
			const p = await connectPlanner({ start: true });
			p?.close();
			const info = await ping();
			if (!info) throw new Error(`the planner did not start (see ${logPath()})`);
			return info;
		},
		stop: () => stopPlanner(),
		socket: (): string | undefined => socketPath(),
		logPath: (): string => logPath(),
		serviceState(): PlannerServiceState {
			const kind = serviceKind() ?? null;
			const unit = installedUnit();
			return { kind, installed: !!unit, ...(unit && { file: unit.file }), autoInstall: readSwitchyardConfig().service !== "off" };
		},
		async install(): Promise<{ ok: boolean; file: string; hint: string }> {
			const script = plannerScript();
			// A planner started by hand holds the socket: the service's own one must take over.
			await stopPlanner();
			const r = installService(script);
			if (!r) throw new Error("server install supports Linux (systemd) and macOS (launchd); on Windows the planner starts on demand");
			return { ok: r.ok, file: r.file, hint: r.kind === "systemd" ? "systemctl --user enable --now omp-sessions-planner.service" : "launchctl bootstrap" };
		},
		async uninstall(): Promise<string | undefined> {
			const unit = installedUnit();
			return unit && uninstallService() ? unit.file : undefined;
		},
	};
}
