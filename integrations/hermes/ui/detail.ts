// The detail panel: the session's question with answer buttons, its full last reply, a follow-up box,
// queue controls (run now, retry, schedule), the permission mode and model switches, Stop, and Open in
// VS Code (the chat, or the project folder).
import { errorMessage, type Host, MODE_INFO, MODES, type Mode, type Question, type Session, type SyncState, type UpstreamEdge } from "./api";
import { Button, ErrorBox, Segmented, useDismiss } from "./components";
import { ModelPicker, ModelsError, useModels } from "./models";
import { type Child, h, type ReactElement, useEffect, useRef, useState } from "./react";
import { ago, clock, cx, icon, markdown, money, plain, STATE_LABEL, shortId, stateText } from "./util";
import { QueueControls, type RunQueueAction } from "./queue";
import { openInVscode } from "./vscode";

const POLL_MS = 3000;

const SYNC_LABEL: Record<SyncState, string> = {
	"in-sync": "in sync",
	pending: "changes wait for this turn to end",
	merged: "changes merged",
	resolving: "its agent is resolving the merge",
	conflict: "merge conflict",
	"upstream-changed": "changed after this one finished",
};

/** The parent tasks' sync states (GRAPH-PROPAGATION.md), with Sync now and Re-run with parent changes. */
function Upstream(p: { edges: UpstreamEdge[]; busy: string | null; onSync: (rerun: boolean) => void }): ReactElement {
	const changed = p.edges.some(e => e.state === "upstream-changed");
	return h(
		"section",
		{ className: "omps-upstream", "aria-label": "Parent tasks" },
		h("div", { className: "omps-section-label" }, "Parent tasks"),
		...p.edges.map((e, i) =>
			h(
				"div",
				{ key: i, className: cx("omps-upstream-edge", `omps-sync-${e.state}`) },
				`${e.parent ? shortId(e.parent) : "parent"} · ${SYNC_LABEL[e.state] ?? e.state}`,
				e.files.length ? h("div", { className: "omps-upstream-files" }, `${e.files.slice(0, 8).join(", ")}${e.files.length > 8 ? ` … ${e.files.length - 8} more` : ""}`) : null,
			),
		),
		h(
			"div",
			{ className: "omps-followup-row" },
			h(Button, { small: true, kind: "ghost", label: "Sync now", title: "Merge the parents' changes into this session's worktree", busy: p.busy === "sync", onClick: () => p.onSync(false) }),
			changed ? h(Button, { small: true, kind: "primary", label: "Re-run with parent changes", busy: p.busy === "rerun", onClick: () => p.onSync(true) }) : null,
		),
	);
}

/** switchyard answer's text for each question kind (see dialogAnswer in src/shared/session-report.ts). */
function AnswerBox(p: { q: Question; busy: boolean; onAnswer: (answer: string) => void }): ReactElement {
	const { q } = p;
	const [text, setText] = useState("");
	const [picks, setPicks] = useState<number[][]>(() => (q.questions ?? []).map(() => []));
	const [others, setOthers] = useState<string[]>(() => (q.questions ?? []).map(() => ""));
	// questionOf() falls back to the dialog kind ("ask") when omp gives no title.
	const [title, ...rest] = (q.title === q.kind ? "omp asks" : q.title).split("\n");
	const head = h(
		"div",
		{ className: "omps-q-head" },
		h("span", { className: "omps-q-icon" }, icon("ask", 16)),
		h("div", { className: "omps-q-titles" }, h("div", { className: "omps-q-title" }, title), rest.length ? h("pre", { className: "omps-q-detail" }, rest.join("\n")) : null, q.message ? h("div", { className: "omps-q-message" }, q.message) : null),
	);
	let body: Child;
	if (q.kind === "select" && q.options?.length) {
		body = h(
			"div",
			{ className: "omps-q-options" },
			...q.options.map((o, i) =>
				h(Button, { key: i, kind: i === 0 ? "primary" : /^deny|^no\b|^reject/i.test(o) ? "danger" : "default", label: o, disabled: p.busy, onClick: () => p.onAnswer(String(i + 1)) }),
			),
		);
	} else if (q.kind === "confirm") {
		body = h("div", { className: "omps-q-options" }, h(Button, { kind: "primary", label: "Yes", disabled: p.busy, onClick: () => p.onAnswer("yes") }), h(Button, { label: "No", disabled: p.busy, onClick: () => p.onAnswer("no") }));
	} else if (q.kind === "input" || q.kind === "editor") {
		body = h(
			"form",
			{
				className: "omps-q-form",
				onSubmit: (e: Event) => {
					e.preventDefault();
					if (text.trim()) p.onAnswer(text);
				},
			},
			h("textarea", { className: "omps-input", rows: q.kind === "editor" ? 5 : 2, value: text, "aria-label": "Your answer", onChange: (e: Event) => setText((e.target as HTMLTextAreaElement).value) }),
			h(Button, { type: "submit", kind: "primary", icon: "send", label: "Answer", busy: p.busy, disabled: !text.trim() }),
		);
	} else if (q.kind === "ask" && q.questions?.length) {
		const qs = q.questions;
		const single = qs.length === 1 && !qs[0].multi;
		const toggle = (qi: number, oi: number, multi: boolean): void => setPicks(prev => prev.map((list, i) => (i !== qi ? list : multi ? (list.includes(oi) ? list.filter(x => x !== oi) : [...list, oi]) : [oi])));
		const answer = qs.map((_, i) => (picks[i]?.length ? picks[i].map(n => n + 1).join(",") : (others[i] ?? "").trim())).join("|");
		const complete = qs.every((_, i) => picks[i]?.length || (others[i] ?? "").trim());
		body = h(
			"div",
			{ className: "omps-q-ask" },
			...qs.map((sub, qi) =>
				h(
					"fieldset",
					{ key: qi, className: "omps-q-sub" },
					h("legend", null, sub.question || `Question ${qi + 1}`, sub.multi ? h("span", { className: "omps-muted" }, " · pick any") : null),
					h(
						"div",
						{ className: "omps-q-options" },
						...sub.options.map((o, oi) =>
							h(Button, {
								key: oi,
								label: o,
								pressed: picks[qi]?.includes(oi),
								kind: picks[qi]?.includes(oi) ? "primary" : "default",
								disabled: p.busy,
								onClick: () => (single ? p.onAnswer(String(oi + 1)) : toggle(qi, oi, sub.multi)),
							}),
						),
					),
					h("input", {
						className: "omps-input",
						placeholder: "Or type your own answer",
						"aria-label": `Your own answer to: ${sub.question}`,
						value: others[qi] ?? "",
						onChange: (e: Event) => {
							const v = (e.target as HTMLInputElement).value;
							setOthers(prev => prev.map((x, i) => (i === qi ? v : x)));
							setPicks(prev => prev.map((x, i) => (i === qi ? [] : x)));
						},
						onKeyDown: (e: KeyboardEvent) => {
							if (e.key === "Enter" && single && (others[qi] ?? "").trim()) p.onAnswer((others[qi] ?? "").trim());
						},
					}),
				),
			),
			single && !(others[0] ?? "").trim() ? null : h(Button, { kind: "primary", icon: "send", label: "Answer", busy: p.busy, disabled: !complete, onClick: () => p.onAnswer(answer) }),
		);
	} else {
		body = h("div", { className: "omps-muted" }, "This kind of question can only be answered in VS Code or with switchyard attach.");
	}
	return h("section", { className: "omps-question", "aria-label": "omp is asking" }, head, body);
}

function Meta(p: { label: string; children: Child }): ReactElement {
	return h("div", { className: "omps-meta-item" }, h("dt", null, p.label), h("dd", null, p.children));
}

export function DetailPanel(p: { host: Host; id: string; summary: Session | undefined; now: number; onClose: () => void; onChanged: () => void }): ReactElement {
	const [s, setS] = useState<Session | undefined>(p.summary);
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [text, setText] = useState("");
	const [steer, setSteer] = useState(false);
	const [confirmStop, setConfirmStop] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [model, setModel] = useState("");
	const models = useModels(p.host);
	const root = useRef<HTMLElement | null>(null);
	const tick = useRef(0);
	useDismiss(p.onClose, root);

	const load = async (): Promise<void> => {
		const mine = ++tick.current;
		try {
			const next = await p.host.request<Session>(`/sessions/${encodeURIComponent(p.id)}`);
			if (mine === tick.current) {
				setS(next);
				setError(null);
			}
		} catch (err) {
			if (mine === tick.current) setError(errorMessage(err));
		}
	};

	useEffect(() => {
		setS(p.summary);
		setConfirmStop(false);
		setActionError(null);
		setNotice(null);
		void load();
		const timer = setInterval(() => {
			if (!document.hidden) void load();
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [p.id]);

	const act = async (name: string, path: string, body: Record<string, unknown>, after?: () => void): Promise<void> => {
		setBusy(name);
		setActionError(null);
		try {
			await p.host.request(`/sessions/${encodeURIComponent(p.id)}/${path}`, { method: "POST", body });
			after?.();
			await load();
			p.onChanged();
		} catch (err) {
			setActionError(errorMessage(err));
		} finally {
			setBusy(null);
		}
	};

	const send = (): void => {
		if (!text.trim()) return;
		void act("send", "send", { text, steer: s?.state === "working" && steer }, () => setText(""));
	};

	// The VS Code window last used on omp's machine takes the request; the link brings that window up.
	const openVscode = async (what: "vscode" | "project"): Promise<void> => {
		setBusy(what);
		setActionError(null);
		setNotice(null);
		try {
			setNotice(await openInVscode(p.host, `/sessions/${encodeURIComponent(p.id)}/${what}`));
		} catch (err) {
			setActionError(errorMessage(err));
		} finally {
			setBusy(null);
		}
	};

	const queueAction: RunQueueAction = async (id, action, body) => {
		await p.host.request(`/sessions/${encodeURIComponent(id)}/${action}`, { method: "POST", body });
		await load();
		p.onChanged();
	};

	const view = s ?? p.summary;
	const questionId = view?.question?.id;
	const working = view?.state === "working" || view?.state === "starting";
	return h(
		"aside",
		{ className: "omps-drawer", ref: root, role: "dialog", "aria-modal": false, "aria-labelledby": "omps-detail-title" },
		h(
			"header",
			{ className: "omps-drawer-head" },
			h(
				"div",
				{ className: "omps-drawer-titles" },
				view ? h("span", { className: cx("omps-state", `tone-${view.state}`) }, h("span", { className: cx("omps-dot", `tone-${view.state}`) }), STATE_LABEL[view.state]) : null,
				h("h2", { id: "omps-detail-title", className: "omps-drawer-title" }, view?.title ?? shortId(p.id)),
				view ? h("div", { className: "omps-drawer-sub" }, icon("folder", 12), h("span", { title: view.cwd }, view.cwdLabel ?? view.cwd), h("span", { className: "omps-sep" }, "·"), h("code", null, shortId(view.id))) : null,
			),
			h(Button, { kind: "ghost", small: true, icon: "folder", label: "Open project in VS Code", title: "Open the session's project folder in VS Code (its Hermes project or board folder, else its git repository)", busy: busy === "project", onClick: () => void openVscode("project") }),
			h(Button, { kind: "ghost", small: true, icon: "external", label: "VS Code", title: "Open this session's chat in VS Code", busy: busy === "vscode", onClick: () => void openVscode("vscode") }),
			h(Button, { kind: "ghost", icon: "x", title: "Close (Esc)", onClick: p.onClose }),
		),
		h(
			"div",
			{ className: "omps-drawer-body" },
			error && !view ? h(ErrorBox, { message: error, onRetry: () => void load() }) : null,
			error && view ? h("div", { className: "omps-stale" }, icon("alert", 12), `Not refreshed: ${error}`) : null,
			actionError ? h(ErrorBox, { message: actionError }) : null,
			notice ? h("div", { className: "omps-notice" }, icon("external", 12), notice) : null,
			view?.state === "needs_input" && view.question
				? h(AnswerBox, { key: view.question.id, q: view.question, busy: busy === "answer", onAnswer: answer => void act("answer", "answer", { answer, question: questionId }) })
				: null,
			view
				? h(
						"dl",
						{ className: "omps-meta" },
						h(Meta, { label: "Status", children: stateText(view, p.now) }),
						view.group ? h(Meta, { label: "Group", children: view.group }) : null,
						view.card ? h(Meta, { label: "Kanban card", children: h("span", null, `${view.card.board} · `, view.card.title ?? view.card.id, view.card.status ? h("span", { className: cx("omps-kstatus", `k-${view.card.status}`) }, view.card.status) : null) }) : null,
						typeof view.startAt === "number" ? h(Meta, { label: "Starts", children: clock(view.startAt) }) : null,
						view.queue.total ? h(Meta, { label: "Tasks", children: `${view.queue.done} of ${view.queue.total} done${view.queue.running ? " · one running" : ""}${view.queue.failed ? ` · ${view.queue.failed} failed` : ""}` }) : null,
						view.model ? h(Meta, { label: "Model", children: view.model }) : null,
						h(Meta, { label: "Cost", children: money(view.cost) || "—" }),
						h(Meta, { label: "Files changed", children: String(view.changedFiles) }),
						h(Meta, { label: "Active", children: ago(view.updatedAt, p.now) || "—" }),
						view.tags.length ? h(Meta, { label: "Tags", children: h("span", { className: "omps-tags" }, ...view.tags.map(t => h("span", { key: t, className: "omps-chip" }, t))) }) : null,
						view.completed ? h(Meta, { label: "Completed", children: view.completedAt ? `${ago(view.completedAt, p.now)} (${clock(view.completedAt)})` : "yes" }) : null,
					)
				: null,
			view
				? h(
						"div",
						{ className: "omps-mode-row omps-detail-actions" },
						h("span", { className: "omps-section-label" }, view.archived ? "Archived" : view.completed ? "Completed" : "Organize"),
						view.completed
							? h(Button, { small: true, kind: "ghost", icon: "undo", label: "Mark not completed", busy: busy === "uncomplete", onClick: () => void act("uncomplete", "uncomplete", {}) })
							: h(Button, { small: true, kind: "ghost", icon: "check", label: "Mark completed", title: "Done, whatever its state: Archive all on the Done column takes it", busy: busy === "complete", onClick: () => void act("complete", "complete", {}) }),
						view.archived
							? h(Button, { small: true, kind: "ghost", icon: "unarchive", label: "Unarchive", busy: busy === "unarchive", onClick: () => void act("unarchive", "unarchive", {}) })
							: h(Button, { small: true, kind: "ghost", icon: "archive", label: "Archive", title: "Hide it from the board (Show archived brings it back)", busy: busy === "archive", onClick: () => void act("archive", "archive", {}) }),
					)
				: null,
			view ? h(QueueControls, { s: view, onAction: queueAction }) : null,
			view
				? h(
						"div",
						{ className: "omps-mode-row" },
						h("span", { className: "omps-section-label" }, "Permission mode"),
						h(Segmented<Mode>, {
							label: "Permission mode",
							small: true,
							value: view.mode,
							disabled: busy === "mode",
							options: MODES.map(m => ({ value: m, label: MODE_INFO[m].label, title: MODE_INFO[m].detail })),
							onChange: (mode: Mode) => {
								if (mode !== view.mode) void act("mode", "mode", { mode });
							},
						}),
					)
				: null,
			view
				? h(
						"form",
						{
							className: "omps-mode-row",
							onSubmit: (e: Event) => {
								e.preventDefault();
								if (model.trim() && model.trim() !== view.model) void act("model", "model", { model: model.trim() }, () => setModel(""));
							},
						},
						h("label", { className: "omps-section-label", htmlFor: "omps-detail-model" }, "Model"),
						h(ModelPicker, { id: "omps-detail-model", models: models.models, value: model, onChange: setModel, disabled: busy === "model", placeholder: view.model ?? undefined, label: `Switch model (now ${view.model ?? "the default"})` }),
						h(Button, { type: "submit", small: true, label: "Switch", title: "A running session switches now; otherwise from its next start", busy: busy === "model", disabled: !model.trim() || model.trim() === view.model }),
					)
				: null,
			view && models.error ? h(ModelsError, { error: models.error, loading: models.loading, onRetry: models.reload }) : null,
			view?.upstream?.length ? h(Upstream, { edges: view.upstream, busy, onSync: rerun => void act(rerun ? "rerun" : "sync", "sync", { rerun }) }) : null,
			h(
				"section",
				{ className: "omps-reply", "aria-label": "Last reply" },
				h("div", { className: "omps-section-label" }, "Last reply"),
				view?.reply ? h("div", { className: "omps-md" }, ...markdown(view.reply)) : view?.excerpt ? h("div", { className: "omps-md" }, h("p", null, plain(view.excerpt))) : h("div", { className: "omps-muted" }, view ? "No reply yet." : "Loading…"),
				view?.exitReason ? h("div", { className: "omps-exit" }, `${view.state === "interrupted" ? "Interrupted" : "Stopped"}: ${view.exitReason}`) : null,
			),
		),
		view
			? h(
					"footer",
					{ className: "omps-drawer-foot" },
					h(
						"form",
						{
							className: "omps-followup",
							onSubmit: (e: Event) => {
								e.preventDefault();
								send();
							},
						},
						h("textarea", {
							className: "omps-input",
							rows: 2,
							value: text,
							placeholder: working ? (steer ? "Steer the current turn…" : "Send a follow-up for after this turn…") : view.state === "stopped" || view.state === "interrupted" ? "Send a prompt (resumes the session)…" : "Send a follow-up…",
							"aria-label": "Message to the session",
							onChange: (e: Event) => setText((e.target as HTMLTextAreaElement).value),
							onKeyDown: (e: KeyboardEvent) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									send();
								}
							},
						}),
						h(
							"div",
							{ className: "omps-followup-row" },
							working
								? h(
										"label",
										{ className: "omps-check" },
										h("input", { type: "checkbox", checked: steer, onChange: (e: Event) => setSteer((e.target as HTMLInputElement).checked) }),
										"Steer this turn",
									)
								: h("span", { className: "omps-hint" }, "Ctrl+Enter to send"),
							h("span", { className: "omps-grow" }),
							// An interrupted session whose host still runs (an interrupted task) can be stopped.
							view.state !== "stopped" && !(view.state === "interrupted" && view.status === "stopped")
								? confirmStop
									? h(
											"span",
											{ className: "omps-confirm" },
											"Stop this session?",
											h(Button, { small: true, kind: "danger", label: "Stop", busy: busy === "stop", onClick: () => void act("stop", "stop", {}, () => setConfirmStop(false)) }),
											h(Button, { small: true, kind: "ghost", label: "Cancel", onClick: () => setConfirmStop(false) }),
										)
									: h(Button, { small: true, kind: "ghost", icon: "stop", label: "Stop", onClick: () => setConfirmStop(true) })
								: null,
							h(Button, { type: "submit", small: true, kind: "primary", icon: "send", label: working && steer ? "Steer" : "Send", busy: busy === "send", disabled: !text.trim() }),
						),
					),
				)
			: null,
	);
}
