// Types for test/ao-fixture.mjs (TypeScript tests import it; esbuild bundles the .mjs).

export interface AoFixtureOptions {
	/** ao executable (default $OMP_TEST_AO_BIN, else `ao` on PATH). */
	aoBin?: string;
	/** Run the real omp from PATH with the real HOME instead of test/fake-omp-acp.mjs. */
	realOmp?: boolean;
	/** Extra daemon env (AO_* overrides). */
	env?: Record<string, string>;
	/** Extra env for the fake omp (FAKE_OMP_DELAY, FAKE_OMP_NO_STEERING, ...). */
	fakeOmpEnv?: Record<string, string>;
	readyTimeoutMs?: number;
	/** Leave the temp dir after stop() (default $OMP_TEST_KEEP_AO=1). */
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
	root: string;
	dataDir: string;
	runFile: string;
	logFile: string;
	/** HOME the daemon and omp run with (a temp dir unless realOmp). */
	home: string;
	/** PI_CODING_AGENT_DIR of the fake (its session store); undefined with realOmp. */
	agentDir?: string;
	fakeOmpLog?: string;
	pid: number;
	/** JSON request against the daemon; throws on non-2xx with the body. */
	api(method: string, path: string, body?: unknown): Promise<any>;
	/** A fresh git repo (one commit on main) under the fixture root. */
	scratchRepo(name?: string): string;
	/** Registers `dir` as an AO project whose workers default to omp; returns its id. */
	createProject(dir: string, projectId?: string): Promise<string>;
	fakeOmpFrames(): FakeOmpFrame[];
	daemonLog(): string;
	/** SIGKILLs the chat host(s) of one AO session and the omp they run (as a crash would); returns how many. */
	killChatHosts(sessionId: string): number;
	killNow(): void;
	/** Stops the daemon, its detached chat hosts and their omp; removes the temp dir. */
	stop(): Promise<void>;
}

export function aoBinary(): string | undefined;
export function aoAvailable(): boolean;
export function fakeOmpAcpPath(): string;
export function startAoFixture(opts?: AoFixtureOptions): Promise<AoFixture>;
export function useAoFixture(hooks: { before: (fn: () => Promise<void>) => void; after: (fn: () => Promise<void>) => void }, opts?: AoFixtureOptions): { current: AoFixture | undefined };
