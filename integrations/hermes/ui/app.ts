// The Switchyard page, written once for both hosts (the Hermes dashboard tab and the Hermes
// Desktop page): status strip, session board with filters, detail panel, New session, Orchestrator (AO's
// orchestrator of each project), Boards, Graph, and the AO dashboard (Agent Orchestrator's own web UI).
import { type ArchiveDone, errorMessage, type Host, type Overview, type Session, type Started } from "./api";
import { AoDashboardPanel } from "./ao";
import { type CardAction, SessionBoard } from "./board";
import { BoardsPanel } from "./boards";
import { Button, Empty, ErrorBox, Notes, Segmented } from "./components";
import { DetailPanel } from "./detail";
import { GraphPanel } from "./graph";
import { NewSessionDialog } from "./newSession";
import { OrchestratorPanel } from "./orchestrator";
import type { RunQueueAction } from "./queue";
import { type Child, h, type ReactElement, setReact, useEffect, useMemo, useRef, useState } from "./react";
import { SessionSounds, setSoundMuted, soundMuted } from "./sounds";
import { ago, cx, icon, logo } from "./util";
import { openInVscode } from "./vscode";

const SESSIONS_MS = 4000;
const OVERVIEW_MS = 10_000;

type View = "sessions" | "orchestrator" | "boards" | "graph" | "ao";

/** Runs `fn` now and every `every` ms while the page is visible (and right away when it shows again). */
function usePoll(fn: () => Promise<void>, every: number): void {
	const latest = useRef(fn);
	latest.current = fn;
	useEffect(() => {
		let stopped = false;
		const run = (): void => {
			if (!stopped && !document.hidden) void latest.current();
		};
		run();
		const timer = setInterval(run, every);
		document.addEventListener("visibilitychange", run);
		return () => {
			stopped = true;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", run);
		};
	}, [every]);
}

function boardOf(s: Session): string | null {
	return s.card?.board ?? s.tags.find(t => t.startsWith("hermes:"))?.slice(7) ?? null;
}

function StatusStrip(p: { o: Overview | null; error: string | null; sessions: Session[] | null; now: number; refreshedAt: number | null; onBoards: () => void }): ReactElement {
	const { o } = p;
	const items: Child[] = [];
	if (!o) {
		items.push(h("span", { key: "l", className: "omps-strip-item omps-muted" }, p.error ? `Status unavailable: ${p.error}` : "Checking switchyard…"));
	} else {
		const v = o.switchyard;
		const server = o.scheduler?.server ?? Boolean(v.server);
		items.push(
			h(
				"span",
				{ key: "omp", className: "omps-strip-item", title: v.command ?? v.hint ?? "" },
				h("span", { className: cx("omps-led", v.found && !v.error ? (server ? "is-ok" : "is-warn") : "is-bad") }),
				h("strong", null, "switchyard"),
				v.found ? (v.cli ? ` ${v.cli}` : "") : " not installed",
				v.found ? h("span", { className: "omps-muted" }, server ? ` · server ${v.server ?? "running"}` : " · server not running") : null,
			),
		);
		const sc = o.scheduler;
		if (sc) {
			const limit = sc.maxConcurrent ?? 0;
			const running = sc.running ?? 0;
			const slots = limit > 0 ? Array.from({ length: Math.min(limit, 12) }, (_, i) => h("span", { key: i, className: cx("omps-slot", i < running && "is-used") })) : null;
			items.push(
				h(
					"span",
					{ key: "sched", className: "omps-strip-item", title: limit ? `The Switchyard scheduler runs at most ${limit} queued tasks at once` : "No concurrency limit" },
					icon("slots", 13),
					slots ? h("span", { className: "omps-slots", "aria-hidden": true }, ...slots) : null,
					h("span", null, limit ? `${running}/${limit} slots` : `${running} running · no limit`),
					sc.waiting ? h("span", { className: "omps-muted" }, ` · ${sc.waiting} waiting`) : null,
					sc.paused ? h("span", { className: "omps-chip is-warn" }, "paused") : null,
				),
			);
		}
		const lane = o.lane;
		const notes = lane.notes ?? [];
		const tick = lane.dispatcher;
		items.push(
			h(
				"button",
				{
					key: "lane",
					type: "button",
					className: cx("omps-strip-item omps-strip-btn", notes.length > 0 && "is-warn"),
					onClick: p.onBoards,
					title: notes.length ? notes.join("\n") : tick ? `Kanban dispatcher (profile ${tick.profile}) last ran the lane at ${new Date(tick.at * 1000).toLocaleTimeString()}` : "Kanban lane settings",
				},
				h("span", { className: cx("omps-led", notes.length ? "is-warn" : lane.enabled ? "is-ok" : "is-off") }),
				h("strong", null, "Lane"),
				lane.enabled ? ` on · ${lane.boards === "all" ? "all boards" : `${lane.boards.length} board${lane.boards.length === 1 ? "" : "s"}`}` : " off",
				lane.enabled && tick ? h("span", { className: "omps-muted" }, ` · last pass ${ago(tick.at, p.now)}`) : null,
				lane.linked ? h("span", { className: "omps-muted" }, ` · ${lane.linked} linked card${lane.linked === 1 ? "" : "s"}`) : null,
				notes.length ? icon("alert", 12) : null,
			),
		);
	}
	if (p.sessions) {
		const need = p.sessions.filter(s => s.state === "needs_input").length;
		if (need) items.push(h("span", { key: "need", className: "omps-strip-item omps-strip-need" }, icon("ask", 13), `${need} need${need === 1 ? "s" : ""} you`));
	}
	return h(
		"div",
		{ className: "omps-strip", role: "status", "aria-live": "polite" },
		...items,
		h("span", { className: "omps-grow" }),
		p.refreshedAt ? h("span", { className: "omps-strip-time", title: new Date(p.refreshedAt).toLocaleTimeString() }, icon("refresh", 11), ago(p.refreshedAt, p.now)) : null,
		o?.lane.notes?.length ? h(Notes, { notes: o.lane.notes, className: "omps-strip-notes" }) : null,
	);
}

function Select(p: { label: string; value: string; all: string; options: string[]; onChange: (v: string) => void }): ReactElement | null {
	if (p.options.length === 0) return null;
	return h(
		"label",
		{ className: cx("omps-filter", p.value && "is-set") },
		h("span", { className: "omps-filter-label" }, p.label),
		h("select", { value: p.value, "aria-label": p.label, onChange: (e: Event) => p.onChange((e.target as HTMLSelectElement).value) }, h("option", { value: "" }, p.all), ...p.options.map(o => h("option", { key: o, value: o }, o))),
	);
}

export function createPage(host: Host): () => ReactElement {
	setReact(host.React);
	return function SwitchyardPage(): ReactElement {
		const [view, setView] = useState<View>("sessions");
		const [overview, setOverview] = useState<Overview | null>(null);
		const [overviewError, setOverviewError] = useState<string | null>(null);
		const [sessions, setSessions] = useState<Session[] | null>(null);
		const [error, setError] = useState<string | null>(null);
		const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
		const [now, setNow] = useState(Date.now());
		const [selected, setSelected] = useState<string | null>(null);
		const [creating, setCreating] = useState(false);
		const [query, setQuery] = useState("");
		const [board, setBoard] = useState("");
		const [group, setGroup] = useState("");
		const [project, setProject] = useState("");
		const [archived, setArchived] = useState(false);
		const [notice, setNotice] = useState<string | null>(null);
		const [boardNote, setBoardNote] = useState<{ text: string; error: boolean } | null>(null);
		const [busyCards, setBusyCards] = useState<ReadonlySet<string>>(new Set());
		const search = useRef<HTMLInputElement | null>(null);
		const sounds = useRef<SessionSounds | null>(null);
		const [muted, setMuted] = useState(soundMuted);

		const loadSessions = async (): Promise<void> => {
			try {
				const res = await host.request<{ sessions: Session[] }>("/sessions");
				setSessions(res.sessions);
				sounds.current ??= new SessionSounds();
				sounds.current.observe(res.sessions);
				setError(null);
				setRefreshedAt(Date.now());
			} catch (err) {
				setError(errorMessage(err));
			}
			setNow(Date.now());
		};
		const loadOverview = async (): Promise<void> => {
			try {
				setOverview(await host.request<Overview>("/overview"));
				setOverviewError(null);
			} catch (err) {
				setOverviewError(errorMessage(err));
			}
		};
		const refresh = (): void => {
			void loadSessions();
			void loadOverview();
		};
		usePoll(loadSessions, SESSIONS_MS);
		usePoll(loadOverview, OVERVIEW_MS);

		useEffect(() => {
			const onKey = (e: KeyboardEvent): void => {
				const t = e.target instanceof HTMLElement ? e.target : null;
				if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
				if (e.key === "/" && view === "sessions") {
					e.preventDefault();
					search.current?.focus();
				} else if (e.key === "n" || e.key === "N") {
					e.preventDefault();
					setCreating(true);
				}
			};
			window.addEventListener("keydown", onKey);
			return () => window.removeEventListener("keydown", onKey);
		}, [view]);

		const all = sessions ?? [];
		const facets = useMemo(() => {
			const uniq = (xs: Array<string | null | undefined>): string[] => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort((a, b) => a.localeCompare(b));
			return { boards: uniq(all.map(boardOf)), groups: uniq(all.map(s => s.group)), projects: uniq(all.map(s => s.project)) };
		}, [sessions]);
		const q = query.trim().toLowerCase();
		const shown = all.filter(
			s =>
				(archived || !s.archived) &&
				(!board || boardOf(s) === board) &&
				(!group || s.group === group) &&
				(!project || s.project === project) &&
				(!q || [s.title, s.cwd, s.excerpt ?? "", s.id, s.group ?? "", s.card?.title ?? "", ...s.tags].some(x => x.toLowerCase().includes(q))),
		);
		const filtered = Boolean(q || board || group || project);
		const archivedCount = all.filter(s => s.archived).length;

		const started = (s: Started): void => {
			setCreating(false);
			setView("sessions");
			setSelected(s.id);
			refresh();
		};

		const cardAction = async (id: string, action: CardAction): Promise<void> => {
			setBoardNote(null);
			setBusyCards(prev => new Set(prev).add(id));
			try {
				await host.request(`/sessions/${encodeURIComponent(id)}/${action}`, { method: "POST", body: {} });
				await loadSessions();
			} catch (err) {
				setBoardNote({ text: errorMessage(err), error: true });
			} finally {
				setBusyCards(prev => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
			}
		};

		const archiveAll = async (ids: string[]): Promise<void> => {
			setBoardNote(null);
			try {
				const res = await host.request<ArchiveDone>("/sessions/archive-done", { method: "POST", body: { ids } });
				const n = res.archived.length;
				const failed = res.failed.map(f => `${f.id.slice(0, 8)}: ${f.error}`);
				setBoardNote({ text: `Archived ${n} session${n === 1 ? "" : "s"}.${failed.length ? ` Not archived: ${failed.join("; ")}` : ""}`, error: failed.length > 0 });
				await loadSessions();
			} catch (err) {
				setBoardNote({ text: errorMessage(err), error: true });
			}
		};

		const openProject = async (id: string): Promise<void> => {
			setNotice(null);
			try {
				setNotice(await openInVscode(host, `/sessions/${encodeURIComponent(id)}/project`));
			} catch (err) {
				setNotice(errorMessage(err));
			}
		};

		// Run now / Retry / Schedule from a card or the detail panel; the board refreshes after it.
		const queueAction: RunQueueAction = async (id, action, body) => {
			await host.request(`/sessions/${encodeURIComponent(id)}/${action}`, { method: "POST", body });
			await loadSessions();
		};

		const notInstalled = overview && !overview.switchyard.found;
		let main: Child;
		if (view === "boards") {
			main = h(BoardsPanel, { host, lane: overview?.lane ?? null, now, onChanged: () => void loadOverview(), onOpenSession: id => (setView("sessions"), setSelected(id)) });
		} else if (view === "graph") {
			main = h(GraphPanel, { host, onOpenSession: setSelected });
		} else if (view === "orchestrator") {
			main = h(OrchestratorPanel, { host, now, onOpenSession: setSelected, onOpenAo: () => setView("ao") });
		} else if (view === "ao") {
			main = h(AoDashboardPanel, { host, project });
		} else if (notInstalled) {
			main = h(Empty, { icon: "terminal", title: "switchyard is not installed", body: overview.switchyard.hint ?? "", action: h(Button, { label: "Check again", icon: "refresh", onClick: refresh }) });
		} else if (!sessions) {
			main = error ? h(ErrorBox, { message: error, onRetry: refresh }) : h("div", { className: "omps-loading" }, h("span", { className: "omps-spinner" }), "Loading sessions…");
		} else if (all.length === 0) {
			main = h(Empty, {
				icon: "sparkle",
				title: "No sessions yet",
				body: "Start one here, with switchyard new, from VS Code or the Agent Orchestrator app, or ask Hermes to (the switchyard_session_start tool). Kanban cards assigned to switchyard show up here too once the lane is on.",
				action: h(Button, { kind: "brand", icon: "plus", label: "New session", onClick: () => setCreating(true) }),
			});
		} else {
			main = h(
				"div",
				{ className: "omps-main" },
				h(
					"div",
					{ className: "omps-filters" },
					h(
						"label",
						{ className: "omps-search" },
						icon("search", 14),
						h("input", { ref: search, type: "search", value: query, placeholder: "Search sessions  /", "aria-label": "Search sessions", onChange: (e: Event) => setQuery((e.target as HTMLInputElement).value) }),
					),
					h(Select, { label: "Board", value: board, all: "All boards", options: facets.boards, onChange: setBoard }),
					h(Select, { label: "Group", value: group, all: "All groups", options: facets.groups, onChange: setGroup }),
					h(Select, { label: "Project", value: project, all: "All projects", options: facets.projects, onChange: setProject }),
					archivedCount ? h(Button, { small: true, kind: archived ? "primary" : "ghost", icon: "archive", pressed: archived, label: `Show archived · ${archivedCount}`, onClick: () => setArchived(!archived) }) : null,
					filtered ? h(Button, { small: true, kind: "ghost", icon: "x", label: "Clear", onClick: () => (setQuery(""), setBoard(""), setGroup(""), setProject("")) }) : null,
					h("span", { className: "omps-grow" }),
					h("span", { className: "omps-muted omps-total" }, filtered ? `${shown.length} of ${all.length}` : `${all.length} session${all.length === 1 ? "" : "s"}`),
				),
				error ? h("div", { className: "omps-stale" }, icon("alert", 12), `Not refreshed: ${error}`) : null,
				notice ? h("div", { className: "omps-notice" }, icon("external", 12), notice) : null,
				boardNote ? h("div", { className: boardNote.error ? "omps-stale" : "omps-notice" }, icon(boardNote.error ? "alert" : "archive", 12), boardNote.text) : null,
				h(SessionBoard, { sessions: shown, selected, now, busy: busyCards, onOpen: setSelected, onOpenProject: id => void openProject(id), onQueueAction: queueAction, onAction: (id, action) => void cardAction(id, action), onArchiveAll: archiveAll, filtered }),
			);
		}

		return h(
			"div",
			{ className: cx("omps", `omps-host-${host.kind}`, selected && view !== "boards" && view !== "ao" && "has-drawer") },
			host.css ? h("style", null, host.css) : null,
			h(
				"header",
				{ className: "omps-head" },
				logo(30),
				h("div", { className: "omps-head-titles" }, h("h1", { className: "omps-title" }, "Switchyard"), overview ? h("span", { className: "omps-profile", title: "Hermes profile" }, overview.profile) : null),
				h(Segmented<View>, {
					label: "View",
					value: view,
					onChange: setView,
					options: [
						{ value: "sessions", label: "Sessions" },
						{ value: "orchestrator", label: "Orchestrator", title: "AO's orchestrator of each project: give it a high-level task, see its workers, change its settings" },
						{ value: "boards", label: "Boards" },
						{ value: "graph", label: "Graph", title: "Kanban cards as a dependency graph" },
						{ value: "ao", label: "AO dashboard", title: "Agent Orchestrator's own web UI, served by Switchyard on the Switchyard machine" },
					],
				}),
				h("span", { className: "omps-grow" }),
				h(Button, {
					kind: "ghost",
					icon: muted ? "bellOff" : "bell",
					pressed: !muted,
					title: muted ? "Session sounds off: click to hear when a session finishes or needs input" : "Session sounds on: click to mute",
					onClick: () => {
						setSoundMuted(!muted);
						setMuted(!muted);
					},
				}),
				h(Button, { kind: "ghost", icon: "refresh", title: "Refresh", onClick: refresh }),
				h(Button, { kind: "brand", icon: "plus", label: "New session", title: "New session (N)", disabled: Boolean(notInstalled), onClick: () => setCreating(true) }),
			),
			h(StatusStrip, { o: overview, error: overviewError, sessions, now, refreshedAt, onBoards: () => setView("boards") }),
			// Desktop keeps its own copy of this page; after a plugin update it can lag the backend it talks to.
			host.kind === "desktop" && overview?.pluginVersion && overview.pluginVersion !== PAGE_VERSION
				? h(Notes, {
						className: "omps-page-note",
						notes: [
							`This page is Switchyard ${PAGE_VERSION}; the plugin on this Hermes is ${overview.pluginVersion}. Update the page in Capabilities → Plugins → Switchyard: Rescan when Hermes runs on this computer, or Install from Git again with Force reinstall when it runs on another machine.`,
						],
					})
				: null,
			h("div", { className: "omps-body" }, main),
			selected && view !== "boards" && view !== "ao"
				? h(DetailPanel, { key: selected, host, id: selected, summary: all.find(s => s.id === selected), now, onClose: () => setSelected(null), onChanged: () => void loadSessions() })
				: null,
			creating ? h(NewSessionDialog, { host, groups: facets.groups, onClose: () => setCreating(false), onStarted: started }) : null,
		);
	};
}
