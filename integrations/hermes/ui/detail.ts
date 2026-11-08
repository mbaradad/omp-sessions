// The detail panel: the session's question with answer buttons, its full last reply, a follow-up box,
// the permission mode switch, Stop, and Open in VS Code.
import { errorMessage, type Host, MODE_INFO, MODES, type Mode, type Question, type Session, type VscodeLink } from "./api";
import { Button, ErrorBox, Segmented, useDismiss } from "./components";
import { type Child, h, type ReactElement, useEffect, useRef, useState } from "./react";
import { ago, clock, cx, icon, markdown, money, plain, STATE_LABEL, shortId, stateText } from "./util";

const POLL_MS = 3000;

/** omp-sessions answer's text for each question kind (see dialogAnswer in src/shared/session-report.ts). */
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
		body = h("div", { className: "omps-muted" }, "This kind of question can only be answered in VS Code or with omp-sessions attach.");
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
	const [followUp, setFollowUp] = useState(false);
	const [confirmStop, setConfirmStop] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
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
		void act("send", "send", { text, followUp: s?.state === "working" && followUp }, () => setText(""));
	};

	// The VS Code window last used on omp's machine takes the request; the link brings that window up.
	const openVscode = async (): Promise<void> => {
		setBusy("vscode");
		setActionError(null);
		setNotice(null);
		try {
			const link = await p.host.request<VscodeLink>(`/sessions/${encodeURIComponent(p.id)}/vscode`, { method: "POST", body: {} });
			await p.host.openVscode(link);
			setNotice(
				link.authority
					? `Opening in the VS Code window connected to ${link.authority.replace(/^ssh-remote\+/, "")}${link.windowAt ? ` (used ${ago(link.windowAt)})` : ""}.`
					: link.authority === ""
						? "Opening in VS Code on omp's machine."
						: "No VS Code window has used omp Sessions on omp's machine yet: the link opens VS Code here, which needs the omp Sessions extension.",
			);
		} catch (err) {
			setActionError(errorMessage(err));
		} finally {
			setBusy(null);
		}
	};

	const view = s ?? p.summary;
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
			h(Button, { kind: "ghost", small: true, icon: "external", label: "VS Code", title: "Open this session in VS Code", busy: busy === "vscode", onClick: () => void openVscode() }),
			h(Button, { kind: "ghost", icon: "x", title: "Close (Esc)", onClick: p.onClose }),
		),
		h(
			"div",
			{ className: "omps-drawer-body" },
			error && !view ? h(ErrorBox, { message: error, onRetry: () => void load() }) : null,
			error && view ? h("div", { className: "omps-stale" }, icon("alert", 12), `Not refreshed: ${error}`) : null,
			actionError ? h(ErrorBox, { message: actionError }) : null,
			notice ? h("div", { className: "omps-notice" }, icon("external", 12), notice) : null,
			view?.state === "needs_input" && view.question ? h(AnswerBox, { key: view.question.id, q: view.question, busy: busy === "answer", onAnswer: answer => void act("answer", "answer", { answer }) }) : null,
			view
				? h(
						"dl",
						{ className: "omps-meta" },
						h(Meta, { label: "Status", children: stateText(view, p.now) }),
						view.group ? h(Meta, { label: "Group", children: view.group }) : null,
						view.card ? h(Meta, { label: "Kanban card", children: h("span", null, `${view.card.board} · `, view.card.title ?? view.card.id, view.card.status ? h("span", { className: cx("omps-kstatus", `k-${view.card.status}`) }, view.card.status) : null) }) : null,
						view.startAt && view.state === "queued" ? h(Meta, { label: "Starts", children: clock(view.startAt) }) : null,
						view.queue.total ? h(Meta, { label: "Tasks", children: `${view.queue.done} of ${view.queue.total} done${view.queue.running ? " · one running" : ""}` }) : null,
						view.model ? h(Meta, { label: "Model", children: view.model }) : null,
						h(Meta, { label: "Cost", children: money(view.cost) || "—" }),
						h(Meta, { label: "Files changed", children: String(view.changedFiles) }),
						h(Meta, { label: "Active", children: ago(view.updatedAt, p.now) || "—" }),
						view.tags.length ? h(Meta, { label: "Tags", children: h("span", { className: "omps-tags" }, ...view.tags.map(t => h("span", { key: t, className: "omps-chip" }, t))) }) : null,
					)
				: null,
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
			h(
				"section",
				{ className: "omps-reply", "aria-label": "Last reply" },
				h("div", { className: "omps-section-label" }, "Last reply"),
				view?.reply ? h("div", { className: "omps-md" }, ...markdown(view.reply)) : view?.excerpt ? h("div", { className: "omps-md" }, h("p", null, plain(view.excerpt))) : h("div", { className: "omps-muted" }, view ? "No reply yet." : "Loading…"),
				view?.exitReason ? h("div", { className: "omps-exit" }, `Stopped: ${view.exitReason}`) : null,
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
							placeholder: working ? "Steer the current turn…" : view.state === "stopped" ? "Send a prompt (resumes the session)…" : "Send a follow-up…",
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
										h("input", { type: "checkbox", checked: followUp, onChange: (e: Event) => setFollowUp((e.target as HTMLInputElement).checked) }),
										"After this turn",
									)
								: h("span", { className: "omps-hint" }, "Ctrl+Enter to send"),
							h("span", { className: "omps-grow" }),
							view.state !== "stopped"
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
							h(Button, { type: "submit", small: true, kind: "primary", icon: "send", label: working && !followUp ? "Steer" : "Send", busy: busy === "send", disabled: !text.trim() }),
						),
					),
				)
			: null,
	);
}
