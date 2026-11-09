// Sessions board webview: columns per mode, cards, drag & drop, keyboard moves, filters, swimlanes.
import { plainExcerpt } from "../shared/excerpt";
import type { SyncState } from "../shared/protocol";
import {
	BOARD_MODES,
	type BoardCard,
	type BoardColumn,
	type BoardData,
	type BoardMode,
	type BoardSection,
	type CardUpdate,
	type DropTarget,
	type FromBoard,
	type OrgColor,
	PRIORITIES,
	PRIORITY_LABEL,
	SYNC_LABEL,
	type Priority,
	type SchedulerInfo,
	type StatusKey,
	type ToBoard,
	adjacentTarget,
	buildColumns,
	canRerunWithParent,
	cyclePriority,
	filterCards,
	findCard,
	planDrop,
	projectsOf,
	statusKey,
	stepTarget,
} from "./board";
import { GRAPH_METRICS, dependencyGraph, layoutGraph, waitsForLabel } from "./graph";

interface VsCodeApi {
	postMessage(msg: FromBoard): void;
	setState(state: unknown): void;
	getState(): unknown;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
const post = (msg: FromBoard): void => vscode.postMessage(msg);

// ---------- view state (persisted by the webview, restored after reloads) ----------

interface ViewState {
	mode: BoardMode;
	filter: string;
	showArchived: boolean;
	showStopped: boolean;
	swimlanes: boolean;
	/** Dependency graph instead of the columns. */
	graph: boolean;
	/** Collapsed sub-group sections and swimlanes. */
	collapsed: string[];
}

function loadState(): ViewState {
	const raw = vscode.getState();
	const s: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
	return {
		mode: BOARD_MODES.find(m => m === s.mode) ?? "status",
		filter: typeof s.filter === "string" ? s.filter : "",
		showArchived: s.showArchived === true,
		showStopped: s.showStopped !== false,
		swimlanes: s.swimlanes === true,
		graph: s.graph === true,
		collapsed: Array.isArray(s.collapsed) ? s.collapsed.filter((x): x is string => typeof x === "string") : [],
	};
}
const view = loadState();
const collapsed = new Set(view.collapsed);
function saveState(): void {
	view.collapsed = [...collapsed];
	vscode.setState(view);
}

// ---------- model ----------

let data: BoardData = { cards: [], lanes: [], groups: [] };
let scheduler: SchedulerInfo | null = null;
let loaded = false;
const selected = new Set<string>();
let focusedId: string | undefined;
/** Rows (one per swimlane, or a single row) as last rendered: drop planning and keyboard moves use them. */
let rows: Array<{ key: string; title: string; columns: BoardColumn[] }> = [];
let dragging: { ids: string[]; row: string } | undefined;
let renderPending = false;
let editingLane: { id: string | null; value: string } | undefined;

const COLORS: readonly OrgColor[] = ["red", "orange", "yellow", "green", "blue", "purple", "pink", "gray"];

// ---------- DOM helpers ----------

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...children: Child[]): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
	return e;
}

const ICONS: Record<string, string> = {
	chat: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
	stop: '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/>',
	play: '<path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor"/>',
	rerun: '<path d="M13 8a5 5 0 11-1.6-3.7M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
	archive: '<path d="M2 3.5h12v3H2zM3 6.5v6h10v-6M6.5 9h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
	unarchive: '<path d="M2 3.5h12v3H2zM3 6.5v6h10v-6M8 12V8.5M6.5 10 8 8.5 9.5 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
	palette: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6.3" r="1" fill="currentColor"/><circle cx="9.8" cy="6.3" r="1" fill="currentColor"/><circle cx="6.5" cy="10" r="1" fill="currentColor"/>',
	more: '<circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/>',
	chevron: '<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
	plus: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
	minus: '<path d="M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
	pin: '<path d="M6 2.5h4l-.5 4 2 2v1h-7v-1l2-2zM8 9.5V14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
	bell: '<path d="M4 11V7a4 4 0 018 0v4l1 1H3zM6.5 13.5a1.5 1.5 0 003 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
	check: '<path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
	circle: '<circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
	clock: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
	link: '<path d="M7 9a2.5 2.5 0 003.5 0l2.5-2.5a2.5 2.5 0 00-3.5-3.5L8.8 3.7M9 7a2.5 2.5 0 00-3.5 0L3 9.5A2.5 2.5 0 006.5 13l.7-.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
	expand: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
	folder: '<path d="M1.5 4h4.5l1.5 1.5h7v7h-13z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
	"p-urgent": '<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor"/><path d="M8 4.5v4.3" stroke="var(--vscode-editor-background)" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.4" r="1.05" fill="var(--vscode-editor-background)"/>',
	"p-high": '<rect x="2" y="9" width="3" height="5" rx=".8" fill="currentColor"/><rect x="6.5" y="6" width="3" height="8" rx=".8" fill="currentColor"/><rect x="11" y="2.5" width="3" height="11.5" rx=".8" fill="currentColor"/>',
	"p-normal": '<rect x="2" y="9" width="3" height="5" rx=".8" fill="currentColor"/><rect x="6.5" y="6" width="3" height="8" rx=".8" fill="currentColor"/><rect x="11" y="2.5" width="3" height="11.5" rx=".8" fill="currentColor" opacity=".25"/>',
	"p-low": '<rect x="2" y="9" width="3" height="5" rx=".8" fill="currentColor"/><rect x="6.5" y="6" width="3" height="8" rx=".8" fill="currentColor" opacity=".25"/><rect x="11" y="2.5" width="3" height="11.5" rx=".8" fill="currentColor" opacity=".25"/>',
};
function icon(name: string, cls = ""): HTMLElement {
	const span = el("span", `ic ${cls}`.trim());
	span.setAttribute("aria-hidden", "true");
	span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16">${ICONS[name] ?? ""}</svg>`;
	return span;
}

function button(cls: string, title: string, content: Child[], run: (ev: MouseEvent) => void): HTMLButtonElement {
	const b = el("button", cls, ...content);
	b.type = "button";
	b.title = title;
	b.setAttribute("aria-label", title);
	b.addEventListener("click", ev => {
		ev.stopPropagation();
		run(ev);
	});
	return b;
}

function relTime(ts: number): string {
	const s = Math.max(0, (Date.now() - ts) / 1000);
	if (s < 60) return "now";
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

// ---------- menus ----------

interface MenuItem {
	label: string;
	icon?: HTMLElement;
	checked?: boolean;
	danger?: boolean;
	run: () => void;
}
let menuEl: HTMLElement | undefined;
function closeMenu(): void {
	menuEl?.remove();
	menuEl = undefined;
}
function showMenu(anchor: HTMLElement | SVGElement, items: MenuItem[]): void {
	closeMenu();
	const menu = el("div", "menu");
	menu.setAttribute("role", "menu");
	for (const it of items) {
		const row = button(`menu-item${it.danger ? " danger" : ""}`, it.label, [it.icon ?? el("span", "ic"), el("span", "menu-label", it.label), it.checked ? icon("check", "menu-check") : null], () => {
			closeMenu();
			it.run();
		});
		row.setAttribute("role", "menuitem");
		menu.append(row);
	}
	document.body.append(menu);
	const r = anchor.getBoundingClientRect();
	const w = menu.offsetWidth;
	const hgt = menu.offsetHeight;
	menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
	menu.style.top = `${r.bottom + 4 + hgt > window.innerHeight ? Math.max(4, r.top - hgt - 4) : r.bottom + 4}px`;
	menuEl = menu;
	menu.querySelector<HTMLElement>(".menu-item")?.focus();
	menu.addEventListener("keydown", ev => {
		const items = [...menu.querySelectorAll<HTMLElement>(".menu-item")];
		const i = items.indexOf(document.activeElement as HTMLElement);
		if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
			ev.preventDefault();
			items[(i + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
		} else if (ev.key === "Escape") {
			ev.preventDefault();
			closeMenu();
			anchor.focus();
		}
	});
}
document.addEventListener("mousedown", ev => {
	if (menuEl && !(ev.target instanceof Node && menuEl.contains(ev.target))) closeMenu();
});
window.addEventListener("blur", closeMenu);

const priorityIcon = (p: Priority) => icon(`p-${p}`, `prio prio-${p}`);
const swatch = (c: OrgColor | null) => el("span", `swatch ${c ? `c-${c}` : "none"}`);

function priorityMenu(anchor: HTMLElement | SVGElement, ids: string[]): void {
	const current = ids.length === 1 ? data.cards.find(c => c.id === ids[0])?.priority : undefined;
	showMenu(
		anchor,
		PRIORITIES.map(p => ({ label: PRIORITY_LABEL[p], icon: priorityIcon(p), checked: p === current, run: () => setPriority(ids, p) })),
	);
}
function colorMenu(anchor: HTMLElement | SVGElement, ids: string[]): void {
	const current = ids.length === 1 ? (data.cards.find(c => c.id === ids[0])?.color ?? null) : undefined;
	showMenu(anchor, [
		...COLORS.map(c => ({ label: c[0].toUpperCase() + c.slice(1), icon: swatch(c), checked: c === current, run: () => setColor(ids, c) })),
		{ label: "No color", icon: swatch(null), checked: current === null, run: () => setColor(ids, null) },
	]);
}
/** Per-session menu: right-click or the context-menu key on a card or graph node. */
function cardMenu(anchor: HTMLElement | SVGElement, id: string): void {
	const card = data.cards.find(c => c.id === id);
	showMenu(anchor, [
		{ label: "Open chat", run: () => post({ type: "open", id }) },
		{ label: "Dependencies…", icon: icon("link"), run: () => post({ type: "setDeps", id }) },
		{ label: "Priority…", run: () => priorityMenu(anchor, targets(id)) },
		{ label: "Color…", run: () => colorMenu(anchor, targets(id)) },
		...(card && canRerunWithParent(card) ? [{ label: "Re-run with parent changes", run: () => post({ type: "rerunWithParent", ids: targets(id) }) }] : []),
		card?.archived ? { label: "Unarchive", run: () => setArchived(targets(id), false) } : { label: "Archive", run: () => setArchived(targets(id), true) },
		card?.status === "stopped" ? { label: "Resume", run: () => post({ type: "resume", ids: targets(id) }) } : { label: "Stop", run: () => post({ type: "stop", ids: targets(id) }) },
	]);
}

// ---------- actions (optimistic: patch locally, the extension pushes the authoritative data) ----------

function patchLocal(id: string, fn: (c: BoardCard) => void): void {
	const c = data.cards.find(x => x.id === id);
	if (c) fn(c);
}
function applyUpdates(updates: CardUpdate[]): void {
	if (updates.length === 0) return;
	for (const u of updates)
		patchLocal(u.id, c => {
			if (u.patch.lane !== undefined) c.lane = u.patch.lane;
			if (u.patch.group !== undefined) c.group = u.patch.group ?? undefined;
			if (u.patch.priority !== undefined) c.priority = u.patch.priority;
			if (u.patch.rank !== undefined) c.rank = u.patch.rank;
		});
	post({ type: "apply", updates });
	render();
}
function setPriority(ids: string[], priority: Priority): void {
	for (const id of ids)
		patchLocal(id, c => {
			c.priority = priority;
		});
	post({ type: "setPriority", ids, priority });
	render();
}
function setColor(ids: string[], color: OrgColor | null): void {
	for (const id of ids)
		patchLocal(id, c => {
			c.color = color ?? undefined;
		});
	post({ type: "setColor", ids, color });
	render();
}
function setArchived(ids: string[], archived: boolean): void {
	for (const id of ids)
		patchLocal(id, c => {
			c.archived = archived;
		});
	if (!view.showArchived && archived) for (const id of ids) selected.delete(id);
	post({ type: "setArchived", ids, archived });
	render();
}
/** The cards an action on `id` applies to: the selection when `id` is part of it. */
function targets(id: string): string[] {
	return selected.has(id) ? orderedSelection() : [id];
}
/** Selected ids in board order. */
function orderedSelection(): string[] {
	const order: string[] = [];
	for (const row of rows) for (const col of row.columns) for (const s of col.sections) for (const c of s.cards) if (selected.has(c.id)) order.push(c.id);
	return order;
}
function rowOf(id: string): { key: string; columns: BoardColumn[] } | undefined {
	return rows.find(r => findCard(r.columns, id));
}
function moveCards(ids: string[], target: DropTarget | undefined, columns: BoardColumn[]): void {
	if (!target) return;
	const updates = planDrop(view.mode, columns, ids, target);
	if (updates) applyUpdates(updates);
}

// ---------- header ----------

const app = el("div", "app");
const header = el("header", "bar");
const boardEl = el("main", "board");
boardEl.setAttribute("aria-label", "Sessions board");
app.append(header, boardEl);
document.body.append(app);

const filterInput = el("input", "filter");
filterInput.type = "search";
filterInput.placeholder = "Filter  ·  text, #tag, project:name";
filterInput.value = view.filter;
filterInput.setAttribute("aria-label", "Filter sessions");
let filterTimer: number | undefined;
filterInput.addEventListener("input", () => {
	clearTimeout(filterTimer);
	filterTimer = window.setTimeout(() => {
		view.filter = filterInput.value;
		saveState();
		render();
	}, 80);
});
filterInput.addEventListener("keydown", ev => {
	if (ev.key === "Escape" && filterInput.value) {
		ev.stopPropagation();
		filterInput.value = "";
		view.filter = "";
		saveState();
		render();
	} else if (ev.key === "ArrowDown" || ev.key === "Enter") {
		ev.preventDefault();
		focusCard(rows[0]?.columns.flatMap(c => c.sections.flatMap(s => s.cards))[0]?.id);
	}
});

function toggle(label: string, title: string, get: () => boolean, set: (v: boolean) => void): HTMLButtonElement {
	const b = button("toggle", title, [label], () => {
		set(!get());
		saveState();
		render();
	});
	b.setAttribute("aria-pressed", String(get()));
	return b;
}

function renderHeader(cardCount: number): void {
	const modes = el("div", "segmented");
	modes.setAttribute("role", "tablist");
	for (const m of BOARD_MODES) {
		const label = m === "status" ? "Status" : m === "lane" ? "Lanes" : m === "group" ? "Groups" : "Priority";
		const b = button(`seg${view.mode === m && !view.graph ? " active" : ""}`, `Columns by ${label.toLowerCase()}`, [label], () => {
			view.mode = m;
			view.graph = false;
			saveState();
			render();
		});
		b.setAttribute("role", "tab");
		b.setAttribute("aria-selected", String(view.mode === m && !view.graph));
		modes.append(b);
	}
	const toggles = el(
		"div",
		"toggles",
		toggle("Stopped", "Show stopped sessions", () => view.showStopped, v => (view.showStopped = v)),
		toggle("Archived", "Show archived sessions", () => view.showArchived, v => (view.showArchived = v)),
		toggle("Swimlanes", "One row per project", () => view.swimlanes, v => (view.swimlanes = v)),
		toggle("Graph", "Show session dependencies as a graph", () => view.graph, v => (view.graph = v)),
	);
	const right = el("div", "right");
	if (scheduler) {
		const s = scheduler;
		const limit = s.max === 0 ? "∞" : String(s.max);
		const minus = button("icon-btn small", "Fewer concurrent tasks", [icon("minus")], () => post({ type: "concurrency", max: s.max === 0 ? Math.max(1, s.running) : s.max - 1 }));
		minus.disabled = s.max === 1;
		const plus = button("icon-btn small", "More concurrent tasks", [icon("plus")], () => post({ type: "concurrency", max: s.max + 1 }));
		plus.disabled = s.max === 0;
		const value = button("slots-value", "Concurrent queued tasks across all sessions — click to set (0 = unlimited)", [`Running ${s.running} / ${limit}`], () => post({ type: "concurrency" }));
		right.append(el("div", `slots${s.max !== 0 && s.running >= s.max ? " full" : ""}`, value, minus, plus, s.waiting ? el("span", "slots-waiting", `${s.waiting} waiting`) : null, s.paused ? el("span", "slots-paused", "paused") : null));
	}
	right.append(
		el("span", "count", `${cardCount} session${cardCount === 1 ? "" : "s"}`),
		button("icon-btn", "Toggle full width (maximize editor group)", [icon("expand")], () => post({ type: "maximize" })),
		button("primary", "New session", [icon("plus"), "New"], () => post({ type: "newSession" })),
	);
	const children: Node[] = [modes, filterInput, toggles, right];
	if (selected.size) {
		const ids = () => orderedSelection();
		const bulk = el(
			"div",
			"bulk",
			el("span", "bulk-count", `${selected.size} selected`),
			button("ghost", "Set priority", ["Priority"], ev => priorityMenu(ev.currentTarget instanceof HTMLElement ? ev.currentTarget : boardEl, ids())),
			button("ghost", "Set color", ["Color"], ev => colorMenu(ev.currentTarget instanceof HTMLElement ? ev.currentTarget : boardEl, ids())),
			button("ghost", "Archive", ["Archive"], () => setArchived(ids(), true)),
			button("ghost", "Unarchive", ["Unarchive"], () => setArchived(ids(), false)),
			button("ghost", "Stop", ["Stop"], () => post({ type: "stop", ids: ids() })),
			button("ghost", "Resume", ["Resume"], () => post({ type: "resume", ids: ids() })),
			button("ghost", "Clear selection (Esc)", ["Clear"], () => {
				selected.clear();
				render();
			}),
		);
		children.push(bulk);
	}
	const keepFilterFocus = document.activeElement === filterInput;
	header.replaceChildren(...children);
	if (keepFilterFocus) filterInput.focus();
}

// ---------- board ----------

function statusPill(c: BoardCard): HTMLElement {
	const key = statusKey(c);
	if (key === "working") return el("span", "pill working", el("span", "spinner"), c.status === "starting" ? "Starting" : "Working");
	if (key === "waiting") return el("span", "pill waiting", icon("bell"), "Needs input");
	if (key === "queued") return el("span", "pill queued", icon("clock"), c.waiting ? `Queued #${c.waiting.position}` : c.blockedBy?.length ? "Blocked" : "Queued");
	if (key === "stopped") return el("span", "pill stopped", icon("circle"), "Stopped");
	return el("span", "pill idle", icon("check"), "Idle");
}

function renderCard(c: BoardCard, row: string): HTMLElement {
	const card = el("div", `card${c.color ? ` c-${c.color}` : ""}${selected.has(c.id) ? " selected" : ""}${c.archived ? " archived" : ""}${c.status === "stopped" ? " stopped" : ""}`);
	card.dataset.id = c.id;
	card.dataset.row = row;
	card.tabIndex = c.id === focusedId ? 0 : -1;
	card.draggable = true;
	card.setAttribute("role", "listitem");
	card.setAttribute("aria-label", `${c.title}, ${PRIORITY_LABEL[c.priority]} priority, ${statusKey(c)}`);
	card.setAttribute("aria-selected", String(selected.has(c.id)));

	const prio = button(`prio-btn prio-${c.priority}`, `Priority: ${PRIORITY_LABEL[c.priority]} (P to cycle)`, [priorityIcon(c.priority)], ev => priorityMenu(ev.currentTarget instanceof HTMLElement ? ev.currentTarget : card, targets(c.id)));
	const title = el("span", "title", c.title);
	const top = el("div", "card-top", prio, title, c.pinned ? icon("pin", "pinned") : null, c.unread ? el("span", "unread-dot") : null);
	if (c.unread) title.title = "New activity";

	const meta = el("div", "card-meta", statusPill(c), el("span", "project", icon("folder"), c.project));
	meta.title = c.cwd;
	if (c.sync && c.sync.state !== "in-sync") {
		const sync = el("span", `pill sync sync-${c.sync.state}`, icon(c.sync.state === "conflict" ? "bell" : "clock"), SYNC_LABEL[c.sync.state]);
		sync.title = `${SYNC_LABEL[c.sync.state]}${c.sync.parents.length ? ` (from ${c.sync.parents.join(", ")})` : ""}`;
		meta.append(sync);
	}

	const parts: Node[] = [top, meta];
	const waits = waitsForLabel(c, data.cards);
	if (waits) {
		const badge = el("div", "deps-badge", icon("link"), el("span", "deps-text", waits.text));
		badge.title = waits.tooltip;
		parts.push(badge);
	}
	if (c.lastText) parts.push(el("div", "excerpt", plainExcerpt(c.lastText)));

	const foot = el("div", "card-foot");
	if (c.queue && c.queue.total > 0) {
		const pct = Math.round((c.queue.done / c.queue.total) * 100);
		const bar = el("span", "progress", el("span", "progress-fill"));
		bar.firstElementChild?.setAttribute("style", `width:${pct}%`);
		const q = el("span", "queue", bar, `${c.queue.done}/${c.queue.total}`);
		q.title = `Task queue: ${c.queue.done} done, ${c.queue.running} running, ${c.queue.pending} pending`;
		foot.append(q);
	}
	for (const t of c.tags.slice(0, 4)) foot.append(el("span", "tag", `#${t}`));
	const spacer = el("span", "spacer");
	foot.append(spacer);
	if (c.cost) foot.append(el("span", "cost", `$${c.cost.toFixed(2)}`));
	const when = el("span", "when", relTime(c.updatedAt));
	when.title = new Date(c.updatedAt).toLocaleString();
	foot.append(when);
	parts.push(foot);

	const stopped = c.status === "stopped";
	const actions = el(
		"div",
		"actions",
		button("icon-btn", "Open chat (Enter)", [icon("chat")], () => post({ type: "open", id: c.id })),
		canRerunWithParent(c) ? button("icon-btn", "Re-run with parent changes", [icon("rerun")], () => post({ type: "rerunWithParent", ids: targets(c.id) })) : null,
		stopped ? button("icon-btn", "Resume", [icon("play")], () => post({ type: "resume", ids: targets(c.id) })) : button("icon-btn", "Stop", [icon("stop")], () => post({ type: "stop", ids: targets(c.id) })),
		button("icon-btn", "Color…", [icon("palette")], ev => colorMenu(ev.currentTarget instanceof HTMLElement ? ev.currentTarget : card, targets(c.id))),
		c.archived ? button("icon-btn", "Unarchive", [icon("unarchive")], () => setArchived(targets(c.id), false)) : button("icon-btn", "Archive", [icon("archive")], () => setArchived(targets(c.id), true)),
	);
	card.append(el("div", "card-body", ...parts), actions);
	return card;
}

function renderSection(col: BoardColumn, sec: BoardSection, row: string, hidden: boolean): HTMLElement[] {
	const out: HTMLElement[] = [];
	const isCollapsed = collapsed.has(sec.id);
	if (sec.depth > 0) {
		const head = el("div", `section-head${sec.color ? ` c-${sec.color}` : ""}`);
		head.style.setProperty("--depth", String(sec.depth));
		const chev = icon("chevron", `chev${isCollapsed ? "" : " open"}`);
		const toggleBtn = button("section-toggle", isCollapsed ? "Expand" : "Collapse", [chev, sec.color ? el("span", `dot c-${sec.color}`) : null, el("span", "section-title", sec.title ?? ""), el("span", "badge", String(sec.cards.length))], () => {
			if (collapsed.has(sec.id)) collapsed.delete(sec.id);
			else collapsed.add(sec.id);
			saveState();
			render();
		});
		toggleBtn.setAttribute("aria-expanded", String(!isCollapsed));
		head.append(toggleBtn);
		if (hidden) head.hidden = true;
		out.push(head);
	}
	const zone = el("div", `zone${sec.depth > 0 ? " sub" : ""}`);
	zone.style.setProperty("--depth", String(sec.depth));
	zone.dataset.column = col.id;
	zone.dataset.section = sec.id;
	zone.dataset.row = row;
	zone.setAttribute("role", "list");
	for (const c of sec.cards) zone.append(renderCard(c, row));
	if (sec.cards.length === 0 && sec.depth === 0 && !col.sections.some(s => s.cards.length)) zone.append(el("div", "empty", col.droppable ? "Drop sessions here" : "No sessions"));
	if (hidden || (sec.depth > 0 && isCollapsed)) zone.hidden = true;
	out.push(zone);
	return out;
}

function laneHeaderControls(col: BoardColumn, index: number, total: number): HTMLElement | null {
	const id = col.value;
	if (view.mode !== "lane" || id === undefined) return null;
	return button("icon-btn col-menu", "Lane actions", [icon("more")], ev =>
		showMenu(ev.currentTarget instanceof HTMLElement ? ev.currentTarget : boardEl, [
			{ label: "Rename…", run: () => startLaneEdit(id, col.title) },
			...(index > 0 ? [{ label: "Move left", run: () => post({ type: "moveLane", id, delta: -1 }) }] : []),
			...(index < total - 1 ? [{ label: "Move right", run: () => post({ type: "moveLane", id, delta: 1 }) }] : []),
			{ label: "Delete lane…", danger: true, run: () => post({ type: "deleteLane", id }) },
		]),
	);
}

function startLaneEdit(id: string | null, value: string): void {
	editingLane = { id, value };
	render();
}

function laneInput(): HTMLInputElement {
	const input = el("input", "lane-input");
	input.value = editingLane?.value ?? "";
	input.placeholder = "Lane name";
	input.addEventListener("input", () => {
		if (editingLane) editingLane.value = input.value;
	});
	const commit = () => {
		const edit = editingLane;
		editingLane = undefined;
		const name = input.value.trim();
		if (edit && name) post(edit.id === null ? { type: "addLane", name } : { type: "renameLane", id: edit.id, name });
		render();
	};
	input.addEventListener("keydown", ev => {
		ev.stopPropagation();
		if (ev.key === "Enter") commit();
		else if (ev.key === "Escape") {
			editingLane = undefined;
			render();
		}
	});
	input.addEventListener("blur", () => {
		if (editingLane) commit();
	});
	return input;
}

function columnHeader(col: BoardColumn, index: number, total: number, count: number): HTMLElement {
	const editing = editingLane && editingLane.id === col.value && view.mode === "lane";
	const title = editing ? laneInput() : el("span", "col-title", col.title);
	if (!editing && view.mode === "lane" && col.value !== undefined) {
		const id = col.value;
		title.title = "Double-click to rename";
		title.addEventListener("dblclick", () => startLaneEdit(id, col.title));
	}
	const head = el("div", `col-head${col.color ? ` c-${col.color}` : ""}${col.queued ? " queued" : ""}`, col.color ? el("span", `dot c-${col.color}`) : statusDot(col), title, el("span", "badge", String(count)), laneHeaderControls(col, index, total));
	if (col.queued) head.title = "Sessions waiting for a global concurrency slot, in start order. Reorder to change who starts next.";
	else if (!col.droppable && view.mode === "status") head.title = "Status columns follow the sessions; reorder within a column only.";
	return head;
}

function statusDot(col: BoardColumn): HTMLElement | null {
	if (view.mode === "status") return el("span", `dot s-${col.value ?? ""}`);
	if (view.mode === "priority" && col.value) {
		const p = PRIORITIES.find(x => x === col.value);
		return p ? priorityIcon(p) : null;
	}
	return null;
}

// ---------- dependency graph ----------

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: Array<Node | string>): SVGElementTagNameMap[K] {
	const e = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	e.append(...children);
	return e;
}

const GRAPH_STATE: Record<StatusKey, string> = { working: "working", waiting: "needs input", queued: "queued", idle: "idle", stopped: "stopped" };

const EDGE_KINDS = ["pending", "changed", "conflict", "merged"] as const;
type EdgeKind = (typeof EDGE_KINDS)[number];

/** How an arrow reads: the parent's changes in the child (propagation), else whether the child still waits for it. */
function edgeKind(state: SyncState | undefined, blocked: boolean): EdgeKind | undefined {
	if (state === "conflict" || state === "resolving") return "conflict";
	if (state === "upstream-changed") return "changed";
	if (state === "pending") return "pending";
	if (state === "merged") return "merged";
	return blocked ? "pending" : undefined;
}

/** Sessions with dependencies as a left-to-right DAG: arrows run from a dependency to the session waiting for it. */
function renderGraph(visible: BoardCard[]): HTMLElement {
	if (!loaded) return el("div", "graph", el("div", "notice", "Loading sessions…"));
	const { nodes, edges } = dependencyGraph(visible);
	if (!nodes.length) {
		const hint = data.cards.some(c => c.after?.length) ? "No sessions with dependencies match the filter." : "No dependencies yet — right-click a card → Dependencies…";
		return el("div", "graph", el("div", "notice", hint));
	}
	const { nodeWidth: w, nodeHeight: h } = GRAPH_METRICS;
	const pad = 16;
	const layout = layoutGraph(
		nodes.map(n => n.id),
		edges,
	);
	const width = layout.width + 2 * pad;
	const height = layout.height + 2 * pad;
	const root = svgEl("svg", { class: "graph-svg", width, height, viewBox: `${-pad} ${-pad} ${width} ${height}`, role: "group", "aria-label": "Session dependencies" });
	const defs = svgEl("defs", {});
	for (const id of ["graph-arrow", ...EDGE_KINDS.map(k => `graph-arrow-${k}`)]) defs.append(svgEl("marker", { id, class: id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" }, svgEl("path", { d: "M0 0L10 5L0 10z" })));
	root.append(defs);

	const byId = new Map(nodes.map(n => [n.id, n]));
	const edgeLayer = svgEl("g", { class: "graph-edges" });
	for (const r of layout.routes) {
		// Horizontal tangents at every point: smooth S-curves between layers, straight runs through virtual slots.
		const d = r.points
			.map((q, i) => {
				if (i === 0) return `M${q.x} ${q.y}`;
				const p = r.points[i - 1];
				const dx = Math.max(30, Math.abs(q.x - p.x) / 2);
				return `C${p.x + dx} ${p.y} ${q.x - dx} ${q.y} ${q.x} ${q.y}`;
			})
			.join("");
		const to = byId.get(r.to);
		const kind = edgeKind(to?.sync?.edges?.[r.from], to?.blockedBy?.includes(r.from) === true);
		const path = svgEl("path", { class: `gedge${kind ? ` ${kind}` : ""}`, d, "marker-end": `url(#${kind ? `graph-arrow-${kind}` : "graph-arrow"})` });
		path.dataset.from = r.from;
		path.dataset.to = r.to;
		edgeLayer.append(path);
	}

	const nodeLayer = svgEl("g", { class: "graph-nodes" });
	const maxChars = Math.floor((w - 22) / 7);
	for (const c of nodes) {
		const p = layout.positions.get(c.id);
		if (!p) continue;
		const key = statusKey(c);
		const blocked = (c.blockedBy?.length ?? 0) > 0;
		const waits = waitsForLabel(c, data.cards);
		const title = c.title.length > maxChars ? `${c.title.slice(0, maxChars - 1)}…` : c.title;
		const state = `${GRAPH_STATE[key]}${blocked ? ` · blocked by ${c.blockedBy?.length}` : ""}`;
		const g = svgEl(
			"g",
			{ class: `gnode s-${key}${blocked ? " blocked" : ""}`, transform: `translate(${p.x} ${p.y})`, tabindex: 0, role: "button", "aria-label": `${c.title}, ${state}` },
			svgEl("title", {}, [c.title, `${c.project} · ${state}`, waits?.tooltip].filter(Boolean).join("\n")),
			svgEl("rect", { class: "gnode-box", width: w, height: h, rx: 6 }),
			svgEl("rect", { class: "gnode-stripe", width: 4, height: h - 12, x: 4, y: 6, rx: 2 }),
			svgEl("text", { class: "gnode-title", x: 14, y: 20 }, title),
			svgEl("text", { class: "gnode-state", x: 14, y: 37 }, state),
		);
		g.dataset.node = c.id;
		nodeLayer.append(g);
	}
	root.append(edgeLayer, nodeLayer);
	return el("div", "graph", root);
}

function render(): void {
	if (dragging) {
		renderPending = true;
		return;
	}
	renderPending = false;
	const visible = filterCards(data.cards, { text: view.filter, showArchived: view.showArchived, showStopped: view.showStopped });
	for (const id of [...selected]) if (!visible.some(c => c.id === id)) selected.delete(id);
	if (view.graph) {
		rows = [];
		renderHeader(visible.length);
		const focusedNode = document.activeElement instanceof SVGElement ? document.activeElement.dataset.node : undefined;
		const { scrollTop, scrollLeft } = boardEl;
		boardEl.replaceChildren(renderGraph(visible));
		boardEl.scrollTop = scrollTop;
		boardEl.scrollLeft = scrollLeft;
		if (focusedNode) boardEl.querySelector<SVGElement>(`.gnode[data-node="${CSS.escape(focusedNode)}"]`)?.focus({ preventScroll: true });
		return;
	}
	const lanesData = { lanes: data.lanes, groups: data.groups };
	const all = buildColumns(view.mode, lanesData, visible);
	// Stopped column is noise while stopped sessions are hidden.
	const keep = (c: BoardColumn) => !(view.mode === "status" && c.value === "stopped" && !view.showStopped);
	rows = view.swimlanes
		? projectsOf(visible).map(p => ({ key: `swim:${p}`, title: p, columns: buildColumns(view.mode, lanesData, visible.filter(c => c.project === p)).filter(keep) }))
		: [{ key: "", title: "", columns: all.filter(keep) }];
	const columns = all.filter(keep);
	renderHeader(visible.length);

	const hadFocus = document.activeElement instanceof HTMLElement && (document.activeElement.classList.contains("card") || document.activeElement === document.body);
	if (focusedId && !visible.some(c => c.id === focusedId)) focusedId = undefined;
	focusedId ??= rows[0]?.columns.flatMap(c => c.sections.flatMap(s => s.cards))[0]?.id;

	const grid = el("div", `grid${view.swimlanes ? " swim" : ""}`);
	const addCol = view.mode === "lane";
	grid.style.setProperty("--cols", String(columns.length));
	grid.style.gridTemplateColumns = `repeat(${columns.length}, minmax(260px, 340px))${addCol ? " 220px" : ""}`;
	columns.forEach((col, i) => {
		const count = view.swimlanes ? rows.reduce((n, r) => n + (r.columns[i]?.count ?? 0), 0) : col.count;
		grid.append(columnHeader(col, i, columns.length, count));
	});
	if (addCol) {
		const add = editingLane?.id === null ? el("div", "col-head add-lane", laneInput()) : el("div", "col-head add-lane", button("ghost add-lane-btn", "Add lane", [icon("plus"), "Add lane"], () => startLaneEdit(null, "")));
		grid.append(add);
	}
	if (!loaded) grid.append(el("div", "notice", "Loading sessions…"));
	else if (data.cards.length === 0) grid.append(el("div", "notice", "No sessions yet. Start one with New."));
	else if (visible.length === 0) grid.append(el("div", "notice", "No sessions match the filter."));
	for (const row of rows) {
		const rowCollapsed = view.swimlanes && collapsed.has(row.key);
		if (view.swimlanes) {
			const n = row.columns.reduce((s, c) => s + c.count, 0);
			const t = button("swim-head", rowCollapsed ? "Expand" : "Collapse", [icon("chevron", `chev${rowCollapsed ? "" : " open"}`), icon("folder"), el("span", "swim-title", row.title), el("span", "badge", String(n))], () => {
				if (collapsed.has(row.key)) collapsed.delete(row.key);
				else collapsed.add(row.key);
				saveState();
				render();
			});
			t.setAttribute("aria-expanded", String(!rowCollapsed));
			grid.append(t);
		}
		if (rowCollapsed) continue;
		for (const col of row.columns) {
			const cell = el("div", `col${col.droppable ? "" : " locked"}${col.queued ? " queued" : ""}`);
			cell.dataset.column = col.id;
			const hiddenBy = new Set<string>();
			for (const sec of col.sections) {
				const hidden = sec.ancestors.some(a => collapsed.has(a));
				cell.append(...renderSection(col, sec, row.key, hidden));
				if (hidden) hiddenBy.add(sec.id);
			}
			grid.append(cell);
		}
		if (addCol) grid.append(el("div", "col ghost-col"));
	}
	const { scrollTop, scrollLeft } = boardEl;
	boardEl.replaceChildren(grid);
	boardEl.scrollTop = scrollTop;
	boardEl.scrollLeft = scrollLeft;
	const laneEdit = boardEl.querySelector<HTMLInputElement>(".lane-input");
	if (laneEdit) {
		laneEdit.focus();
		laneEdit.setSelectionRange(laneEdit.value.length, laneEdit.value.length);
	} else if (hadFocus && focusedId) cardEl(focusedId)?.focus({ preventScroll: true });
}

function cardEl(id: string): HTMLElement | null {
	return boardEl.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(id)}"]`);
}

function focusCard(id: string | undefined): void {
	if (!id) return;
	const prev = focusedId ? cardEl(focusedId) : null;
	if (prev) prev.tabIndex = -1;
	focusedId = id;
	const e = cardEl(id);
	if (!e) return;
	e.tabIndex = 0;
	e.focus();
	e.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---------- pointer: click / multi-select ----------

let anchorId: string | undefined;
boardEl.addEventListener("click", ev => {
	const target = ev.target instanceof Element ? ev.target : null;
	const node = target?.closest<SVGElement>(".gnode")?.dataset.node;
	if (node) {
		post({ type: "open", id: node });
		return;
	}
	const card = target?.closest<HTMLElement>(".card");
	if (!card?.dataset.id) {
		if (target === boardEl || target?.classList.contains("grid")) {
			selected.clear();
			render();
		}
		return;
	}
	const id = card.dataset.id;
	if (ev.shiftKey && anchorId) {
		const row = rowOf(id);
		const anchorAt = row && findCard(row.columns, anchorId);
		const at = row && findCard(row.columns, id);
		if (anchorAt && at && anchorAt.column === at.column) {
			const flat = at.column.sections.flatMap(s => s.cards.map(c => c.id));
			const [a, b] = [flat.indexOf(anchorId), flat.indexOf(id)].sort((x, y) => x - y);
			for (const x of flat.slice(a, b + 1)) selected.add(x);
		} else selected.add(id);
		focusedId = id;
		render();
		return;
	}
	if (ev.metaKey || ev.ctrlKey) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
		anchorId = id;
		focusedId = id;
		render();
		return;
	}
	anchorId = id;
	focusedId = id;
	post({ type: "open", id });
});

boardEl.addEventListener("contextmenu", ev => {
	const item = ev.target instanceof Element ? ev.target.closest<HTMLElement | SVGElement>(".card, .gnode") : null;
	const id = item?.dataset.id ?? item?.dataset.node;
	if (!item || !id) return;
	ev.preventDefault();
	cardMenu(item, id);
});

// ---------- drag & drop ----------

const MIME = "application/x-omp-board";
let indicator: HTMLElement | undefined;
let lastDrop: { zone: HTMLElement; target: DropTarget; columns: BoardColumn[] } | undefined;

function clearIndicator(): void {
	indicator?.remove();
	indicator = undefined;
	for (const z of boardEl.querySelectorAll(".zone.over, .col.over, .col.reject")) z.classList.remove("over", "reject");
	lastDrop = undefined;
}

boardEl.addEventListener("dragstart", ev => {
	const card = ev.target instanceof Element ? ev.target.closest<HTMLElement>(".card") : null;
	const id = card?.dataset.id;
	if (!card || !id || !ev.dataTransfer) return;
	closeMenu();
	const ids = selected.has(id) ? orderedSelection() : [id];
	dragging = { ids, row: card.dataset.row ?? "" };
	ev.dataTransfer.effectAllowed = "move";
	ev.dataTransfer.setData(MIME, JSON.stringify(ids));
	ev.dataTransfer.setData("text/plain", ids.map(x => data.cards.find(c => c.id === x)?.title ?? x).join("\n"));
	if (ids.length > 1) {
		const ghost = el("div", "drag-ghost", `${ids.length} sessions`);
		document.body.append(ghost);
		ev.dataTransfer.setDragImage(ghost, 12, 12);
		setTimeout(() => ghost.remove(), 0);
	}
	requestAnimationFrame(() => {
		for (const x of ids) cardEl(x)?.classList.add("dragging");
	});
});

boardEl.addEventListener("dragover", ev => {
	if (!dragging) return;
	const t = ev.target instanceof Element ? ev.target : null;
	const zone = t?.closest<HTMLElement>(".zone") ?? (t?.closest<HTMLElement>(".col")?.querySelector<HTMLElement>(".zone:not([hidden])") ?? null);
	const row = rows.find(r => r.key === zone?.dataset.row);
	if (!zone || !row || zone.dataset.row !== dragging.row) {
		clearIndicator();
		return;
	}
	let beforeEl: HTMLElement | undefined;
	for (const c of zone.querySelectorAll<HTMLElement>(":scope > .card")) {
		if (c.classList.contains("dragging")) continue;
		const r = c.getBoundingClientRect();
		if (ev.clientY < r.top + r.height / 2) {
			beforeEl = c;
			break;
		}
	}
	const target: DropTarget = { columnId: zone.dataset.column ?? "", sectionId: zone.dataset.section ?? "", beforeId: beforeEl?.dataset.id };
	const ok = !!planDrop(view.mode, row.columns, dragging.ids, target);
	const colEl = zone.closest<HTMLElement>(".col");
	if (!ok) {
		clearIndicator();
		colEl?.classList.add("reject");
		if (ev.dataTransfer) ev.dataTransfer.dropEffect = "none";
		return;
	}
	ev.preventDefault();
	if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
	if (lastDrop && lastDrop.zone === zone && lastDrop.target.beforeId === target.beforeId) return;
	clearIndicator();
	zone.classList.add("over");
	colEl?.classList.add("over");
	indicator = el("div", "drop-line");
	zone.insertBefore(indicator, beforeEl ?? null);
	lastDrop = { zone, target, columns: row.columns };
});

boardEl.addEventListener("drop", ev => {
	ev.preventDefault();
	const drop = lastDrop;
	const ids = dragging?.ids;
	clearIndicator();
	dragging = undefined;
	if (drop && ids) {
		const updates = planDrop(view.mode, drop.columns, ids, drop.target);
		if (updates) {
			applyUpdates(updates);
			return;
		}
	}
	render();
});

boardEl.addEventListener("dragleave", ev => {
	if (ev.relatedTarget instanceof Node && boardEl.contains(ev.relatedTarget)) return;
	clearIndicator();
});

document.addEventListener("dragend", () => {
	clearIndicator();
	if (!dragging) return;
	dragging = undefined;
	for (const e of boardEl.querySelectorAll(".card.dragging")) e.classList.remove("dragging");
	if (renderPending) render();
});

// ---------- keyboard ----------

/** Visible cards of a column in display order (collapsed sections skipped). */
function visibleCards(col: BoardColumn): string[] {
	return col.sections.filter(s => !collapsed.has(s.id) && !s.ancestors.some(a => collapsed.has(a))).flatMap(s => s.cards.map(c => c.id));
}

document.addEventListener("keydown", ev => {
	if (menuEl) return;
	const active = document.activeElement;
	const inInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
	if ((ev.key === "/" && !inInput) || (ev.key.toLowerCase() === "f" && (ev.ctrlKey || ev.metaKey))) {
		ev.preventDefault();
		filterInput.focus();
		filterInput.select();
		return;
	}
	if (inInput) return;
	if (ev.key === "Escape" && selected.size) {
		selected.clear();
		render();
		return;
	}
	if (active instanceof SVGElement && active.dataset.node) {
		const node = active.dataset.node;
		if (ev.key === "Enter" || ev.key === " ") {
			ev.preventDefault();
			post({ type: "open", id: node });
		} else if (ev.key === "ContextMenu" || (ev.key === "F10" && ev.shiftKey)) {
			ev.preventDefault();
			cardMenu(active, node);
		}
		return;
	}
	const id = active instanceof HTMLElement && active.classList.contains("card") ? active.dataset.id : undefined;
	if (!id) {
		if (ev.key.startsWith("Arrow") && focusedId) {
			ev.preventDefault();
			focusCard(focusedId);
		}
		return;
	}
	const row = rowOf(id);
	if (!row) return;
	const at = findCard(row.columns, id);
	if (!at) return;
	const vertical = ev.key === "ArrowUp" ? -1 : ev.key === "ArrowDown" ? 1 : 0;
	const horizontal = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
	if (ev.altKey && (vertical || horizontal)) {
		ev.preventDefault();
		const ids = targets(id);
		const target = vertical ? (ids.length === 1 ? stepTarget(row.columns, id, vertical === -1 ? -1 : 1) : undefined) : adjacentTarget(row.columns, id, horizontal === -1 ? -1 : 1);
		moveCards(ids, target, row.columns);
		focusCard(id);
		return;
	}
	if (vertical) {
		ev.preventDefault();
		const list = visibleCards(at.column);
		focusCard(list[list.indexOf(id) + vertical]);
		if (ev.shiftKey && focusedId) {
			selected.add(id);
			selected.add(focusedId);
			render();
		}
		return;
	}
	if (horizontal) {
		ev.preventDefault();
		const index = visibleCards(at.column).indexOf(id);
		for (let i = row.columns.indexOf(at.column) + horizontal; i >= 0 && i < row.columns.length; i += horizontal) {
			const list = visibleCards(row.columns[i]);
			if (list.length) {
				focusCard(list[Math.min(index, list.length - 1)]);
				break;
			}
		}
		return;
	}
	if (ev.key === "Enter") {
		ev.preventDefault();
		post({ type: "open", id });
	} else if (ev.key === " ") {
		ev.preventDefault();
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
		anchorId = id;
		render();
	} else if (ev.key.toLowerCase() === "p" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
		ev.preventDefault();
		const card = data.cards.find(c => c.id === id);
		if (card) setPriority(targets(id), cyclePriority(card.priority, ev.shiftKey ? -1 : 1));
	} else if (ev.key === "ContextMenu" || (ev.key === "F10" && ev.shiftKey)) {
		ev.preventDefault();
		cardMenu(cardEl(id) ?? boardEl, id);
	}
});

boardEl.addEventListener("focusin", ev => {
	const card = ev.target instanceof HTMLElement && ev.target.classList.contains("card") ? ev.target : null;
	if (card?.dataset.id && card.dataset.id !== focusedId) {
		const prev = focusedId ? cardEl(focusedId) : null;
		if (prev) prev.tabIndex = -1;
		focusedId = card.dataset.id;
		card.tabIndex = 0;
	}
});

// ---------- extension messages ----------

window.addEventListener("message", (ev: MessageEvent<ToBoard>) => {
	const msg = ev.data;
	if (msg.type === "data") {
		data = msg.data;
		scheduler = msg.scheduler;
		loaded = true;
		if (editingLane?.id && !data.lanes.some(l => l.id === editingLane?.id)) editingLane = undefined;
		render();
	} else if (msg.type === "focusFilter") {
		filterInput.focus();
		filterInput.select();
	}
});

// Relative times on cards.
setInterval(() => {
	if (!dragging && !menuEl && !editingLane) render();
}, 60_000);

render();
post({ type: "ready" });
