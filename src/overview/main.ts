// Switchyard Overview webview (src/ext/overview.ts): one page that answers "what needs me, what is running,
// what is next, what is blocked, what is held and why". The extension host sends the model
// (src/overview/overview-core.ts); this draws it, words the times against its own clock and posts clicks back.
import { drawDag } from "../shared/graph-svg";
import { SESSION_MARKERS, sessionDag } from "../shared/session-graph";
import { formatStartTime } from "../shared/task-text";
import { type Child, button, el, icon } from "../shared/webview-dom";
import {
	type BudgetMeter,
	type FromOverview,
	type HeldGroup,
	type NeedsItem,
	type NextItem,
	type OverviewModel,
	type SchedulerView,
	type ToOverview,
	type UsageMeter,
	agoText,
	inText,
} from "./overview-core";

interface VsCodeApi {
	postMessage(msg: FromOverview): void;
	setState(state: unknown): void;
	getState(): unknown;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
const post = (msg: FromOverview): void => vscode.postMessage(msg);

/** Relative times move on without new data: redraw this often while the page is visible. */
const TICK_MS = 30_000;
/** A long queue shows its first rows; the Tasks view has the rest. */
const NEXT_LIMIT = 40;

let model: OverviewModel | undefined;
const collapsed = new Set<string>((vscode.getState() as { collapsed?: string[] } | undefined)?.collapsed ?? []);

const root = el("div", "app");
document.body.append(root);

// ---------- small pieces ----------

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function chip(text: string, tone = "", title?: string, ic?: string): HTMLElement {
	const c = el("span", `chip${tone ? ` ${tone}` : ""}`, ic ? icon(ic) : null, text);
	if (title) c.title = title;
	return c;
}

function absolute(at: number): string {
	const d = new Date(at);
	return `${formatStartTime(at, new Date())}${d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

function cardChip(card: { board?: string; card: string }, session: string): HTMLElement {
	return button("chip hermes", `Open the Hermes kanban card ${card.card}${card.board ? ` on ${card.board}` : ""}`, [icon("hermes"), card.board ? `${card.board} · ${card.card}` : card.card], () => post({ type: "openCard", id: session }));
}

/** One list row: the whole row opens `open`; its buttons stop the click. */
function row(cls: string, open: () => void, leading: Child, main: Child[], actions: Child[] = []): HTMLElement {
	const r = el("div", `row ${cls}`, leading, el("div", "row-main", ...main), actions.length ? el("div", "row-actions", ...actions) : null);
	r.tabIndex = 0;
	r.setAttribute("role", "button");
	r.addEventListener("click", open);
	r.addEventListener("keydown", ev => {
		if (ev.target === r && (ev.key === "Enter" || ev.key === " ")) {
			ev.preventDefault();
			open();
		}
	});
	return r;
}

const rowTitle = (text: string, ...chips: Child[]): HTMLElement => el("div", "row-title", el("span", "row-name", text), ...chips);
const rowSub = (...parts: Child[]): HTMLElement => el("div", "row-sub", ...parts);

function meter(percent: number, tone: string, title: string, mark?: number): HTMLElement {
	const fill = el("span", `meter-fill ${tone}`);
	fill.style.width = `${percent}%`;
	const m = el("span", "meter", fill);
	if (mark !== undefined) {
		const tick = el("span", "meter-mark");
		tick.style.left = `${mark}%`;
		m.append(tick);
	}
	m.title = title;
	m.setAttribute("role", "meter");
	m.setAttribute("aria-valuenow", String(percent));
	m.setAttribute("aria-valuemin", "0");
	m.setAttribute("aria-valuemax", "100");
	return m;
}

function section(id: string, title: string, count: number | undefined, body: Child[], opts: { wide?: boolean; tone?: string; extra?: Child[] } = {}): HTMLElement {
	const closed = collapsed.has(id);
	const head = button("section-head", closed ? `Expand ${title}` : `Collapse ${title}`, [icon("chevron", `chev${closed ? "" : " open"}`), el("span", "section-title", title), count === undefined ? null : el("span", "badge", String(count))], () => {
		if (collapsed.has(id)) collapsed.delete(id);
		else collapsed.add(id);
		vscode.setState({ collapsed: [...collapsed] });
		render();
	});
	head.setAttribute("aria-expanded", String(!closed));
	const s = el("section", `panel${opts.wide ? " wide" : ""}${opts.tone ? ` ${opts.tone}` : ""}`, el("div", "section-bar", head, el("span", "grow"), ...(opts.extra ?? [])), closed ? null : el("div", "section-body", ...body));
	s.dataset.section = id;
	return s;
}

// ---------- sections ----------

const NEED_ICON: Record<NeedsItem["kind"], string> = { question: "question", approval: "bell", conflict: "alert", interrupted: "alert", failed: "alert" };
const NEED_LABEL: Record<NeedsItem["kind"], string> = { question: "Question", approval: "Approval", conflict: "Merge conflict", interrupted: "Interrupted", failed: "Failed" };

function needsSection(items: NeedsItem[], now: number): HTMLElement {
	const rows = items.map(it => {
		const answer = it.kind === "question" || it.kind === "approval";
		const open = (): void => post({ type: "openSession", id: it.session, answer });
		const actions: Child[] = [
			answer ? button("btn primary", "Open the chat with the cursor in the composer: the question is answered there", [it.kind === "approval" ? "Review & approve" : "Answer"], open) : button("btn", "Open the chat", [icon("chat"), "Open chat"], open),
			it.requeue ? button("btn", "Run the failed or interrupted tasks again", [icon("retry"), "Requeue"], () => post({ type: "requeue", id: it.session })) : null,
			it.orchestrator ? null : button("icon-btn", "Changed files", [icon("diff")], () => post({ type: "changes", id: it.session })),
		];
		return row(
			`need ${it.kind}`,
			open,
			el("span", `lead ${it.kind === "question" || it.kind === "approval" ? "warn" : "bad"}`, icon(NEED_ICON[it.kind])),
			[
				rowTitle(it.title, chip(NEED_LABEL[it.kind], it.kind === "question" || it.kind === "approval" ? "warn" : "bad"), it.card ? cardChip(it.card, it.session) : null),
				rowSub(el("span", "detail", it.detail), el("span", "dim", ` · ${it.project} · ${agoText(it.since, now)}`)),
			],
			actions,
		);
	});
	return section("needs", "Needs you", items.length, rows, { wide: true, tone: "attention" });
}

function workingSection(model: OverviewModel, now: number): HTMLElement {
	const rows = model.working.map(w => {
		const open = (): void => post({ type: "openSession", id: w.session });
		const p = w.progress;
		return row(
			"working",
			open,
			el("span", "lead run", el("span", "spinner")),
			[
				rowTitle(w.title, chip(w.project, "dim", undefined, "folder"), w.card ? cardChip(w.card, w.session) : null),
				rowSub(`last activity ${agoText(w.since, now)}`, w.cost ? el("span", "dim", ` · $${w.cost.toFixed(2)}`) : null, p ? el("span", "progress", ` · ${p.done}/${p.total} tasks${p.failed ? ` · ${p.failed} failed` : ""}`) : null),
				w.lastText ? el("div", "excerpt", w.lastText.replace(/\s+/g, " ").slice(0, 180)) : null,
			],
			[button("icon-btn", "Changed files", [icon("diff")], () => post({ type: "changes", id: w.session })), button("icon-btn", "Open chat", [icon("chat")], open)],
		);
	});
	return section("working", "Working now", model.working.length, rows);
}

const NEXT_HEAD: Record<NextItem["state"], string> = { waiting: "Next in line", scheduled: "Scheduled", blocked: "Waiting on other work", paused: "Paused" };
const NEXT_ICON: Record<NextItem["state"], string> = { waiting: "play", scheduled: "clock", blocked: "link", paused: "pause" };

function nextSection(items: NextItem[], now: number): HTMLElement {
	const body: Child[] = [];
	let last: NextItem["state"] | undefined;
	for (const it of items.slice(0, NEXT_LIMIT)) {
		if (it.state !== last) {
			body.push(el("div", "group-head", NEXT_HEAD[it.state]));
			last = it.state;
		}
		const open = (): void => post({ type: "openTask", id: it.task });
		const when =
			it.state === "scheduled" && it.at !== undefined
				? el("span", "when", el("strong", "", it.at <= now ? "due now" : `starts ${inText(it.at, now)}`), el("span", "dim", absolute(it.at)))
				: it.state === "waiting"
					? el("span", "when", el("strong", "", it.position ? `#${it.position}` : "next"), el("span", "dim", "for a slot"))
					: el("span", "when", icon(NEXT_ICON[it.state]));
		const reason = it.state === "blocked" ? "" : (it.reason ?? "");
		body.push(
			row(
				`next ${it.state}`,
				open,
				when,
				[
					rowTitle(it.title, it.priority ? chip(it.priority, it.priority === "urgent" ? "bad" : "warn", `${it.priority} priority`) : null),
					rowSub(
						it.queue ? el("span", "dim", `${it.queue}${reason ? " · " : ""}`) : null,
						reason ? el("span", "", reason) : null,
						...it.blockedBy.map(b => chip(`waits for ${b.title}`, "wait", `Not finished: ${b.title}`, "link")),
					),
				],
				[it.state === "scheduled" || it.state === "paused" || it.state === "waiting" ? button("btn", "Start this task now", [icon("run"), "Run now"], () => post({ type: "runTask", id: it.task })) : null],
			),
		);
	}
	if (items.length > NEXT_LIMIT) body.push(el("div", "more", `${plural(items.length - NEXT_LIMIT, "more task")} in the Tasks view`));
	return section("next", "Next up", items.length, body, { extra: [button("btn ghost", "Open the Tasks view", ["Tasks"], () => post({ type: "open", what: "tasks" }))] });
}

function heldSection(groups: HeldGroup[], now: number): HTMLElement {
	const body = groups.map(g => {
		const head = el(
			"div",
			"held-head",
			el("span", `lead ${g.kind === "backoff" ? "dim" : "warn"}`, icon(g.kind === "budget" ? "clock" : "pause")),
			el("div", "row-main", rowTitle(g.title, chip(g.kind === "rate-limit" ? "provider limit" : g.kind === "usage" ? "usage window" : g.kind, "wait")), rowSub(g.detail ? el("span", "", g.detail) : null, g.until ? el("span", "dim", `${g.detail ? " · " : ""}lifts ${inText(g.until, now)} (${absolute(g.until)})`) : null)),
			g.provider ? button("btn", `Forget ${g.provider}'s limit: held tasks may start again, a new limit error puts the hold back`, ["Clear limit"], () => post({ type: "clearLimits", provider: g.provider })) : null,
		);
		const tasks = g.tasks.map(t => row("held-task", () => post({ type: "openTask", id: t.task }), el("span", "lead dim", icon("circle")), [rowTitle(t.title)]));
		return el("div", "held-group", head, ...(tasks.length ? tasks : [el("div", "row-sub pad", "No queued work waits on it right now.")]));
	});
	const clearable = groups.filter(g => g.provider).length;
	return section("held", "Held", groups.length, body, { tone: "caution", extra: clearable > 1 ? [button("btn ghost", "Clear every provider limit", ["Clear all limits"], () => post({ type: "clearLimits" }))] : [] });
}

function budgetRow(b: BudgetMeter, now: number): HTMLElement {
	return el(
		"div",
		"meter-row",
		el("span", "meter-label", `${b.window} budget`),
		meter(b.percent, b.over ? "bad" : b.percent >= 80 ? "warn" : "ok", `$${b.spent.toFixed(2)} of $${b.cap}`),
		el("span", "meter-value", `$${b.spent.toFixed(2)} / $${b.cap}`, b.over ? el("span", "bad-text", b.freesAt ? ` · cap reached, frees ${inText(b.freesAt, now)}` : " · cap reached") : null),
	);
}

function usageRow(u: UsageMeter, hold: number, now: number): HTMLElement {
	return el(
		"div",
		"meter-row",
		el("span", "meter-label", `${u.provider} ${u.window}`),
		meter(u.percent, u.level === "hold" ? "bad" : u.level === "warn" ? "warn" : "ok", `${u.percent}% used; work is held at ${hold}%`, hold),
		el("span", "meter-value", `${u.percent}%`, u.resetsAt ? el("span", "dim", ` · resets ${inText(u.resetsAt, now)}`) : null),
	);
}

function schedulerSection(s: SchedulerView, now: number): HTMLElement {
	const slots = s.limit > 0 ? Array.from({ length: Math.min(s.limit, 16) }, (_, i) => el("span", `slot${i < s.running ? " used" : ""}`)) : [];
	const stats: Array<[string, number, string]> = [
		["running", s.running, "run"],
		["waiting for a slot", s.waiting, ""],
		["scheduled", s.scheduled, "wait"],
		["held", s.held, "wait"],
		["blocked", s.blocked, "wait"],
		["interrupted", s.interrupted, "bad"],
	];
	const body: Child[] = [
		el(
			"div",
			"sched-top",
			el("span", "slot-line", el("strong", "", s.limit ? `${s.running}/${s.limit}` : `${s.running}`), ` running${s.limit ? "" : ", no limit"}`, slots.length ? el("span", "slots", ...slots) : null),
			s.paused ? chip("paused", "warn", "No new queued task starts; running ones finish") : null,
			el("span", "grow"),
			button("btn", s.paused ? "Queued tasks may start again" : "No new queued task starts; running ones finish", [icon(s.paused ? "play" : "pause"), s.paused ? "Resume" : "Pause"], () => post({ type: "scheduler", action: "togglePause" })),
			button("icon-btn", "One fewer concurrent task", [icon("minus")], () => post({ type: "scheduler", action: "decrease" })),
			button("icon-btn", "One more concurrent task", [icon("plus")], () => post({ type: "scheduler", action: "increase" })),
			button("btn ghost", "Set the concurrency limit", ["Limit…"], () => post({ type: "scheduler", action: "setConcurrency" })),
		),
		el("div", "stat-line", ...stats.filter(([, n]) => n > 0).map(([label, n, tone]) => chip(`${n} ${label}`, tone))),
	];
	if (!s.aoConnected) body.push(el("div", "warn-line", icon("alert"), `The planner cannot reach AO${s.aoError ? ` (${s.aoError})` : ""}: nothing starts until it can.`));
	if (s.budget.length) body.push(el("div", "meter-block", el("div", "mini-head", "Spend (rolling window)"), ...s.budget.map(b => budgetRow(b, now))));
	if (s.usage.length) body.push(el("div", "meter-block", el("div", "mini-head", `Provider usage (holds work at ${s.thresholds.holdAtPercent}%, spare tasks wait above ${s.thresholds.spareBelowPercent}%)`), ...s.usage.map(u => usageRow(u, s.thresholds.holdAtPercent, now))));
	if (s.limits.length) {
		body.push(
			el(
				"div",
				"meter-block",
				el("div", "mini-head", "Provider limits"),
				...s.limits.map(l =>
					el(
						"div",
						"limit-row",
						el("span", "meter-label", l.provider),
						el("span", "limit-text", `held until ${absolute(l.until)} (${inText(l.until, now)})${l.guessed ? ", a guess" : ""}${l.reason ? ` — ${l.reason}` : ""}`),
						button("btn", `Forget ${l.provider}'s limit`, ["Clear"], () => post({ type: "clearLimits", provider: l.provider })),
					),
				),
			),
		);
	}
	return section("scheduler", "Scheduler", undefined, body, {
		extra: [
			s.defaultModel ? el("span", "dim small", `default model ${s.defaultModel}`) : null,
			button("btn ghost", "Spend caps per hour, day and week", ["Budget…"], () => post({ type: "scheduler", action: "setBudget" })),
			button("btn ghost", "When provider usage holds work, and when spare tasks start", ["Usage…"], () => post({ type: "scheduler", action: "setUsage" })),
			button("icon-btn", "All planner settings", [icon("gear")], () => post({ type: "scheduler", action: "configure" })),
		],
	});
}

function orchestratorsSection(model: OverviewModel, now: number): HTMLElement {
	const rows = model.orchestrators.map(o => {
		const w = o.workers;
		const summary = [w.working && `${w.working} working`, w.needsInput && `${w.needsInput} need${w.needsInput === 1 ? "s" : ""} input`, w.idle && `${w.idle} idle`, w.stopped && `${w.stopped} stopped`].filter(Boolean).join(" · ");
		const tone = !o.active ? "dim" : o.status === "waiting" ? "warn" : o.status === "working" || o.status === "starting" ? "run" : "ok";
		return row(
			"orch",
			() => post({ type: "openOrchestrator", projectId: o.projectId }),
			el("span", `lead ${tone}`, icon("orchestrator")),
			[
				rowTitle(o.name, chip(o.active ? (o.status === "waiting" ? "needs input" : o.status) : "stopped", tone), o.harness ? chip(o.model ? `${o.harness} · ${o.model.replace(/^.*\//, "")}` : o.harness, "dim") : null),
				rowSub(w.workers ? `${plural(w.workers, "worker")}${summary ? ` — ${summary}` : ""}` : "no workers yet", w.openPrs ? chip(plural(w.openPrs, "open PR"), "", undefined, "pr") : null, el("span", "dim", ` · ${agoText(o.updatedAt, now)}`)),
				o.question ? el("div", "excerpt warn-text", o.question.title) : null,
			],
			[button("icon-btn", "Open the orchestrator's chat", [icon("chat")], () => post({ type: "openOrchestrator", projectId: o.projectId }))],
		);
	});
	return section("orchestrators", "Orchestrators", model.orchestrators.length, rows);
}

function prsSection(model: OverviewModel): HTMLElement {
	const rows = model.prs.map(p => {
		const open = (): void => post({ type: "reviewPr", session: p.session, pr: p.number });
		return row(
			"pr",
			open,
			el("span", "lead bad", icon("pr")),
			[rowTitle(`#${p.number} ${p.sessionTitle}`, ...p.reasons.map(r => chip(r, "bad"))), rowSub(p.summary)],
			[button("btn", "Review the pull request's files in VS Code", [icon("diff"), "Review"], open)],
		);
	});
	return section("prs", "Pull requests needing attention", model.prs.length, rows);
}

function graphSection(model: OverviewModel, now: number): HTMLElement {
	const { nodes, edges } = sessionDag(model.graph, model.graph, new Date(now));
	const legend = el("div", "graph-legend", el("span", "key enforced", "dependency the planner enforces"), el("span", "key pending", "still waiting / not merged yet"), el("span", "key changed", "parent changed"), el("span", "key conflict", "conflict"), el("span", "key merged", "merged"));
	const svg = drawDag({
		nodes,
		edges,
		markers: SESSION_MARKERS,
		label: "Session dependencies",
		onSelect: id => post({ type: "openSession", id }),
	});
	return section("graph", "Dependency graph", nodes.length, [legend, el("div", "graph", svg)], {
		wide: true,
	});
}

// ---------- page ----------

function summaryChips(m: OverviewModel): HTMLElement[] {
	const s = m.scheduler;
	const out: HTMLElement[] = [];
	if (m.needsYou.length) out.push(chip(`${m.needsYou.length} need${m.needsYou.length === 1 ? "s" : ""} you`, "warn", undefined, "bell"));
	if (m.working.length) out.push(chip(`${m.working.length} working`, "run"));
	if (s?.scheduled) out.push(chip(`${s.scheduled} scheduled`, "wait", undefined, "clock"));
	if (s?.blocked) out.push(chip(`${s.blocked} blocked`, "wait", undefined, "link"));
	if (m.held.length) out.push(chip(`${plural(m.held.length, "hold")}`, "wait", undefined, "pause"));
	if (m.prs.length) out.push(chip(plural(m.prs.length, "PR") + " need attention", "bad", undefined, "pr"));
	return out;
}

function render(): void {
	const scroll = document.scrollingElement?.scrollTop ?? 0;
	root.replaceChildren();
	const header = el(
		"header",
		"head",
		el("h1", "", "Switchyard Overview"),
		...(model ? summaryChips(model) : []),
		el("span", "grow"),
		button("btn ghost", "The Sessions Board: every session as a card", [icon("folder"), "Board"], () => post({ type: "open", what: "board" })),
		button("btn ghost", "The planner's task graph", [icon("link"), "Task graph"], () => post({ type: "open", what: "taskGraph" })),
		button("btn ghost", "Cost and usage dashboard", [icon("clock"), "Usage"], () => post({ type: "open", what: "usage" })),
	);
	root.append(header);
	if (!model) {
		root.append(el("div", "notice", "Loading…"));
		return;
	}
	const m = model;
	const now = Date.now();
	if (!m.planner.reachable) root.append(el("div", "warn-line banner", icon("alert"), `The planner is not reachable${m.planner.error ? ` (${m.planner.error})` : ""}. Queues, schedules, holds and limits appear once it answers.`));
	const top: HTMLElement[] = [];
	const flow: HTMLElement[] = [];
	if (m.needsYou.length) top.push(needsSection(m.needsYou, now));
	if (m.working.length) flow.push(workingSection(m, now));
	if (m.nextUp.length) flow.push(nextSection(m.nextUp, now));
	if (m.held.length) flow.push(heldSection(m.held, now));
	if (m.scheduler) flow.push(schedulerSection(m.scheduler, now));
	if (m.orchestrators.length) flow.push(orchestratorsSection(m, now));
	if (m.prs.length) flow.push(prsSection(m));
	if (!m.needsYou.length && !m.working.length && !m.nextUp.length && !m.held.length) {
		top.push(el("section", "panel wide quiet", el("div", "section-body", icon("check"), " All quiet: nothing needs you, runs, waits or is held. New work shows up here as it is queued or scheduled.")));
	}
	// The page reads top to bottom: what needs you, then the sections flowing in columns, then the graph across the page.
	root.append(el("main", "page", ...top, flow.length ? el("div", "flow", ...flow) : null, m.graph.length ? graphSection(m, now) : null));
	if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
}

window.addEventListener("message", e => {
	const msg = e.data as ToOverview;
	if (msg.type === "data") {
		model = msg.model;
		render();
	}
});
setInterval(() => {
	if (document.visibilityState === "visible" && model) render();
}, TICK_MS);
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible" && model) render();
});
render();
post({ type: "ready" });
