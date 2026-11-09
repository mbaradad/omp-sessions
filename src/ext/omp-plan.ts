// omp's own todo plan of each AO session, for the Tasks view: read from the mirror files the shipped
// omp extension writes (src/omp-extension/todos.ts), edited by sending omp's `/todo import <file>`
// to the session through AO (GAPS.md G2). omp applies it without a model call; while a turn runs,
// AO queues it behind that turn.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AoClient } from "../ao/client";
import { type TodoPhase, aoDataDir, phasesToMarkdown, readTodoMirror, todoImportCommand, todoImportFile, todoMirrorDir, writeFileAtomic } from "../shared/omp-todos";

const POLL_MS = 3000;

export class OmpPlans implements vscode.Disposable {
	private readonly dir: string;
	private readonly plans = new Map<string, { mtime: number; phases: TodoPhase[] }>();
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private watcher: fs.FSWatcher | undefined;
	private readonly poll: NodeJS.Timeout;
	private pending: NodeJS.Timeout | undefined;

	constructor(private readonly dataDir = aoDataDir()) {
		this.dir = todoMirrorDir(dataDir);
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

	/** Asks omp to replace the session's plan with `phases`. */
	async set(client: AoClient, aoSessionId: string, phases: readonly TodoPhase[]): Promise<void> {
		const file = todoImportFile(this.dataDir, aoSessionId);
		writeFileAtomic(file, phasesToMarkdown(phases));
		await client.sendMessage(aoSessionId, { text: todoImportCommand(file) });
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
			this.watcher = fs.watch(this.dir, () => {
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
		let names: string[];
		try {
			names = fs.readdirSync(this.dir).filter(n => n.endsWith(".json"));
		} catch {
			names = [];
		}
		let changed = false;
		const seen = new Set<string>();
		for (const name of names) {
			const id = name.slice(0, -".json".length);
			seen.add(id);
			const file = path.join(this.dir, name);
			let mtime: number;
			try {
				mtime = fs.statSync(file).mtimeMs;
			} catch {
				continue;
			}
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
