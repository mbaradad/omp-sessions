// Graph: a board's kanban cards as a dependency graph (parent → child, left to right; a child waits
// for its parents), coloured by card status, with the state of the omp session working on each card.
// Plain SVG laid out by graph-layout.ts. Clicking a card shows its links; a card with an omp session
// opens that session's detail too.
import { type BoardsView, errorMessage, type GraphCard, type Host } from "./api";
import { SESSION_STATE } from "./boards";
import { Button, Empty, ErrorBox } from "./components";
import { layoutGraph, NODE_H, NODE_W } from "./graph-layout";
import { h, type ReactElement, useEffect, useMemo, useState } from "./react";
import { cx, icon, shortId } from "./util";

const POLL_MS = 8000;
const TITLE_CHARS = 30;
const STATUSES = ["triage", "todo", "ready", "running", "blocked", "done"] as const;
/** A parent in these states no longer holds its children back. */
const MET: Record<string, true> = { done: true, archived: true };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function hasLinks(cards: readonly GraphCard[]): boolean {
	const ids = new Set(cards.map(c => c.id));
	return cards.some(c => c.parents.some(p => ids.has(p)) || c.children.some(ch => ids.has(ch)));
}

function CardNode(p: { card: GraphCard; x: number; y: number; selected: boolean; faded: boolean; onOpen: (c: GraphCard) => void }): ReactElement {
	const { card } = p;
	const session = card.sessionState ? (SESSION_STATE[card.sessionState] ?? card.sessionState) : null;
	const label = `${card.title} (${card.status}${session ? `, omp session ${session}` : ""})`;
	return h(
		"g",
		{
			className: cx("omps-gnode", `k-${card.status}`, p.selected && "is-selected", p.faded && "is-faded"),
			transform: `translate(${p.x} ${p.y})`,
			role: "button",
			tabIndex: 0,
			"aria-label": label,
			"aria-pressed": p.selected,
			"data-card": card.id,
			onClick: () => p.onOpen(card),
			onKeyDown: (e: KeyboardEvent) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					p.onOpen(card);
				}
			},
		},
		h("title", null, `${card.title}\n${card.id} · ${card.status}${card.assignee ? ` · ${card.assignee}` : ""}${session ? `\nomp session: ${session}` : ""}`),
		h("rect", { className: "omps-gnode-box", width: NODE_W, height: NODE_H, rx: 8 }),
		h("rect", { className: "omps-gnode-bar", width: 4, height: NODE_H - 12, x: 0, y: 6, rx: 2 }),
		h("text", { className: "omps-gnode-title", x: 14, y: 22 }, clip(card.title, TITLE_CHARS)),
		h("text", { className: "omps-gnode-status", x: 14, y: 44 }, card.status),
		session
			? h(
					"g",
					{ className: cx("omps-gnode-session", card.sessionState && `tone-${card.sessionState}`), transform: `translate(${NODE_W - 12} 40)` },
					h("circle", { className: "omps-gnode-dot", cx: 0, cy: 0, r: 4 }),
					h("text", { x: -10, y: 4, textAnchor: "end" }, card.lane ? `lane · ${session}` : session),
				)
			: null,
	);
}

function CardInfo(p: { card: GraphCard; byId: Map<string, GraphCard>; onSelect: (id: string) => void; onOpenSession: (id: string) => void; onClose: () => void }): ReactElement {
	const { card } = p;
	const chips = (ids: string[]): ReactElement[] =>
		ids.map(id => {
			const c = p.byId.get(id);
			return h(
				"button",
				{ key: id, type: "button", className: "omps-gchip", disabled: !c, title: c ? `${c.title} (${c.status})` : `${id} (archived)`, onClick: () => p.onSelect(id) },
				h("span", { className: cx("omps-kstatus", `k-${c?.status ?? "archived"}`) }, c?.status ?? "archived"),
				clip(c?.title ?? id, 40),
			);
		});
	return h(
		"section",
		{ className: "omps-gcard", "aria-label": `Card ${card.title}` },
		h(
			"div",
			{ className: "omps-gcard-head" },
			h("span", { className: cx("omps-kstatus", `k-${card.status}`) }, card.status),
			h("span", { className: "omps-gcard-title" }, card.title),
			h("span", { className: "omps-muted omps-mono" }, card.id),
			card.assignee ? h("span", { className: "omps-muted" }, `· ${card.assignee}`) : null,
			h("span", { className: "omps-grow" }),
			card.session
				? h(
						"button",
						{ type: "button", className: cx("omps-linked-session", card.sessionState && `tone-${card.sessionState}`), title: `Open omp session ${shortId(card.session)}`, onClick: () => card.session && p.onOpenSession(card.session) },
						h("span", { className: cx("omps-dot", card.sessionState && `tone-${card.sessionState}`) }),
						SESSION_STATE[card.sessionState ?? ""] ?? card.sessionState,
					)
				: h("span", { className: "omps-muted" }, card.lane ? "lane · no session yet" : "no omp session"),
			h(Button, { small: true, kind: "ghost", icon: "x", title: "Close", onClick: p.onClose }),
		),
		h(
			"div",
			{ className: "omps-gcard-links" },
			h("span", { className: "omps-section-label" }, "Waits for"),
			card.parents.length ? chips(card.parents) : h("span", { className: "omps-muted" }, "nothing"),
		),
		h(
			"div",
			{ className: "omps-gcard-links" },
			h("span", { className: "omps-section-label" }, "Unblocks"),
			card.children.length ? chips(card.children) : h("span", { className: "omps-muted" }, "nothing"),
		),
	);
}

export function GraphPanel(p: { host: Host; onOpenSession: (id: string) => void }): ReactElement {
	const [view, setView] = useState<BoardsView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [slug, setSlug] = useState("");
	const [showAll, setShowAll] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);

	const load = async (): Promise<void> => {
		try {
			setView(await p.host.request<BoardsView>("/boards"));
			setError(null);
		} catch (err) {
			setError(errorMessage(err));
		}
	};
	useEffect(() => {
		void load();
		const timer = setInterval(() => {
			if (!document.hidden) void load();
		}, POLL_MS);
		return () => clearInterval(timer);
	}, []);

	const boards = view?.boards ?? [];
	// The chosen board, else the first one with links, else the first one.
	const board = boards.find(b => b.slug === slug) ?? boards.find(b => hasLinks(b.cards ?? [])) ?? boards[0];
	const cards = board?.cards;
	const layout = useMemo(() => layoutGraph(cards ?? [], showAll), [cards, showAll]);
	const byId = useMemo(() => new Map((cards ?? []).map(c => [c.id, c])), [cards]);

	if (!view) return error ? h(ErrorBox, { message: error, onRetry: () => void load() }) : h("div", { className: "omps-loading" }, h("span", { className: "omps-spinner" }), "Loading boards…");
	if (!board) return h(Empty, { icon: "kanban", title: "No kanban boards", body: "Create one in Hermes (hermes kanban boards create <name>)." });

	const open = (c: GraphCard): void => {
		setSelected(c.id);
		if (c.session) p.onOpenSession(c.session);
	};
	const picked = selected ? byId.get(selected) : undefined;

	let body: ReactElement;
	if (!cards) {
		body = h(Empty, { icon: "alert", title: "The graph needs a newer Switchyard plugin", body: "This Hermes runs an Switchyard backend that doesn't report card links; update the plugin and restart Hermes." });
	} else if (layout.nodes.length === 0) {
		body = h(Empty, {
			icon: "kanban",
			title: cards.length ? "No linked cards on this board" : "No cards on this board",
			body: cards.length ? "Cards appear here once one waits for another (hermes kanban link <parent> <child>, or create a card with parents)." : undefined,
			action: cards.length ? h(Button, { small: true, label: `Show all ${cards.length} cards`, onClick: () => setShowAll(true) }) : undefined,
		});
	} else {
		body = h(
			"div",
			{ className: "omps-graph-scroll" },
			h(
				"svg",
				{ className: "omps-graph", width: layout.width, height: layout.height, viewBox: `0 0 ${layout.width} ${layout.height}`, role: "group", "aria-label": `Dependency graph of ${board.name}` },
				h("defs", null, h("marker", { id: "omps-graph-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, h("path", { d: "M0 0L10 5L0 10z", className: "omps-gedge-head" }))),
				...layout.edges.map(e =>
					h("path", {
						key: `${e.from}>${e.to}`,
						d: e.d,
						className: cx("omps-gedge", MET[byId.get(e.from)?.status ?? ""] && "is-met", picked && (e.from === picked.id || e.to === picked.id) && "is-near"),
						markerEnd: "url(#omps-graph-arrow)",
					}),
				),
				...layout.nodes.map(n =>
					h(CardNode, {
						key: n.card.id,
						card: n.card,
						x: n.x,
						y: n.y,
						selected: n.card.id === selected,
						faded: picked !== undefined && n.card.id !== picked.id && !picked.parents.includes(n.card.id) && !picked.children.includes(n.card.id),
						onOpen: open,
					}),
				),
			),
		);
	}

	return h(
		"div",
		{ className: "omps-graph-panel" },
		h(
			"div",
			{ className: "omps-filters" },
			h(
				"label",
				{ className: "omps-filter is-set" },
				h("span", { className: "omps-filter-label" }, "Board"),
				h(
					"select",
					{ value: board.slug, "aria-label": "Board", onChange: (e: Event) => (setSlug((e.target as HTMLSelectElement).value), setSelected(null)) },
					...boards.map(b => h("option", { key: b.slug, value: b.slug }, b.name)),
				),
			),
			h(Button, {
				small: true,
				kind: showAll ? "primary" : "ghost",
				pressed: showAll,
				label: showAll ? "All cards" : `Linked cards only${layout.hidden ? ` · ${layout.hidden} hidden` : ""}`,
				title: showAll ? "Show only cards linked to another card" : "Show every card of the board",
				onClick: () => setShowAll(!showAll),
			}),
			h("span", { className: "omps-grow" }),
			h("span", { className: "omps-glegend", "aria-label": "Card status colours" }, ...STATUSES.map(s => h("span", { key: s, className: cx("omps-kstatus", `k-${s}`) }, s))),
		),
		error ? h("div", { className: "omps-stale" }, icon("alert", 12), `Not refreshed: ${error}`) : null,
		board.error ? h(ErrorBox, { message: board.error }) : null,
		picked ? h(CardInfo, { card: picked, byId, onSelect: setSelected, onOpenSession: p.onOpenSession, onClose: () => setSelected(null) }) : null,
		body,
	);
}
