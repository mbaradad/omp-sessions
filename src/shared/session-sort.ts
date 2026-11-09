// Session orderings shared by the Sessions view (organize-view.ts) and the kanban webview
// (kanban/board.ts). No node, DOM or vscode imports: it is bundled into the webview too.
import type { SessionMeta } from "./protocol";

export const SESSION_SORTS = ["manual", "activity", "priority", "name", "created", "cost", "scheduled", "completed"] as const;
export type SessionSort = (typeof SESSION_SORTS)[number];

/** What the orderings look at, gathered from meta, queue summary and organize entry. */
export interface SortFields {
	title: string;
	createdAt: number;
	updatedAt: number;
	cost?: number;
	/** Manual order (organize.ts `effectiveRank`); lower first. */
	rank: number;
	/** Index in PRIORITIES (0 = urgent). */
	priority: number;
	/** Scheduled start of pending queued work (`scheduledStart`). */
	startAt?: number;
	completed: boolean;
	completedAt?: number;
	/** When the session last finished work (`finishedAt`). */
	finishedAt?: number;
}

type Queue = SessionMeta["queue"];

/** The queue's scheduled start while pending tasks wait for it. */
export function scheduledStart(queue: Queue): number | undefined {
	return queue && queue.pending > 0 && queue.startAt !== undefined ? queue.startAt : undefined;
}

/**
 * When a session last finished something: the last update of a settled (idle or stopped) session —
 * a turn or queued task ending leaves it idle and stamps `updatedAt`. Undefined while it works or
 * waits for an answer.
 */
export function finishedAt(status: SessionMeta["status"], updatedAt: number): number | undefined {
	return status === "idle" || status === "stopped" ? updatedAt : undefined;
}

const recent = (a: SortFields, b: SortFields) => b.updatedAt - a.updatedAt;
/** Ascending with missing values last. */
const ascLast = (a: number | undefined, b: number | undefined) => (a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : a - b);
/** Descending with missing values last. */
const descLast = (a: number | undefined, b: number | undefined) => (a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : b - a);

export const SESSION_COMPARATORS: Readonly<Record<SessionSort, (a: SortFields, b: SortFields) => number>> = {
	manual: (a, b) => a.rank - b.rank || recent(a, b),
	activity: recent,
	priority: (a, b) => a.priority - b.priority || recent(a, b),
	name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }) || recent(a, b),
	created: (a, b) => b.createdAt - a.createdAt,
	cost: (a, b) => (b.cost ?? 0) - (a.cost ?? 0) || recent(a, b),
	/** Next scheduled start first; unscheduled sessions last, most recently active first. */
	scheduled: (a, b) => ascLast(a.startAt, b.startAt) || recent(a, b),
	/** Completed first (latest mark first), then the most recently finished; never-finished last. */
	completed: (a, b) => Number(b.completed) - Number(a.completed) || descLast(a.completed ? (a.completedAt ?? 0) : undefined, b.completed ? (b.completedAt ?? 0) : undefined) || descLast(a.finishedAt, b.finishedAt) || recent(a, b),
};

/** `list` sorted by `sort`; `fields` is called once per item. */
export function sortBy<T>(list: readonly T[], sort: SessionSort, fields: (item: T) => SortFields): T[] {
	const keyed = list.map(item => ({ item, f: fields(item) }));
	const cmp = SESSION_COMPARATORS[sort];
	keyed.sort((a, b) => cmp(a.f, b.f));
	return keyed.map(k => k.item);
}
