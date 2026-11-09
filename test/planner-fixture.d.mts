// Types for test/planner-fixture.mjs. Plan shapes: src/planner/types.ts.
import type { AoFixture } from "./ao-fixture.mjs";

export interface PlannerFixtureOptions {
	ao: AoFixture;
	/** SWITCHYARD_HOME to use (e.g. the one a VS Code under test already has); must be under the temp dir. Default: a temp dir. */
	stateRoot?: string;
	/** Bundled planner (default $SWITCHYARD_TEST_PLANNER_JS, else built from src/planner/main.ts). */
	plannerJs?: string;
	env?: Record<string, string>;
	/** false: no `omp usage` polling (SWITCHYARD_PLANNER_USAGE=off). Default: polls the AO fixture's omp. */
	usage?: boolean;
	/** SWITCHYARD_PLANNER_RETRY_BASE_MS. */
	retryBaseMs?: number;
	/** SWITCHYARD_PLANNER_POLL_MS: how often the planner re-checks AO and its clock. */
	pollMs?: number;
	/** SWITCHYARD_PLANNER_USAGE_EVERY_MS: how often it reads `omp usage`. */
	usageEveryMs?: number;
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
	/** SWITCHYARD_HOME of the planner. */
	stateRoot: string;
	socket: string;
	/** Env for planner clients: SWITCHYARD_HOME → this planner, AO_* → the AO fixture, the fake omp first on PATH. */
	clientEnv: Record<string, string>;
	plannerJs: string;
	readonly pid: number;
	/** One planner op; rejects with the planner's error. */
	call(op: string, args?: unknown, timeoutMs?: number): Promise<any>;
	plan(args?: { lane?: string; all?: boolean }): Promise<any>;
	subscribe(onEvent: (ev: PlannerWireEvent) => void): Promise<{ close(): void }>;
	/** Polls `plan` until `pred` holds. */
	waitFor(pred: (plan: any) => boolean, opts?: { what?: string; timeoutMs?: number; args?: unknown }): Promise<any>;
	/** Moves the planner's clock `ms` further ahead of real time (cumulative): startAt, recurring schedules and holds come due. */
	advanceClock(ms: number): void;
	log(): string;
	/** Same state, new process: SIGTERM, or SIGKILL with `kill`. */
	restart(opts?: { kill?: boolean }): Promise<void>;
	kill(): Promise<void>;
	stop(): Promise<void>;
}

export function startPlannerFixture(opts: PlannerFixtureOptions): Promise<PlannerFixture>;
