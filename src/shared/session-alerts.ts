// Which session state changes deserve a sound: shared by the VS Code extension (session status transitions),
// the phone app (the live sessions stream) and the Hermes Switchyard page (polled sessions). Browser-safe.

/** `complete`: a working session finished its turn; `input`: a session asks something. */
export type AlertKind = "complete" | "input";

/**
 * The alert a state change earns. States are agent states (`working`, `needs_input`, `idle`, …) or session
 * statuses (`working`, `waiting`, `idle`, …). A first sighting (`from` undefined) never alerts: a list that
 * loads, or a session another client just created, is not news.
 */
export function alertFor(from: string | undefined, to: string): AlertKind | undefined {
	if (from === undefined || from === to) return undefined;
	const input = (s: string) => s === "needs_input" || s === "waiting";
	if (input(to)) return input(from) ? undefined : "input";
	if (to === "idle" && from === "working") return "complete";
	return undefined;
}

/**
 * The alert a planner task's state change earns (PLANNER-API `task` events): a run that ended well sounds like a
 * finished turn; a run that failed or was cut short by a crash needs a person, like a question. Retries and
 * waiting states do not sound.
 */
export function taskAlertFor(from: string | undefined, to: string): AlertKind | undefined {
	if (from !== "running" || from === to) return undefined;
	if (to === "done") return "complete";
	if (to === "failed" || to === "interrupted") return "input";
	return undefined;
}

export interface SessionAlert {
	id: string;
	kind: AlertKind;
	/** The session's `updatedAt` when seen: with id and kind, the same key in every page that saw the change. */
	key: string;
}

/** Remembers each session's last state across snapshots of the session list and reports what changed. */
export class AlertTracker {
	private last = new Map<string, string>();

	/** The alerts between the previous snapshot and `sessions` (none for the first snapshot). */
	observe(sessions: Iterable<{ id: string; state: string; updatedAt?: number | null }>): SessionAlert[] {
		const next = new Map<string, string>();
		const alerts: SessionAlert[] = [];
		for (const s of sessions) {
			next.set(s.id, s.state);
			const kind = alertFor(this.last.get(s.id), s.state);
			if (kind) alerts.push({ id: s.id, kind, key: `${s.id}.${kind}.${s.updatedAt ?? ""}` });
		}
		this.last = next;
		return alerts;
	}
}

/** One cue for a batch of alerts (several sessions changing at once sound once): a question outranks a finish. */
export function cueFor(alerts: readonly SessionAlert[]): AlertKind | undefined {
	if (alerts.some(a => a.kind === "input")) return "input";
	return alerts.length ? "complete" : undefined;
}

const CLAIMS_KEY = "switchyard.sound.claims";
/** Claims older than this are forgotten. */
const CLAIM_TTL_MS = 60_000;

/**
 * Keeps the alerts no other page of this origin (another tab, the same page in a second window) already took,
 * and takes them: with several pages open each change sounds once. `storage` is the page's localStorage; when it
 * is unusable every alert is kept.
 */
export function claimAlerts(storage: Pick<Storage, "getItem" | "setItem"> | undefined, alerts: readonly SessionAlert[], now = Date.now()): SessionAlert[] {
	if (!alerts.length || !storage) return [...alerts];
	try {
		const claims: Record<string, number> = {};
		const parsed: unknown = JSON.parse(storage.getItem(CLAIMS_KEY) ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			for (const [k, t] of Object.entries(parsed)) if (typeof t === "number" && now - t < CLAIM_TTL_MS) claims[k] = t;
		}
		const mine = alerts.filter(a => claims[a.key] === undefined);
		for (const a of mine) claims[a.key] = now;
		storage.setItem(CLAIMS_KEY, JSON.stringify(claims));
		return mine;
	} catch {
		return [...alerts];
	}
}

/** The page's localStorage, if it may be used (private modes and sandboxed frames throw). */
export function pageStorage(): Storage | undefined {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
}
