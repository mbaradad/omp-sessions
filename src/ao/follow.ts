// One conversation kept current: a snapshot, then the items each change brings (attach, tail, chat).
//
// AO pushes no content stream: the change feed only says a session changed. Reading
// `GET /conversation?afterSequence=N` returns items whose sequence is above N, and an item keeps its
// sequence while it changes (a streaming message grows, a command goes pending → completed under new
// revisions). So each read starts below the oldest item that can still change: those of open turns,
// streaming messages and unsettled activities. Merging keeps the newest revision of each item.
import type { AoActivity, AoClient, AoConversation, AoMessage, AoStreamStatus, AoTurn } from "./client";

type Item = AoMessage | AoActivity;

const OPEN_TURN: Readonly<Partial<Record<AoTurn["state"], true>>> = { queued: true, running: true };
const OPEN_ACTIVITY: Readonly<Partial<Record<AoActivity["status"], true>>> = { running: true, pending: true };

/** The `afterSequence` the next read needs: just below the oldest item that may still change, else the newest sequence. */
export function deltaCursor(conversation: AoConversation): number {
	const openTurns = new Set(conversation.turns.filter(t => OPEN_TURN[t.state]).map(t => t.id));
	let cursor = conversation.latestSequence;
	const consider = (item: Item, open: boolean) => {
		if (open || (item.turnId !== undefined && openTurns.has(item.turnId))) cursor = Math.min(cursor, item.sequence - 1);
	};
	for (const m of conversation.messages) consider(m, m.streaming);
	for (const a of conversation.activities) consider(a, OPEN_ACTIVITY[a.status] === true);
	return Math.max(cursor, 0);
}

function mergeItems<T extends Item>(base: readonly T[], delta: readonly T[], changed: Item[]): T[] {
	const byId = new Map(base.map(i => [i.id, i]));
	for (const item of delta) {
		const old = byId.get(item.id);
		if (old && old.revision > item.revision) continue;
		if (!old || old.revision !== item.revision || old.sequence !== item.sequence) changed.push(item);
		byId.set(item.id, item);
	}
	return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

function mergeTurns(base: readonly AoTurn[], delta: readonly AoTurn[]): AoTurn[] {
	const fresh = new Map(delta.map(t => [t.id, t]));
	const out = base.map(t => fresh.get(t.id) ?? t);
	const known = new Set(base.map(t => t.id));
	for (const t of delta) if (!known.has(t.id)) out.push(t);
	// Queued turns take the order the daemon reports (the queue may have been reordered).
	const queuedOrder = delta.filter(t => t.state === "queued").map(t => t.id);
	if (queuedOrder.length > 1) {
		const slots = out.flatMap((t, i) => (t.state === "queued" && queuedOrder.includes(t.id) ? [i] : []));
		const byId = new Map(out.map(t => [t.id, t]));
		slots.forEach((slot, k) => {
			const t = byId.get(queuedOrder[k]);
			if (t) out[slot] = t;
		});
	}
	return out;
}

/** `base` with a delta read (`afterSequence`) applied; `changed` lists the items that are new or newer. */
export function mergeConversation(base: AoConversation, delta: AoConversation): { conversation: AoConversation; changed: Item[] } {
	const changed: Item[] = [];
	const messages = mergeItems(base.messages, delta.messages, changed);
	const activities = mergeItems(base.activities, delta.activities, changed);
	changed.sort((a, b) => a.sequence - b.sequence);
	return {
		conversation: {
			...delta,
			messages,
			activities,
			turns: mergeTurns(base.turns, delta.turns),
			latestSequence: Math.max(base.latestSequence, delta.latestSequence),
			hasMoreBefore: base.hasMoreBefore,
			...(base.oldestSequence !== undefined && { oldestSequence: base.oldestSequence }),
		},
		changed,
	};
}

export interface AoConversationUpdate {
	conversation: AoConversation;
	/** Items new or changed since the last update, in sequence order (all of them on a reset). */
	changed: Item[];
	/** The snapshot was read whole: the first read, or after the change stream reconnected. */
	reset: boolean;
}

export interface AoFollowOptions {
	/** Messages in the first read (`limit`); older ones stay unread (`hasMoreBefore`). Default 100. */
	limit?: number;
	/** Coalesce change events for this long before reading. Default 50 ms. */
	debounceMs?: number;
	onUpdate(update: AoConversationUpdate): void;
	onStatus?(status: AoStreamStatus): void;
	/** A read failed; the next change event or reconnect reads again. */
	onError?(error: unknown): void;
}

export interface AoConversationFollow {
	/** Resolves with the first snapshot (rejects when it cannot be read). */
	readonly ready: Promise<AoConversation>;
	readonly conversation: AoConversation | undefined;
	close(): void;
}

/** Follows one session's conversation until `close()`: a snapshot, then a delta read for each change. */
export function followConversation(client: Pick<AoClient, "getConversation" | "events">, sessionId: string, options: AoFollowOptions): AoConversationFollow {
	let current: AoConversation | undefined;
	let closed = false;
	let reading = false;
	let again = false;
	let wantReset = true;
	let opens = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const first = Promise.withResolvers<AoConversation>();
	// Unhandled when the caller never awaits `ready`.
	first.promise.catch(() => undefined);

	const read = async (): Promise<void> => {
		if (reading) {
			again = true;
			return;
		}
		reading = true;
		try {
			do {
				again = false;
				const reset = wantReset || !current;
				wantReset = false;
				try {
					if (reset) {
						const conversation = await client.getConversation(sessionId, { limit: options.limit ?? 100 });
						if (closed) return;
						current = conversation;
						first.resolve(conversation);
						options.onUpdate({ conversation, changed: [...conversation.messages, ...conversation.activities].sort((a, b) => a.sequence - b.sequence), reset: true });
					} else if (current) {
						// AO takes only a positive afterSequence: below the first item, read it whole and merge.
						const cursor = deltaCursor(current);
						const delta = await client.getConversation(sessionId, cursor > 0 ? { afterSequence: cursor } : { limit: options.limit ?? 100 });
						if (closed) return;
						const merged = mergeConversation(current, delta);
						current = merged.conversation;
						options.onUpdate({ conversation: merged.conversation, changed: merged.changed, reset: false });
					}
				} catch (error) {
					if (!current) first.reject(error);
					if (reset) wantReset = true;
					options.onError?.(error);
				}
			} while (again && !closed);
		} finally {
			reading = false;
		}
	};

	const schedule = () => {
		if (closed || timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			void read();
		}, options.debounceMs ?? 50);
	};

	const subscription = client.events({
		after: "latest",
		onEvent: event => {
			if (event.sessionId === sessionId) schedule();
		},
		onStatus: status => {
			// After a reconnect the stream cannot say what the gap missed: read it whole again.
			if (status.state === "open" && opens++ > 0) {
				wantReset = true;
				schedule();
			}
			options.onStatus?.(status);
		},
	});
	void read();

	return {
		ready: first.promise,
		get conversation() {
			return current;
		},
		close() {
			closed = true;
			clearTimeout(timer);
			subscription.close();
		},
	};
}
