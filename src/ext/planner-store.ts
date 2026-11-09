// One planner connection per VS Code window: the latest PlanView (pushed by the planner's `plan`
// subscription), task transitions, and the edit calls the Tasks view, the board and the chat use.
// The planner owns queues, schedules and the global concurrency limit (PLANNER-API.md); this is only
// a cache of what it last said plus a reconnect loop.
import * as vscode from "vscode";
import { PlannerClient, ensurePlanner } from "../planner/client";
import type { PlanOp, PlanView, PlannerConfig, PlannerStatus, QueueOp, QueueView, TaskStatus, TaskView } from "../planner/types";

const RECONNECT_MS = [500, 1000, 2000, 5000];

export class PlannerStore implements vscode.Disposable {
	private client: PlannerClient | undefined;
	private connecting: Promise<PlannerClient> | undefined;
	private retry: NodeJS.Timeout | undefined;
	private failures = 0;
	private disposed = false;
	private current: PlanView | undefined;
	private lastError: string | undefined;
	private readonly planEmitter = new vscode.EventEmitter<PlanView | undefined>();
	private readonly taskEmitter = new vscode.EventEmitter<{ task: TaskView; from: TaskStatus }>();
	/** The plan changed (undefined: the planner went away). */
	readonly onDidChange = this.planEmitter.event;
	/** A task changed status (sounds, notifications). */
	readonly onDidTransition = this.taskEmitter.event;

	/** `script`: the planner's `planner.js`, started (user service, else detached) when none answers; undefined: only connect. */
	constructor(private readonly script?: string) {
		void this.connect().catch(() => undefined);
	}

	get plan(): PlanView | undefined {
		return this.current;
	}

	/** Why there is no plan (the planner is unreachable), for empty views. */
	get error(): string | undefined {
		return this.current ? undefined : this.lastError;
	}

	/** Applies edits; afterwards `plan` already reflects them (commands that follow each other decide from it). */
	async edit(ops: PlanOp[]): Promise<Record<string, string>> {
		const client = await this.connect();
		const { refs } = await client.request("edit", { ops });
		await this.refresh(client);
		return refs;
	}

	/** The old per-session queue ops on a lane (or AO session id): for code ported from the queue model. */
	async queue(id: string, ops: QueueOp[]): Promise<QueueView> {
		const client = await this.connect();
		const view = await client.request("queue", { id, ops });
		await this.refresh(client);
		return view;
	}

	async scheduler(set?: Partial<PlannerConfig>): Promise<PlannerStatus> {
		const client = await this.connect();
		return client.request("scheduler", set ? { set } : {});
	}

	private async refresh(client: PlannerClient): Promise<void> {
		try {
			const plan = await client.request("plan", {});
			// The pushed snapshot may be newer already (rev only grows).
			if (this.current && plan.rev < this.current.rev) return;
			this.current = plan;
			this.planEmitter.fire(plan);
		} catch {
			/* the subscription delivers it */
		}
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.retry);
		this.client?.close();
		this.planEmitter.dispose();
		this.taskEmitter.dispose();
	}

	private connect(): Promise<PlannerClient> {
		if (this.client && !this.client.closed) return Promise.resolve(this.client);
		this.connecting ??= this.open().finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async open(): Promise<PlannerClient> {
		let client: PlannerClient | undefined;
		try {
			client = this.script ? await ensurePlanner(this.script) : await PlannerClient.connect();
			if (!client) throw new Error("the planner is not running");
			await client.subscribe(ev => {
				if (ev.event === "plan") {
					this.current = ev.plan;
					this.planEmitter.fire(ev.plan);
				} else if (ev.event === "task") this.taskEmitter.fire({ task: ev.task, from: ev.from });
				// `sync` events (graph propagation steps) are also in the plan snapshot's TaskView.sync.
			});
		} catch (err) {
			client?.close();
			this.lastError = err instanceof Error ? err.message : String(err);
			this.scheduleReconnect();
			throw err;
		}
		this.client = client;
		this.failures = 0;
		this.lastError = undefined;
		client.onClose(() => {
			if (this.client !== client) return;
			this.client = undefined;
			this.current = undefined;
			this.lastError = "lost the connection to the planner";
			this.planEmitter.fire(undefined);
			this.scheduleReconnect();
		});
		return client;
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.retry) return;
		const delay = RECONNECT_MS[Math.min(this.failures++, RECONNECT_MS.length - 1)];
		this.retry = setTimeout(() => {
			this.retry = undefined;
			void this.connect().catch(() => undefined);
		}, delay);
	}
}
