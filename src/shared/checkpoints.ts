// Checkpoints: every prompt is one. Restoring a prompt's checkpoint rewinds the conversation to
// just before it (omp `branch`) and puts back every file the session's edit tools changed from
// then on, using the host's before/after snapshots. Pure planning here; the extension applies it.
import type { FileChange } from "./protocol";

/** One file to put back: `before` is its content hash before the first change, `after` after the last. */
export interface CheckpointFile {
	path: string;
	before: string | null;
	after: string | null;
}

export interface CheckpointPlan {
	/** Index of the prompt in the transcript. */
	index: number;
	files: CheckpointFile[];
}

function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function userText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(b => rec(b))
		.filter(b => b?.type === "text" && typeof b.text === "string")
		.map(b => String(b?.text))
		.join("");
}

/** Index of the person's prompt with this text (last match; long texts may arrive truncated), else -1. */
export function findPrompt(messages: readonly unknown[], text: string): number {
	const want = text.trim();
	const prompts = messages.flatMap((m, i) => {
		const r = rec(m);
		return r?.role === "user" && r.attribution !== "agent" ? [{ i, text: userText(r).trim() }] : [];
	});
	const exact = prompts.findLast(p => p.text === want);
	if (exact) return exact.i;
	const head = want.slice(0, 200);
	return head ? (prompts.findLast(p => p.text.startsWith(head))?.i ?? -1) : -1;
}

/** Index of the last prompt the person wrote, else -1. */
export function lastPrompt(messages: readonly unknown[]): number {
	return messages.findLastIndex(m => rec(m)?.role === "user" && rec(m)?.attribution !== "agent");
}


/** Text of the message at `index` as omp stores it (plan-mode preamble included). */
export function promptText(messages: readonly unknown[], index: number): string {
	const m = rec(messages[index]);
	return m ? userText(m) : "";
}
/**
 * What restoring the checkpoint of the prompt at `index` puts back: every file changed by a tool
 * call after that prompt, at its content before the first such change.
 */
export function planCheckpoint(messages: readonly unknown[], changes: readonly FileChange[], index: number): CheckpointPlan {
	const calls = new Set<string>();
	for (const m of messages.slice(index + 1)) {
		const r = rec(m);
		if (r?.role !== "assistant" || !Array.isArray(r.content)) continue;
		for (const b of r.content) {
			const block = rec(b);
			if (block?.type === "toolCall" && typeof block.id === "string") calls.add(block.id);
		}
	}
	const files = new Map<string, CheckpointFile>();
	for (const change of [...changes].filter(c => calls.has(c.toolCallId)).sort((a, b) => a.timestamp - b.timestamp)) {
		for (const f of change.files) {
			const known = files.get(f.path);
			if (known) known.after = f.after;
			else files.set(f.path, { path: f.path, before: f.before, after: f.after });
		}
	}
	return { index, files: [...files.values()].filter(f => f.before !== f.after) };
}
