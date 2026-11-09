// Checkpoints in VS Code, for sessions Agent Orchestrator runs. The Switchyard omp extension
// (src/omp-extension/checkpoints.ts) does the work inside omp: it records every edit and runs
// `/undo` and `/redo`, which rewind omp's conversation and put the files back. This module is its
// client: it asks before undoing (listing the files), interrupts a running turn, sends the command
// through AO like any message, and reports the outcome omp wrote to state.json. It also serves the
// recorded edits: Review Changes (VS Code's multi-file diff), per-file and per-edit diffs, the chat's
// inline diffs, and which AO turns are undone (AO's timeline keeps them; GAPS.md G12).
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import type { AoClient, AoConversation } from "../ao/client";
import { switchyardHome } from "../ao/native";
import { agentState } from "../ao/model";
import {
	type CheckpointPrompt,
	type CheckpointResult,
	type CheckpointState,
	type FileChange,
	type TurnLike,
	type TurnStatus,
	aoCheckpointDir,
	fileMatches,
	liveChanges,
	matchTurns,
	planRestore,
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

/** The person's prompts in an AO conversation: each turn's first human message. */
export function aoTurns(conversation: AoConversation): TurnLike[] {
	const text = new Map<string, string>();
	for (const m of conversation.messages) if (m.kind === "message" && m.role === "user" && m.turnId && !text.has(m.turnId)) text.set(m.turnId, m.text);
	return conversation.turns.flatMap(t => {
		const prompt = text.get(t.id);
		return prompt === undefined ? [] : [{ id: t.id, text: prompt, at: Date.parse(t.startedAt ?? t.requestedAt ?? "") || 0 }];
	});
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
	 * Undoes the last prompt, or the prompt `target` names (an AO turn, or its text for clients that
	 * render omp's transcript) and everything after it: omp rewinds the conversation and writes back
	 * the files. Asks first. Resolves with omp's result (its `prompt` goes back into the composer),
	 * or undefined when cancelled or nothing happened.
	 */
	async undo(sessionId: string, target?: { turnId: string } | { text: string }): Promise<CheckpointResult | undefined> {
		const ao = await this.connect();
		const [view, conversation] = await Promise.all([ao.getSession(sessionId), ao.getConversation(sessionId)]);
		const state = this.state(sessionId);
		if (!state) {
			void vscode.window.showWarningMessage("This session has no checkpoints: the Switchyard omp extension was not loaded when it started. Restart the session to enable undo.");
			return undefined;
		}
		const active = state.prompts.filter(p => p.active);
		let prompt: CheckpointPrompt | undefined;
		if (!target) prompt = active.at(-1);
		else if ("turnId" in target) prompt = matchTurns(aoTurns(conversation), state.prompts).get(target.turnId);
		else {
			const want = target.text.trim();
			prompt = active.findLast(p => p.text.trim() === want) ?? active.findLast(p => want.startsWith(p.text.trim().slice(0, 200)));
		}
		if (!prompt?.active) {
			void vscode.window.showInformationMessage(target ? "That prompt is not part of the conversation any more (already undone)." : "Nothing to undo: no prompt in the conversation.");
			return undefined;
		}
		const rewound = active.slice(active.indexOf(prompt));
		const dir = aoCheckpointDir(sessionId);
		const files = planRestore(this.changes(sessionId), new Set(rewound.map(p => p.id)));
		const rel = (f: string) => path.relative(state.cwd, f) || f;
		const overwritten = files.filter(f => !fileMatches(dir, f.path, f.after)).map(f => rel(f.path));
		const busy = ["working", "needs_input", "starting"].includes(agentState(view, conversation));
		const detail = [
			rewound.length > 1 ? `${rewound.length} prompts are undone: this one and every later one.` : "",
			files.length ? `${files.length} file${files.length === 1 ? "" : "s"} go back to their content from before: ${listNames(files.map(f => rel(f.path)))}.` : "No file edits to revert.",
			"The conversation rewinds to before the prompt, which goes back into the composer.",
			overwritten.length ? `Changed since omp last wrote them (your edits are overwritten): ${listNames(overwritten)}.` : "",
			busy ? "omp is working: the turn is interrupted first." : "",
			"Changes made by shell commands are not tracked. Redo brings everything back.",
		]
			.filter(Boolean)
			.join("\n\n");
		const ok = await vscode.window.showWarningMessage(target ? "Restore the checkpoint before this prompt?" : "Undo the last prompt?", { modal: true, detail }, "Undo");
		if (ok !== "Undo") return undefined;
		if (busy && !(await this.interrupt(ao, sessionId))) {
			void vscode.window.showErrorMessage("omp did not stop; nothing was undone.");
			return undefined;
		}
		return this.run(ao, sessionId, target ? `/undo ${prompt.id}` : "/undo");
	}

	/** Brings back what the newest undo removed: the conversation and the files. */
	async redo(sessionId: string): Promise<CheckpointResult | undefined> {
		const ao = await this.connect();
		const [view, conversation] = await Promise.all([ao.getSession(sessionId), ao.getConversation(sessionId)]);
		const next = this.state(sessionId)?.redo[0];
		if (!next) {
			void vscode.window.showInformationMessage("Nothing to redo.");
			return undefined;
		}
		if (["working", "needs_input", "starting"].includes(agentState(view, conversation))) {
			void vscode.window.showWarningMessage("omp is working: stop it before redoing.");
			return undefined;
		}
		const dir = aoCheckpointDir(sessionId);
		const changed = next.files.filter(f => !fileMatches(dir, f.path, f.before));
		if (changed.length) {
			const cwd = this.state(sessionId)?.cwd ?? "";
			const ok = await vscode.window.showWarningMessage("Redo?", { modal: true, detail: `Changed since the undo (your edits are overwritten): ${listNames(changed.map(f => path.relative(cwd, f.path) || f.path))}.` }, "Redo");
			if (ok !== "Redo") return undefined;
		}
		return this.run(ao, sessionId, "/redo");
	}

	/** Sends the command through AO and waits for omp's outcome in state.json. */
	private async run(ao: AoClient, sessionId: string, command: string): Promise<CheckpointResult | undefined> {
		const sentAt = Date.now();
		await ao.sendMessage(sessionId, { text: command });
		const deadline = sentAt + RESULT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const last = this.state(sessionId)?.last;
			if (last && last.at >= sentAt) {
				const show = !last.ok ? vscode.window.showWarningMessage : last.failed.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
				void show(last.message);
				return last.ok ? last : undefined;
			}
			await sleep(250);
		}
		void vscode.window.showWarningMessage(`omp has not answered ${command.split(" ")[0]} yet; it runs once the session is connected.`);
		return undefined;
	}

	private async interrupt(ao: AoClient, sessionId: string): Promise<boolean> {
		await ao.interrupt(sessionId);
		for (let i = 0; i < 50; i++) {
			const [view, conversation] = await Promise.all([ao.getSession(sessionId), ao.getConversation(sessionId)]);
			if (agentState(view, conversation) !== "working") return true;
			await sleep(200);
		}
		return false;
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
