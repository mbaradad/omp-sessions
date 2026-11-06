// User organization of sessions (groups, colors, priorities, pins, archive, tags, kanban lanes,
// manual order). Lives in `<stateRoot>/organize.json`, separate from host-owned meta.json.
// Shared by the extension (Sessions view, board) and session hosts (scheduling): no vscode import.

import * as fs from "node:fs";
import * as path from "node:path";
import { stateRoot } from "./protocol";

export const ORG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "pink", "gray"] as const;
export type OrgColor = (typeof ORG_COLORS)[number];

/** Most urgent first; a missing priority means "normal". */
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface OrgGroup {
	id: string;
	name: string;
	/** Enclosing group; undefined = top level. */
	parentId?: string;
	color?: OrgColor;
	/** Codicon id (without `$()`). */
	icon?: string;
	/** Position among siblings (ascending). */
	order: number;
}

export interface OrgLane {
	id: string;
	name: string;
	order: number;
	color?: OrgColor;
}

export interface OrgSession {
	groupId?: string;
	priority?: Priority;
	/** Manual position (ascending, fractional). Missing = `-createdAt` (newest first), see `effectiveRank`. */
	rank?: number;
	color?: OrgColor;
	pinned?: boolean;
	archived?: boolean;
	tags?: string[];
	/** Kanban lane id. */
	lane?: string;
}

export interface OrgData {
	version: 1;
	groups: OrgGroup[];
	/** Empty = `DEFAULT_LANES` (persisted on first lane edit). */
	lanes: OrgLane[];
	sessions: Record<string, OrgSession>;
	/** Remembered collapse state of Sessions-view sections, keyed by section key. */
	collapsed: Record<string, boolean>;
}

export const DEFAULT_LANES: readonly OrgLane[] = [
	{ id: "backlog", name: "Backlog", order: 0 },
	{ id: "todo", name: "To Do", order: 1 },
	{ id: "doing", name: "In Progress", order: 2 },
	{ id: "review", name: "Review", order: 3 },
	{ id: "done", name: "Done", order: 4 },
];

export function organizeFile(): string {
	return path.join(stateRoot(), "organize.json");
}

export function emptyOrgData(): OrgData {
	return { version: 1, groups: [], lanes: [], sessions: {}, collapsed: {} };
}

// ---------- tolerant parsing ----------

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}
export function isOrgColor(v: unknown): v is OrgColor {
	return typeof v === "string" && (ORG_COLORS as readonly string[]).includes(v);
}
export function isPriority(v: unknown): v is Priority {
	return typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Normalized tag list: trimmed, without leading `#`, no blanks/duplicates (case-insensitive). */
export function cleanTags(tags: readonly unknown[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const t of tags) {
		if (typeof t !== "string") continue;
		const tag = t.trim().replace(/^#+/, "").replace(/\s+/g, "-");
		if (!tag || seen.has(tag.toLowerCase())) continue;
		seen.add(tag.toLowerCase());
		out.push(tag);
	}
	return out;
}

function normalizeSession(v: unknown): OrgSession | undefined {
	if (!isRecord(v)) return undefined;
	const out: OrgSession = {};
	const groupId = str(v.groupId);
	if (groupId) out.groupId = groupId;
	if (isPriority(v.priority) && v.priority !== "normal") out.priority = v.priority;
	const rank = num(v.rank);
	if (rank !== undefined) out.rank = rank;
	if (isOrgColor(v.color)) out.color = v.color;
	if (v.pinned === true) out.pinned = true;
	if (v.archived === true) out.archived = true;
	const tags = Array.isArray(v.tags) ? cleanTags(v.tags) : [];
	if (tags.length) out.tags = tags;
	const lane = str(v.lane);
	if (lane) out.lane = lane;
	return out;
}

/** Turns anything (parsed JSON of any shape) into valid data; invalid parts are dropped. */
export function normalizeOrgData(raw: unknown): OrgData {
	const data = emptyOrgData();
	if (!isRecord(raw)) return data;
	const groupIds = new Set<string>();
	if (Array.isArray(raw.groups)) {
		for (const [i, g] of raw.groups.entries()) {
			if (!isRecord(g)) continue;
			const id = str(g.id);
			const name = str(g.name);
			if (!id || !name || groupIds.has(id)) continue;
			groupIds.add(id);
			const group: OrgGroup = { id, name, order: num(g.order) ?? i };
			const parentId = str(g.parentId);
			if (parentId) group.parentId = parentId;
			if (isOrgColor(g.color)) group.color = g.color;
			const icon = str(g.icon);
			if (icon && /^[a-z0-9-~]+$/.test(icon)) group.icon = icon;
			data.groups.push(group);
		}
		// Dangling parents and cycles collapse to the top level.
		for (const g of data.groups) {
			if (g.parentId && (!groupIds.has(g.parentId) || g.parentId === g.id)) delete g.parentId;
		}
		for (const g of data.groups) {
			const seen = new Set<string>([g.id]);
			let p = g.parentId;
			while (p) {
				if (seen.has(p)) {
					delete g.parentId;
					break;
				}
				seen.add(p);
				p = data.groups.find(x => x.id === p)?.parentId;
			}
		}
	}
	if (Array.isArray(raw.lanes)) {
		const laneIds = new Set<string>();
		for (const [i, l] of raw.lanes.entries()) {
			if (!isRecord(l)) continue;
			const id = str(l.id);
			const name = str(l.name);
			if (!id || !name || laneIds.has(id)) continue;
			laneIds.add(id);
			const lane: OrgLane = { id, name, order: num(l.order) ?? i };
			if (isOrgColor(l.color)) lane.color = l.color;
			data.lanes.push(lane);
		}
	}
	if (isRecord(raw.sessions)) {
		for (const [id, v] of Object.entries(raw.sessions)) {
			const entry = normalizeSession(v);
			if (!entry) continue;
			if (entry.groupId && !groupIds.has(entry.groupId)) delete entry.groupId;
			if (Object.keys(entry).length) data.sessions[id] = entry;
		}
	}
	if (isRecord(raw.collapsed)) {
		for (const [k, v] of Object.entries(raw.collapsed)) if (typeof v === "boolean") data.collapsed[k] = v;
	}
	return data;
}

export type OrgParse = { ok: true; data: OrgData } | { ok: false; data: OrgData; error: string };

/** Parses organize.json text; never throws. Empty text is a valid empty store. */
export function parseOrgData(text: string): OrgParse {
	if (!text.trim()) return { ok: true, data: emptyOrgData() };
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw)) return { ok: false, data: emptyOrgData(), error: "not a JSON object" };
		return { ok: true, data: normalizeOrgData(raw) };
	} catch (err) {
		return { ok: false, data: emptyOrgData(), error: err instanceof Error ? err.message : String(err) };
	}
}

/** Reads organize.json (missing/corrupt → empty). For session hosts and other read-only users. */
export function readOrgFile(file = organizeFile()): OrgData {
	try {
		return parseOrgData(fs.readFileSync(file, "utf8")).data;
	} catch {
		return emptyOrgData();
	}
}

// ---------- ordering ----------

export function priorityIndex(p: Priority | undefined): number {
	return PRIORITIES.indexOf(p ?? "normal");
}

/** Manual-order key: explicit rank, else newest first by creation time. */
export function effectiveRank(entry: OrgSession | undefined, createdAt: number | undefined): number {
	return entry?.rank ?? -(createdAt ?? 0);
}

/**
 * Which session runs first: priority (urgent → low), then manual rank, then input order.
 * Sessions without any organize entry come last.
 */
export function schedulingOrder(data: OrgData, sessionIds: readonly string[]): string[] {
	const keyed = sessionIds.map((id, i) => {
		const e = data.sessions[id];
		return { id, i, known: e ? 0 : 1, prio: priorityIndex(e?.priority), rank: e?.rank ?? Number.POSITIVE_INFINITY };
	});
	keyed.sort((a, b) => a.known - b.known || a.prio - b.prio || (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1) || a.i - b.i);
	return keyed.map(k => k.id);
}

/**
 * New ranks that put `ordered` in that order while reusing the ranks they occupy now, so their
 * order relative to sessions outside the list is kept. Ties are spread minimally.
 */
export function permuteRanks(ordered: readonly string[], rankOf: (id: string) => number): Map<string, number> {
	const slots = ordered.map(rankOf).sort((a, b) => a - b);
	for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1;
	return new Map(ordered.map((id, i) => [id, slots[i]]));
}

/** `siblings` with `moving` taken out and re-inserted at `index` (an index into the remaining list). */
export function insertAt(siblings: readonly string[], moving: readonly string[], index: number): string[] {
	const set = new Set(moving);
	const rest = siblings.filter(id => !set.has(id));
	const at = Math.max(0, Math.min(rest.length, index));
	return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/** Ancestors of a group, nearest first (cycle-safe). */
export function groupAncestors(data: OrgData, groupId: string | undefined): OrgGroup[] {
	const out: OrgGroup[] = [];
	const seen = new Set<string>();
	let id = groupId;
	while (id && !seen.has(id)) {
		seen.add(id);
		const g = data.groups.find(x => x.id === id);
		if (!g) break;
		out.push(g);
		id = g.parentId;
	}
	return out;
}

/** Sub-groups of `parentId` (undefined = top level) in display order. */
export function childGroups(data: OrgData, parentId: string | undefined): OrgGroup[] {
	return data.groups.filter(g => g.parentId === parentId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Full "Parent / Child" path of a group. */
export function groupPath(data: OrgData, groupId: string): string {
	return groupAncestors(data, groupId)
		.reverse()
		.map(g => g.name)
		.join(" / ");
}

/** Session color to show: its own, else the nearest colored enclosing group. */
export function effectiveColor(data: OrgData, sessionId: string): OrgColor | undefined {
	const e = data.sessions[sessionId];
	return e?.color ?? groupAncestors(data, e?.groupId).find(g => g.color)?.color;
}

// ---------- store ----------

export interface OrgDisposable {
	dispose(): void;
}

function newId(prefix: string): string {
	return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * organize.json with atomic read-modify-write (several VS Code windows share it), change events,
 * file watching and corruption tolerance (a corrupt file is backed up to `organize.json.corrupt`
 * and the last good state is kept).
 */
export class OrganizeStore {
	private current: OrgData = emptyOrgData();
	private raw: string | undefined;
	private readonly listeners = new Set<() => void>();
	/** Last parse error, if the file on disk is corrupt. */
	lastError: string | undefined;

	constructor(
		readonly file = organizeFile(),
		/** Creation time of a session, for the default manual order of sessions never moved. */
		private readonly createdAt: (id: string) => number | undefined = () => undefined,
	) {
		this.reload();
	}

	/** Current snapshot. Treat as read-only; mutate through the setters. */
	get data(): OrgData {
		return this.current;
	}

	session(id: string): OrgSession {
		return this.current.sessions[id] ?? {};
	}

	group(id: string | undefined): OrgGroup | undefined {
		return id ? this.current.groups.find(g => g.id === id) : undefined;
	}

	lanes(): OrgLane[] {
		const lanes = this.current.lanes.length ? this.current.lanes : DEFAULT_LANES;
		return [...lanes].sort((a, b) => a.order - b.order);
	}

	rankOf(id: string): number {
		return effectiveRank(this.current.sessions[id], this.createdAt(id));
	}

	onDidChange(listener: () => void): OrgDisposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	private fire(): void {
		for (const l of [...this.listeners]) {
			try {
				l();
			} catch {
				/* a listener's bug must not break the store */
			}
		}
	}

	/** Re-reads the file; fires and returns true when its content changed. */
	reload(): boolean {
		let text: string;
		try {
			text = fs.readFileSync(this.file, "utf8");
		} catch {
			text = "";
		}
		if (text === this.raw) return false;
		this.raw = text;
		const parsed = parseOrgData(text);
		if (!parsed.ok) {
			this.lastError = parsed.error;
			this.backupCorrupt(text);
			return false;
		}
		this.lastError = undefined;
		this.current = parsed.data;
		this.fire();
		return true;
	}

	private backupCorrupt(text: string): void {
		const backup = `${this.file}.corrupt`;
		try {
			if (fs.existsSync(backup) && fs.readFileSync(backup, "utf8") === text) return;
			fs.writeFileSync(backup, text);
		} catch {
			/* best effort */
		}
	}

	/** Watches the file (directory watch survives atomic renames; polling covers flaky watchers). */
	watch(): OrgDisposable {
		const dir = path.dirname(this.file);
		const base = path.basename(this.file);
		let watcher: fs.FSWatcher | undefined;
		let pending: NodeJS.Timeout | undefined;
		const schedule = () => {
			pending ??= setTimeout(() => {
				pending = undefined;
				this.reload();
			}, 50);
		};
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			watcher = fs.watch(dir, (_event, name) => {
				if (!name || name.toString() === base) schedule();
			});
			watcher.on("error", () => {});
		} catch {
			/* polling below */
		}
		const poll = () => schedule();
		fs.watchFile(this.file, { interval: 2000, persistent: false }, poll);
		return {
			dispose: () => {
				watcher?.close();
				fs.unwatchFile(this.file, poll);
				clearTimeout(pending);
			},
		};
	}

	/** Read-modify-write: re-reads the file (other windows), applies `fn` to a copy, writes atomically. */
	update(fn: (data: OrgData) => void): void {
		let base = this.current;
		try {
			const parsed = parseOrgData(fs.readFileSync(this.file, "utf8"));
			if (parsed.ok) base = parsed.data;
		} catch {
			/* missing: start from memory */
		}
		const next = normalizeOrgData(structuredClone(base));
		fn(next);
		const normalized = normalizeOrgData(next);
		const text = `${JSON.stringify(normalized, null, 1)}\n`;
		this.writeAtomic(text);
		this.raw = text;
		this.lastError = undefined;
		this.current = normalized;
		this.fire();
	}

	private writeAtomic(text: string): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
		fs.writeFileSync(tmp, text, { mode: 0o600 });
		for (let attempt = 0; ; attempt++) {
			try {
				fs.renameSync(tmp, this.file);
				return;
			} catch (err) {
				// Windows: the target may be briefly locked by a reader/watcher.
				if (attempt >= 5) {
					fs.rmSync(tmp, { force: true });
					throw err;
				}
				const until = Date.now() + 20 * (attempt + 1);
				while (Date.now() < until) {
					/* short spin; renames are rare and user-triggered */
				}
			}
		}
	}

	private patchSessions(ids: readonly string[], patch: (e: OrgSession, id: string) => void): void {
		if (ids.length === 0) return;
		this.update(d => {
			for (const id of ids) {
				const e = d.sessions[id] ?? {};
				patch(e, id);
				d.sessions[id] = e;
			}
		});
	}

	// ---------- sessions ----------
	setGroup(ids: readonly string[], groupId: string | undefined): void {
		this.patchSessions(ids, e => {
			if (groupId) e.groupId = groupId;
			else delete e.groupId;
		});
	}
	setColor(ids: readonly string[], color: OrgColor | undefined): void {
		this.patchSessions(ids, e => {
			if (color) e.color = color;
			else delete e.color;
		});
	}
	setPriority(ids: readonly string[], priority: Priority | undefined): void {
		this.patchSessions(ids, e => {
			if (priority && priority !== "normal") e.priority = priority;
			else delete e.priority;
		});
	}
	setPinned(ids: readonly string[], pinned: boolean): void {
		this.patchSessions(ids, e => {
			if (pinned) e.pinned = true;
			else delete e.pinned;
		});
	}
	setArchived(ids: readonly string[], archived: boolean): void {
		this.patchSessions(ids, e => {
			if (archived) e.archived = true;
			else delete e.archived;
		});
	}
	setTags(ids: readonly string[], tags: readonly string[]): void {
		const clean = cleanTags(tags);
		this.patchSessions(ids, e => {
			if (clean.length) e.tags = clean;
			else delete e.tags;
		});
	}
	setLane(ids: readonly string[], laneId: string | undefined): void {
		this.patchSessions(ids, e => {
			if (laneId) e.lane = laneId;
			else delete e.lane;
		});
	}

	/** Gives `ordered` (ids as currently shown, in the wanted order) ranks in that order. */
	reorder(ordered: readonly string[]): void {
		const ranks = permuteRanks(ordered, id => this.rankOf(id));
		this.patchSessions([...ranks.keys()], (e, id) => {
			e.rank = ranks.get(id);
		});
	}

	/** Moves `moving` to `index` within the shown sibling list `siblings` (index into the list without them). */
	place(moving: readonly string[], siblings: readonly string[], index: number): void {
		this.reorder(insertAt(siblings, moving, index));
	}

	/** Moves one session up (delta < 0) or down within `siblings`; false at the edge. */
	move(id: string, delta: number, siblings: readonly string[]): boolean {
		const from = siblings.indexOf(id);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= siblings.length) return false;
		this.reorder(insertAt(siblings, [id], to));
		return true;
	}

	/** Moves `ids` to the top (index 0) of `siblings`. */
	moveToTop(ids: readonly string[], siblings: readonly string[]): void {
		this.place(ids, siblings, 0);
	}

	/** Sessions among `allIds` in the same custom group as `id` (incl. itself), in manual order. */
	groupSiblings(id: string, allIds: readonly string[]): string[] {
		const groupId = this.current.sessions[id]?.groupId;
		return allIds.filter(x => this.current.sessions[x]?.groupId === groupId).sort((a, b) => this.rankOf(a) - this.rankOf(b));
	}

	// ---------- groups ----------
	createGroup(opts: { name: string; parentId?: string; color?: OrgColor; icon?: string }): OrgGroup {
		const group: OrgGroup = { id: newId("g"), name: opts.name.trim() || "Group", order: 0 };
		if (opts.parentId) group.parentId = opts.parentId;
		if (opts.color) group.color = opts.color;
		if (opts.icon) group.icon = opts.icon;
		this.update(d => {
			const siblings = d.groups.filter(g => g.parentId === group.parentId);
			group.order = siblings.reduce((m, g) => Math.max(m, g.order + 1), 0);
			d.groups.push(group);
		});
		return this.group(group.id) ?? group;
	}

	updateGroup(id: string, patch: { name?: string; color?: OrgColor | null; icon?: string | null }): void {
		this.update(d => {
			const g = d.groups.find(x => x.id === id);
			if (!g) return;
			if (patch.name?.trim()) g.name = patch.name.trim();
			if (patch.color === null) delete g.color;
			else if (patch.color) g.color = patch.color;
			if (patch.icon === null) delete g.icon;
			else if (patch.icon) g.icon = patch.icon;
		});
	}

	/** Deletes a group; its sub-groups and sessions move to its parent. */
	deleteGroup(id: string): void {
		this.update(d => {
			const g = d.groups.find(x => x.id === id);
			if (!g) return;
			for (const c of d.groups) if (c.parentId === id) c.parentId = g.parentId;
			for (const e of Object.values(d.sessions)) {
				if (e.groupId !== id) continue;
				if (g.parentId) e.groupId = g.parentId;
				else delete e.groupId;
			}
			d.groups = d.groups.filter(x => x.id !== id);
			delete d.collapsed[`group:${id}`];
		});
	}

	/** Re-parents a group (undefined = top level) at `index` among its new siblings; refuses cycles. */
	moveGroup(id: string, parentId: string | undefined, index?: number): boolean {
		if (parentId && groupAncestors(this.current, parentId).some(g => g.id === id)) return false;
		this.update(d => {
			const g = d.groups.find(x => x.id === id);
			if (!g) return;
			if (parentId) g.parentId = parentId;
			else delete g.parentId;
			const siblings = childGroups(d, parentId).filter(x => x.id !== id);
			siblings.splice(Math.max(0, Math.min(siblings.length, index ?? siblings.length)), 0, g);
			siblings.forEach((x, i) => {
				x.order = i;
			});
		});
		return true;
	}

	/** Moves a group up/down among its siblings; false at the edge. */
	shiftGroup(id: string, delta: number): boolean {
		const g = this.group(id);
		if (!g) return false;
		const siblings = childGroups(this.current, g.parentId);
		const to = siblings.findIndex(x => x.id === id) + delta;
		if (to < 0 || to >= siblings.length) return false;
		return this.moveGroup(id, g.parentId, to);
	}

	// ---------- lanes ----------
	private materializeLanes(d: OrgData): void {
		if (d.lanes.length === 0) d.lanes = DEFAULT_LANES.map(l => ({ ...l }));
	}
	createLane(name: string, color?: OrgColor): OrgLane {
		const lane: OrgLane = { id: newId("l"), name: name.trim() || "Lane", order: 0 };
		if (color) lane.color = color;
		this.update(d => {
			this.materializeLanes(d);
			lane.order = d.lanes.reduce((m, l) => Math.max(m, l.order + 1), 0);
			d.lanes.push(lane);
		});
		return lane;
	}
	updateLane(id: string, patch: { name?: string; color?: OrgColor | null }): void {
		this.update(d => {
			this.materializeLanes(d);
			const l = d.lanes.find(x => x.id === id);
			if (!l) return;
			if (patch.name?.trim()) l.name = patch.name.trim();
			if (patch.color === null) delete l.color;
			else if (patch.color) l.color = patch.color;
		});
	}
	/** Deletes a lane; its sessions lose their lane. */
	deleteLane(id: string): void {
		this.update(d => {
			this.materializeLanes(d);
			d.lanes = d.lanes.filter(l => l.id !== id);
			for (const e of Object.values(d.sessions)) if (e.lane === id) delete e.lane;
		});
	}
	reorderLanes(ids: readonly string[]): void {
		this.update(d => {
			this.materializeLanes(d);
			const pos = new Map(ids.map((id, i) => [id, i]));
			const sorted = [...d.lanes].sort((a, b) => (pos.get(a.id) ?? ids.length + a.order) - (pos.get(b.id) ?? ids.length + b.order));
			sorted.forEach((l, i) => {
				l.order = i;
			});
		});
	}

	// ---------- misc ----------
	setCollapsed(key: string, collapsed: boolean): void {
		if (this.current.collapsed[key] === collapsed) return;
		this.update(d => {
			d.collapsed[key] = collapsed;
		});
	}

	/** Drops entries of sessions that no longer exist; returns how many were removed. */
	cleanup(exists: (id: string) => boolean): number {
		const gone = Object.keys(this.current.sessions).filter(id => !exists(id));
		if (gone.length === 0) return 0;
		this.update(d => {
			for (const id of gone) delete d.sessions[id];
		});
		return gone.length;
	}
}
