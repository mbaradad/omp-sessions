// Checkpoints in VS Code, for sessions Agent Orchestrator runs. The Switchyard omp extension
// (src/omp-extension/checkpoints.ts) does the work inside omp: it records every edit and runs
// `/undo` and `/redo`, which rewind omp's conversation and put the files back. This module is its
// client: it asks before undoing (listing the files), interrupts a running turn, sends the command
// through AO like any message, and reports the outcome omp wrote to state.json. It also serves the
// recorded edits: Review Changes (VS Code's multi-file diff), per-file and per-edit diffs, the chat's
// inline diffs, and which AO turns are undone (AO's timeline keeps them; GAPS.md G27). The AO side
// of undo/redo is src/shared/checkpoint-ops.ts, shared with the CLI, Hermes and the planner.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { type AoClient, type AoConversation, switchyardHome } from "../ao/client";
import { type UndoTarget, interruptAndWait, isBusy, planRedo, planUndo, runCheckpointCommand } from "../shared/checkpoint-ops";
import {
	type CheckpointResult,
	type CheckpointState,
	type FileChange,
	type TurnStatus,
	aoCheckpointDir,
	aoTurns,
	liveChanges,
	readBlob,
	readChanges,
	readState,
	turnStatuses,
} from "../shared/checkpoints";
import { diffTexts } from "../shared/diff";
import type { DiffsByPath } from "../shared/webview";
import { type SnapshotProvider, targetColumn } from "./diff";

/** Larger before/after pairs get no inline diff. */
const MAX_INLINE_DIFF_BYTES = 2 * 1024 * 1024;
/** How long omp may take to answer `/undo` or `/redo` once AO delivered it. */
const RESULT_TIMEOUT_MS = 60_000;

export interface CheckpointsChange {
	sessionId: string;
	/** Edits recorded since the last event for this session. */
	added: FileChange[];
	state: CheckpointState | undefined;
}

function listNames(names: readonly string[]): string {
	return names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ");
}

export class Checkpoints implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<CheckpointsChange>();
	/** Fires when a session's edits or checkpoint state change on disk. */
	readonly onDidChange = this.emitter.event;
	/** Edits already reported per session (line count of changes.jsonl). */
	private readonly seen = new Map<string, number>();
	private readonly diffCache = new Map<string, DiffsByPath>();
	private readonly watcher: vscode.FileSystemWatcher;

	constructor(private readonly connect: () => Promise<AoClient>) {
		const root = vscode.Uri.file(path.join(switchyardHome(), "sessions"));
		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "*/checkpoints/{changes.jsonl,state.json}"));
		const fire = (uri: vscode.Uri) => {
			const sessionId = path.basename(path.dirname(path.dirname(uri.fsPath)));
			const all = this.changes(sessionId);
			const added = all.slice(this.seen.get(sessionId) ?? all.length);
			this.seen.set(sessionId, all.length);
			this.emitter.fire({ sessionId, added, state: this.state(sessionId) });
		};
		this.watcher.onDidCreate(fire);
		this.watcher.onDidChange(fire);
	}

	dispose(): void {
		this.watcher.dispose();
		this.emitter.dispose();
	}

	/** Every edit omp's edit tools made in the session, in order. */
	changes(sessionId: string): FileChange[] {
		const all = readChanges(aoCheckpointDir(sessionId));
		if (!this.seen.has(sessionId)) this.seen.set(sessionId, all.length);
		return all;
	}

	/** The edits still in effect: those of undone prompts left out. */
	liveChanges(sessionId: string): FileChange[] {
		return liveChanges(aoCheckpointDir(sessionId));
	}

	state(sessionId: string): CheckpointState | undefined {
		return readState(aoCheckpointDir(sessionId));
	}

	/** How many undos `/redo` can bring back. */
	redoCount(sessionId: string): number {
		return this.state(sessionId)?.redo.length ?? 0;
	}

	/** Content of a snapshot; undefined when absent (null) or unreadable. */
	blob(sessionId: string, hash: string | null): Buffer | undefined {
		if (hash === null) return undefined;
		try {
			return readBlob(aoCheckpointDir(sessionId), hash);
		} catch {
			return undefined;
		}
	}

	/** The chat's inline diffs of one edit, by path (absent files diff as empty). */
	toolDiffs(sessionId: string, change: FileChange): DiffsByPath {
		const key = `${sessionId}\0${change.toolCallId}`;
		const cached = this.diffCache.get(key);
		if (cached) return cached;
		const out: DiffsByPath = {};
		for (const f of change.files) {
			const before = f.before === null ? Buffer.alloc(0) : this.blob(sessionId, f.before);
			const after = f.after === null ? Buffer.alloc(0) : this.blob(sessionId, f.after);
			if (before && after && before.length + after.length < MAX_INLINE_DIFF_BYTES) out[f.path] = diffTexts(before.toString("utf8"), after.toString("utf8"));
		}
		this.diffCache.set(key, out);
		return out;
	}

	/** AO turns the chat should not show as live conversation: undone ones and the /undo, /redo commands. */
	turnStatuses(sessionId: string, conversation: AoConversation): Map<string, TurnStatus> {
		return turnStatuses(aoTurns(conversation), this.state(sessionId)?.prompts ?? []);
	}

	/**
	 * Undoes the last prompt, or the prompt `target` names and everything after it: omp rewinds the
	 * conversation and writes back the files. Asks first, interrupts a running turn. Resolves with
	 * omp's result (its `prompt` goes back into the composer), or undefined when nothing happened.
	 */
	async undo(sessionId: string, target?: UndoTarget): Promise<CheckpointResult | undefined> {
		const ao = await this.connect();
		const [view, conversation] = await Promise.all([ao.getSession(sessionId), ao.getConversation(sessionId)]);
		const plan = planUndo(sessionId, conversation, target);
		if ("error" in plan) {
			void vscode.window.showInformationMessage(plan.error);
			return undefined;
		}
		const rel = (f: string) => path.relative(plan.cwd, f) || f;
		const busy = isBusy(view, conversation);
		const detail = [
			plan.rewound.length > 1 ? `${plan.rewound.length} prompts are undone: this one and every later one.` : "",
			plan.files.length ? `${plan.files.length} file${plan.files.length === 1 ? "" : "s"} go back to their content from before: ${listNames(plan.files.map(f => rel(f.path)))}.` : "No file edits to revert.",
			"The conversation rewinds to before the prompt, which goes back into the composer.",
			plan.merged.length ? `Changed since omp wrote them, without overlapping its edits (kept): ${listNames(plan.merged.map(rel))}.` : "",
			plan.conflicts.length ? `Changed since omp wrote them, overlapping its edits (overwritten if you continue): ${listNames(plan.conflicts.map(rel))}.` : "",
			busy ? "omp is working: the turn is interrupted first." : "",
			"Changes made by shell commands are not tracked. Redo brings everything back.",
		]
			.filter(Boolean)
			.join("\n\n");
		const ok = await vscode.window.showWarningMessage(target ? "Restore the checkpoint before this prompt?" : "Undo the last prompt?", { modal: true, detail }, "Undo");
		if (ok !== "Undo") return undefined;
		if (busy && !(await interruptAndWait(ao, sessionId))) {
			void vscode.window.showErrorMessage("omp did not stop; nothing was undone.");
			return undefined;
		}
		return this.run(ao, sessionId, plan.conflicts.length ? `${plan.command} --force` : plan.command);
	}

	/** Brings back what the newest undo removed: the conversation and the files. */
	async redo(sessionId: string): Promise<CheckpointResult | undefined> {
		const ao = await this.connect();
		const [view, conversation] = await Promise.all([ao.getSession(sessionId), ao.getConversation(sessionId)]);
		const plan = planRedo(sessionId);
		if ("error" in plan) {
			void vscode.window.showInformationMessage(plan.error);
			return undefined;
		}
		if (isBusy(view, conversation)) {
			void vscode.window.showWarningMessage("omp is working: stop it before redoing.");
			return undefined;
		}
		if (plan.conflicts.length || plan.merged.length) {
			const rel = (f: string) => path.relative(plan.cwd, f) || f;
			const detail = [
				plan.merged.length ? `Changed since the undo, without overlapping (kept): ${listNames(plan.merged.map(rel))}.` : "",
				plan.conflicts.length ? `Changed since the undo, overlapping (overwritten if you continue): ${listNames(plan.conflicts.map(rel))}.` : "",
			]
				.filter(Boolean)
				.join("\n\n");
			const ok = await vscode.window.showWarningMessage("Redo?", { modal: true, detail }, "Redo");
			if (ok !== "Redo") return undefined;
		}
		return this.run(ao, sessionId, plan.conflicts.length ? "/redo --force" : plan.command);
	}

	private async run(ao: AoClient, sessionId: string, command: string): Promise<CheckpointResult | undefined> {
		const last = await runCheckpointCommand(ao, sessionId, command, RESULT_TIMEOUT_MS);
		if (!last) {
			void vscode.window.showWarningMessage(`omp has not answered ${command.split(" ")[0]} yet; it runs once the session is connected.`);
			return undefined;
		}
		void (last.ok && !last.failed.length ? vscode.window.showInformationMessage(last.message) : vscode.window.showWarningMessage(last.message));
		return last.ok ? last : undefined;
	}

	/** Each file the session's live edits touched, with its content before the first of them (null: did not exist). */
	baselines(sessionId: string): Map<string, string | null> {
		const first = new Map<string, string | null>();
		for (const c of this.liveChanges(sessionId)) for (const f of c.files) if (!first.has(f.path)) first.set(f.path, f.before);
		return first;
	}

	/** Review Changes: every file the session changed, from before its first edit to now, in VS Code's multi-file diff. */
	async review(sessionId: string, title: string, snapshots: SnapshotProvider): Promise<void> {
		const first = this.baselines(sessionId);
		if (first.size === 0) {
			void vscode.window.showInformationMessage("This session has not changed any files yet.");
			return;
		}
		const resources = [...first].map(([file, before]) => {
			const left = snapshots.blobUri(file, sessionId, before, "session start");
			const right = fs.existsSync(file) ? vscode.Uri.file(file) : snapshots.blobUri(file, sessionId, null, "deleted");
			return [vscode.Uri.file(file), left, right];
		});
		await vscode.commands.executeCommand("vscode.changes", `${title} — ${resources.length} file${resources.length === 1 ? "" : "s"} changed`, resources);
	}

	/** Diff of one file from before the session's first edit of it to the live file. */
	async openFileDiff(sessionId: string, file: string, snapshots: SnapshotProvider, chatColumn?: vscode.ViewColumn): Promise<void> {
		const before = this.baselines(sessionId).get(file);
		if (before === undefined) return;
		const left = snapshots.blobUri(file, sessionId, before, "session start");
		const right = fs.existsSync(file) ? vscode.Uri.file(file) : snapshots.blobUri(file, sessionId, null, "deleted");
		await vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(file)} (session changes)`, { preview: true, viewColumn: targetColumn(chatColumn) });
	}
}
