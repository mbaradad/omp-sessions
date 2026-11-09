// What the planner needs from AO, as a narrow interface (the seam the service's tests replace), and its
// implementation on src/ao (the only HTTP client to AO). Errors are AoErrors; `transientAoError` tells
// a retryable failure (daemon unreachable, 5xx, a spawn still being committed) from a final one.
import { AoClient, AoError, DAEMON_UNREACHABLE } from "../ao/client";
import type { AoConversation, AoEvent, AoStreamStatus } from "../ao/client";

export interface AoTurnInfo {
	id: string;
	state: "queued" | "running" | "completed" | "recovered" | "interrupted" | "failed" | "cancelled";
	errorMessage?: string;
	/** Reset time AO parsed from a known usage-limit message. */
	usageLimitResetsAt?: number;
	requestedAt: number;
}

export interface AoMessageInfo {
	turnId?: string;
	role: "user" | "assistant";
	text: string;
	streaming: boolean;
	clientMessageId?: string;
}

export interface AoConversationInfo {
	turns: AoTurnInfo[];
	messages: AoMessageInfo[];
	/** Running cost of the whole conversation (USD), when AO reports it. */
	cost?: number;
	model?: string;
}

export interface AoSessionInfo {
	id: string;
	terminated: boolean;
	/** AO activity state: active | idle | waiting_input | blocked | exited. */
	activity?: string;
}

export interface AoStreamHandlers {
	/** A change in AO; `session` absent for project-level events. */
	onEvent(seq: number, session: string | undefined, activity: string | undefined): void;
	/** The stream (re)opened; `reset`: events may have been missed, re-check everything. */
	onOpen(reset: boolean): void;
	onDown(error: string): void;
}

export interface AoPort {
	readonly url: string;
	/** `branch`: the git branch AO checked out for the session (project sessions). */
	spawn(body: Record<string, unknown>): Promise<{ session: string; branch?: string }>;
	send(session: string, text: string, clientMessageId: string): Promise<{ turn?: string }>;
	conversation(session: string): Promise<AoConversationInfo>;
	/** Undefined when AO doesn't know the session (deleted). */
	session(id: string): Promise<AoSessionInfo | undefined>;
	activeSessions(): Promise<AoSessionInfo[]>;
	interrupt(session: string): Promise<void>;
	restore(session: string): Promise<void>;
	/** Sets the model for the next turns; returns the one it replaced. */
	setModel(session: string, model: string): Promise<string | undefined>;
	/** Sets omp's thinking level; returns the one it replaced. */
	setThinking(session: string, level: string): Promise<string | undefined>;
	/** AO project for a folder (registered on first use); undefined outside git. */
	projectFor(cwd: string): Promise<string | undefined>;
	/** Folder of an AO project (the repo's main checkout). */
	projectPath(id: string): Promise<string | undefined>;
	subscribe(after: number | undefined, handlers: AoStreamHandlers): { close(): void; readonly lastEventId: number | undefined };
}

/** Worth retrying later: AO unreachable, a server error, or a spawn AO is still committing. */
export function transientAoError(err: unknown): boolean {
	if (!(err instanceof AoError)) return true;
	return err.code === DAEMON_UNREACHABLE || err.status === 0 || err.status >= 500 || err.status === 429 || err.code === "CLIENT_REQUEST_INCOMPLETE";
}

const epoch = (s: string | null | undefined): number | undefined => {
	const t = s ? Date.parse(s) : Number.NaN;
	return Number.isFinite(t) ? t : undefined;
};

export function conversationInfo(c: AoConversation): AoConversationInfo {
	const out: AoConversationInfo = {
		turns: c.turns.map(t => {
			const turn: AoTurnInfo = { id: t.id, state: t.state, requestedAt: epoch(t.requestedAt) ?? 0 };
			if (t.errorMessage) turn.errorMessage = t.errorMessage;
			const reset = epoch(t.usageLimit?.resetsAt);
			if (reset) turn.usageLimitResetsAt = reset;
			return turn;
		}),
		messages: c.messages.map(m => {
			const msg: AoMessageInfo = { role: m.role, text: m.text, streaming: m.streaming };
			if (m.turnId) msg.turnId = m.turnId;
			if (m.clientMessageId) msg.clientMessageId = m.clientMessageId;
			return msg;
		}),
	};
	if (typeof c.usage?.cost === "number") out.cost = c.usage.cost;
	if (c.settings?.model) out.model = c.settings.model;
	return out;
}

function payloadActivity(payload: unknown): string | undefined {
	if (payload && typeof payload === "object" && "activity" in payload && typeof payload.activity === "string") return payload.activity;
	return undefined;
}

/** The AoPort over a real daemon. */
export function aoPort(ao: AoClient): AoPort {
	const sessionInfo = (s: { id: string; isTerminated: boolean; activity?: { state: string } }): AoSessionInfo => ({ id: s.id, terminated: s.isTerminated, ...(s.activity?.state ? { activity: s.activity.state } : {}) });
	return {
		get url() {
			return ao.baseUrl;
		},
		async spawn(body) {
			const res = await ao.spawnSession(body as Parameters<AoClient["spawnSession"]>[0]);
			return { session: res.session.id, ...(res.session.branch ? { branch: res.session.branch } : {}) };
		},
		async send(session, text, clientMessageId) {
			const res = await ao.sendMessage(session, { text, clientMessageId });
			return res.turnId ? { turn: res.turnId } : {};
		},
		async conversation(session) {
			return conversationInfo(await ao.getConversation(session));
		},
		async session(id) {
			try {
				return sessionInfo(await ao.getSession(id));
			} catch (err) {
				if (err instanceof AoError && err.status === 404) return undefined;
				throw err;
			}
		},
		async activeSessions() {
			return (await ao.listSessions({ active: true })).sessions.map(sessionInfo);
		},
		async interrupt(session) {
			try {
				await ao.interrupt(session);
			} catch (err) {
				// Nothing running any more: the turn ended on its own meanwhile.
				if (!(err instanceof AoError && err.code === "CHAT_NO_ACTIVE_TURN")) throw err;
			}
		},
		async restore(session) {
			await ao.restoreSession(session);
		},
		async setModel(session, model) {
			// PATCH settings replaces every field: send the current ones back with the new model.
			const current = (await ao.getConversation(session, { limit: 1 })).settings;
			await ao.setTurnSettings(session, { ...current, model });
			return current.model || undefined;
		},
		async setThinking(session, level) {
			const params = { params: { path: { sessionId: session } } };
			const { data: list } = await ao.api.GET("/api/v1/sessions/{sessionId}/conversation/config-options", params);
			const previous = list?.options.find(o => o.id === "thinking")?.currentValue;
			const { error, response } = await ao.api.PATCH("/api/v1/sessions/{sessionId}/conversation/config-options/{configId}", { params: { path: { sessionId: session, configId: "thinking" } }, body: { value: level } });
			if (!response.ok) throw new AoError(`thinking level ${level}: ${JSON.stringify(error)}`, response.status, `HTTP_${response.status}`);
			return previous || undefined;
		},
		async projectPath(id) {
			return (await ao.listProjects()).find(p => p.id === id)?.path;
		},
		async projectFor(cwd) {
			return (await ao.projectForFolder(cwd))?.id;
		},
		subscribe(after, handlers) {
			return ao.events({
				after: after ?? "latest",
				onEvent: (e: AoEvent) => handlers.onEvent(e.seq, e.sessionId, payloadActivity(e.payload)),
				onStatus: (s: AoStreamStatus) => {
					if (s.state === "open") handlers.onOpen(s.reset);
					else if (s.state === "retrying") handlers.onDown(s.error);
				},
			});
		},
	};
}

export async function connectAo(): Promise<AoPort> {
	return aoPort(await AoClient.connect({ start: false }));
}
