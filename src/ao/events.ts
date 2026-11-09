// AO's change stream (`GET /api/v1/events`): server-sent CDC events with durable replay.
//
// Frames are `id: <seq>` / `event: <type>` / `data: <cdc.Event JSON>`. A fresh `?after=latest` stream
// first sends `event: cursor` with the head sequence as its id, and a named `heartbeat` (no id) every
// 10 s. The daemon resumes after `Last-Event-ID` when the query says `after=latest`, which is what a
// reconnect sends, like a browser EventSource. It reports the cursor it used in `X-AO-Event-After`:
// lower than ours means its log was replaced or truncated past us, so the caller's state must be
// rebuilt (`reset`). A cursor older than the pruned log replays from the oldest retained event
// without notice; callers that care refetch on every `open`.
//
// Uses fetch streaming rather than EventSource: it runs in Node (VS Code extension host, CLI, MCP
// bridge), where there is no EventSource, and it can read the response headers.

/** The CDC event types the daemon writes (backend/internal/cdc/event.go). */
export const AO_EVENT_TYPES = [
	"session_created",
	"session_updated",
	"pr_created",
	"pr_updated",
	"pr_check_recorded",
	"pr_session_changed",
	"pr_review_thread_added",
	"pr_review_thread_resolved",
	"review_run_created",
	"review_run_updated",
] as const;
export type AoEventType = (typeof AO_EVENT_TYPES)[number];

/** One durable change (cdc.Event). `payload` is the trigger-built row JSON; it has `conversationId` for conversation changes. */
export interface AoEvent {
	seq: number;
	projectId: string;
	/** Absent for project-level events. */
	sessionId?: string;
	type: AoEventType | (string & {});
	payload: unknown;
	createdAt: string;
}

export interface SseFrame {
	/** The frame's `id:` field, when it had one. */
	id?: string;
	event: string;
	data: string;
	retry?: number;
}

/** Incremental `text/event-stream` parser (WHATWG HTML §9.2.6). Feed decoded text; get complete frames back. */
export class SseParser {
	private buffer = "";
	private data: string[] = [];
	private event = "";
	private id: string | undefined;
	private retry: number | undefined;
	private seenBom = false;
	/** The previous chunk ended in CR: an LF starting this one belongs to it. */
	private afterCr = false;

	feed(chunk: string): SseFrame[] {
		if (!this.seenBom && chunk.length > 0) {
			this.seenBom = true;
			if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
		}
		if (this.afterCr && chunk.startsWith("\n")) chunk = chunk.slice(1);
		this.afterCr = false;
		this.buffer += chunk;
		const frames: SseFrame[] = [];
		let start = 0;
		for (;;) {
			const cr = this.buffer.indexOf("\r", start);
			const lf = this.buffer.indexOf("\n", start);
			if (cr === -1 && lf === -1) break;
			const end = cr !== -1 && (lf === -1 || cr < lf) ? cr : lf;
			let next = end + 1;
			if (end === cr) {
				if (next === this.buffer.length) this.afterCr = true;
				else if (this.buffer[next] === "\n") next++;
			}
			const frame = this.line(this.buffer.slice(start, end));
			if (frame) frames.push(frame);
			start = next;
		}
		this.buffer = this.buffer.slice(start);
		return frames;
	}

	private line(line: string): SseFrame | undefined {
		if (line === "") return this.dispatch();
		if (line.startsWith(":")) return undefined;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		switch (field) {
			case "data":
				this.data.push(value);
				break;
			case "event":
				this.event = value;
				break;
			case "id":
				if (!value.includes("\0")) this.id = value;
				break;
			case "retry":
				if (/^\d+$/.test(value)) this.retry = Number(value);
				break;
		}
		return undefined;
	}

	private dispatch(): SseFrame | undefined {
		const frame: SseFrame | undefined =
			this.data.length > 0 || this.id !== undefined
				? { event: this.event || "message", data: this.data.join("\n"), ...(this.id !== undefined && { id: this.id }), ...(this.retry !== undefined && { retry: this.retry }) }
				: undefined;
		this.data = [];
		this.event = "";
		this.id = undefined;
		this.retry = undefined;
		return frame;
	}
}

export type AoStreamStatus =
	| { state: "connecting"; attempt: number }
	/**
	 * The stream is open. `cursor`: the sequence the daemon resumes after. `resumed`: it continues
	 * after events this subscription already delivered. `reset`: the daemon's log no longer contains
	 * our cursor (replaced, or truncated past it); rebuild whatever was derived from earlier events.
	 */
	| { state: "open"; cursor: number; resumed: boolean; reset: boolean }
	| { state: "retrying"; attempt: number; delayMs: number; error: string }
	| { state: "closed" };

export interface AoEventStreamOptions {
	/** The daemon's base URL, or a function asked before every (re)connect: the daemon may come back on another port. */
	baseUrl: string | (() => string | Promise<string>);
	/** Start after this sequence, or at the head (default). */
	after?: number | "latest";
	onEvent(event: AoEvent): void;
	onStatus?(status: AoStreamStatus): void;
	fetch?: typeof fetch;
	/** Reconnect delay: doubles from `initialMs` (default 1 s) up to `maxMs` (default 30 s), with jitter in [0.5, 1). */
	backoff?: { initialMs?: number; maxMs?: number };
	/** Reconnect when nothing arrives for this long; the daemon sends a heartbeat every 10 s. Default 35 s. */
	idleTimeoutMs?: number;
	random?: () => number;
}

export interface AoEventSubscription {
	/** Sequence of the last event received; the next reconnect resumes after it. */
	readonly lastEventId: number | undefined;
	close(): void;
}

/** Delay before reconnect attempt `failures` (1-based): exponential, capped, jittered so streams that failed together spread out. */
export function retryDelayMs(failures: number, initialMs = 1_000, maxMs = 30_000, random: () => number = Math.random): number {
	const attempt = Number.isFinite(failures) ? Math.min(Math.max(Math.floor(failures), 1), 31) : 1;
	const step = Math.min(initialMs * 2 ** (attempt - 1), maxMs);
	const jitter = 0.5 + Math.min(Math.max(random(), 0), 0.999_999) * 0.5;
	return Math.round(step * jitter);
}

/** The request one (re)connect sends: the explicit start cursor once, then `Last-Event-ID` like a browser EventSource. */
export function eventsRequest(baseUrl: string, after: number | "latest", lastEventId: number | undefined): { url: string; headers: Record<string, string> } {
	const base = baseUrl.replace(/\/+$/, "");
	if (lastEventId !== undefined) return { url: `${base}/api/v1/events?after=latest`, headers: { accept: "text/event-stream", "last-event-id": String(lastEventId) } };
	return { url: `${base}/api/v1/events?after=${after}`, headers: { accept: "text/event-stream" } };
}

function parseSeq(value: string | null | undefined): number | undefined {
	if (value == null || !/^\d+$/.test(value.trim())) return undefined;
	return Number(value.trim());
}

/** Subscribes to the daemon's CDC stream and keeps it open (reconnect with backoff, resume after the last event) until `close()`. */
export function subscribeEvents(options: AoEventStreamOptions): AoEventSubscription {
	const doFetch = options.fetch ?? globalThis.fetch;
	const initialMs = options.backoff?.initialMs ?? 1_000;
	const maxMs = options.backoff?.maxMs ?? 30_000;
	const idleTimeoutMs = options.idleTimeoutMs ?? 35_000;
	const startAfter = options.after ?? "latest";
	// The resume point: the explicit start cursor until the daemon tells us one.
	let lastEventId: number | undefined = typeof startAfter === "number" ? startAfter : undefined;
	let delivered = false;
	let closed = false;
	let failures = 0;
	let controller: AbortController | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let wake: (() => void) | undefined;
	const status = (s: AoStreamStatus) => {
		try {
			options.onStatus?.(s);
		} catch {
			// A listener's bug must not kill the stream.
		}
	};

	const connectOnce = async (): Promise<void> => {
		const base = typeof options.baseUrl === "string" ? options.baseUrl : await options.baseUrl();
		// A numeric start cursor goes in the query (Last-Event-ID only overrides `latest`); after that, the header.
		const explicitStart = !delivered && typeof startAfter === "number";
		const req = eventsRequest(base, explicitStart ? startAfter : "latest", explicitStart ? undefined : lastEventId);
		controller = new AbortController();
		const signal = controller.signal;
		let idle: ReturnType<typeof setTimeout> | undefined;
		const armIdle = () => {
			clearTimeout(idle);
			idle = setTimeout(() => controller?.abort(new Error(`no data for ${idleTimeoutMs} ms`)), idleTimeoutMs);
		};
		armIdle();
		try {
			const response = await doFetch(req.url, { headers: req.headers, signal });
			if (!response.ok || !response.body) {
				const body = await response.text().catch(() => "");
				throw new Error(`GET /api/v1/events: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`);
			}
			const cursor = parseSeq(response.headers.get("x-ao-event-after"));
			const previous = lastEventId;
			const reset = previous !== undefined && cursor !== undefined && cursor < previous;
			if (reset) lastEventId = cursor;
			status({ state: "open", cursor: cursor ?? lastEventId ?? 0, resumed: delivered && !reset, reset });
			failures = 0;
			const parser = new SseParser();
			const decoder = new TextDecoder();
			const reader = response.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				armIdle();
				for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
					if (closed) return;
					const seq = parseSeq(frame.id);
					if (frame.event === "heartbeat") continue;
					if (frame.event === "cursor") {
						if (seq !== undefined) lastEventId = seq;
						continue;
					}
					// Replays after a reconnect may overlap what was already delivered.
					if (seq !== undefined && lastEventId !== undefined && seq <= lastEventId && delivered) continue;
					let event: AoEvent;
					try {
						event = JSON.parse(frame.data) as AoEvent;
					} catch {
						if (seq !== undefined) lastEventId = seq;
						continue;
					}
					if (seq !== undefined) lastEventId = seq;
					delivered = true;
					try {
						options.onEvent(event);
					} catch {
						// A consumer's bug must not stop delivery to the rest of the stream.
					}
				}
			}
			throw new Error("event stream ended");
		} finally {
			clearTimeout(idle);
		}
	};

	const loop = async (): Promise<void> => {
		while (!closed) {
			status({ state: "connecting", attempt: failures + 1 });
			try {
				await connectOnce();
			} catch (error) {
				if (closed) break;
				failures += 1;
				const delayMs = retryDelayMs(failures, initialMs, maxMs, options.random);
				const reason = error instanceof Error ? (error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message) : String(error);
				status({ state: "retrying", attempt: failures, delayMs, error: reason });
				const { promise, resolve } = Promise.withResolvers<void>();
				wake = resolve;
				retryTimer = setTimeout(resolve, delayMs);
				await promise;
				clearTimeout(retryTimer);
				retryTimer = undefined;
				wake = undefined;
			}
		}
		status({ state: "closed" });
	};
	void loop();

	return {
		get lastEventId() {
			return lastEventId;
		},
		close() {
			if (closed) return;
			closed = true;
			controller?.abort();
			wake?.();
		},
	};
}
