// omp's own todo plan of each AO session, for the Tasks view: read from the mirror files the shipped
// omp extension writes (src/omp-extension/todos.ts, `<switchyard home>/sessions/<id>/todos.json`),
// edited by sending omp's `/todo import <file>` to the session through AO (GAPS.md G2). omp applies
// it without a model call; while a turn runs, AO queues it behind that turn.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AoError, type AoClient, switchyardHome } from "../ao/client";
import { type TodoPhase, phasesToMarkdown, readTodoMirror, todoImportCommand, todoImportFile, writeFileAtomic } from "../shared/omp-todos";

const POLL_MS = 3000;

export class OmpPlans implements vscode.Disposable {
	private readonly sessionsDir: string;
	private readonly plans = new Map<string, { mtime: number; phases: TodoPhase[] }>();
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private watcher: fs.FSWatcher | undefined;
	private readonly poll: NodeJS.Timeout;
	private pending: NodeJS.Timeout | undefined;

	constructor(private readonly home = switchyardHome()) {
		this.sessionsDir = path.join(home, "sessions");
		this.scan();
		this.watch();
		// fs.watch misses events on some file systems (and can't watch a folder that doesn't exist yet).
		this.poll = setInterval(() => {
			this.watch();
			this.scan();
		}, POLL_MS);
	}

	/** omp's current phases for an AO session; undefined when omp never reported a plan for it. */
	get(aoSessionId: string): TodoPhase[] | undefined {
		return this.plans.get(aoSessionId)?.phases;
	}

	/** Asks omp to replace the session's plan with `phases`. Fails with a plain reason when the session's agent is down. */
	async set(client: AoClient, aoSessionId: string, phases: readonly TodoPhase[]): Promise<void> {
		const file = todoImportFile(this.home, aoSessionId);
		writeFileAtomic(file, phasesToMarkdown(phases));
		try {
			await client.sendMessage(aoSessionId, { text: todoImportCommand(file) });
		} catch (err) {
			// AO answers 409 CHAT_CONTROLLER_NOT_READY while the session's agent is exited or crashed, until it is resumed.
			if (err instanceof AoError && err.code === "CHAT_CONTROLLER_NOT_READY") throw new Error("omp is not running in this session: resume it, then edit its plan.");
			throw err;
		}
	}

	dispose(): void {
		clearInterval(this.poll);
		clearTimeout(this.pending);
		this.watcher?.close();
		this.emitter.dispose();
	}

	private watch(): void {
		if (this.watcher) return;
		try {
			this.watcher = fs.watch(this.sessionsDir, { recursive: true }, (_event, name) => {
				if (name && !String(name).endsWith("todos.json")) return;
				this.pending ??= setTimeout(() => {
					this.pending = undefined;
					this.scan();
				}, 100);
			});
			this.watcher.on("error", () => {
				this.watcher?.close();
				this.watcher = undefined;
			});
		} catch {
			/* no folder yet: the poll retries */
		}
	}

	private scan(): void {
		let ids: string[];
		try {
			ids = fs.readdirSync(this.sessionsDir);
		} catch {
			ids = [];
		}
		let changed = false;
		const seen = new Set<string>();
		for (const id of ids) {
			const file = path.join(this.sessionsDir, id, "todos.json");
			let mtime: number;
			try {
				mtime = fs.statSync(file).mtimeMs;
			} catch {
				continue;
			}
			seen.add(id);
			if (this.plans.get(id)?.mtime === mtime) continue;
			const mirror = readTodoMirror(file);
			if (!mirror) continue;
			this.plans.set(id, { mtime, phases: mirror.phases });
			changed = true;
		}
		for (const id of this.plans.keys()) {
			if (seen.has(id)) continue;
			this.plans.delete(id);
			changed = true;
		}
		if (changed) this.emitter.fire();
	}
}
