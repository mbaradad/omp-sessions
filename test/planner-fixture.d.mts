// Types for test/planner-fixture.mjs. Plan shapes: src/planner/types.ts.
import type { AoFixture } from "./ao-fixture.mjs";

export interface PlannerFixtureOptions {
	ao: AoFixture;
	/** OMP_VSCODE_HOME to use (e.g. the one a VS Code under test already has). Default: a temp dir. */
	stateRoot?: string;
	/** Bundled planner (default $SWITCHYARD_TEST_PLANNER_JS, else built from src/planner/main.ts). */
	plannerJs?: string;
	env?: Record<string, string>;
	/** false: no `omp usage` polling (OMP_PLANNER_USAGE=off). Default: polls the AO fixture's omp. */
	usage?: boolean;
	/** OMP_PLANNER_RETRY_BASE_MS. */
	retryBaseMs?: number;
	readyTimeoutMs?: number;
}

/** A planner wire event (`{id, event: "plan", plan}` or `{id, event: "task", task, from}`). */
export interface PlannerWireEvent {
	id: number;
	event: "plan" | "task";
	/** The rest of the event (typed by src/planner/types.ts PlannerEvent). */
	[key: string]: any;
}

export interface PlannerFixture {
	root: string;
	/** OMP_VSCODE_HOME of the planner. */
	stateRoot: string;
	socket: string;
	/** Env for planner clients: OMP_VSCODE_HOME → this planner, AO_* → the AO fixture, the fake omp first on PATH. */
	clientEnv: Record<string, string>;
	plannerJs: string;
	readonly pid: number;
	/** One planner op; rejects with the planner's error. */
	call(op: string, args?: unknown, timeoutMs?: number): Promise<any>;
	plan(args?: { lane?: string; all?: boolean }): Promise<any>;
	subscribe(onEvent: (ev: PlannerWireEvent) => void): Promise<{ close(): void }>;
	/** Polls `plan` until `pred` holds. */
	waitFor(pred: (plan: any) => boolean, opts?: { what?: string; timeoutMs?: number; args?: unknown }): Promise<any>;
	log(): string;
	/** Same state, new process: SIGTERM, or SIGKILL with `kill`. */
	restart(opts?: { kill?: boolean }): Promise<void>;
	kill(): Promise<void>;
	stop(): Promise<void>;
}

export function startPlannerFixture(opts: PlannerFixtureOptions): Promise<PlannerFixture>;
