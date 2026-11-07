// Boards: the kanban lane per board (folder, group, mode, assignee), the cards it runs as omp sessions
// and the ready cards it will take next, with the lane's switches.
import { type Board, type BoardsView, errorMessage, type Host, MODE_INFO, MODES, type Mode } from "./api";
import { Button, Empty, ErrorBox, Field, Switch } from "./components";
import { h, type ReactElement, useEffect, useState } from "./react";
import { ago, cx, icon, shortId } from "./util";

const SESSION_STATE: Record<string, string> = {
	needs_input: "needs you",
	working: "working",
	starting: "starting",
	queued: "queued",
	idle: "done",
	stopped: "stopped",
	removed: "session removed",
	"not created": "no session yet",
};

function BoardCard(p: { b: Board; laneOn: boolean; busy: boolean; onSave: (slug: string, body: Record<string, unknown>) => Promise<boolean>; onOpenSession: (id: string) => void }): ReactElement {
	const { b } = p;
	const [folder, setFolder] = useState(b.folder ?? "");
	const [group, setGroup] = useState(b.group ?? "");
	const [mode, setMode] = useState<string>(b.mode ?? "");
	const [assignee, setAssignee] = useState(b.assignee ?? "");
	useEffect(() => {
		setFolder(b.folder ?? "");
		setGroup(b.group ?? "");
		setMode(b.mode ?? "");
		setAssignee(b.assignee ?? "");
	}, [b.folder, b.group, b.mode, b.assignee]);
	const dirty = folder !== (b.folder ?? "") || group !== (b.group ?? "") || mode !== (b.mode ?? "") || assignee !== (b.assignee ?? "");
	const id = (k: string): string => `omps-${b.slug}-${k}`;
	return h(
		"section",
		{ className: cx("omps-bcard", b.lane && "is-on"), "aria-label": `Board ${b.name}` },
		h(
			"header",
			{ className: "omps-bcard-head" },
			h("span", { className: "omps-bcard-icon" }, icon("kanban", 15)),
			h("div", { className: "omps-bcard-titles" }, h("div", { className: "omps-bcard-name" }, b.name), h("div", { className: "omps-bcard-slug" }, b.slug)),
			h("span", { className: "omps-grow" }),
			h("span", { className: cx("omps-lane-state", b.lane && "is-on") }, b.lane ? "Lane on" : p.laneOn ? "Not in the lane" : "Lane off"),
			h(Switch, { checked: b.listed, label: `Run ${b.name} cards assigned to ${b.effectiveAssignee} as omp sessions`, busy: p.busy, onChange: on => void p.onSave(b.slug, { lane: on }) }),
		),
		h(
			"form",
			{
				className: "omps-bcard-form",
				onSubmit: (e: Event) => {
					e.preventDefault();
					void p.onSave(b.slug, { folder, group, mode, assignee });
				},
			},
			h(Field, { label: "Folder", htmlFor: id("folder"), hint: "Where cards without a worktree run", children: h("input", { id: id("folder"), className: "omps-input omps-mono", value: folder, placeholder: "Not set", onChange: (e: Event) => setFolder((e.target as HTMLInputElement).value) }) }),
			h(Field, { label: "omp group", htmlFor: id("group"), children: h("input", { id: id("group"), className: "omps-input", value: group, placeholder: b.defaultGroup, onChange: (e: Event) => setGroup((e.target as HTMLInputElement).value) }) }),
			h(Field, {
				label: "Mode",
				htmlFor: id("mode"),
				children: h(
					"select",
					{ id: id("mode"), className: "omps-input", value: mode, onChange: (e: Event) => setMode((e.target as HTMLSelectElement).value) },
					h("option", { value: "" }, "Lane default"),
					...MODES.map((m: Mode) => h("option", { key: m, value: m }, `${MODE_INFO[m].label} — ${MODE_INFO[m].detail}`)),
				),
			}),
			h(Field, { label: "Assignee", htmlFor: id("assignee"), children: h("input", { id: id("assignee"), className: "omps-input", value: assignee, placeholder: b.effectiveAssignee, onChange: (e: Event) => setAssignee((e.target as HTMLInputElement).value) }) }),
			h("div", { className: "omps-bcard-save" }, h(Button, { type: "submit", small: true, kind: dirty ? "primary" : "default", label: "Save", disabled: !dirty, busy: p.busy && dirty })),
		),
		h(
			"div",
			{ className: "omps-bcard-cards" },
			h("div", { className: "omps-section-label" }, `Linked cards · ${b.linked.length}`),
			b.linked.length
				? h(
						"ul",
						{ className: "omps-linked" },
						...b.linked.map(c =>
							h(
								"li",
								{ key: c.id, className: "omps-linked-row" },
								h("span", { className: cx("omps-kstatus", `k-${c.status}`) }, c.status),
								h("span", { className: "omps-linked-title", title: `${b.slug}/${c.id}` }, c.title ?? c.id),
								c.waitingOnInput ? h("span", { className: "omps-chip is-needs" }, "needs input") : null,
								c.session
									? h("button", { type: "button", className: cx("omps-linked-session", `tone-${c.sessionState}`), title: `Open omp session ${shortId(c.session)}`, onClick: () => c.session && p.onOpenSession(c.session) }, h("span", { className: cx("omps-dot", `tone-${c.sessionState}`) }), SESSION_STATE[c.sessionState] ?? c.sessionState)
									: h("span", { className: "omps-muted" }, SESSION_STATE[c.sessionState] ?? c.sessionState),
								c.error ? h("span", { className: "omps-linked-error", title: c.error }, icon("alert", 12)) : null,
							),
						),
					)
				: h("div", { className: "omps-muted" }, b.lane ? `No cards assigned to ${b.effectiveAssignee} are running.` : "None."),
			b.ready.length
				? h(
						"div",
						{ className: "omps-ready" },
						h("div", { className: "omps-section-label" }, `Ready for ${b.effectiveAssignee} · ${b.ready.length}`),
						h("ul", { className: "omps-linked" }, ...b.ready.slice(0, 6).map(c => h("li", { key: c.id, className: "omps-linked-row" }, h("span", { className: "omps-kstatus k-ready" }, "ready"), h("span", { className: "omps-linked-title" }, c.title)))),
					)
				: null,
		),
		h(
			"footer",
			{ className: "omps-bcard-foot" },
			b.lastPass ? `Last lane pass ${ago(b.lastPass)}` : b.lane ? "No lane pass yet (the gateway's kanban dispatcher runs it)" : "",
			b.error ? h("span", { className: "omps-linked-error", title: b.error }, icon("alert", 12), b.error) : null,
		),
	);
}

export function BoardsPanel(p: { host: Host; onOpenSession: (id: string) => void; onChanged: () => void }): ReactElement {
	const [view, setView] = useState<BoardsView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

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
		}, 8000);
		return () => clearInterval(timer);
	}, []);

	const post = async (key: string, path: string, body: Record<string, unknown>): Promise<boolean> => {
		setBusy(key);
		setActionError(null);
		try {
			setView(await p.host.request<BoardsView>(path, { method: "POST", body }));
			p.onChanged();
			return true;
		} catch (err) {
			setActionError(errorMessage(err));
			return false;
		} finally {
			setBusy(null);
		}
	};

	if (!view) return error ? h(ErrorBox, { message: error, onRetry: () => void load() }) : h("div", { className: "omps-loading" }, h("span", { className: "omps-spinner" }), "Loading boards…");
	return h(
		"div",
		{ className: "omps-boards" },
		h(
			"div",
			{ className: cx("omps-lane-banner", view.enabled && "is-on") },
			h("span", { className: "omps-lane-banner-icon" }, icon("lane", 18)),
			h(
				"div",
				{ className: "omps-lane-banner-text" },
				h("div", { className: "omps-lane-banner-title" }, view.enabled ? "The kanban lane is on" : "The kanban lane is off"),
				h(
					"div",
					{ className: "omps-muted" },
					view.enabled
						? `Cards assigned to ${view.assignee} on ${view.allBoards ? "every board" : "the boards switched on below"} run as omp sessions and report back to the card.`
						: `Turn it on to run kanban cards assigned to ${view.assignee} as omp sessions (they queue under omp's concurrency limit). Settings are this profile's (${view.profile}).`,
				),
			),
			h(Switch, { checked: view.enabled, label: "Kanban lane", busy: busy === "lane", onChange: on => void post("lane", "/lane", { enabled: on }) }),
		),
		error ? h("div", { className: "omps-stale" }, icon("alert", 12), `Not refreshed: ${error}`) : null,
		actionError ? h(ErrorBox, { message: actionError }) : null,
		view.boards.length
			? h(
					"div",
					{ className: "omps-bgrid" },
					...view.boards.map(b => h(BoardCard, { key: b.slug, b, laneOn: view.enabled, busy: busy === b.slug, onSave: (slug, body) => post(slug, `/boards/${encodeURIComponent(slug)}`, body), onOpenSession: p.onOpenSession })),
				)
			: h(Empty, { icon: "kanban", title: "No kanban boards", body: "Create one in Hermes (hermes kanban boards create <name>)." }),
	);
}
