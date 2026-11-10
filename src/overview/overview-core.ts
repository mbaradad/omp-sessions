// The Switchyard Overview's data model (src/ext/overview.ts hosts it, src/overview/main.ts draws it): what needs
// the person, what runs, what is next and when, what is held and why, the scheduler's meters, the project
// orchestrators, the pull requests that need someone and the session dependency graph. AO owns sessions, PRs and
// orchestrators; the planner owns queues, schedules, holds, limits and the budget: this only reads what they
// already computed (`SessionMeta.queue`, `PlanView`) and groups it for one page. Pure: no DOM, vscode or node
// imports (it is bundled into the webview too, which words the times against its own clock).
import { statusKey } from "../kanban/board";
import type { PlanView, PlannerStatus, Priority, TaskState, TaskView } from "../planner/types";
import { type PrFacts, prAttentionReasons, prSummaryLine } from "../shared/pr-review";
import type { SessionMeta, SessionStatus } from "../shared/protocol";
import { type GraphCard, dependencyGraph } from "../shared/session-graph";

// ---------- input: what the host reads from its stores ----------

export interface OverviewSession {
	id: string;
	title: string;
	/** Project display name (repository or folder). */
	project: string;
	status: SessionStatus;
	createdAt: number;
	updatedAt: number;
	cost?: number;
	lastText?: string;
	/** The planner's summary of the session's queue (`SessionMeta.queue`). */
	queue?: SessionMeta["queue"];
	/** The question or approval the session waits on. */
	question?: { title: string; approval: boolean };
	/** The Hermes kanban card that started it (tags `hermes:<board>`, `card:<id>`). */
	card?: { board?: string; card: string };
	prs: PrFacts[];
}

export interface OverviewOrchestrator {
	projectId: string;
	projectName: string;
	/** The orchestrator's session id (its chat). */
	id: string;
	active: boolean;
	status: SessionStatus;
	/** AO's status line for it. */
	displayStatus: string;
	harness?: string;
	model?: string;
	updatedAt: number;
	question?: { title: string; approval: boolean };
	counts: { workers: number; working: number; needsInput: number; idle: number; stopped: number; openPrs: number };
}

export interface OverviewInput {
	now: number;
	sessions: OverviewSession[];
	orchestrators: OverviewOrchestrator[];
	/** Undefined while the planner is unreachable. */
	plan: PlanView | undefined;
	plannerError?: string;
}

/** The overview's record of a session: its `SessionMeta` (with the planner's queue summary) plus what only the stores around it know. */
export function overviewSession(m: SessionMeta, extra: { project: string; question?: { title: string; kind: string }; card?: { board?: string; card: string }; prs: PrFacts[] }): OverviewSession {
	return {
		id: m.id,
		title: m.title,
		project: extra.project,
		status: m.status,
		createdAt: m.createdAt,
		updatedAt: m.updatedAt,
		...(m.cost && { cost: m.cost }),
		...(m.lastText && { lastText: m.lastText }),
		...(m.queue && { queue: m.queue }),
		...(m.status === "waiting" && extra.question && { question: { title: extra.question.title, approval: extra.question.kind === "approval" } }),
		...(extra.card && { card: extra.card }),
		prs: extra.prs,
	};
}

// ---------- the model the webview gets ----------

export type NeedKind = "question" | "approval" | "conflict" | "interrupted" | "failed";

export interface NeedsItem {
	key: string;
	kind: NeedKind;
	/** The session to open (the answer UI is its chat). */
	session: string;
	title: string;
	detail: string;
	project: string;
	since: number;
	card?: { board?: string; card: string };
	/** Set for an orchestrator: its project. */
	orchestrator?: string;
	/** A queue that can be requeued from here (interrupted or failed tasks). */
	requeue?: boolean;
}

export interface WorkingItem {
	session: string;
	title: string;
	project: string;
	since: number;
	progress?: { done: number; total: number; failed: number };
	lastText?: string;
	cost?: number;
	card?: { board?: string; card: string };
}

export interface NextItem {
	/** Planner task id. */
	task: string;
	title: string;
	/** The chat it runs in, when its session exists. */
	session?: string;
	queue?: string;
	state: "waiting" | "scheduled" | "blocked" | "paused";
	/** Start position among the tasks waiting for a slot. */
	position?: number;
	/** Scheduled start (or the time the wait lifts), epoch ms. */
	at?: number;
	reason?: string;
	blockedBy: Array<{ id: string; title: string }>;
	priority?: Priority;
}

export type HeldKind = "rate-limit" | "usage" | "budget" | "backoff" | "other";

export interface HeldGroup {
	kind: HeldKind;
	key: string;
	title: string;
	detail: string;
	/** When the hold lifts (the earliest of its tasks'), epoch ms. */
	until?: number;
	/** The provider a rate limit holds: it can be cleared. */
	provider?: string;
	tasks: Array<{ task: string; title: string; session?: string }>;
}

export interface BudgetMeter {
	window: "hour" | "day" | "week";
	cap: number;
	spent: number;
	/** Of the cap, 0 to 100. */
	percent: number;
	over: boolean;
	freesAt?: number;
}

export type UsageLevel = "ok" | "warn" | "hold";

export interface UsageMeter {
	provider: string;
	window: string;
	percent: number;
	resetsAt?: number;
	level: UsageLevel;
}

export interface LimitView {
	provider: string;
	until: number;
	reason: string;
	guessed: boolean;
}

export interface SchedulerView {
	running: number;
	waiting: number;
	scheduled: number;
	held: number;
	blocked: number;
	interrupted: number;
	/** 0 = unlimited. */
	limit: number;
	paused: boolean;
	budget: BudgetMeter[];
	usage: UsageMeter[];
	limits: LimitView[];
	thresholds: { holdAtPercent: number; spareBelowPercent: number };
	aoConnected: boolean;
	aoError?: string;
	defaultModel?: string;
}

export interface PrItem {
	session: string;
	sessionTitle: string;
	number: number;
	url: string;
	summary: string;
	reasons: string[];
}

export interface OrchestratorItem {
	projectId: string;
	name: string;
	session: string;
	active: boolean;
	status: SessionStatus;
	displayStatus: string;
	harness?: string;
	model?: string;
	updatedAt: number;
	question?: { title: string; approval: boolean };
	workers: OverviewOrchestrator["counts"];
}

export interface OverviewModel {
	now: number;
	planner: { reachable: boolean; error?: string };
	needsYou: NeedsItem[];
	working: WorkingItem[];
	nextUp: NextItem[];
	held: HeldGroup[];
	scheduler?: SchedulerView;
	orchestrators: OrchestratorItem[];
	prs: PrItem[];
	/** The sessions of the dependency graph (those with dependencies and those they wait for). */
	graph: GraphCard[];
}

// ---------- messages ----------

export type ToOverview = { type: "data"; model: OverviewModel };

export type SchedulerAction = "togglePause" | "increase" | "decrease" | "setConcurrency" | "setBudget" | "setUsage" | "configure";

export type FromOverview =
	| { type: "ready" }
	/** Open a session's chat; `answer` puts the cursor in the composer (the question or approval is answered there). */
	| { type: "openSession"; id: string; answer?: boolean }
	/** A planner task: its chat when it has run, else the Tasks view. */
	| { type: "openTask"; id: string }
	| { type: "runTask"; id: string }
	| { type: "requeue"; id: string }
	| { type: "changes"; id: string }
	| { type: "reviewPr"; session: string; pr: number }
	| { type: "openOrchestrator"; projectId: string }
	| { type: "openCard"; id: string }
	/** `provider`: clear just that provider's limit; without it, every provider's. */
	| { type: "clearLimits"; provider?: string }
	| { type: "scheduler"; action: SchedulerAction }
	| { type: "open"; what: "board" | "taskGraph" | "tasks" | "usage" };

// ---------- times, meters, hold kinds ----------

/** "under 1m", "14m", "2h 10m", "3d 4h": a span of time in the two largest units that matter. */
export function durationText(ms: number): string {
	const min = Math.floor(ms / 60_000);
	if (min < 1) return "under 1m";
	if (min < 60) return `${min}m`;
	const hours = Math.floor(min / 60);
	if (hours < 24) return min % 60 ? `${hours}h ${min % 60}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** "in 2h 10m", or "due now" once the time has come. */
export function inText(at: number, now: number): string {
	return at <= now ? "due now" : `in ${durationText(at - now)}`;
}

/** "14m ago", "just now". */
export function agoText(at: number, now: number): string {
	return now - at < 60_000 ? "just now" : `${durationText(now - at)} ago`;
}

/** A usage or spend figure as a 0–100 percent of its cap, for a meter (a bad number or no cap reads as 0). */
export function meterPercent(used: number, cap: number): number {
	if (!(cap > 0) || !(used > 0)) return 0;
	return Math.min(100, Math.round((used / cap) * 100));
}

/** Where a usage window stands against the planner's thresholds: at/above `holdAtPercent` it holds work, above `spareBelowPercent` spare tasks wait. */
export function usageLevel(percent: number, thresholds: { holdAtPercent: number; spareBelowPercent: number }): UsageLevel {
	if (percent >= thresholds.holdAtPercent) return "hold";
	return percent >= thresholds.spareBelowPercent ? "warn" : "ok";
}

/** What the planner's hold reasons (src/planner/usage.ts `holdFor`, the engine's backoff) are about. */
export function holdKind(reason: string | undefined): HeldKind {
	const r = reason ?? "";
	if (/^rate-limit\b/.test(r)) return "rate-limit";
	if (/^(spare: )?usage\b/.test(r)) return "usage";
	if (/^budget\b/.test(r)) return "budget";
	if (/^retry backoff\b/.test(r)) return "backoff";
	return "other";
}

const withoutUntil = (reason: string): string => reason.replace(/\s+until\s+\S.*$/, "");

/** A provider's error text as one short line: the `message` of a JSON error body, whitespace collapsed, cut at `max`. */
export function tidyReason(reason: string, max = 110): string {
	const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(reason)?.[1];
	const text = (message ?? reason).replace(/\\"/g, '"').replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------- sections ----------

const NEED_RANK: Record<NeedKind, number> = { approval: 0, question: 0, conflict: 1, interrupted: 2, failed: 3 };

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Questions, approvals, merge conflicts, interrupted and failed queues: the work only a person can move on, oldest first. */
export function needsYou(sessions: readonly OverviewSession[], orchestrators: readonly OverviewOrchestrator[]): NeedsItem[] {
	const out: NeedsItem[] = [];
	for (const s of sessions) {
		const base = { session: s.id, title: s.title, project: s.project, since: s.updatedAt, ...(s.card && { card: s.card }) };
		const conflict = s.queue?.sync?.state === "conflict";
		if (conflict) {
			const files = s.queue?.sync?.files ?? [];
			out.push({ ...base, key: `${s.id}:conflict`, kind: "conflict", detail: `Merge conflict${files.length ? `: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}` : ""}` });
		} else if (s.status === "waiting") {
			out.push({ ...base, key: `${s.id}:ask`, kind: s.question?.approval ? "approval" : "question", detail: s.question?.title ?? "Waiting for your answer" });
		}
		if (s.queue?.interrupted) out.push({ ...base, key: `${s.id}:interrupted`, kind: "interrupted", detail: `${plural(s.queue.interrupted, "task")} cut short: never re-run unattended`, requeue: true });
		else if (s.queue?.failed) out.push({ ...base, key: `${s.id}:failed`, kind: "failed", detail: `${plural(s.queue.failed, "task")} failed`, requeue: true });
	}
	for (const o of orchestrators) {
		if (o.status !== "waiting" || !o.active) continue;
		out.push({ key: `${o.id}:ask`, kind: o.question?.approval ? "approval" : "question", session: o.id, title: `${o.projectName} orchestrator`, detail: o.question?.title ?? "Waiting for your answer", project: o.projectName, since: o.updatedAt, orchestrator: o.projectId });
	}
	return out.sort((a, b) => NEED_RANK[a.kind] - NEED_RANK[b.kind] || a.since - b.since || a.key.localeCompare(b.key));
}

/** Sessions whose agent is busy, longest-running first. */
export function workingNow(sessions: readonly OverviewSession[]): WorkingItem[] {
	return sessions
		.filter(s => s.status === "working" || s.status === "starting")
		.sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
		.map(s => ({
			session: s.id,
			title: s.title,
			project: s.project,
			since: s.updatedAt,
			...(s.queue && s.queue.total > 0 && { progress: { done: s.queue.done, total: s.queue.total, failed: s.queue.failed ?? 0 } }),
			...(s.lastText && { lastText: s.lastText }),
			...(s.cost && { cost: s.cost }),
			...(s.card && { card: s.card }),
		}));
}

const NEXT_RANK: Record<NextItem["state"], number> = { waiting: 0, scheduled: 1, blocked: 2, paused: 3 };

/**
 * The timeline order: tasks ready for a free slot first (by start position), then scheduled starts by time, then
 * work that waits for another task, then paused work (in the planner's order). Ties keep the planner's order.
 */
export function orderNextUp(items: readonly NextItem[]): NextItem[] {
	return items
		.map((item, i) => ({ item, i }))
		.sort((a, b) => NEXT_RANK[a.item.state] - NEXT_RANK[b.item.state] || (a.item.state === "waiting" ? (a.item.position ?? Number.MAX_SAFE_INTEGER) - (b.item.position ?? Number.MAX_SAFE_INTEGER) : 0) || (a.item.state === "scheduled" ? (a.item.at ?? Number.MAX_SAFE_INTEGER) - (b.item.at ?? Number.MAX_SAFE_INTEGER) : 0) || a.i - b.i)
		.map(x => x.item);
}

/** The session a planner task's chat is: its own, else its queue's, when AO has it. */
function chatOf(plan: PlanView, task: TaskView, known: ReadonlySet<string>): string | undefined {
	const lane = task.lane ? plan.lanes.find(l => l.id === task.lane) : undefined;
	return [task.session, lane?.session, lane?.id].find((id): id is string => id !== undefined && known.has(id));
}

const isNextState = (state: TaskState): state is NextItem["state"] => state === "waiting" || state === "scheduled" || state === "blocked" || state === "paused";

/** What the planner will start, in timeline order. Held and interrupted work is `held`/`needsYou`. */
export function nextUp(plan: PlanView, known: ReadonlySet<string>): NextItem[] {
	const titles = new Map(plan.tasks.map(t => [t.id, t.title]));
	const items: NextItem[] = [];
	for (const t of plan.tasks) {
		if (t.status !== "pending" || !isNextState(t.state)) continue;
		const lane = t.lane ? plan.lanes.find(l => l.id === t.lane) : undefined;
		const session = chatOf(plan, t, known);
		const state = t.state;
		const at = state === "scheduled" ? (t.waitUntil ?? t.startAt) : undefined;
		items.push({
			task: t.id,
			title: t.title,
			...(session && { session }),
			...(lane && { queue: lane.title ?? lane.id }),
			state,
			...(t.position !== undefined && { position: t.position }),
			...(at !== undefined && { at }),
			...(t.waitReason && { reason: t.waitReason }),
			blockedBy: (t.blockedBy ?? []).map(id => ({ id, title: titles.get(id) ?? `missing task ${id}` })),
			...(t.priority && t.priority !== "normal" && { priority: t.priority }),
		});
	}
	return orderNextUp(items);
}

interface GroupSeed {
	kind: HeldKind;
	key: string;
	title: string;
	detail: string;
}

/** The group a held task belongs to: its cause, named the way the planner worded it (a provider, a usage window, a budget window). */
function seedOf(task: TaskView, status: PlannerStatus): GroupSeed {
	const reason = task.waitReason ?? "held";
	const kind = holdKind(reason);
	switch (kind) {
		case "rate-limit": {
			const provider = /^rate-limit (\S+)/.exec(reason)?.[1] ?? "provider";
			return { kind, key: `rate-limit:${provider}`, title: `${provider} rate limit`, detail: tidyReason(status.limits.find(l => l.provider === provider)?.reason ?? "") };
		}
		case "usage": {
			const window = status.usageWindows.find(w => reason.includes(`${w.provider} ${w.window}`));
			return window ? usageSeed(window.provider, window.window, window.usedPercent) : { kind, key: `usage:${withoutUntil(reason)}`, title: "Usage window", detail: withoutUntil(reason) };
		}
		case "budget": {
			const window = /^budget (hour|day|week)/.exec(reason)?.[1] ?? "";
			return { kind, key: `budget:${window}`, title: `${window} budget`.trim(), detail: withoutUntil(reason).replace(/^budget\s+\S+\s*/, "") };
		}
		case "backoff":
			return { kind, key: "backoff", title: "Retry backoff", detail: "a failed task waits before its next attempt" };
		case "other":
			return { kind, key: `other:${withoutUntil(reason)}`, title: withoutUntil(reason), detail: "" };
	}
}

function usageSeed(provider: string, window: string, percent: number): GroupSeed {
	return { kind: "usage", key: `usage:${provider} ${window}`, title: `${provider} ${window} usage`, detail: `${Math.round(percent)}% used` };
}

/**
 * Everything that holds work back, one group per cause: a provider rate limit, a usage window at the hold
 * threshold, a spend cap that is reached, a retry backoff. A group lists the tasks it holds (a limit or cap that
 * holds none yet still shows: the next task would wait) and when it lifts.
 */
export function heldGroups(plan: PlanView, known: ReadonlySet<string>, now: number): HeldGroup[] {
	const { status } = plan;
	const groups = new Map<string, HeldGroup>();
	const ensure = (seed: GroupSeed, provider?: string): HeldGroup => {
		let g = groups.get(seed.key);
		if (!g) {
			g = { ...seed, ...(provider && { provider }), tasks: [] };
			groups.set(seed.key, g);
		}
		return g;
	};
	const lift = (g: HeldGroup, at: number | undefined): void => {
		if (at !== undefined && at > now && (g.until === undefined || at < g.until)) g.until = at;
	};
	for (const l of status.limits) {
		if (l.until <= now) continue;
		const g = ensure({ kind: "rate-limit", key: `rate-limit:${l.provider}`, title: `${l.provider} rate limit`, detail: `${tidyReason(l.reason)}${l.guessed ? " (a guess: the error gave no reset time)" : ""}`.trim() }, l.provider);
		lift(g, l.until);
	}
	for (const w of status.usageWindows) {
		if (w.usedPercent < status.usage.holdAtPercent) continue;
		lift(ensure(usageSeed(w.provider, w.window, w.usedPercent)), w.resetsAt);
	}
	for (const s of status.spend) {
		if (!s.over) continue;
		lift(ensure({ kind: "budget", key: `budget:${s.window}`, title: `${s.window} budget`, detail: `$${s.spent.toFixed(2)} of $${s.cap} spent` }), s.freesAt);
	}
	for (const t of plan.tasks) {
		if (t.status !== "pending" || t.state !== "held") continue;
		const seed = seedOf(t, status);
		const g = ensure(seed, seed.kind === "rate-limit" ? seed.key.slice("rate-limit:".length) : undefined);
		g.tasks.push({ task: t.id, title: t.title, ...(chatOf(plan, t, known) && { session: chatOf(plan, t, known) }) });
		lift(g, t.waitUntil);
	}
	const RANK: Record<HeldKind, number> = { "rate-limit": 0, usage: 1, budget: 2, backoff: 3, other: 4 };
	return [...groups.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.until ?? Number.MAX_SAFE_INTEGER) - (b.until ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title));
}

export function schedulerView(status: PlannerStatus, now: number): SchedulerView {
	const thresholds = { holdAtPercent: status.usage.holdAtPercent, spareBelowPercent: status.usage.spareBelowPercent };
	return {
		running: status.running,
		waiting: status.waiting,
		scheduled: status.scheduled,
		held: status.held,
		blocked: status.blocked,
		interrupted: status.interrupted,
		limit: status.maxConcurrent,
		paused: status.paused,
		budget: status.spend.map(s => ({ window: s.window, cap: s.cap, spent: s.spent, percent: meterPercent(s.spent, s.cap), over: s.over, ...(s.freesAt && { freesAt: s.freesAt }) })),
		usage: status.usageWindows.map(w => ({ provider: w.provider, window: w.window, percent: Math.min(100, Math.max(0, Math.round(w.usedPercent))), ...(w.resetsAt && w.resetsAt > now && { resetsAt: w.resetsAt }), level: usageLevel(w.usedPercent, thresholds) })),
		limits: status.limits.filter(l => l.until > now).map(l => ({ provider: l.provider, until: l.until, reason: tidyReason(l.reason), guessed: l.guessed === true })),
		thresholds,
		aoConnected: status.ao.connected,
		...(status.ao.error && !status.ao.connected && { aoError: status.ao.error }),
		...(status.defaults?.model && { defaultModel: status.defaults.model }),
	};
}

/** Open pull requests that need someone (failing CI, changes requested, conflicts), newest first. */
export function prsNeedingAttention(sessions: readonly OverviewSession[]): PrItem[] {
	const out: Array<PrItem & { updatedAt: number }> = [];
	for (const s of sessions) {
		for (const pr of s.prs) {
			const reasons = prAttentionReasons(pr);
			if (reasons.length) out.push({ session: s.id, sessionTitle: s.title, number: pr.number, url: pr.url, summary: prSummaryLine(pr), reasons, updatedAt: Date.parse(pr.updatedAt) || 0 });
		}
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt || a.session.localeCompare(b.session) || a.number - b.number).map(({ updatedAt: _u, ...item }) => item);
}

/** Orchestrators that exist, running ones first, then by recent activity. */
export function orchestratorItems(orchestrators: readonly OverviewOrchestrator[]): OrchestratorItem[] {
	return [...orchestrators]
		.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt || a.projectName.localeCompare(b.projectName))
		.map(o => ({
			projectId: o.projectId,
			name: o.projectName,
			session: o.id,
			active: o.active,
			status: o.status,
			displayStatus: o.displayStatus,
			...(o.harness && { harness: o.harness }),
			...(o.model && { model: o.model }),
			updatedAt: o.updatedAt,
			...(o.question && { question: o.question }),
			workers: o.counts,
		}));
}

/** The sessions the dependency graph shows (one with dependencies, and the ones it waits for), as graph cards. */
export function graphSessions(sessions: readonly OverviewSession[]): GraphCard[] {
	const cards = sessions.map((s): GraphCard => {
		const q = s.queue;
		return {
			id: s.id,
			title: s.title,
			project: s.project,
			createdAt: s.createdAt,
			state: statusKey({ status: s.status, queue: q, blockedBy: q?.blockedBy, waiting: q?.waiting, sync: q?.sync, completed: q?.completed }),
			...(q && { queue: q }),
			...(q?.after && { after: q.after }),
			...(q?.blockedBy && { blockedBy: q.blockedBy }),
			...(q?.sync && { sync: q.sync }),
		};
	});
	return dependencyGraph(cards).nodes;
}

export function buildOverview(input: OverviewInput): OverviewModel {
	const { now, plan } = input;
	const known = new Set(input.sessions.map(s => s.id));
	return {
		now,
		planner: { reachable: plan !== undefined, ...(input.plannerError && !plan && { error: input.plannerError }) },
		needsYou: needsYou(input.sessions, input.orchestrators),
		working: workingNow(input.sessions),
		nextUp: plan ? nextUp(plan, known) : [],
		held: plan ? heldGroups(plan, known, now) : [],
		...(plan && { scheduler: schedulerView(plan.status, now) }),
		orchestrators: orchestratorItems(input.orchestrators),
		prs: prsNeedingAttention(input.sessions),
		graph: graphSessions(input.sessions),
	};
}

