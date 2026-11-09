// What the Tasks view, the scheduler status and the board read besides VS Code: the planner (one
// subscription per window), omp's plans (mirror files), and AO's sessions (titles, states) plus a
// client to send omp `/todo import`. AO is connected lazily and retried, so the view works (planner
// data only) while the daemon is down.
import * as path from "node:path";
import * as vscode from "vscode";
import { AoClient } from "../ao/client";
import { type AoSessionModel, AoSessionWatcher } from "../ao/model";
import { OmpPlans } from "./omp-plan";
import { PlannerStore } from "./planner-store";

/** The part of AoSessionWatcher the Tasks view uses. */
export interface TaskSessions {
	get(id: string): AoSessionModel | undefined;
	all(): AoSessionModel[];
	onChange(listener: () => void): () => void;
}

export interface TasksDeps {
	planner: PlannerStore;
	plans: OmpPlans;
	aoSessions: TaskSessions;
	/** The AO client (connects on first use). */
	ao(): Promise<AoClient>;
}

const RETRY_MS = 10_000;

/** AO sessions from a watcher that exists once the daemon answers. */
class LateSessions implements TaskSessions, vscode.Disposable {
	private watcher: AoSessionWatcher | undefined;
	private client: Promise<AoClient> | undefined;
	private retry: NodeJS.Timeout | undefined;
	private disposed = false;
	private readonly listeners = new Set<() => void>();

	constructor() {
		void this.connect().catch(() => undefined);
	}

	connect(): Promise<AoClient> {
		this.client ??= AoClient.connect().then(
			async client => {
				const watcher = new AoSessionWatcher(client);
				watcher.onChange(() => this.emit());
				await watcher.start();
				if (this.disposed) watcher.close();
				else {
					this.watcher = watcher;
					this.emit();
				}
				return client;
			},
			(err: unknown) => {
				this.client = undefined;
				if (!this.disposed) this.retry ??= setTimeout(() => {
					this.retry = undefined;
					void this.connect().catch(() => undefined);
				}, RETRY_MS);
				throw err;
			},
		);
		return this.client;
	}

	get(id: string): AoSessionModel | undefined {
		return this.watcher?.get(id);
	}

	all(): AoSessionModel[] {
		return this.watcher?.all() ?? [];
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.retry);
		this.watcher?.close();
		this.listeners.clear();
	}

	private emit(): void {
		for (const l of this.listeners) l();
	}
}

export function createTasksDeps(context: vscode.ExtensionContext): TasksDeps {
	// Start the planner when none runs, unless the person (`omp.server.autoStart`) or a test says not to.
	const mayStart = !process.env.OMP_SESSIONS_NO_SERVER && vscode.workspace.getConfiguration("omp").get<boolean>("server.autoStart", true);
	const planner = new PlannerStore(mayStart ? path.join(context.extensionPath, "out", "planner.js") : undefined);
	const plans = new OmpPlans();
	const sessions = new LateSessions();
	context.subscriptions.push(planner, plans, sessions);
	return { planner, plans, aoSessions: sessions, ao: () => sessions.connect() };
}
