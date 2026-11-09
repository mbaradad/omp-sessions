// Pure layout of the Sessions view: grouping modes, pinned/archived sections, filter and sorting.
// No vscode import, so it is unit-tested directly and reusable by a CLI listing.

import * as path from "node:path";
import { type OrgData, type OrgGroup, childGroups, effectiveColor, effectiveRank, groupPath, priorityIndex } from "./organize";
import type { SessionMeta, SessionStatus } from "./protocol";
import { finishedAt, scheduledStart, sortBy } from "./session-sort";

export const GROUP_MODES = ["project", "group", "status", "none"] as const;
export type GroupMode = (typeof GROUP_MODES)[number];
export const SORT_MODES = ["auto", "manual", "activity", "priority", "name", "created", "cost", "scheduled", "completed"] as const;
export type SortMode = (typeof SORT_MODES)[number];
/** Every mode but `auto` is a session-sort.ts ordering. */
export type ResolvedSort = Exclude<SortMode, "auto">;

export type StatusBucket = "waiting" | "working" | "idle" | "stopped";
export const STATUS_BUCKETS: ReadonlyArray<{ bucket: StatusBucket; label: string }> = [
	{ bucket: "waiting", label: "Needs input" },
	{ bucket: "working", label: "Working" },
	{ bucket: "idle", label: "Idle" },
	{ bucket: "stopped", label: "Stopped" },
];

export type SectionKind = "pinned" | "archived" | "ungrouped" | "status" | "other";

/** Layout node. Containers carry their already-sorted children; `key` is stable per container. */
export type ViewNode =
	| { kind: "project"; key: string; root: string; isRepo: boolean; inWorkspace: boolean; sessions: SessionMeta[]; children: ViewNode[] }
	| { kind: "section"; key: string; section: SectionKind; label: string; status?: StatusBucket; sessions: SessionMeta[]; children: ViewNode[] }
	| { kind: "orgGroup"; key: string; group: OrgGroup; sessions: SessionMeta[]; children: ViewNode[] }
	| { kind: "session"; meta: SessionMeta; parent: string; project?: string };

export const ROOT_KEY = "root";

export function isGroupMode(v: unknown): v is GroupMode {
	return typeof v === "string" && (GROUP_MODES as readonly string[]).includes(v);
}
export function isSortMode(v: unknown): v is SortMode {
	return typeof v === "string" && (SORT_MODES as readonly string[]).includes(v);
}

/** `auto` = manual order when grouping by custom groups, else most recent activity. */
export function resolveSort(sort: SortMode, mode: GroupMode): ResolvedSort {
	if (sort !== "auto") return sort;
	return mode === "group" ? "manual" : "activity";
}

export function statusBucket(s: SessionStatus): StatusBucket {
	return s === "starting" ? "working" : s;
}

export function sortSessions(list: readonly SessionMeta[], sort: ResolvedSort, data: OrgData): SessionMeta[] {
	return sortBy(list, sort, m => {
		const e = data.sessions[m.id];
		return {
			title: m.title,
			createdAt: m.createdAt,
			updatedAt: m.updatedAt,
			cost: m.cost,
			rank: effectiveRank(e, m.createdAt),
			priority: priorityIndex(e?.priority),
			startAt: scheduledStart(m.queue),
			completed: m.queue?.completed === true,
			completedAt: m.queue?.completedAt,
			finishedAt: finishedAt(m.status, m.updatedAt),
		};
	});
}

/** Text a filter query is matched against. */
export function sessionHaystack(m: SessionMeta, data: OrgData, projectName: string): string {
	const e = data.sessions[m.id];
	const parts = [m.title, projectName, path.basename(m.cwd), m.cwd, m.lastText ?? "", m.model ?? "", m.status === "waiting" ? "needs input" : m.status];
	if (e?.tags) parts.push(...e.tags.map(t => `#${t}`));
	if (e?.groupId) parts.push(groupPath(data, e.groupId));
	const color = effectiveColor(data, m.id);
	if (color) parts.push(color);
	if (e?.priority) parts.push(e.priority);
	if (e?.pinned) parts.push("pinned");
	if (e?.archived) parts.push("archived");
	if (m.queue?.completed) parts.push("completed");
	return parts.join("\n").toLowerCase();
}

/** Every whitespace-separated token must occur in the haystack (case-insensitive). */
export function matchesFilter(haystack: string, query: string): boolean {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	return tokens.every(t => haystack.includes(t));
}

export interface ViewInput {
	sessions: readonly SessionMeta[];
	data: OrgData;
	groupBy: GroupMode;
	sortBy: SortMode;
	filter: string;
	showArchived: boolean;
	/** Hide sessions marked completed (organize.ts). */
	hideCompleted?: boolean;
	/** Listed at all in this window (`omp.sessionScope`, hidden finished sessions). */
	visible(m: SessionMeta): boolean;
	inWorkspace(m: SessionMeta): boolean;
	project(m: SessionMeta): { root: string; isRepo: boolean };
	/** Window has no folder open: everything is "local". */
	noWorkspace: boolean;
}

function sessionNodes(list: readonly SessionMeta[], parent: string, project?: string): ViewNode[] {
	return list.map(meta => (project ? { kind: "session", meta, parent, project } : { kind: "session", meta, parent }));
}

/** Root nodes of the Sessions view. */
export function buildView(input: ViewInput): ViewNode[] {
	const { data, groupBy } = input;
	const sort = resolveSort(input.sortBy, groupBy);
	const sorted = (list: readonly SessionMeta[]) => sortSessions(list, sort, data);
	const query = input.filter.trim();
	const shown = input.sessions.filter(m => {
		if (!input.visible(m)) return false;
		if (data.sessions[m.id]?.archived && !input.showArchived) return false;
		if (m.queue?.completed && input.hideCompleted) return false;
		return !query || matchesFilter(sessionHaystack(m, data, path.basename(input.project(m).root)), query);
	});
	const archived = shown.filter(m => data.sessions[m.id]?.archived);
	const pinned = shown.filter(m => !data.sessions[m.id]?.archived && data.sessions[m.id]?.pinned);
	const rest = shown.filter(m => !data.sessions[m.id]?.archived && !data.sessions[m.id]?.pinned);
	const section = (section: SectionKind, key: string, label: string, list: readonly SessionMeta[], status?: StatusBucket): ViewNode => {
		const s = sorted(list);
		return { kind: "section", key, section, label, ...(status ? { status } : {}), sessions: s, children: sessionNodes(s, key) };
	};

	const nodes: ViewNode[] = [];
	if (pinned.length) nodes.push(section("pinned", "pinned", "Pinned", pinned));

	if (groupBy === "project") {
		const byRoot = new Map<string, { isRepo: boolean; sessions: SessionMeta[] }>();
		for (const m of rest) {
			const p = input.project(m);
			const entry = byRoot.get(p.root) ?? { isRepo: p.isRepo, sessions: [] };
			entry.sessions.push(m);
			byRoot.set(p.root, entry);
		}
		const projects = [...byRoot].map(([root, v]) => {
			const key = `project:${root}`;
			const s = sorted(v.sessions);
			return { kind: "project" as const, key, root, isRepo: v.isRepo, inWorkspace: s.some(m => input.inWorkspace(m)), sessions: s, children: sessionNodes(s, key, root) };
		});
		const recent = (p: (typeof projects)[number]) => Math.max(...p.sessions.map(m => m.updatedAt));
		projects.sort((a, b) => Number(b.inWorkspace) - Number(a.inWorkspace) || recent(b) - recent(a));
		nodes.push(...projects);
	} else if (groupBy === "group") {
		const known = new Set(data.groups.map(g => g.id));
		const byGroup = new Map<string | undefined, SessionMeta[]>();
		for (const m of rest) {
			const gid = data.sessions[m.id]?.groupId;
			const key = gid && known.has(gid) ? gid : undefined;
			byGroup.set(key, [...(byGroup.get(key) ?? []), m]);
		}
		const build = (g: OrgGroup, seen: Set<string>): ViewNode | undefined => {
			if (seen.has(g.id)) return undefined;
			seen.add(g.id);
			const key = `group:${g.id}`;
			const subs = childGroups(data, g.id)
				.map(c => build(c, seen))
				.filter((n): n is ViewNode => !!n);
			const own = sorted(byGroup.get(g.id) ?? []);
			const all = [...own, ...subs.flatMap(n => (n.kind === "session" ? [] : n.sessions))];
			// While filtering, groups without matches disappear; otherwise empty groups stay as drop targets.
			if (query && all.length === 0) return undefined;
			return { kind: "orgGroup", key, group: g, sessions: all, children: [...subs, ...sessionNodes(own, key)] };
		};
		const seen = new Set<string>();
		const tops = childGroups(data, undefined)
			.map(g => build(g, seen))
			.filter((n): n is ViewNode => !!n);
		nodes.push(...tops);
		const loose = byGroup.get(undefined) ?? [];
		if (data.groups.length === 0) nodes.push(...sessionNodes(sorted(loose), ROOT_KEY));
		else if (loose.length) nodes.push(section("ungrouped", "ungrouped", "Ungrouped", loose));
	} else if (groupBy === "status") {
		for (const { bucket, label } of STATUS_BUCKETS) {
			const list = rest.filter(m => statusBucket(m.status) === bucket);
			if (list.length) nodes.push(section("status", `status:${bucket}`, label, list, bucket));
		}
	} else {
		const local = input.noWorkspace ? rest : rest.filter(m => input.inWorkspace(m));
		const other = input.noWorkspace ? [] : rest.filter(m => !input.inWorkspace(m));
		nodes.push(...sessionNodes(sorted(local), ROOT_KEY));
		if (other.length) nodes.push(section("other", "other", "Other folders", other));
	}

	if (archived.length) nodes.push(section("archived", "archived", "Archived", archived));
	return nodes;
}

/** Ids of the sessions directly inside the container `parent` (display order), for Move Up/Down. */
export function siblingIds(roots: readonly ViewNode[], parent: string): string[] {
	const find = (nodes: readonly ViewNode[]): readonly ViewNode[] | undefined => {
		for (const n of nodes) {
			if (n.kind === "session") continue;
			if (n.key === parent) return n.children;
			const hit = find(n.children);
			if (hit) return hit;
		}
		return undefined;
	};
	const list = parent === ROOT_KEY ? roots : (find(roots) ?? []);
	return list.flatMap(n => (n.kind === "session" ? [n.meta.id] : []));
}
