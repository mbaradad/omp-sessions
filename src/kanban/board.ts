// Pure board logic shared by the Kanban webview and the extension: columns per mode, ordering,
// drop planning (field + rank updates), priority cycling and filtering.
// No DOM, vscode or node imports (type-only): it is bundled into the webview too.

import type { OrgColor, OrgGroup, OrgLane, Priority } from "../shared/organize";
import type { SessionStatus } from "../shared/protocol";

export type { OrgColor, Priority };
export type BoardMode = "status" | "lane" | "group" | "priority";
export const BOARD_MODES: readonly BoardMode[] = ["status", "lane", "group", "priority"];

/** Highest first (board column order); same values as organize.ts's PRIORITIES. */
export const PRIORITIES: readonly Priority[] = ["urgent", "high", "normal", "low"];
export const PRIORITY_LABEL: Record<Priority, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
const PRIORITY_WEIGHT: Record<Priority, number> = { urgent: 3, high: 2, normal: 1, low: 0 };

export interface BoardCard {
	id: string;
	title: string;
	cwd: string;
	/** Project display name (repository or folder basename). */
	project: string;
	status: SessionStatus;
	lastText?: string;
	cost?: number;
	queue?: { pending: number; running: number; done: number; total: number };
	/** Set while the session waits for a global concurrency slot. */
	waiting?: { position: number; since: number };
	createdAt: number;
	updatedAt: number;
	unread: boolean;
	priority: Priority;
	/** Effective manual order (organize.ts `effectiveRank`); lower first. */
	rank: number;
	color?: OrgColor;
	pinned: boolean;
	archived: boolean;
	tags: string[];
	lane?: string;
	group?: string;
}

export type BoardLane = OrgLane;
export type BoardGroup = OrgGroup;

export interface BoardData {
	cards: BoardCard[];
	lanes: BoardLane[];
	groups: BoardGroup[];
}

/** Cards of one drop container: the column itself (depth 0) or a nested sub-group inside it. */
export interface BoardSection {
	/** Unique across the board: `<columnId>` or `<columnId>/<groupId>`. */
	id: string;
	/** Group mode: the group a card dropped here joins (undefined = ungrouped). */
	groupId?: string;
	title?: string;
	color?: OrgColor;
	depth: number;
	/** Ancestor section ids (collapsing one hides the descendants). */
	ancestors: string[];
	cards: BoardCard[];
}

export interface BoardColumn {
	id: string;
	/** Lane id / group id / priority / status key; undefined for "Ungrouped". */
	value?: string;
	title: string;
	color?: OrgColor;
	/** Accepts cards from other columns. */
	droppable: boolean;
	/** Status mode's Queued column: order = scheduler position, reorder adjusts priority. */
	queued?: boolean;
	sections: BoardSection[];
	count: number;
}

export type CardPatch = { lane?: string; group?: string | null; priority?: Priority; rank?: number };
export interface CardUpdate {
	id: string;
	patch: CardPatch;
}

// ---------- ordering ----------

export function compareCards(a: BoardCard, b: BoardCard): number {
	return a.rank - b.rank || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

function compareQueued(a: BoardCard, b: BoardCard): number {
	return (a.waiting?.position ?? Number.MAX_SAFE_INTEGER) - (b.waiting?.position ?? Number.MAX_SAFE_INTEGER) || compareCards(a, b);
}

// ---------- columns ----------

export const STATUS_COLUMNS = [
	{ key: "waiting", title: "Needs input" },
	{ key: "working", title: "Working" },
	{ key: "queued", title: "Queued" },
	{ key: "idle", title: "Idle" },
	{ key: "stopped", title: "Stopped" },
] as const;
export type StatusKey = (typeof STATUS_COLUMNS)[number]["key"];

export function statusKey(c: BoardCard): StatusKey {
	if (c.status === "stopped") return "stopped";
	if (c.status === "waiting") return "waiting";
	if (c.status === "working" || c.status === "starting") return "working";
	if (c.waiting) return "queued";
	return "idle";
}

function section(columnId: string, cards: BoardCard[], sort = compareCards): BoardSection {
	return { id: columnId, depth: 0, ancestors: [], cards: cards.sort(sort) };
}

function column(id: string, title: string, value: string | undefined, droppable: boolean, sections: BoardSection[], extra: Partial<BoardColumn> = {}): BoardColumn {
	return { id, value, title, droppable, sections, count: sections.reduce((n, s) => n + s.cards.length, 0), ...extra };
}

function sortGroups(groups: BoardGroup[]): BoardGroup[] {
	return [...groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Columns for `mode` over `cards` (already filtered); column set depends only on mode + lanes/groups. */
export function buildColumns(mode: BoardMode, data: Pick<BoardData, "lanes" | "groups">, cards: BoardCard[]): BoardColumn[] {
	switch (mode) {
		case "status":
			return STATUS_COLUMNS.map(s => {
				const id = `status:${s.key}`;
				const mine = cards.filter(c => statusKey(c) === s.key);
				return column(id, s.title, s.key, false, [section(id, mine, s.key === "queued" ? compareQueued : compareCards)], s.key === "queued" ? { queued: true } : {});
			});
		case "priority":
			return PRIORITIES.map(p => {
				const id = `priority:${p}`;
				return column(id, PRIORITY_LABEL[p], p, true, [section(id, cards.filter(c => c.priority === p))]);
			});
		case "lane": {
			if (data.lanes.length === 0) return [column("lane:", "No lanes", undefined, false, [section("lane:", [...cards])])];
			const known = new Set(data.lanes.map(l => l.id));
			const first = data.lanes[0].id;
			return data.lanes.map(l => {
				const id = `lane:${l.id}`;
				const mine = cards.filter(c => (c.lane && known.has(c.lane) ? c.lane : first) === l.id);
				return column(id, l.name, l.id, true, [section(id, mine)], { color: l.color });
			});
		}
		case "group": {
			const byId = new Map(data.groups.map(g => [g.id, g]));
			const children = new Map<string | undefined, BoardGroup[]>();
			for (const g of data.groups) {
				const parent = g.parentId && byId.has(g.parentId) ? g.parentId : undefined;
				children.set(parent, [...(children.get(parent) ?? []), g]);
			}
			const cardsIn = (groupId: string | undefined) => cards.filter(c => (c.group && byId.has(c.group) ? c.group : undefined) === groupId);
			const ungrouped = column("group:", "Ungrouped", undefined, true, [section("group:", cardsIn(undefined))]);
			const tops = sortGroups(children.get(undefined) ?? []).map(top => {
				const id = `group:${top.id}`;
				const sections: BoardSection[] = [{ ...section(id, cardsIn(top.id)), groupId: top.id }];
				const seen = new Set([top.id]);
				const walk = (parentId: string, depth: number, ancestors: string[]) => {
					for (const g of sortGroups(children.get(parentId) ?? [])) {
						if (seen.has(g.id)) continue;
						seen.add(g.id);
						const sid = `${id}/${g.id}`;
						sections.push({ id: sid, groupId: g.id, title: g.name, color: g.color, depth, ancestors, cards: cardsIn(g.id).sort(compareCards) });
						walk(g.id, depth + 1, [...ancestors, sid]);
					}
				};
				walk(top.id, 1, []);
				return column(id, top.name, top.id, true, sections, { color: top.color });
			});
			return [ungrouped, ...tops];
		}
	}
}

// ---------- rank math ----------

export const RANK_STEP = 1024;

/**
 * Ranks that put `moving` (in order) at `index` of `list` (the container without the moving cards).
 * Only the moving cards change when the neighbours leave room; otherwise the whole container is
 * renumbered from its first rank on.
 */
export function rankInsert(list: Array<Pick<BoardCard, "id" | "rank">>, index: number, moving: string[]): Array<{ id: string; rank: number }> {
	const at = Math.max(0, Math.min(index, list.length));
	const lo = list[at - 1]?.rank;
	const hi = list[at]?.rank;
	const n = moving.length;
	if (lo === undefined && hi === undefined) return moving.map((id, i) => ({ id, rank: i * RANK_STEP }));
	if (hi === undefined) return moving.map((id, i) => ({ id, rank: (lo ?? 0) + (i + 1) * RANK_STEP }));
	if (lo === undefined) return moving.map((id, i) => ({ id, rank: hi - (n - i) * RANK_STEP }));
	const between = moving.map((id, i) => ({ id, rank: lo + ((hi - lo) * (i + 1)) / (n + 1) }));
	// Room only when every new rank lands strictly between its neighbours (floats run out of precision).
	if ([lo, ...between.map(r => r.rank), hi].every((r, i, all) => i === 0 || all[i - 1] < r)) return between;
	const order = [...list.slice(0, at).map(c => c.id), ...moving, ...list.slice(at).map(c => c.id)];
	const base = Math.min(list[0].rank, lo);
	const old = new Map(list.map(c => [c.id, c.rank]));
	return order.map((id, i) => ({ id, rank: base + i * RANK_STEP })).filter(r => old.get(r.id) !== r.rank);
}

// ---------- drops ----------

export interface DropTarget {
	columnId: string;
	sectionId: string;
	/** Insert before this card; undefined = at the end. */
	beforeId?: string;
}

export function findCard(columns: BoardColumn[], cardId: string): { column: BoardColumn; section: BoardSection; index: number } | undefined {
	for (const column of columns)
		for (const section of column.sections) {
			const index = section.cards.findIndex(c => c.id === cardId);
			if (index >= 0) return { column, section, index };
		}
	return undefined;
}

/** Field + rank updates that drop `movingIds` at `target`; undefined when the drop is not allowed. */
export function planDrop(mode: BoardMode, columns: BoardColumn[], movingIds: string[], target: DropTarget): CardUpdate[] | undefined {
	const col = columns.find(c => c.id === target.columnId);
	const sec = col?.sections.find(s => s.id === target.sectionId);
	if (!col || !sec || movingIds.length === 0) return undefined;
	const moving = movingIds.map(id => findCard(columns, id)?.section.cards.find(c => c.id === id)).filter((c): c is BoardCard => !!c);
	if (moving.length === 0) return undefined;
	if (!col.droppable && moving.some(c => findCard(columns, c.id)?.column.id !== col.id)) return undefined;
	const ids = new Set(moving.map(c => c.id));
	const rest = sec.cards.filter(c => !ids.has(c.id));
	const before = target.beforeId && !ids.has(target.beforeId) ? rest.findIndex(c => c.id === target.beforeId) : -1;
	const index = before >= 0 ? before : rest.length;
	const patches = new Map<string, CardPatch>();
	const set = (id: string, patch: CardPatch) => patches.set(id, { ...patches.get(id), ...patch });
	for (const r of rankInsert(rest, index, moving.map(c => c.id))) set(r.id, { rank: r.rank });
	for (const c of moving) {
		if (mode === "lane" && col.value !== undefined && findCard(columns, c.id)?.column.id !== col.id) set(c.id, { lane: col.value });
		if (mode === "group" && (c.group ?? undefined) !== sec.groupId) set(c.id, { group: sec.groupId ?? null });
		const p = mode === "priority" ? PRIORITIES.find(x => x === col.value) : undefined;
		if (p && c.priority !== p) set(c.id, { priority: p });
		if (col.queued) {
			// The scheduler orders by priority before rank: keep the moved card between its new neighbours.
			const upper = rest[index - 1]?.priority;
			const lower = rest[index]?.priority;
			let w = PRIORITY_WEIGHT[c.priority];
			if (upper !== undefined) w = Math.min(w, PRIORITY_WEIGHT[upper]);
			if (lower !== undefined) w = Math.max(w, PRIORITY_WEIGHT[lower]);
			const clamped = PRIORITIES.find(x => PRIORITY_WEIGHT[x] === w);
			if (clamped && clamped !== c.priority) set(c.id, { priority: clamped });
		}
	}
	return [...patches].map(([id, patch]) => ({ id, patch }));
}

/** Drop target that moves `cardId` one place up (-1) or down (+1) in its container. */
export function stepTarget(columns: BoardColumn[], cardId: string, delta: -1 | 1): DropTarget | undefined {
	const at = findCard(columns, cardId);
	if (!at) return undefined;
	const { column, section, index } = at;
	if (delta < 0 && index === 0) return undefined;
	if (delta > 0 && index === section.cards.length - 1) return undefined;
	const beforeId = delta < 0 ? section.cards[index - 1].id : section.cards[index + 2]?.id;
	return { columnId: column.id, sectionId: section.id, beforeId };
}

/** Drop target in the nearest droppable column left (-1) / right (+1), at the same position. */
export function adjacentTarget(columns: BoardColumn[], cardId: string, delta: -1 | 1): DropTarget | undefined {
	const at = findCard(columns, cardId);
	if (!at) return undefined;
	for (let i = columns.indexOf(at.column) + delta; i >= 0 && i < columns.length; i += delta) {
		const col = columns[i];
		if (!col.droppable) continue;
		const sec = col.sections[0];
		return { columnId: col.id, sectionId: sec.id, beforeId: sec.cards[Math.min(at.index, sec.cards.length)]?.id };
	}
	return undefined;
}

// ---------- priority ----------

/** low → normal → high → urgent → low (dir -1 reverses). */
export function cyclePriority(p: Priority, dir: 1 | -1 = 1): Priority {
	const up: Priority[] = ["low", "normal", "high", "urgent"];
	return up[(up.indexOf(p) + dir + up.length) % up.length];
}

// ---------- filtering ----------

export interface BoardFilter {
	/** Free text; `#tag` matches tags, `project:name` the project; other words title/text/project/tags/folder. */
	text: string;
	showArchived: boolean;
	showStopped: boolean;
}

export function filterCards(cards: BoardCard[], f: BoardFilter): BoardCard[] {
	const tokens = f.text.toLowerCase().split(/\s+/).filter(Boolean);
	return cards.filter(c => {
		if (c.archived && !f.showArchived) return false;
		if (c.status === "stopped" && !f.showStopped) return false;
		const tags = c.tags.map(t => t.toLowerCase());
		const hay = `${c.title}\n${c.lastText ?? ""}\n${c.project}\n${c.cwd}\n${tags.map(t => `#${t}`).join(" ")}`.toLowerCase();
		return tokens.every(t => {
			if (t.startsWith("#") && t.length > 1) return tags.some(tag => tag.includes(t.slice(1)));
			if (t.startsWith("project:")) return c.project.toLowerCase().includes(t.slice(8)) || c.cwd.toLowerCase().includes(t.slice(8));
			return hay.includes(t);
		});
	});
}

/** Distinct projects in display order (swimlanes). */
export function projectsOf(cards: BoardCard[]): string[] {
	return [...new Set(cards.map(c => c.project))].sort((a, b) => a.localeCompare(b));
}

// ---------- extension <-> board webview ----------

export interface SchedulerInfo {
	/** Queued tasks holding a global slot now. */
	running: number;
	/** 0 = unlimited. */
	max: number;
	/** Sessions waiting for a slot. */
	waiting: number;
	paused: boolean;
}

export type ToBoard = { type: "data"; data: BoardData; scheduler: SchedulerInfo | null } | { type: "focusFilter" };

export type FromBoard =
	| { type: "ready" }
	| { type: "open"; id: string }
	| { type: "stop"; ids: string[] }
	| { type: "resume"; ids: string[] }
	/** Moves (drag & drop, keyboard): lane/group/priority/rank patches applied in one store write. */
	| { type: "apply"; updates: CardUpdate[] }
	| { type: "setPriority"; ids: string[]; priority: Priority }
	| { type: "setColor"; ids: string[]; color: OrgColor | null }
	| { type: "setArchived"; ids: string[]; archived: boolean }
	| { type: "addLane"; name: string }
	| { type: "renameLane"; id: string; name: string }
	| { type: "moveLane"; id: string; delta: -1 | 1 }
	| { type: "deleteLane"; id: string }
	/** New global limit (0 = unlimited); undefined = ask with an input box. */
	| { type: "concurrency"; max?: number }
	| { type: "newSession" }
	| { type: "maximize" };
