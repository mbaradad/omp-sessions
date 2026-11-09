// What the planner needs from AO, as a narrow interface (the seam the service's tests replace), and its
// implementation on src/ao (the only HTTP client to AO). Errors are AoErrors; `transientAoError` tells
// a retryable failure (daemon unreachable, 5xx, a spawn still being committed) from a final one.
import { AoClient, AoError, DAEMON_UNREACHABLE } from "../ao/client";
import { type AoSessionMode, spawnSwitchyardSession } from "../ao/spawn";
import { setSessionMode } from "../shared/session-mode-ops";
import type { SessionStart } from "./types";
import type { AoConversation, AoEvent, AoStreamStatus } from "../ao/client";

export interface StartSession extends SessionStart {
	/** Idempotency key for the spawn and the prompt. */
	key: string;
	prompt: string;
}

/** AO or the session refused what the task asked for (an unknown model or thinking level): not worth retrying. */
export class DispatchRefused extends Error {}

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
	/**
	 * Starts a session the Switchyard way (MAPPING D11, src/ao/spawn.ts): spawn without a prompt, model and
	 * thinking through the session's options, the permission mode, then the prompt. Idempotent in `key`
	 * (clientRequestId and clientMessageId): a replay after a crash returns the same session and turn.
	 * `branch`: the git branch AO checked out for the session (project sessions). Throws DispatchRefused
	 * for what retrying can't fix (unknown model or thinking level).
	 */
	startSession(opts: StartSession): Promise<{ session: string; branch?: string; turn?: string }>;
	send(session: string, text: string, clientMessageId: string): Promise<{ turn?: string }>;
	conversation(session: string): Promise<AoConversationInfo>;
	/** Undefined when AO doesn't know the session (deleted). */
	session(id: string): Promise<AoSessionInfo | undefined>;
	activeSessions(): Promise<AoSessionInfo[]>;
	/** Interrupts the running turn and waits until AO has settled it; `discarded`: prompts queued behind it that AO threw away with it (G41). */
	interrupt(session: string): Promise<{ discarded: number }>;
	/** Brings back the agent of an `exited` session (host died or stopped); the transcript continues. */
	resumeAgent(session: string): Promise<void>;
	/** Applies the opt-in `hibernation` setting of config.json (G28); AO forgets it on every daemon boot. Returns what it did, undefined when the user set nothing. */
	applyHibernation(): Promise<{ enabled: boolean; changed: boolean } | undefined>;
	restore(session: string): Promise<void>;
	/** Sets the model for the next turns; returns the one it replaced. */
	setModel(session: string, model: string): Promise<string | undefined>;
	/** Sets omp's thinking level; returns the one it replaced. */
	setThinking(session: string, level: string): Promise<string | undefined>;
	/** AO project for a folder (registered on first use); undefined outside git. */
	projectFor(cwd: string): Promise<string | undefined>;
	/** The git branch and project folder of an existing session (undefined parts: not a git project session). */
	sessionGit(session: string): Promise<{ repo?: string; branch?: string; workspace?: string }>;
	/** The folder the session's agent works in (its git worktree); undefined when AO can't say. */
	workspacePath(session: string): Promise<string | undefined>;
	/** Folder of an AO project (the repo's main checkout). */
	projectPath(id: string): Promise<string | undefined>;
	subscribe(after: number | undefined, handlers: AoStreamHandlers): { close(): void; readonly lastEventId: number | undefined };
}

/** Worth retrying later: AO unreachable, a server error, or a spawn AO is still committing. */
export function transientAoError(err: unknown): boolean {
	if (err instanceof DispatchRefused) return false;
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
		async startSession(opts) {
			try {
				const res = await spawnSwitchyardSession(ao, {
					displayName: opts.displayName,
					prompt: opts.prompt,
					clientRequestId: opts.key,
					clientMessageId: opts.key,
					...(opts.projectId ? { projectId: opts.projectId } : {}),
					...(opts.branch ? { branch: opts.branch } : {}),
					...(opts.model ? { model: opts.model } : {}),
					...(opts.thinking ? { thinking: opts.thinking } : {}),
					...(opts.mode ? { mode: opts.mode as AoSessionMode } : {}),
					// The mode file is written by checkpoints' setSessionMode only (G40), never by hand.
					setMode: (sessionId, mode) => setSessionMode(ao, sessionId, mode),
				});
				return { session: res.session.id, ...(res.session.branch ? { branch: res.session.branch } : {}), ...(res.sent?.turnId ? { turn: res.sent.turnId } : {}) };
			} catch (err) {
				// AO's own errors keep their status (retried or not by transientAoError); the helper's plain errors are refusals.
				if (err instanceof AoError || !(err instanceof Error) || /did not come back/.test(err.message)) throw err;
				throw new DispatchRefused(err.message);
			}
		},
		async send(session, text, clientMessageId) {
			const attempt = () => ao.sendMessage(session, { text, clientMessageId });
			let res: Awaited<ReturnType<typeof attempt>>;
			try {
				res = await attempt();
			} catch (err) {
				// A dead chat host (G39): bring the agent back, then send once more (the clientMessageId dedupes).
				if (!(err instanceof AoError && err.code === "CHAT_CONTROLLER_NOT_READY")) throw err;
				await ao.resumeAgent(session);
				res = await attempt();
			}
			return res.turnId ? { turn: res.turnId } : {};
		},
		async resumeAgent(session) {
			await ao.resumeAgent(session);
		},
		async applyHibernation() {
			return ao.applyChatHibernation();
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
				// AO answers the interrupt before it settles the turns: wait for them, and learn what was queued behind.
				const { discarded } = await ao.interruptWithQueue(session);
				return { discarded: discarded.length };
			} catch (err) {
				// Nothing running any more: the turn ended on its own meanwhile.
				if (!(err instanceof AoError && err.code === "CHAT_NO_ACTIVE_TURN")) throw err;
				return { discarded: 0 };
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
		async sessionGit(session) {
			const view = await ao.getSession(session);
			const repo = view.projectId ? (await ao.listProjects()).find(p => p.id === view.projectId)?.path : undefined;
			const workspace = await ao.workspacePath(session).catch(() => undefined);
			return { ...(repo ? { repo } : {}), ...(view.branch ? { branch: view.branch } : {}), ...(workspace ? { workspace } : {}) };
		},
		async workspacePath(session) {
			return ao.workspacePath(session).catch(() => undefined);
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
					// Events were skipped (pruned or replaced log): the planner re-checks every running task, as after a reset.
					else if (s.state === "gap") handlers.onOpen(true);
				},
			});
		},
	};
}

export async function connectAo(): Promise<AoPort> {
	return aoPort(await AoClient.connect({ start: false }));
}
