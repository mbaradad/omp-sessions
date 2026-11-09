// The only HTTP client to Agent Orchestrator's daemon. Everything else in Switchyard imports AO
// types and calls from here (and src/ao/model.ts), never from ./schema.
//
//   const ao = await AoClient.connect({ start: true });     // find (or start) the local daemon
//   const { sessions } = await ao.listSessions();
//   const view = await unwrap(ao.api.GET("/api/v1/sessions/{sessionId}", { params: { path: { sessionId } } }));
//   const sub = ao.events({ onEvent: e => …, onStatus: s => … });
//
// `api` is an openapi-fetch client typed by AO's OpenAPI spec: every endpoint, typed params and
// bodies. `unwrap` turns its `{ data, error }` into the data or a thrown AoError. The wrappers below
// cover what several clients call; add one here rather than repeating a call shape across clients.
import { randomUUID } from "node:crypto";
import createClient, { type Client } from "openapi-fetch";
import { type AoDaemon, type AoStartOptions, ensureDaemon, findDaemon } from "./daemon";
import { type AoEventStreamOptions, type AoEventSubscription, subscribeEvents } from "./events";
import { readHibernationSetting } from "./native";
import { type AoProjectForFolderOptions, projectForFolder } from "./projects";
import { type AoQueueItem, queueOf, turnReply } from "./model";
import { type SpawnedSwitchyardSession, type SpawnSwitchyardOptions, spawnSwitchyardSession } from "./spawn";
import { AO_SCHEMA_COMMIT, type components, type paths } from "./schema";

export { AO_SCHEMA_COMMIT };
export type AoPaths = paths;
export type AoSchemas = components["schemas"];
export type AoApi = Client<paths>;

export type AoSessionView = AoSchemas["ControllersSessionView"];
export type AoSessionStatus = AoSessionView["status"];
export type AoConversation = AoSchemas["ConversationSnapshotResponse"];
export type AoTurn = AoSchemas["ConversationTurnResponse"];
export type AoTurnState = AoTurn["state"];
export type AoMessage = AoSchemas["ConversationMessageResponse"];
export type AoActivity = AoSchemas["ConversationActivityResponse"];
export type AoUsage = AoSchemas["ConversationUsagePayload"];
export type AoTurnSettings = AoSchemas["ConversationTurnSettingsPayload"];
export type AoConfigOptions = AoSchemas["ConversationConfigOptionsResponse"];
export type AoWorkspaceManifest = AoSchemas["WorkspaceManifestResponse"];
export type AoProject = AoSchemas["ProjectSummary"];
export type AoSpawnRequest = AoSchemas["SpawnSessionRequest"];
export type AoSpawnResponse = AoSchemas["SpawnSessionResponse"];
export type AoSendRequest = AoSchemas["SendConversationMessageRequest"];
export type AoSendResponse = AoSchemas["SendConversationMessageResponse"];
export type AoSteerOrSendResponse = AoSchemas["SteerOrSendConversationResponse"];
export type AoResolveInputRequest = AoSchemas["ResolveConversationInputRequest"];
export type AoApiErrorBody = AoSchemas["APIError"];
export type AoListSessionsQuery = NonNullable<paths["/api/v1/sessions"]["get"]["parameters"]["query"]>;
export type AoConversationQuery = NonNullable<paths["/api/v1/sessions/{sessionId}/conversation"]["get"]["parameters"]["query"]>;

export type { AoDaemon, AoStartOptions } from "./daemon";
export { applyChatHibernation, defaultRunFile, ensureDaemon, findDaemon, getChatHibernation, stopDaemon } from "./daemon";
export type { AoEvent, AoEventStreamOptions, AoEventSubscription, AoEventType, AoStreamStatus } from "./events";
export { AO_EVENT_TYPES } from "./events";
export type { SwitchyardConfig } from "./config";
export { readSwitchyardConfig, switchyardConfigPath, writeSwitchyardConfig } from "./config";
export type { PairingEndpoint, PairingStatus } from "./mobile";
export { ANDROID_APP_URL, IOS_APP_URL, PAIRING_LINK_BASE, pairingLink, pairingPending, pairingReady, reachSummary, tunnelHost } from "./mobile";
export type { AoProjectForFolderOptions } from "./projects";
export type { AoGateStatus } from "./gate";
export { gateStatus } from "./gate";
export { gitDefaultBranch, gitRoot } from "./projects";
export type { AoNativeSession } from "./native";
export { nativeSessionFile, readHibernationSetting, readNativeSession, sessionStateFile, shimDir, switchyardHome } from "./native";
export type { AoSessionMode, SpawnedSwitchyardSession, SpawnSwitchyardOptions } from "./spawn";
export type { AoAuthStatus, AoHarnessInfo, HarnessChoice, HarnessSource } from "./harness";
export { availableHarnesses, defaultHarness, HarnessError, isOmpHarness, OMP_HARNESS, projectWorkerHarness, resolveHarness, resolveSessionHarness } from "./harness";

/** A failed AO call: the daemon's error envelope (`code`, `message`, `requestId`), or `DAEMON_UNREACHABLE` (status 0). */
export class AoError extends Error {
	readonly status: number;
	readonly code: string;
	readonly requestId?: string;
	readonly details?: Record<string, unknown>;

	constructor(message: string, status: number, code: string, extra: { requestId?: string; details?: Record<string, unknown>; cause?: unknown } = {}) {
		super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
		this.name = "AoError";
		this.status = status;
		this.code = code;
		if (extra.requestId) this.requestId = extra.requestId;
		if (extra.details) this.details = extra.details;
	}
}

export const DAEMON_UNREACHABLE = "DAEMON_UNREACHABLE";

/** The error a non-2xx openapi-fetch result carries, as an AoError. */
export function aoError(error: unknown, response: Response): AoError {
	const body = typeof error === "object" && error !== null ? (error as Partial<AoApiErrorBody>) : undefined;
	const message = body?.message || body?.error || (typeof error === "string" && error) || `HTTP ${response.status}`;
	const route = (() => {
		try {
			return new URL(response.url).pathname;
		} catch {
			return "";
		}
	})();
	return new AoError(route ? `${message} (${route})` : message, response.status, body?.code || `HTTP_${response.status}`, {
		...(body?.requestId && { requestId: body.requestId }),
		...(body?.details && { details: body.details }),
	});
}

/** The data of an openapi-fetch call, or throws its AoError. */
export async function unwrap<T>(call: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
	const { data, error, response } = await call;
	if (!response.ok || error !== undefined) throw aoError(error, response);
	return data as T;
}

export interface AoClientOptions {
	baseUrl: string;
	fetch?: typeof fetch;
}

export interface AoConnectOptions extends AoStartOptions {
	/** Start `ao daemon` when none runs. Default false: throws AoError DAEMON_UNREACHABLE. */
	start?: boolean;
}

function errorCode(value: unknown): string | undefined {
	return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" ? value.code : undefined;
}

/**
 * `X-AO-Attachment-Upload: 1` on a request that carries attachments: AO then raises that request's
 * deadline to at least 10 minutes, so a large image upload is not cut off by the default timeout.
 */
function uploadHeaders(body: { attachments?: readonly unknown[] }): Record<string, string> | undefined {
	return body.attachments && body.attachments.length > 0 ? { "X-AO-Attachment-Upload": "1" } : undefined;
}

/** The request never reached a daemon (nothing listens there, or it went away mid-connection). */
function connectionError(error: unknown): boolean {
	if (!(error instanceof Error) || error.name === "AbortError") return false;
	const code = errorCode(error.cause) ?? errorCode(error);
	return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET" || (error instanceof TypeError && /fetch failed/i.test(error.message));
}

export class AoClient {
	private client: AoApi;
	private currentBaseUrl: string;
	private readonly doFetch: typeof fetch;
	/** Set when connected through discovery: a refused connection looks for the daemon again (it may have restarted on another port). */
	private readonly discovery: AoConnectOptions | undefined;
	/** The probe in flight, shared by every request that failed at once. */
	private rediscovering: Promise<AoDaemon | undefined> | undefined;

	constructor(options: AoClientOptions, discovery?: AoConnectOptions) {
		this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.discovery = discovery;
		this.currentBaseUrl = options.baseUrl.replace(/\/+$/, "");
		this.client = this.create();
	}

	/** A client for the local daemon: found through its run file (or port), or started when `start` is set. */
	static async connect(options: AoConnectOptions = {}): Promise<AoClient> {
		const daemon = options.start ? await ensureDaemon(options) : await findDaemon(options);
		if (!daemon) throw new AoError("No AO daemon is running (start it with `ao daemon`).", 0, DAEMON_UNREACHABLE);
		return new AoClient({ baseUrl: daemon.baseUrl, fetch: options.fetch }, options);
	}

	/** Typed access to every AO endpoint. */
	get api(): AoApi {
		return this.client;
	}

	get baseUrl(): string {
		return this.currentBaseUrl;
	}

	/**
	 * Looks for the daemon again (discovery clients only); returns it, or undefined when none answers.
	 * Never starts one: a daemon someone stopped stays stopped until a client connects with `start`.
	 * Concurrent callers (every in-flight request fails together when the daemon goes down) share one
	 * probe.
	 */
	rediscover(): Promise<AoDaemon | undefined> {
		if (!this.discovery) return Promise.resolve(undefined);
		const discovery = this.discovery;
		this.rediscovering ??= (async () => {
			const daemon = await findDaemon(discovery);
			if (daemon && daemon.baseUrl !== this.currentBaseUrl) {
				this.currentBaseUrl = daemon.baseUrl;
				this.client = this.create();
			}
			return daemon;
		})().finally(() => {
			this.rediscovering = undefined;
		});
		return this.rediscovering;
	}

	private create(): AoApi {
		return createClient<paths>({ baseUrl: this.currentBaseUrl, fetch: request => this.send(request) });
	}

	private async send(request: Request): Promise<Response> {
		const replay = request.method === "GET" || request.method === "HEAD" ? new URL(request.url) : undefined;
		try {
			return await this.doFetch(request);
		} catch (error) {
			if (!connectionError(error)) throw error;
			const before = this.currentBaseUrl;
			const daemon = await this.rediscover().catch(() => undefined);
			// Retry reads on the daemon's new address; a write may have reached the old one, the caller decides.
			if (daemon && replay && daemon.baseUrl !== before) {
				const url = new URL(replay.pathname + replay.search, daemon.baseUrl);
				return this.doFetch(new Request(url, { method: request.method, headers: request.headers, signal: request.signal }));
			}
			throw new AoError(`AO daemon unreachable at ${before}`, 0, DAEMON_UNREACHABLE, { cause: error });
		}
	}

	/** Subscribes to the daemon's change stream; a discovery client follows the daemon to a new port on reconnect. */
	events(options: Omit<AoEventStreamOptions, "baseUrl" | "fetch">): AoEventSubscription {
		return subscribeEvents({
			...options,
			fetch: this.doFetch,
			baseUrl: async () => {
				if (this.discovery) await this.rediscover().catch(() => undefined);
				return this.currentBaseUrl;
			},
		});
	}

	// ---- sessions ----

	listSessions(query: AoListSessionsQuery = {}): Promise<AoSchemas["ListSessionsResponse"]> {
		return unwrap(this.client.GET("/api/v1/sessions", { params: { query } }));
	}

	async getSession(sessionId: string): Promise<AoSessionView> {
		return (await unwrap(this.client.GET("/api/v1/sessions/{sessionId}", { params: { path: { sessionId } } }))).session;
	}

	spawnSession(body: AoSpawnRequest): Promise<AoSpawnResponse> {
		return unwrap(this.client.POST("/api/v1/sessions", { headers: uploadHeaders(body), body }));
	}

	async renameSession(sessionId: string, displayName: string): Promise<void> {
		await unwrap(this.client.PATCH("/api/v1/sessions/{sessionId}", { params: { path: { sessionId } }, body: { displayName } }));
	}

	/** Stops the agent; the session and its transcript stay (MAPPING.md D4 `stop`). */
	exitAgent(sessionId: string): Promise<AoSchemas["ExitAgentResponse"]> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/exit-agent", { params: { path: { sessionId } } }));
	}

	/** Starts the agent again on its transcript (D4 `resume`); needed after it exited or died ("interrupted"). */
	resumeAgent(sessionId: string): Promise<AoSchemas["ResumeAgentResponse"]> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/resume-agent", { params: { path: { sessionId } } }));
	}

	/** Terminates the session (its agent and host) and releases its workspace. */
	async killSession(sessionId: string, body: AoSchemas["ControllersKillSessionRequest"] = {}): Promise<AoSchemas["KillSessionResponse"]> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/kill", { params: { path: { sessionId } }, body }));
	}

	/** Brings a terminated session back. */
	restoreSession(sessionId: string): Promise<AoSchemas["RestoreSessionResponse"]> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/restore", { params: { path: { sessionId } } }));
	}

	/** Deletes a terminated session for good (D4 `rm`: kill first); `cleanup` removes a clean leftover worktree. */
	async deleteSession(sessionId: string, cleanup = true): Promise<void> {
		await unwrap(this.client.DELETE("/api/v1/sessions/{sessionId}", { params: { path: { sessionId }, query: { cleanup } } }));
	}

	async setPinned(sessionId: string, pinned: boolean): Promise<void> {
		const params = { params: { path: { sessionId } } };
		await unwrap(pinned ? this.client.POST("/api/v1/sessions/{sessionId}/pin", params) : this.client.DELETE("/api/v1/sessions/{sessionId}/pin", params));
	}

	// ---- conversation ----

	getConversation(sessionId: string, query: AoConversationQuery = {}): Promise<AoConversation> {
		return unwrap(this.client.GET("/api/v1/sessions/{sessionId}/conversation", { params: { path: { sessionId }, query } }));
	}

	/**
	 * Sends a message: it starts a turn, or queues one behind the running turn. `clientMessageId` makes
	 * it idempotent (a retry with the same id is reported `duplicate`); one is generated when absent.
	 * With `attachments` the request carries `X-AO-Attachment-Upload`, which raises AO's request deadline
	 * for a large image upload (the same for `steer`, `steerOrSend` and `spawnSession`).
	 */
	sendMessage(sessionId: string, body: AoSendRequest): Promise<AoSendResponse> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/messages", { params: { path: { sessionId } }, headers: uploadHeaders(body), body: { ...body, clientMessageId: body.clientMessageId ?? randomUUID() } }));
	}

	/**
	 * Steers the running turn with this text, or sends it as a new turn when none runs. AO requires a
	 * `clientMessageId` (generated when absent); after a CHAT_STEER_UNCERTAIN error, retry only with the same one.
	 */
	steerOrSend(sessionId: string, body: AoSchemas["SteerConversationRequest"]): Promise<AoSteerOrSendResponse> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/steer-or-send", { params: { path: { sessionId } }, headers: uploadHeaders(body), body: { ...body, clientMessageId: body.clientMessageId ?? randomUUID() } }));
	}

	/**
	 * Steers the running turn with this text (omp's `_session/steering`). Refused when no turn runs
	 * (CHAT_NO_ACTIVE_TURN: send it as a message instead). It also folds every queued message into the
	 * same steering call, in queue order, and those queued turns end (VALIDATION.md §5): warn before
	 * steering a session with a queue. `clientMessageId` is generated when absent.
	 */
	steer(sessionId: string, body: AoSchemas["SteerConversationRequest"]): Promise<AoSchemas["SteerConversationResponse"]> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/steer", { params: { path: { sessionId } }, headers: uploadHeaders(body), body: { ...body, clientMessageId: body.clientMessageId ?? randomUUID() } }));
	}

	/** Delivers one queued message into the running turn now (steers with its text), leaving the others queued. */
	promoteQueuedTurn(sessionId: string, turnId: string): Promise<AoSchemas["PromoteQueuedTurnResponse"]> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/turns/{turnId}/steer", { params: { path: { sessionId, turnId } } }));
	}

	/**
	 * Stops the running turn. AO also settles every queued turn as `interrupted`: they never run, and the
	 * queue is empty afterwards (G41, checked live). The 204 comes back **before** that: the turns are still
	 * `running` and `queued` for a few hundred ms. Use `interruptWithQueue` to get the prompts back.
	 */
	async interrupt(sessionId: string): Promise<void> {
		await unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/interrupt", { params: { path: { sessionId } } }));
	}

	/**
	 * Stops the running turn and returns the queued prompts the interrupt discarded (G41), in queue order, so
	 * the caller can warn about them or send them again. AO settles the turns after it has answered, so this
	 * waits (up to `settleTimeoutMs`, default 10 s) until the running turn has ended and none of the prompts
	 * that were queued is still queued. A prompt that started running in between ended up running, not
	 * discarded, and is not reported.
	 */
	async interruptWithQueue(sessionId: string, settleTimeoutMs = 10_000): Promise<{ discarded: AoQueueItem[] }> {
		const before = await this.getConversation(sessionId);
		const queued = queueOf(before).items;
		const running = new Set(before.turns.filter(t => t.state === "running").map(t => t.id));
		await this.interrupt(sessionId);
		if (queued.length === 0) return { discarded: [] };
		const watched = new Set(queued.map(q => q.turnId));
		const deadline = Date.now() + settleTimeoutMs;
		for (;;) {
			const turns = (await this.getConversation(sessionId)).turns;
			const open = turns.some(t => (running.has(t.id) && t.state === "running") || (watched.has(t.id) && t.state === "queued"));
			if (!open || Date.now() > deadline) {
				const ended = new Set(turns.filter(t => t.state === "interrupted" || t.state === "cancelled").map(t => t.id));
				return { discarded: queued.filter(item => ended.has(item.turnId)) };
			}
			await new Promise(resolve => setTimeout(resolve, 150));
		}
	}

	/**
	 * The reply of one turn once it is final (turnReply): AO can mark a turn `completed` a moment before its
	 * last assistant message stops streaming, and a read in that window returns nothing or a half reply. Reads
	 * the conversation until the turn has ended and its reply is final, or `graceMs` (default 3 s) has passed,
	 * and returns what there is then with `final: false` (a turn that ended with no assistant text never
	 * becomes final). For anything that stores a turn's summary: the planner's task result.
	 */
	async awaitTurnReply(sessionId: string, turnId: string, options: { graceMs?: number; pollMs?: number } = {}): Promise<{ text?: string; final: boolean }> {
		const deadline = Date.now() + (options.graceMs ?? 3_000);
		for (;;) {
			const reply = turnReply(await this.getConversation(sessionId), turnId);
			if (reply.final || Date.now() >= deadline) return reply;
			await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 150));
		}
	}

	/** Compacts the conversation (omp's `/compact`). `tokensBefore`/`tokensAfter` come back when the agent reports them. */
	compact(sessionId: string): Promise<AoSchemas["CompactConversationResponse"]> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/compact", { params: { path: { sessionId } } }));
	}

	/** The slash commands and skills the agent offers in this conversation. */
	async skills(sessionId: string): Promise<AoSchemas["ConversationSkillResponse"][]> {
		return (await unwrap(this.client.GET("/api/v1/sessions/{sessionId}/conversation/skills", { params: { path: { sessionId } } }))).skills;
	}

	/**
	 * Tells AO a chat view of this session is open (`active`) or closed: AO keeps a keep-awake lease for
	 * as long as one is open. `viewId` identifies the view (one per panel); send `active: true` again
	 * periodically while it stays open, and `false` when it closes.
	 */
	async chatView(sessionId: string, viewId: string, active: boolean): Promise<void> {
		await unwrap(this.client.POST("/api/v1/sessions/{sessionId}/chat-view", { params: { path: { sessionId } }, body: { viewId, active } }));
	}

	async resolveApproval(sessionId: string, requestId: string, decisionId: string): Promise<void> {
		await unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/approvals/{requestId}/resolve", { params: { path: { sessionId, requestId } }, body: { decisionId } }));
	}

	async resolveInput(sessionId: string, requestId: string, body: AoResolveInputRequest): Promise<void> {
		await unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/inputs/{requestId}/resolve", { params: { path: { sessionId, requestId } }, body }));
	}

	/** Withdraws a queued turn before it runs. */
	async cancelQueuedTurn(sessionId: string, turnId: string): Promise<void> {
		await unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/turns/{turnId}/cancel", { params: { path: { sessionId, turnId } } }));
	}

	async reorderQueue(sessionId: string, turnIds: string[]): Promise<void> {
		await unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/queue/reorder", { params: { path: { sessionId } }, body: { turnIds } }));
	}

	setTurnSettings(sessionId: string, body: AoTurnSettings): Promise<AoTurnSettings> {
		return unwrap(this.client.PATCH("/api/v1/sessions/{sessionId}/conversation/settings", { params: { path: { sessionId } }, body }));
	}

	/** The agent's own settings (omp: `mode`, `model`, `thinking`), with their choices. */
	configOptions(sessionId: string): Promise<AoSchemas["ConversationConfigOptionsResponse"]> {
		return unwrap(this.client.GET("/api/v1/sessions/{sessionId}/conversation/config-options", { params: { path: { sessionId } } }));
	}

	setConfigOption(sessionId: string, configId: string, body: AoSchemas["SetConversationConfigOptionRequest"]): Promise<AoSchemas["ConversationConfigOptionsResponse"]> {
		return unwrap(this.client.PATCH("/api/v1/sessions/{sessionId}/conversation/config-options/{configId}", { params: { path: { sessionId, configId } }, body }));
	}

	// ---- workspace ----

	/** The folder the session's agent works in: its git worktree, or its standalone scratch dir. */
	async workspacePath(sessionId: string): Promise<string> {
		return (await unwrap(this.client.GET("/api/v1/desktop/sessions/{sessionId}/workspace", { params: { path: { sessionId } } }))).workspacePath;
	}

	/** The workspace against the base it started from: every changed file with its line counts (empty outside git). */
	workspaceManifest(sessionId: string): Promise<AoWorkspaceManifest> {
		return unwrap(this.client.GET("/api/v1/sessions/{sessionId}/workspace/manifest", { params: { path: { sessionId } } }));
	}

	// ---- projects ----

	async listProjects(): Promise<AoProject[]> {
		return (await unwrap(this.client.GET("/api/v1/projects"))).projects;
	}

	async addProject(body: AoSchemas["AddProjectInput"]): Promise<AoSchemas["Project"]> {
		return (await unwrap(this.client.POST("/api/v1/projects", { body }))).project;
	}

	/** One project with its config (`config.worker.agent`: the project's worker harness); a degraded project has no config. */
	async getProject(projectId: string): Promise<AoSchemas["ProjectOrDegraded"]> {
		return (await unwrap(this.client.GET("/api/v1/projects/{id}", { params: { path: { id: projectId } } }))).project;
	}

	/** Replaces the project's whole per-project config. */
	async setProjectConfig(projectId: string, config: AoSchemas["ProjectConfig"]): Promise<void> {
		await unwrap(this.client.PUT("/api/v1/projects/{id}/config", { params: { path: { id: projectId } }, body: { config } }));
	}

	/** The AO project of `dir`'s git repo, registered (default branch; the worker harness stays AO's project setting) on first use; undefined outside git (spawn standalone). */
	projectForFolder(dir: string, options?: AoProjectForFolderOptions): Promise<AoProject | undefined> {
		return projectForFolder(this, dir, options);
	}

	/**
	 * Starts a Switchyard session the way every client does (MAPPING D11: bypass launch, the mode file,
	 * model and thinking validated against the session's own options, extra omp arguments, then the
	 * prompt with a `clientMessageId`). See spawn.ts.
	 */
	spawnSwitchyard(options?: SpawnSwitchyardOptions): Promise<SpawnedSwitchyardSession> {
		return spawnSwitchyardSession(this, options);
	}

	// ---- agent accounts (provider limits and usage) ----

	/** Provider accounts AO knows (Claude, Codex devices…) with their limit windows; `refresh` re-reads the providers. */
	agentAccounts(refresh = false): Promise<AoSchemas["AgentAccountsResponse"]> {
		return unwrap(this.client.GET("/api/v1/agents/accounts", { params: { query: { refresh } } }));
	}

	/** Per-account token and cost usage (`costNanos`) over the last `days`. */
	agentAccountUsage(days?: number): Promise<AoSchemas["AgentAccountUsageResponse"]> {
		return unwrap(this.client.GET("/api/v1/agents/accounts/usage", { params: { query: days === undefined ? {} : { days } } }));
	}

	// ---- daemon ----

	/** `{hostId, apiVersion}`. */
	identity(): Promise<AoSchemas["IdentityResponse"]> {
		return unwrap(this.client.GET("/api/v1/identity"));
	}

	/** AO's settings (`chatHarnesses`: the harnesses that run in Chat mode, the only mode Switchyard drives). */
	settings(): Promise<AoSchemas["SettingsResponse"]> {
		return unwrap(this.client.GET("/api/v1/settings"));
	}

	/** AO's agent catalog: every supported harness with its auth status and usage, and the installed and authorized ones. */
	agents(): Promise<AoSchemas["ListAgentsResponse"]> {
		return unwrap(this.client.GET("/api/v1/agents"));
	}

	/** Chat harnesses AO knows it can't start here, with why (`pi-acp is not installed…`). */
	async unavailableChatHarnesses(harnesses: readonly string[]): Promise<Map<string, string>> {
		if (!harnesses.length) return new Map();
		const res = await unwrap(this.client.GET("/api/v1/agents/chat/unavailable", { params: { query: { agents: harnesses.join(",") } } }));
		return new Map(res.agents.map(a => [a.agent, a.reason]));
	}

	/** The AO approval modes `harness` can run a chat in, strictest first (Kimi: only `default`); undefined when AO doesn't say. */
	async chatPermissionModes(harness: string): Promise<string[] | undefined> {
		const res = await unwrap(this.client.GET("/api/v1/agents/chat/permission-modes", { params: { query: { agents: harness } } }));
		return res.agents.find(a => a.agent === harness)?.modes;
	}

	/** Whether AO hibernates idle chats now (`GET /settings` `chatHibernationEnabled`). In memory in AO: false after every daemon boot. */
	async chatHibernation(): Promise<boolean> {
		return (await unwrap(this.client.GET("/api/v1/settings"))).chatHibernationEnabled;
	}

	/**
	 * Makes AO's chat hibernation match `enabled`, or, with none, the opt-in `hibernation` key of
	 * `<SWITCHYARD_HOME>/config.json` (G28); with neither it leaves AO alone and returns undefined. Writes only
	 * when it differs. AO forgets the setting on every boot, so call it after a daemon (re)start and whenever
	 * the connection to the daemon comes back (the planner's reconnect). `ensureDaemon` already does it for a
	 * daemon it starts.
	 */
	async applyChatHibernation(enabled?: boolean): Promise<{ enabled: boolean; changed: boolean } | undefined> {
		const wanted = enabled ?? readHibernationSetting();
		if (wanted === undefined) return undefined;
		if ((await this.chatHibernation()) === wanted) return { enabled: wanted, changed: false };
		await unwrap(this.client.PATCH("/api/v1/settings/chat-hibernation", { body: { enabled: wanted } }));
		return { enabled: wanted, changed: true };
	}

	/** The models a harness offers (`omp`: its provider/model ids). */
	agentModels(agent = "omp", query: NonNullable<paths["/api/v1/agents/{agent}/models"]["get"]["parameters"]["query"]> = {}): Promise<AoSchemas["AgentModelsResponse"]> {
		return unwrap(this.client.GET("/api/v1/agents/{agent}/models", { params: { path: { agent }, query } }));
	}

	// ---- mobile (AO's phone app: LAN/tunnel listener and pairing) ----

	mobileStatus(): Promise<AoSchemas["MobileStatusResponse"]> {
		return unwrap(this.client.GET("/api/v1/mobile/status"));
	}

	setMobileEnabled(enabled: boolean): Promise<AoSchemas["MobileStatusResponse"]> {
		return unwrap(enabled ? this.client.POST("/api/v1/mobile/enable") : this.client.POST("/api/v1/mobile/disable"));
	}

	/** New connection password and pairing link; paired phones must pair again. */
	regenerateMobile(): Promise<AoSchemas["MobileStatusResponse"]> {
		return unwrap(this.client.POST("/api/v1/mobile/regenerate"));
	}

	setMobileSecurePairing(enabled: boolean): Promise<AoSchemas["MobileStatusResponse"]> {
		return unwrap(this.client.POST("/api/v1/mobile/secure-pairing", { body: { enabled } }));
	}
}
