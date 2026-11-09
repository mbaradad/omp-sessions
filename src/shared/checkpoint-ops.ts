// Checkpoint operations through AO for every client: the VS Code extension (which asks first), the
// CLI, Hermes and the planner (requeue from a clean slate, a task's own changes). The work happens in
// the Switchyard omp extension (src/omp-extension/checkpoints.ts): `/undo` and `/redo` go to the
// session as ordinary AO messages, and omp's outcome comes back through the checkpoint state file.
// Node-only.
import { setTimeout as sleep } from "node:timers/promises";
import { type AoClient, type AoConversation, AoError, type AoSessionView } from "../ao/client";
import { agentState } from "../ao/model";
import {
	type CheckpointFile,
	type CheckpointPrompt,
	type CheckpointResult,
	type FileChange,
	type RedoSummary,
	aoCheckpointDir,
	aoTurns,
	planFileRestore,
	matchTurns,
	planRestore,
	readChanges,
	readState,
	turnStatuses,
} from "./checkpoints";

/** Which prompt to undo: the AO turn that sent it, or its text (clients that render omp's transcript). */
export type UndoTarget = { turnId: string } | { text: string };

export interface UndoPlan {
	/** What to send: `/undo` (last prompt) or `/undo <omp entry id>`. */
	command: string;
	prompt: CheckpointPrompt;
	/** The prompt and every later one still in the conversation: all of them are undone. */
	rewound: CheckpointPrompt[];
	/** Files that go back, with the content they get (`before`). */
	files: CheckpointFile[];
	/** Files changed since omp wrote them whose later changes are kept (3-way merge). */
	merged: string[];
	/** Files whose later changes overlap omp's edits: the undo refuses unless sent with `--force`. */
	conflicts: string[];
	/** The session's working folder. */
	cwd: string;
}

export interface RedoPlan {
	command: "/redo";
	next: RedoSummary;
	merged: string[];
	/** Overlapping later changes: the redo refuses unless sent with `--force`. */
	conflicts: string[];
	cwd: string;
}

/** What `/undo` would do now, or why it can't. */
export function planUndo(sessionId: string, conversation: AoConversation, target?: UndoTarget): UndoPlan | { error: string } {
	const state = readState(aoCheckpointDir(sessionId));
	if (!state) return { error: "This session has no checkpoints: the Switchyard omp extension was not loaded when it started. Restart the session to enable undo." };
	const active = state.prompts.filter(p => p.active);
	let prompt: CheckpointPrompt | undefined;
	if (!target) prompt = active.at(-1);
	else if ("turnId" in target) prompt = matchTurns(aoTurns(conversation), state.prompts).get(target.turnId);
	else {
		const want = target.text.trim();
		prompt = active.findLast(p => p.text.trim() === want) ?? active.findLast(p => want.startsWith(p.text.trim().slice(0, 200)));
	}
	if (!prompt?.active) return { error: target ? "That prompt is not part of the conversation any more (already undone)." : "Nothing to undo: no prompt in the conversation." };
	const rewound = active.slice(active.indexOf(prompt));
	const dir = aoCheckpointDir(sessionId);
	const files = planRestore(readChanges(dir), new Set(rewound.map(p => p.id)));
	const restore = planFileRestore(dir, files, "before");
	return { command: target ? `/undo ${prompt.id}` : "/undo", prompt, rewound, files, merged: restore.merged, conflicts: restore.conflicts, cwd: state.cwd };
}

/** What `/redo` would do now, or why it can't. */
export function planRedo(sessionId: string): RedoPlan | { error: string } {
	const dir = aoCheckpointDir(sessionId);
	const state = readState(dir);
	const next = state?.redo[0];
	if (!state || !next) return { error: "Nothing to redo." };
	const restore = planFileRestore(dir, next.files, "after");
	return { command: "/redo", next, merged: restore.merged, conflicts: restore.conflicts, cwd: state.cwd };
}

/** omp is running a turn, waiting for an answer, or starting: a command would wait behind it. */
export function isBusy(view: AoSessionView, conversation: AoConversation): boolean {
	return ["working", "needs_input", "starting"].includes(agentState(view, conversation));
}

/** Interrupts the running turn and waits (10 s at most) until omp stopped. */
export async function interruptAndWait(ao: AoClient, sessionId: string): Promise<boolean> {
	await ao.interrupt(sessionId);
	for (let i = 0; i < 50; i++) {
		const [view, conversation] = await Promise.all([ao.getSession(sessionId), ao.getConversation(sessionId)]);
		if (agentState(view, conversation) !== "working") return true;
		await sleep(200);
	}
	return false;
}

/**
 * Sends `/undo …` or `/redo` through AO and waits for omp's outcome. A stopped agent is resumed
 * first (AO refuses messages to it with CHAT_CONTROLLER_NOT_READY). Undefined when omp has not
 * answered within `timeoutMs`.
 */
export async function runCheckpointCommand(ao: AoClient, sessionId: string, command: string, timeoutMs = 60_000): Promise<CheckpointResult | undefined> {
	const sentAt = Date.now();
	try {
		await ao.sendMessage(sessionId, { text: command });
	} catch (err) {
		if (!(err instanceof AoError) || err.code !== "CHAT_CONTROLLER_NOT_READY") throw err;
		await ao.resumeAgent(sessionId);
		await ao.sendMessage(sessionId, { text: command });
	}
	const dir = aoCheckpointDir(sessionId);
	while (Date.now() < sentAt + timeoutMs) {
		const last = readState(dir)?.last;
		if (last && last.at >= sentAt) return last;
		await sleep(250);
	}
	return undefined;
}

/** The edits made for the prompt AO turn `turnId` sent (a planner task's own changes). */
export function turnChanges(sessionId: string, conversation: AoConversation, turnId: string): FileChange[] {
	const dir = aoCheckpointDir(sessionId);
	const prompt = matchTurns(aoTurns(conversation), readState(dir)?.prompts ?? []).get(turnId);
	return prompt ? readChanges(dir).filter(c => c.prompt === prompt.id) : [];
}

/**
 * AO turns omp's `/undo` rewound: the value for `AoWatcherOptions.undoneTurns`, so a session's changed
 * files (src/ao/model.ts `changedFiles`) leave out edits that were undone. Undefined when the session has
 * no checkpoint state or nothing was undone.
 */
export function undoneTurns(sessionId: string, conversation: AoConversation): ReadonlySet<string> | undefined {
	const state = readState(aoCheckpointDir(sessionId));
	if (!state || state.prompts.every(p => p.active)) return undefined;
	const undone = new Set<string>();
	for (const [turnId, status] of turnStatuses(aoTurns(conversation), state.prompts)) if (status === "undone") undone.add(turnId);
	return undone.size ? undone : undefined;
}
