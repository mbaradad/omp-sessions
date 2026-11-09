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
import { type AoProjectForFolderOptions, projectForFolder } from "./projects";
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
export type AoDiffFile = AoSchemas["ConversationDiffFileResponse"];
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
export { defaultRunFile, ensureDaemon, findDaemon, stopDaemon } from "./daemon";
export type { AoEvent, AoEventSubscription, AoEventType, AoStreamStatus } from "./events";
export { AO_EVENT_TYPES } from "./events";
export type { AoProjectForFolderOptions } from "./projects";
export { gitDefaultBranch, gitRoot } from "./projects";

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

	/** Looks for the daemon again (discovery clients only); returns it, or undefined when none answers. */
	async rediscover(): Promise<AoDaemon | undefined> {
		if (!this.discovery) return undefined;
		const daemon = this.discovery.start ? await ensureDaemon(this.discovery) : await findDaemon(this.discovery);
		if (daemon && daemon.baseUrl !== this.currentBaseUrl) {
			this.currentBaseUrl = daemon.baseUrl;
			this.client = this.create();
		}
		return daemon;
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
		return unwrap(this.client.POST("/api/v1/sessions", { body }));
	}

	async renameSession(sessionId: string, displayName: string): Promise<void> {
		await unwrap(this.client.PATCH("/api/v1/sessions/{sessionId}", { params: { path: { sessionId } }, body: { displayName } }));
	}

	/** Terminates the session (its agent and host). */
	async killSession(sessionId: string, body: AoSchemas["ControllersKillSessionRequest"] = {}): Promise<AoSchemas["KillSessionResponse"]> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/kill", { params: { path: { sessionId } }, body }));
	}

	/** Brings a terminated session back. */
	restoreSession(sessionId: string): Promise<AoSchemas["RestoreSessionResponse"]> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/restore", { params: { path: { sessionId } } }));
	}

	// ---- conversation ----

	getConversation(sessionId: string, query: AoConversationQuery = {}): Promise<AoConversation> {
		return unwrap(this.client.GET("/api/v1/sessions/{sessionId}/conversation", { params: { path: { sessionId }, query } }));
	}

	/**
	 * Sends a message: it starts a turn, or queues one behind the running turn. `clientMessageId` makes
	 * it idempotent (a retry with the same id is reported `duplicate`); one is generated when absent.
	 */
	sendMessage(sessionId: string, body: AoSendRequest): Promise<AoSendResponse> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/messages", { params: { path: { sessionId } }, body: { ...body, clientMessageId: body.clientMessageId ?? randomUUID() } }));
	}

	/**
	 * Steers the running turn with this text, or sends it as a new turn when none runs. AO requires a
	 * `clientMessageId` (generated when absent); after a CHAT_STEER_UNCERTAIN error, retry only with the same one.
	 */
	steerOrSend(sessionId: string, body: AoSchemas["SteerConversationRequest"]): Promise<AoSteerOrSendResponse> {
		return unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/steer-or-send", { params: { path: { sessionId } }, body: { ...body, clientMessageId: body.clientMessageId ?? randomUUID() } }));
	}

	/** Stops the running turn. */
	async interrupt(sessionId: string): Promise<void> {
		await unwrap(this.client.POST("/api/v1/sessions/{sessionId}/conversation/interrupt", { params: { path: { sessionId } } }));
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

	// ---- projects ----

	async listProjects(): Promise<AoProject[]> {
		return (await unwrap(this.client.GET("/api/v1/projects"))).projects;
	}

	async addProject(body: AoSchemas["AddProjectInput"]): Promise<AoSchemas["Project"]> {
		return (await unwrap(this.client.POST("/api/v1/projects", { body }))).project;
	}

	/** Replaces the project's whole per-project config. */
	async setProjectConfig(projectId: string, config: AoSchemas["ProjectConfig"]): Promise<void> {
		await unwrap(this.client.PUT("/api/v1/projects/{id}/config", { params: { path: { id: projectId } }, body: { config } }));
	}

	/** The AO project of `dir`'s git repo, registered (default branch, omp workers) on first use; undefined outside git (spawn standalone). */
	projectForFolder(dir: string, options?: AoProjectForFolderOptions): Promise<AoProject | undefined> {
		return projectForFolder(this, dir, options);
	}
}
