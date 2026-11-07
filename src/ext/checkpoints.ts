// Checkpoints in a chat: restore the checkpoint before any prompt (files + conversation), undo the
// last turn, and redo what a restore replaced. The conversation side is omp's `branch` (the old
// transcript file stays intact, so redo switches back to it); files come from the host snapshots.
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { type CheckpointFile, findPrompt, lastPrompt, planCheckpoint, promptText } from "../shared/checkpoints";
import { PLAN_PROMPT_PREFIX } from "../shared/permissions";
import { EMPTY_BLOB, type FileChange, type SessionMeta, blobPath } from "../shared/protocol";
import type { SlimState, ToWebview } from "../shared/webview";
import type { HostClient } from "./client";

/** What the chat panel lends the controller. */
export interface CheckpointHost {
	readonly sessionId: string;
	readonly client: HostClient | undefined;
	readonly meta: SessionMeta | undefined;
	readonly state: SlimState | null;
	readonly changes: readonly FileChange[];
	transcript(): Promise<unknown[]>;
	findUserEntry(text: string): Promise<string | undefined>;
	insertText(text: string): void;
	post(msg: ToWebview): void;
	/** Shown after the transcript reset that `branch` / `switch_session` cause. */
	postAfterReset(msg: ToWebview): void;
}

interface RedoEntry {
	/** omp transcript before the restore (it keeps the rewound turns). */
	sessionFile: string;
	files: CheckpointFile[];
	prompt: string;
}

export class Checkpoints {
	private readonly redoStack: RedoEntry[] = [];

	constructor(private readonly host: CheckpointHost) {}

	get redoCount(): number {
		return this.redoStack.length;
	}

	/** A new prompt moves the conversation on: earlier restores can no longer be redone. */
	clearRedo(): void {
		if (!this.redoStack.length) return;
		this.redoStack.length = 0;
		this.publish();
	}

	/** Restores the checkpoint before the prompt with `text`, or before the last prompt (undo last turn). */
	async restore(text?: string): Promise<void> {
		const { client, meta } = this.host;
		if (!client?.connected || !meta?.ompSessionFile) {
			this.notice("warning", "Resume the session first: checkpoints rewind the running conversation.");
			return;
		}
		const messages = await this.host.transcript();
		const index = text === undefined ? lastPrompt(messages) : findPrompt(messages, text);
		if (index < 0) {
			this.notice("warning", text === undefined ? "Nothing to undo: no prompt on the current branch." : "Could not find that prompt on the current branch.");
			return;
		}
		const prompt = promptText(messages, index);
		const plan = planCheckpoint(messages, this.host.changes, index);
		const changedSince = plan.files.filter(f => !this.matches(f.path, f.after));
		const busy = meta.status === "working" || !!this.host.state?.isStreaming;
		const names = plan.files.map(f => this.rel(f.path));
		const detail = [
			plan.files.length ? `${plan.files.length} file${plan.files.length === 1 ? "" : "s"} go back to their content from before it: ${listNames(names)}.` : "No file edits to revert.",
			"The conversation rewinds to before the prompt, which goes back into the composer.",
			changedSince.length ? `Changed since omp last wrote them (your edits are overwritten): ${listNames(changedSince.map(f => this.rel(f.path)))}.` : "",
			busy ? "omp is working: the turn is interrupted first." : "",
			"Changes made by shell commands are not tracked. Redo (/redo) brings everything back.",
		]
			.filter(Boolean)
			.join("\n\n");
		const ok = await vscode.window.showWarningMessage(text === undefined ? "Undo the last turn?" : "Restore the checkpoint before this prompt?", { modal: true, detail }, "Restore");
		if (ok !== "Restore") return;
		if (busy && !(await this.interrupt(client))) {
			this.notice("error", "omp did not stop; nothing was restored.");
			return;
		}
		const entryId = await this.host.findUserEntry(prompt);
		if (!entryId) {
			this.notice("warning", "Could not locate that prompt in omp's history; nothing was restored.");
			return;
		}
		const sessionFile = meta.ompSessionFile;
		const res = await client.rpc({ type: "branch", entryId });
		if (!res.success || isCancelled(res.data)) {
			this.notice("error", res.success ? "omp cancelled the rewind; nothing was restored." : String(res.error));
			return;
		}
		const failed = await this.write(plan.files, "before");
		this.redoStack.push({ sessionFile, files: plan.files, prompt });
		this.publish();
		this.host.insertText(prompt.replace(PLAN_PROMPT_PREFIX, ""));
		this.host.postAfterReset({
			type: "notice",
			level: failed.length ? "warning" : "info",
			text: `Restored the checkpoint: ${plan.files.length ? `reverted ${listNames(names)}` : "no files to revert"} and rewound the conversation.${failed.length ? ` Could not write ${listNames(failed)}.` : ""} /redo brings it back.`,
		});
	}

	/** Undoes the newest restore: the earlier transcript comes back and its files are rewritten. */
	async redo(): Promise<void> {
		const { client, meta } = this.host;
		const entry = this.redoStack.at(-1);
		if (!entry) {
			this.notice("info", "Nothing to redo.");
			return;
		}
		if (!client?.connected || !meta) {
			this.notice("warning", "Resume the session first.");
			return;
		}
		if (meta.status === "working" || this.host.state?.isStreaming) {
			this.notice("warning", "omp is working: stop it (Esc) before redoing.");
			return;
		}
		const changedSince = entry.files.filter(f => !this.matches(f.path, f.before));
		if (changedSince.length) {
			const ok = await vscode.window.showWarningMessage("Redo the restored turns?", { modal: true, detail: `Changed since the restore (your edits are overwritten): ${listNames(changedSince.map(f => this.rel(f.path)))}.` }, "Redo");
			if (ok !== "Redo") return;
		}
		if (!fs.existsSync(entry.sessionFile)) {
			this.redoStack.pop();
			this.publish();
			this.notice("error", "The earlier transcript is gone; cannot redo.");
			return;
		}
		const res = await client.rpc({ type: "switch_session", sessionPath: entry.sessionFile });
		if (!res.success || isCancelled(res.data)) {
			this.notice("error", res.success ? "omp cancelled the switch; nothing was redone." : String(res.error));
			return;
		}
		this.redoStack.pop();
		this.publish();
		const failed = await this.write(entry.files, "after");
		this.host.post({ type: "clearComposerIf", text: entry.prompt.replace(PLAN_PROMPT_PREFIX, "") });
		this.host.postAfterReset({
			type: "notice",
			level: failed.length ? "warning" : "info",
			text: `Redone: the conversation is back${entry.files.length ? ` and so are ${listNames(entry.files.map(f => this.rel(f.path)))}` : ""}.${failed.length ? ` Could not write ${listNames(failed)}.` : ""}`,
		});
	}

	private publish(): void {
		this.host.post({ type: "checkpoints", redo: this.redoStack.length });
	}

	private notice(level: "info" | "warning" | "error", text: string): void {
		this.host.post({ type: "notice", level, text });
	}

	private rel(file: string): string {
		return path.relative(this.host.meta?.cwd ?? "", file) || file;
	}

	private blob(hash: string): Buffer {
		return hash === EMPTY_BLOB ? Buffer.alloc(0) : fs.readFileSync(blobPath(this.host.sessionId, hash));
	}

	/** Whether the file on disk holds the snapshot `hash` (null: absent). */
	private matches(file: string, hash: string | null): boolean {
		try {
			const exists = fs.existsSync(file);
			if (hash === null) return !exists;
			return exists && fs.readFileSync(file).equals(this.blob(hash));
		} catch {
			return false;
		}
	}

	/** Writes each file's `side` snapshot (deleting files that did not exist); returns the ones that failed. */
	private async write(files: readonly CheckpointFile[], side: "before" | "after"): Promise<string[]> {
		const failed: string[] = [];
		for (const f of files) {
			const hash = f[side];
			const uri = vscode.Uri.file(f.path);
			try {
				if (hash === null) {
					if (fs.existsSync(f.path)) await vscode.workspace.fs.delete(uri, { useTrash: false });
				} else {
					fs.mkdirSync(path.dirname(f.path), { recursive: true });
					await vscode.workspace.fs.writeFile(uri, this.blob(hash));
				}
			} catch {
				failed.push(this.rel(f.path));
			}
		}
		return failed;
	}

	private async interrupt(client: HostClient): Promise<boolean> {
		await client.rpc({ type: "abort" });
		for (let i = 0; i < 50; i++) {
			if (this.host.meta?.status !== "working" && !this.host.state?.isStreaming) return true;
			await sleep(200);
		}
		return false;
	}
}

function isCancelled(data: unknown): boolean {
	return typeof data === "object" && data !== null && "cancelled" in data && data.cancelled === true;
}

function listNames(names: readonly string[]): string {
	return names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ");
}
