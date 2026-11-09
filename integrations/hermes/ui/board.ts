// The session board: five columns by state, cards with what matters at a glance.
import { MODE_INFO, type Session, type State } from "./api";
import { Button, Empty } from "./components";
import { h, type ReactElement, useState } from "./react";
import { QueueControls, type RunQueueAction } from "./queue";
import { ago, clock, cx, type IconName, icon, money, plain, stateText } from "./util";

export interface Column {
	id: "needs" | "working" | "queued" | "done" | "stopped";
	label: string;
	states: readonly State[];
	icon: IconName;
	empty: string;
}

export const COLUMNS: readonly Column[] = [
	{ id: "needs", label: "Needs you", states: ["needs_input"], icon: "ask", empty: "Nothing is waiting on you." },
	{ id: "working", label: "Working", states: ["working", "starting"], icon: "sparkle", empty: "No session is working right now." },
	{ id: "queued", label: "Queued & scheduled", states: ["queued", "scheduled"], icon: "clock", empty: "Nothing queued or scheduled." },
	{ id: "done", label: "Done", states: ["idle"], icon: "check", empty: "No finished turns yet." },
	{ id: "stopped", label: "Stopped", states: ["interrupted", "stopped"], icon: "stop", empty: "No stopped sessions." },
];

export type CardAction = "archive" | "unarchive" | "complete" | "uncomplete";

/** A finished session "Archive all" takes: marked completed, or idle with nothing queued or running
 *  (is_done in the plugin's switchyard.py). */
export function isDone(s: Session): boolean {
	return s.completed || (s.state === "idle" && !s.queue.pending && !s.queue.running);
}

/** The finished columns grow without bound; past this many cards they end in "Show N more". */
const SHOWN: Partial<Record<Column["id"], number>> = { done: 24, stopped: 20 };

function order(col: Column["id"], list: Session[]): Session[] {
	const updated = (s: Session): number => s.updatedAt ?? 0;
	const sorted = [...list];
	if (col === "needs") sorted.sort((a, b) => updated(a) - updated(b)); // waiting longest first
	else if (col === "queued")
		sorted.sort((a, b) => (a.waiting?.position ?? Number.MAX_SAFE_INTEGER) - (b.waiting?.position ?? Number.MAX_SAFE_INTEGER) || (a.startAt ?? Number.MAX_SAFE_INTEGER) - (b.startAt ?? Number.MAX_SAFE_INTEGER));
	else sorted.sort((a, b) => updated(b) - updated(a));
	return sorted;
}

function questionLine(s: Session): string {
	const q = s.question;
	if (!q) return "omp is waiting for an answer";
	if (q.questions?.length) return q.questions[0].question || q.title;
	return q.title.split("\n")[0];
}

function CardButton(p: { icon: IconName; title: string; disabled: boolean; onClick: () => void }): ReactElement {
	return h(
		"button",
		{
			type: "button",
			className: "omps-card-act",
			title: p.title,
			"aria-label": p.title,
			disabled: p.disabled,
			onClick: (e: Event) => {
				e.stopPropagation();
				p.onClick();
			},
			onKeyDown: (e: KeyboardEvent) => e.stopPropagation(),
		},
		icon(p.icon, 12),
	);
}

function SessionCard(p: {
	s: Session;
	selected: boolean;
	now: number;
	busy: boolean;
	onOpen: (id: string) => void;
	onOpenProject: (id: string) => void;
	onAction: (id: string, action: CardAction) => void;
	onQueueAction?: RunQueueAction;
}): ReactElement {
	const { s } = p;
	const open = (): void => p.onOpen(s.id);
	const cost = money(s.cost);
	const q = s.question;
	const options = q?.options ?? q?.questions?.[0]?.options ?? [];
	const progress = s.queue.total > 1 ? Math.round((s.queue.done / s.queue.total) * 100) : null;
	return h(
		"article",
		{
			className: cx("omps-card", `tone-${s.state}`, p.selected && "is-selected", s.archived && "is-archived", s.completed && "is-completed"),
			role: "button",
			tabIndex: 0,
			"aria-pressed": p.selected,
			"aria-label": `${s.title}, ${stateText(s, p.now)}, ${s.project}`,
			"data-session": s.id,
			onClick: open,
			onKeyDown: (e: KeyboardEvent) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				}
			},
		},
		h(
			"div",
			{ className: "omps-card-top" },
			h("span", { className: cx("omps-dot", `tone-${s.state}`), "aria-hidden": true }),
			h("span", { className: "omps-card-title", title: s.title }, s.title),
			s.mode ? h("span", { className: cx("omps-mode", `mode-${s.mode}`), title: `${MODE_INFO[s.mode].label}: ${MODE_INFO[s.mode].detail}` }, MODE_INFO[s.mode].label) : null,
		),
		h(
			"div",
			{ className: "omps-card-meta" },
			h("span", { className: "omps-card-project", title: s.cwdLabel }, icon("folder", 12), s.project),
			h(
				"button",
				{
					type: "button",
					className: "omps-card-vscode",
					title: "Open project in VS Code",
					"aria-label": `Open project of ${s.title} in VS Code`,
					onClick: (e: Event) => {
						e.stopPropagation();
						p.onOpenProject(s.id);
					},
					onKeyDown: (e: KeyboardEvent) => e.stopPropagation(),
				},
				icon("external", 11),
			),
			s.harness && s.harness !== "omp" ? h("span", { className: "omps-chip omps-harness", title: `Runs on the ${s.harness} harness (omp-only: plan mode, the approval gate, /undo)` }, s.harness) : null,
			s.group ? h("span", { className: "omps-chip", title: "Group" }, s.group) : null,
			s.upstream?.some(e => e.state === "conflict")
				? h("span", { className: "omps-chip omps-sync-conflict", title: "A parent task's changes don't merge cleanly into this one" }, "merge conflict")
				: s.upstream?.some(e => e.state === "upstream-changed")
					? h("span", { className: "omps-chip omps-sync-upstream-changed", title: "A parent task changed after this one finished: open it to re-run with the changes" }, "parent changed")
					: null,
			s.completed ? h("span", { className: "omps-chip is-completed", title: s.completedAt ? `Completed ${new Date(s.completedAt).toLocaleString()}` : "Marked completed" }, icon("check", 10), "Completed") : null,
			s.archived ? h("span", { className: "omps-chip", title: "Archived: hidden unless Archived is on" }, "Archived") : null,
		),
		s.state === "needs_input"
			? h(
					"div",
					{ className: "omps-card-question" },
					h("div", { className: "omps-card-question-text" }, questionLine(s)),
					options.length
						? h(
								"div",
								{ className: "omps-card-options" },
								...options.slice(0, 3).map((o, i) => h("span", { key: i, className: "omps-option-chip" }, o)),
								options.length > 3 ? h("span", { className: "omps-option-more" }, `+${options.length - 3}`) : null,
							)
						: null,
				)
			: s.authProblem
				? h("div", { className: "omps-card-excerpt is-warn" }, s.authProblem)
				: s.excerpt && s.state !== "queued" && s.state !== "scheduled"
					? h("div", { className: "omps-card-excerpt" }, plain(s.excerpt))
					: s.exitReason && (s.state === "stopped" || s.state === "interrupted")
						? h("div", { className: "omps-card-excerpt" }, s.exitReason)
						: null,
		s.card
			? h(
					"div",
					{ className: "omps-card-link", title: `Kanban card ${s.card.board}/${s.card.id}` },
					icon("kanban", 12),
					h("span", { className: "omps-card-link-board" }, s.card.board),
					h("span", { className: "omps-card-link-title" }, s.card.title ?? s.card.id),
					s.card.status ? h("span", { className: cx("omps-kstatus", `k-${s.card.status}`) }, s.card.status) : null,
				)
			: null,
		h(
			"div",
			{ className: "omps-card-foot" },
			h("span", { className: "omps-card-state" }, s.state === "working" ? h("span", { className: "omps-pulse", "aria-hidden": true }) : null, stateText(s, p.now)),
			progress !== null ? h("span", { className: cx("omps-progress", (s.queue.failed ?? 0) > 0 && "has-failed"), title: `${s.queue.done} of ${s.queue.total} tasks done${s.queue.failed ? `, ${s.queue.failed} failed` : ""}` }, h("span", { style: { width: `${progress}%` } })) : null,
			h("span", { className: "omps-grow" }),
			cost ? h("span", { className: "omps-cost" }, cost) : null,
			typeof s.startAt === "number"
				? h("span", { className: "omps-when is-scheduled", title: `Queue starts ${new Date(s.startAt).toLocaleString()}` }, icon("clock", 11), clock(s.startAt))
				: h("span", { className: "omps-when", title: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : undefined }, ago(s.updatedAt, p.now)),
			h(
				"span",
				{ className: "omps-card-acts" },
				s.completed
					? h(CardButton, { icon: "undo", title: "Mark not completed", disabled: p.busy, onClick: () => p.onAction(s.id, "uncomplete") })
					: h(CardButton, { icon: "check", title: "Mark completed", disabled: p.busy, onClick: () => p.onAction(s.id, "complete") }),
				s.archived
					? h(CardButton, { icon: "unarchive", title: "Unarchive", disabled: p.busy, onClick: () => p.onAction(s.id, "unarchive") })
					: h(CardButton, { icon: "archive", title: "Archive", disabled: p.busy, onClick: () => p.onAction(s.id, "archive") }),
			),
		),
		p.onQueueAction ? h(QueueControls, { s, onAction: p.onQueueAction, compact: true }) : null,
	);
}

export function SessionBoard(p: {
	sessions: Session[];
	selected: string | null;
	now: number;
	busy: ReadonlySet<string>;
	onOpen: (id: string) => void;
	onOpenProject: (id: string) => void;
	onAction: (id: string, action: CardAction) => void;
	onQueueAction?: RunQueueAction;
	/** Archives these sessions (the view's done ones) in one request. */
	onArchiveAll: (ids: string[]) => Promise<void>;
	filtered: boolean;
}): ReactElement {
	const [expanded, setExpanded] = useState<Partial<Record<Column["id"], boolean>>>({});
	const [confirmAll, setConfirmAll] = useState(false);
	const [archivingAll, setArchivingAll] = useState(false);
	// Done or completed sessions anywhere in the view (a completed session may sit in another column).
	const archivable = p.sessions.filter(s => !s.archived && isDone(s));
	const archiveAll = async (): Promise<void> => {
		setArchivingAll(true);
		try {
			await p.onArchiveAll(archivable.map(s => s.id));
		} finally {
			setArchivingAll(false);
			setConfirmAll(false);
		}
	};
	return h(
		"div",
		{ className: "omps-board", role: "list", "aria-label": "omp sessions by state" },
		...COLUMNS.map(col => {
			const list = order(
				col.id,
				p.sessions.filter(s => col.states.includes(s.state)),
			);
			const cap = SHOWN[col.id];
			// The selected card stays visible even when it falls past the cap.
			const shown = cap !== undefined && !expanded[col.id] && list.length > cap ? list.filter((s, i) => i < cap || s.id === p.selected) : list;
			return h(
				"section",
				{ key: col.id, className: cx("omps-col", `col-${col.id}`, list.length === 0 && "is-empty"), role: "listitem", "aria-label": `${col.label}: ${list.length}` },
				h(
					"header",
					{ className: "omps-col-head" },
					h("span", { className: "omps-col-icon" }, icon(col.icon, 13)),
					h("span", { className: "omps-col-title" }, col.label),
					h("span", { className: "omps-count" }, String(list.length)),
					col.id === "done" && archivable.length
						? confirmAll
							? h(
									"span",
									{ className: "omps-confirm omps-col-confirm" },
									`Archive ${archivable.length}?`,
									h(Button, { small: true, kind: "danger", label: "Archive", busy: archivingAll, onClick: () => void archiveAll() }),
									h(Button, { small: true, kind: "ghost", label: "Cancel", disabled: archivingAll, onClick: () => setConfirmAll(false) }),
								)
							: h(Button, {
									small: true,
									kind: "ghost",
									icon: "archive",
									label: "Archive all",
									className: "omps-col-action",
									title: `Archive the ${archivable.length} done or completed session${archivable.length === 1 ? "" : "s"} shown (idle with nothing queued, or marked completed)`,
									onClick: () => setConfirmAll(true),
								})
						: null,
				),
				h(
					"div",
					{ className: "omps-col-body" },
					shown.length
						? shown.map(s => h(SessionCard, { key: s.id, s, selected: s.id === p.selected, now: p.now, busy: p.busy.has(s.id), onOpen: p.onOpen, onOpenProject: p.onOpenProject, onAction: p.onAction, onQueueAction: p.onQueueAction }))
						: h(Empty, { compact: true, icon: col.icon, title: p.filtered ? "No matches" : col.empty }),
					list.length > shown.length
						? h("button", { type: "button", className: "omps-more", onClick: () => setExpanded({ ...expanded, [col.id]: true }) }, `Show ${list.length - shown.length} more`)
						: null,
				),
			);
		}),
	);
}
