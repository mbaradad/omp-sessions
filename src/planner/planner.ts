// The planner service core: holds the plan, persists every change before acting on it, dispatches ready
// tasks to AO and follows their turns through AO's event stream (with polling as a fallback). The
// socket API (api.ts) and the process (main.ts) sit on top; AO sits behind AoPort.
//
// Dispatch is a sequence of idempotent AO steps recorded in task.run before each call (spawn with
// clientRequestId, then optional settings, then message with clientMessageId). A restarted planner
// replays the outstanding steps: AO answers a replayed spawn or message with what it already made,
// so nothing runs twice. A run AO lost (session deleted or killed, turn recovered/interrupted by
// someone else) becomes `interrupted` and is never re-run unattended.
import { type AoConversationInfo, type AoPort, transientAoError } from "./ao-port";
import { queueOpsToPlanOps, queueView } from "./compat";
import { type Outcome, PlanError, advance, applyOps, effectiveOptions, emptyState, evaluate, finishRun, laneOf, laneViews, nextWake, normalizeConfig, startRun, taskPrompt } from "./engine";
import { savePlan } from "./store";
import type { PlanOp, PlanState, PlanView, PlannerConfig, PlannerStatus, QueueOp, QueueView, Task, TaskStatus, TaskView, UsageWindow } from "./types";
import { activeLimits, providerOf, pruneLimits, pruneSpend, spendUse } from "./usage";

export interface PlannerOptions {
	/** plan.json; undefined keeps the plan in memory (tests). */
	file?: string;
	initial?: PlanState;
	/** Connects to AO; called again while it fails. */
	connect: () => Promise<AoPort>;
	/** Provider usage windows (omp usage); undefined: none. */
	usage?: () => Promise<UsageWindow[]>;
	usageEveryMs?: number;
	log?: (...parts: unknown[]) => void;
	now?: () => number;
	version?: string;
	retryBaseMs?: number;
	/** Fallback poll of running tasks (events usually come first). */
	pollMs?: number;
}

/** AO activity states that mean someone else's turn is going on (or waits for a person). */
const BUSY_ACTIVITY: Record<string, true> = { active: true, waiting_input: true, blocked: true };
/** A spawn AO keeps reporting as not committed after this many tries is given up as lost. */
const MAX_INCOMPLETE_TRIES = 12;
const MAX_TIMER_MS = 2 ** 31 - 1;

export class Planner {
	state: PlanState;
	readonly startedAt: number;
	private ao: AoPort | undefined;
	private aoError: string | undefined;
	private aoConnected = false;
	private lastEventAt: number | undefined;
	private stream: { close(): void } | undefined;
	private connecting = false;
	private stopped = false;
	/** AO session → activity state (from listings and events). */
	private readonly activity = new Map<string, string>();
	private windows: UsageWindow[] = [];
	/** Tasks between "chosen" and "dispatch record written" (project lookup in flight). */
	private readonly preparing = new Set<string>();
	/** Tasks with an AO step or check in flight. */
	private readonly busy = new Set<string>();
	/** Tasks to look at again once their in-flight step ends. */
	private readonly recheck = new Set<string>();
	private readonly interruptSent = new Set<string>();
	private tickTimer: NodeJS.Timeout | undefined;
	private tickDue = 0;
	private pollTimer: NodeJS.Timeout | undefined;
	private usageTimer: NodeJS.Timeout | undefined;
	private readonly retryTimers = new Map<string, NodeJS.Timeout>();
	private readonly listeners = new Set<(change: { plan?: true; task?: { task: TaskView; from: TaskStatus } }) => void>();

	constructor(private readonly opts: PlannerOptions) {
		this.state = opts.initial ?? emptyState();
		this.startedAt = this.now();
	}

	private now(): number {
		return this.opts.now?.() ?? Date.now();
	}

	private log(...parts: unknown[]): void {
		this.opts.log?.(...parts);
	}

	// ---------- lifecycle ----------

	start(): void {
		this.stopped = false;
		void this.connect();
		this.pollTimer = setInterval(() => this.poll(), this.opts.pollMs ?? 10_000);
		if (this.opts.usage) {
			void this.refreshUsage();
			this.usageTimer = setInterval(() => void this.refreshUsage(), this.opts.usageEveryMs ?? 5 * 60_000);
		}
		this.schedule(0);
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.tickTimer);
		clearInterval(this.pollTimer);
		clearInterval(this.usageTimer);
		for (const t of this.retryTimers.values()) clearTimeout(t);
		this.retryTimers.clear();
		this.stream?.close();
	}

	onChange(listener: (change: { plan?: true; task?: { task: TaskView; from: TaskStatus } }) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async connect(): Promise<void> {
		if (this.connecting || this.ao || this.stopped) return;
		this.connecting = true;
		try {
			this.ao = await this.opts.connect();
			this.aoError = undefined;
			this.log("connected to AO", this.ao.url);
			this.stream = this.ao.subscribe(undefined, {
				onEvent: (_seq, session, activity) => this.onAoEvent(session, activity),
				onOpen: () => {
					this.aoConnected = true;
					this.aoError = undefined;
					this.lastEventAt = this.now();
					// Events may have been missed while the stream was down: look at everything again.
					void this.refreshActivity();
					this.poll();
					this.emit();
				},
				onDown: error => {
					this.aoConnected = false;
					this.aoError = error;
					this.emit();
				},
			});
		} catch (err) {
			this.aoError = err instanceof Error ? err.message : String(err);
			setTimeout(() => void this.connect(), 5000).unref();
		} finally {
			this.connecting = false;
		}
	}

	private onAoEvent(session: string | undefined, activity: string | undefined): void {
		this.lastEventAt = this.now();
		if (!session) return;
		const before = this.activity.get(session);
		if (activity) this.activity.set(session, activity);
		for (const t of this.state.tasks) if (t.status === "running" && t.run?.session === session) this.follow(t.id, 250);
		// A session we wait on went idle (or busy): readiness may change.
		if (activity !== before && this.state.lanes.some(l => l.session === session)) this.schedule(100);
	}

	private async refreshActivity(): Promise<void> {
		if (!this.ao) return;
		try {
			const sessions = await this.ao.activeSessions();
			this.activity.clear();
			for (const s of sessions) if (s.activity) this.activity.set(s.id, s.activity);
			this.schedule(0);
		} catch (err) {
			this.log("listing AO sessions failed", String(err));
		}
	}

	private async refreshUsage(): Promise<void> {
		try {
			this.windows = (await this.opts.usage?.()) ?? [];
			this.schedule(0);
		} catch (err) {
			this.log("usage refresh failed", String(err));
		}
	}

	/** Checks every running task (fallback for missed events, and after restarts). */
	private poll(): void {
		for (const t of this.state.tasks) if (t.status === "running") this.follow(t.id, 0);
	}

	// ---------- state changes ----------

	/** Applies `mutate` to the plan, persists it and tells listeners (task transitions included). */
	private commit(mutate: (s: PlanState) => void): void {
		const before = new Map(this.state.tasks.map(t => [t.id, t.status]));
		mutate(this.state);
		this.state.rev++;
		if (this.opts.file) savePlan(this.opts.file, this.state);
		const changed = this.state.tasks.filter(t => before.has(t.id) && before.get(t.id) !== t.status);
		if (changed.length) {
			const views = new Map(this.evaluateNow().views.map(v => [v.id, v]));
			for (const t of changed) {
				const view = views.get(t.id);
				if (view) for (const l of this.listeners) l({ task: { task: view, from: before.get(t.id) as TaskStatus } });
			}
		}
		this.emit();
	}

	private emit(): void {
		for (const l of this.listeners) l({ plan: true });
	}

	edit(ops: PlanOp[], rev?: number): { rev: number; refs: Record<string, string> } {
		if (rev !== undefined && rev !== this.state.rev) throw new PlanError(`stale rev ${rev} (the plan is at ${this.state.rev}); reload and retry`);
		const res = applyOps(this.state, ops, this.now());
		this.commit(s => Object.assign(s, res.state));
		for (const e of res.effects) this.follow(e.task, 0);
		this.schedule(0);
		return { rev: this.state.rev, refs: res.refs };
	}

	/** Old `queue` op: QueueOps on a lane (or on the session lane of an AO session id). */
	async queue(lane: string, ops: QueueOp[]): Promise<QueueView> {
		if (!this.state.lanes.some(l => l.id === lane) && !/^l_[0-9a-f]{10}$/.test(lane)) {
			// A new session lane must name a session AO knows.
			if (this.ao && !(await this.ao.session(lane))) throw new PlanError(`unknown session ${lane}`);
		}
		this.edit(queueOpsToPlanOps(this.state, lane, ops));
		return this.getQueue(lane);
	}

	getQueue(lane: string): QueueView {
		return queueView(this.state, this.evaluateNow().views, lane);
	}

	setConfig(set: Partial<PlannerConfig> | undefined): PlannerStatus {
		if (set && Object.keys(set).length) {
			const config = normalizeConfig({ ...this.state.config, ...set, usage: { ...this.state.config.usage, ...set.usage } }, this.state.config);
			this.commit(s => {
				s.config = config;
			});
			this.schedule(0);
		}
		return this.status();
	}

	// ---------- views ----------

	private usageContext() {
		const now = this.now();
		return { limits: activeLimits(this.state.limits, now), windows: this.windows, spend: spendUse(this.state.spend, this.state.config.budget, now), config: this.state.config.usage };
	}

	private busySessions(): Set<string> {
		const out = new Set<string>();
		for (const [id, a] of this.activity) if (BUSY_ACTIVITY[a]) out.add(id);
		// Sessions our own runs use are busy through their running task; activity lags behind events.
		for (const t of this.state.tasks) if (t.status === "running" && t.run?.session) out.delete(t.run.session);
		return out;
	}

	private evaluateNow() {
		return evaluate(this.state, { now: this.now(), busySessions: this.busySessions(), usage: this.usageContext() });
	}

	view(lane?: string, all = false): PlanView {
		const now = this.now();
		const { views } = this.evaluateNow();
		const weekAgo = now - 7 * 86_400_000;
		const tasks = views
			.filter(t => (!lane || t.lane === lane) && (all || !((t.state === "done" || t.state === "skipped") && (t.finishedAt ?? now) < weekAgo)))
			.map(t => (t.waitReason === "starting" && !this.ao ? { ...t, waitReason: `waiting for AO (${this.aoError ?? "not connected"})` } : t));
		return { rev: this.state.rev, tasks, lanes: laneViews(this.state).filter(l => !lane || l.id === lane), recurring: this.state.recurring, status: this.status(views) };
	}

	status(views: TaskView[] = this.evaluateNow().views): PlannerStatus {
		const usage = this.usageContext();
		const count = (st: TaskView["state"]) => views.filter(v => v.state === st).length;
		return {
			...this.state.config,
			running: count("running"),
			waiting: count("waiting"),
			scheduled: count("scheduled"),
			held: count("held"),
			blocked: count("blocked"),
			interrupted: count("interrupted"),
			limits: usage.limits,
			usageWindows: this.windows,
			spend: usage.spend,
			ao: { ...(this.ao ? { url: this.ao.url } : {}), connected: this.aoConnected, ...(this.lastEventAt ? { lastEventAt: this.lastEventAt } : {}), ...(this.aoError ? { error: this.aoError } : {}) },
			version: this.opts.version ?? "dev",
			startedAt: this.startedAt,
		};
	}

	// ---------- scheduling ----------

	/** Runs a scheduling pass within `delay` ms (an earlier pending pass is kept). */
	schedule(delay = 300): void {
		if (this.stopped) return;
		const due = this.now() + delay;
		if (this.tickTimer && this.tickDue <= due) return;
		clearTimeout(this.tickTimer);
		this.tickDue = due;
		this.tickTimer = setTimeout(
			() => {
				this.tickTimer = undefined;
				this.tick();
			},
			Math.max(0, Math.min(delay, MAX_TIMER_MS)),
		);
	}

	/** One pass: time-driven changes, then dispatch what is ready. */
	tick(): void {
		const now = this.now();
		try {
			// advance only adds tasks and arms lanes (no status transitions): mutate, then persist.
			if (advance(this.state, now)) this.commit(() => {});
			if (pruneLimits(this.state.limits, now) || pruneSpend(this.state.spend, now)) this.commit(() => {});
			const ev = this.evaluateNow();
			if (this.ao) for (const t of ev.dispatch) if (!this.preparing.has(t.id)) void this.launch(t.id);
			const wake = nextWake(this.state, now, ev.holdUntil);
			if (wake !== undefined) this.schedule(wake - now + 50);
		} catch (err) {
			this.log("scheduling pass failed", err instanceof Error ? (err.stack ?? err.message) : String(err));
			this.schedule(2000);
		}
	}

	// ---------- dispatch ----------

	/** Chooses spawn or send, resolves the project, writes the dispatch record, then drives it. */
	private async launch(id: string): Promise<void> {
		const ao = this.ao;
		if (!ao) return;
		this.preparing.add(id);
		try {
			const task = this.state.tasks.find(t => t.id === id);
			if (!task || task.status !== "pending") return;
			const opts = effectiveOptions(this.state, task);
			const lane = laneOf(this.state, task);
			const prompt = taskPrompt(this.state, task);
			const key = `planner-${task.id}-${(task.attempts ?? 0) + 1}-${this.now().toString(36)}`;
			const provider = providerOf(opts.model);
			const session = !opts.freshContext ? lane?.session : undefined;
			let spawn: Record<string, unknown> | undefined;
			let sendAfterSpawn = false;
			if (!session) {
				let projectId: string | undefined = opts.project;
				if (!projectId && opts.cwd) projectId = await ao.projectFor(opts.cwd);
				if (opts.worktree === "always" && !projectId) throw new PlanError(`worktree "always" needs a git folder; ${opts.cwd ?? "no cwd"} is not in git`);
				sendAfterSpawn = !!opts.thinking;
				spawn = {
					harness: "omp",
					mode: "chat",
					kind: "worker",
					displayName: task.title.slice(0, 100),
					clientRequestId: key,
					...(projectId ? { projectId } : {}),
					...(opts.model ? { model: opts.model } : {}),
					...(opts.approvalMode ? { approvalMode: opts.approvalMode } : {}),
					...(sendAfterSpawn ? {} : { prompt }),
				};
			}
			// The task may have changed while the project was looked up.
			const now = this.now();
			if (!this.evaluateNow().dispatch.some(t => t.id === id)) return;
			this.commit(s => {
				startRun(
					s,
					id,
					{
						key,
						via: session ? "send" : "spawn",
						prompt,
						...(spawn ? { spawn } : {}),
						...(sendAfterSpawn ? { sendAfterSpawn: true, settings: { thinking: opts.thinking } } : {}),
						...(session ? { session } : {}),
						...(session && (opts.model || opts.thinking) ? { settings: { ...(opts.model ? { model: opts.model } : {}), ...(opts.thinking ? { thinking: opts.thinking } : {}) } } : {}),
						...(provider ? { provider } : {}),
					},
					now,
				);
			});
			this.log("dispatch", id, JSON.stringify(task.title), session ? `→ ${session}` : "→ new session");
		} catch (err) {
			this.log("dispatch failed", id, String(err));
			const task = this.state.tasks.find(t => t.id === id);
			// A launch that never reached AO: a plain failed attempt (the retry rules apply).
			if (task?.status === "pending" && !transientAoError(err)) {
				this.commit(s => {
					const t = s.tasks.find(x => x.id === id);
					if (!t) return;
					t.status = "running";
					t.startedAt = this.now();
					finishRun(s, id, { kind: "error", error: { message: err instanceof Error ? err.message : String(err) } }, this.now(), this.opts.retryBaseMs);
				});
			}
			this.schedule(transientAoError(err) ? 5000 : 0);
			return;
		} finally {
			this.preparing.delete(id);
		}
		this.follow(id, 0);
	}

	/** Drives or checks task `id` after `delay` ms (coalesced; one AO step per task at a time). */
	private follow(id: string, delay: number): void {
		if (this.stopped || this.retryTimers.has(id)) return;
		const run = () => {
			this.retryTimers.delete(id);
			if (this.busy.has(id)) {
				this.recheck.add(id);
				return;
			}
			this.busy.add(id);
			void this.step(id).finally(() => {
				this.busy.delete(id);
				if (this.recheck.delete(id)) this.follow(id, 0);
			});
		};
		if (delay <= 0) {
			run();
			return;
		}
		this.retryTimers.set(id, setTimeout(run, delay));
	}

	private task(id: string): Task | undefined {
		const t = this.state.tasks.find(x => x.id === id);
		return t?.status === "running" && t.run ? t : undefined;
	}

	/** Records `mutate` on the running task `id` (if it still is). */
	private updateRun(id: string, mutate: (t: Task & { run: NonNullable<Task["run"]> }) => void): void {
		this.commit(s => {
			const t = s.tasks.find(x => x.id === id);
			if (t?.status === "running" && t.run) mutate(t as Task & { run: NonNullable<Task["run"]> });
		});
	}

	private finish(id: string, outcome: Outcome): void {
		const t = this.task(id);
		if (!t) return;
		this.log("finished", id, outcome.kind, outcome.kind === "error" ? outcome.error.message : outcome.kind === "lost" ? outcome.reason : "");
		this.interruptSent.delete(id);
		this.commit(s => {
			finishRun(s, id, outcome, this.now(), this.opts.retryBaseMs);
		});
		this.schedule(0);
	}

	private async step(id: string): Promise<void> {
		const ao = this.ao;
		const t = this.task(id);
		if (!ao || !t?.run) return;
		try {
			if (t.run.phase === "dispatching") await this.drive(ao, id);
			else await this.check(ao, id);
		} catch (err) {
			const live = this.task(id);
			if (!live?.run) return;
			if (transientAoError(err)) {
				const tries = (live.run.tries ?? 0) + 1;
				const incomplete = err instanceof Error && "code" in err && err.code === "CLIENT_REQUEST_INCOMPLETE";
				if (incomplete && tries >= MAX_INCOMPLETE_TRIES) {
					this.finish(id, { kind: "lost", reason: "AO never finished creating its session." });
					return;
				}
				if (live.run.phase === "dispatching") this.updateRun(id, x => (x.run.tries = tries));
				this.log("AO step failed, will retry", id, String(err));
				this.follow(id, Math.min(60_000, 1000 * 2 ** Math.min(tries, 6)));
				return;
			}
			if (live.run.phase === "dispatching") {
				// AO refused the dispatch itself (bad model, unknown project, …): a failed attempt.
				this.finish(id, { kind: "error", error: { message: err instanceof Error ? err.message : String(err) } });
				return;
			}
			this.log("checking the run failed", id, String(err));
			this.follow(id, 10_000);
		}
	}

	/** Carries out the dispatch steps still outstanding; each is idempotent in AO. */
	private async drive(ao: AoPort, id: string): Promise<void> {
		let t = this.task(id);
		if (!t?.run) return;
		if (t.run.via === "spawn" && !t.run.session) {
			const { session } = await ao.spawn(t.run.spawn ?? {});
			this.updateRun(id, x => {
				x.run.session = session;
				x.session = session;
				delete x.run.tries;
			});
			t = this.task(id);
			if (!t?.run) return;
		}
		const session = t.run.session as string;
		if (t.run.via === "send" || t.run.sendAfterSpawn) {
			if (t.run.via === "send") {
				const info = await ao.session(session);
				if (!info) {
					this.finish(id, { kind: "lost", reason: `AO session ${session} no longer exists.` });
					return;
				}
				if (info.terminated) await ao.restore(session);
				if (t.run.baseCost === undefined) {
					const conv = await ao.conversation(session);
					this.updateRun(id, x => (x.run.baseCost = conv.cost ?? 0));
				}
			}
			const settings = t.run.settings;
			if (settings && !t.run.restore) {
				const restore: { model?: string; thinking?: string } = {};
				if (settings.model) {
					const prev = await ao.setModel(session, settings.model);
					if (prev && prev !== settings.model) restore.model = prev;
				}
				if (settings.thinking) {
					const prev = await ao.setThinking(session, settings.thinking);
					if (prev && prev !== settings.thinking) restore.thinking = prev;
				}
				// A fresh session has nothing to put back.
				this.updateRun(id, x => (x.run.restore = x.run.via === "send" ? restore : {}));
			}
			const live = this.task(id);
			if (!live?.run) return;
			const res = await ao.send(session, live.run.prompt, live.run.key);
			this.updateRun(id, x => {
				if (res.turn) x.run.turn = res.turn;
				x.run.phase = "sent";
				delete x.run.tries;
			});
		} else {
			this.updateRun(id, x => {
				x.run.phase = "sent";
				delete x.run.tries;
			});
		}
		this.follow(id, 500);
	}

	/** Follows the task's turn in AO; records the outcome once the turn is over. */
	private async check(ao: AoPort, id: string): Promise<void> {
		const t = this.task(id);
		const run = t?.run;
		if (!t || !run?.session) return;
		const session = run.session;
		let conv: AoConversationInfo;
		try {
			conv = await ao.conversation(session);
		} catch (err) {
			if (err instanceof Error && "status" in err && err.status === 404) {
				this.finish(id, { kind: "lost", reason: `AO session ${session} was deleted.` });
				return;
			}
			throw err;
		}
		let turnId = run.turn;
		if (!turnId) {
			if (run.via === "spawn" && !run.sendAfterSpawn) turnId = [...conv.turns].sort((a, b) => a.requestedAt - b.requestedAt)[0]?.id;
			else turnId = conv.messages.find(m => m.clientMessageId === run.key)?.turnId;
			if (turnId) {
				const found = turnId;
				this.updateRun(id, x => (x.run.turn = found));
			}
		}
		const turn = turnId ? conv.turns.find(x => x.id === turnId) : undefined;
		if (!turn) {
			const info = await ao.session(session);
			if (!info || info.terminated) this.finish(id, { kind: "lost", reason: `AO session ${session} ${info ? "was stopped" : "was deleted"} before the task's turn started.` });
			return;
		}
		if (turn.state === "queued" || turn.state === "running") {
			const timeout = effectiveOptions(this.state, t).timeoutMinutes;
			if (timeout && !run.timedOut && this.now() - (t.startedAt ?? this.now()) > timeout * 60_000) {
				this.log("task timed out", id);
				this.updateRun(id, x => (x.run.timedOut = true));
			}
			const live = this.task(id);
			if ((live?.run?.timedOut || live?.run?.aborted) && !this.interruptSent.has(id)) {
				this.interruptSent.add(id);
				await ao.interrupt(session);
			}
			if (timeout) this.follow(id, 30_000);
			return;
		}
		const cost = conv.cost !== undefined ? Math.max(0, conv.cost - (run.baseCost ?? 0)) : undefined;
		const costPart = cost ? { cost } : {};
		// Put the session's model and thinking back the way they were (best effort).
		if (run.restore?.model) await ao.setModel(session, run.restore.model).catch(err => this.log("model restore failed", String(err)));
		if (run.restore?.thinking) await ao.setThinking(session, run.restore.thinking).catch(err => this.log("thinking restore failed", String(err)));
		switch (turn.state) {
			case "completed": {
				const reply = conv.messages.filter(m => m.turnId === turn.id && m.role === "assistant" && !m.streaming).pop()?.text;
				this.finish(id, { kind: "completed", ...(reply ? { summary: reply } : {}), ...costPart });
				return;
			}
			case "failed": {
				const reset = turn.usageLimitResetsAt ? ` Usage limit reached; resets at ${new Date(turn.usageLimitResetsAt).toISOString()}.` : "";
				this.finish(id, { kind: "error", error: { message: `${turn.errorMessage ?? "The turn failed."}${reset}`, ...(run.provider ? { provider: run.provider } : {}) }, ...costPart });
				return;
			}
			case "interrupted":
			case "cancelled":
				this.finish(id, { kind: "interrupted", reason: run.aborted || run.timedOut ? undefined : "the turn was stopped in AO", ...costPart });
				return;
			case "recovered":
				this.finish(id, { kind: "lost", reason: "AO lost track of the turn (its agent host went away)." });
				return;
		}
	}
}
