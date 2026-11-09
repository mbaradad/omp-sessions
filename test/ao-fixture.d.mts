// Types for test/ao-fixture.mjs (TypeScript tests import it; esbuild bundles the .mjs).

export interface AoFixtureOptions {
	/** ao executable (default $SWITCHYARD_TEST_AO_BIN, else `ao` on PATH). */
	aoBin?: string;
	/** Run the real omp from PATH with the real HOME instead of test/fake-omp-acp.mjs. */
	realOmp?: boolean;
	/** Extra daemon env (AO_* overrides). */
	env?: Record<string, string>;
	/** Extra env for the fake omp (FAKE_OMP_DELAY, FAKE_OMP_NO_STEERING, ...). */
	fakeOmpEnv?: Record<string, string>;
	readyTimeoutMs?: number;
	/** Leave the temp dir after stop() (default $SWITCHYARD_TEST_KEEP_AO=1). */
	keep?: boolean;
}

/** One line of the fake omp's frame log. */
export interface FakeOmpFrame {
	mono: number;
	pid: number;
	dir: "in" | "out" | "argv";
	/** The JSON-RPC frame (free-form). */
	msg?: any;
	argv?: string[];
	cwd?: string;
}

export interface AoFixture {
	/** http://127.0.0.1:<port> */
	baseUrl: string;
	port: number;
	/** The loopback API has no auth: token null, no headers. Native clients must not send Origin. */
	credentials: { token: null; headers: Record<string, string> };
	/** AO_PORT, AO_DATA_DIR, AO_RUN_FILE: makes `ao` and src/ao discovery find this daemon. */
	clientEnv: { AO_PORT: string; AO_DATA_DIR: string; AO_RUN_FILE: string };
	/** The omp AO runs: the fake's wrapper script (or "omp" with realOmp). */
	ompBin: string;
	/** Env to run that omp as AO does: PATH (fake first), PI_CODING_AGENT_DIR, FAKE_OMP_LOG, FAKE_OMP_USAGE, FAKE_OMP_RULES. Empty with realOmp. */
	ompEnv: Record<string, string>;
	/** clientEnv + ompEnv: for a planner, CLI or Hermes process that should use this stack. */
	stackEnv: Record<string, string>;
	root: string;
	dataDir: string;
	runFile: string;
	logFile: string;
	/** HOME the daemon and omp run with (a temp dir unless realOmp). */
	home: string;
	/** PI_CODING_AGENT_DIR of the fake (its session store); undefined with realOmp. */
	agentDir?: string;
	fakeOmpLog?: string;
	/** FAKE_OMP_USAGE: the file the fake's `omp usage --json` reads (see setUsage). */
	usageFile?: string;
	/** The daemon's pid (changes on restart). */
	readonly pid: number;
	/** What the fake's `omp usage --json` reports from now on. */
	setUsage(windows: { provider: string; id: string; label?: string; usedPercent: number; resetsAt?: number }[]): void;
	/** Scripts for prompts the test doesn't write: the first rule whose `match` regex matches runs `script` instead ($1… = groups). */
	setFakeRules(rules: { match: string; flags?: string; script: string }[]): void;
	/** JSON request against the daemon; throws on non-2xx with the body. */
	api(method: string, path: string, body?: unknown): Promise<any>;
	/** A fresh git repo (one commit on main) under the fixture root. */
	scratchRepo(name?: string): string;
	/** Registers `dir` as an AO project whose workers default to omp; returns its id. */
	createProject(dir: string, projectId?: string): Promise<string>;
	/** Frames of the fake omp processes; AO's background chats (title generation) only with includeBackground. */
	fakeOmpFrames(opts?: { includeBackground?: boolean }): FakeOmpFrame[];
	daemonLog(): string;
	/** SIGKILLs the chat host(s) of one AO session and the omp they run (as a crash would); returns how many. */
	killChatHosts(sessionId: string): number;
	killNow(): void;
	/** Restarts the daemon on the same port and data dir (chat hosts survive); `kill` SIGKILLs it first instead of a clean stop. */
	restart(opts?: { kill?: boolean }): Promise<void>;
	/** Stops the daemon, its detached chat hosts and their omp; removes the temp dir. */
	stop(): Promise<void>;
}

export function aoBinary(): string | undefined;
export function aoAvailable(): boolean;
/** node:test `skip` value for tests that need the daemon: false, or why they skip. */
export const skipWithoutAo: false | string;
export function fakeOmpAcpPath(): string;
/** Removes a temp tree, retrying while a just-stopped process still writes into it; never throws. */
export function removeTree(dir: string): Promise<void>;
export function startAoFixture(opts?: AoFixtureOptions): Promise<AoFixture>;
export function useAoFixture(hooks: { before: (fn: () => Promise<void>) => void; after: (fn: () => Promise<void>) => void }, opts?: AoFixtureOptions): { current: AoFixture | undefined };
