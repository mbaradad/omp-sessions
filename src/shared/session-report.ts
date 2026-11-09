// The one-word state of a session as the sessions tree files it (hide finished sessions, keep the ones with work ahead).
import type { SessionMeta } from "./protocol";

/**
 * `queued`: stopped with work that starts now. `scheduled`: pending tasks wait for a start time
 * (`queue.startAt`). `working`: a turn runs, or queued tasks continue on their own. `needs_input`: a question
 * or approval waits for an answer. `interrupted`: a crash or reboot cut a queued task short and nothing
 * continues until someone restarts it (`queue.interrupted`). `idle`: done for now. `stopped`: no omp
 * process and no queued work.
 */
export type AgentState = "queued" | "scheduled" | "starting" | "working" | "needs_input" | "interrupted" | "idle" | "stopped";

/** Work the queue still does on its own: a running task, or pending ones with auto-run on. */
function queueBusy(q: NonNullable<SessionMeta["queue"]>): boolean {
	return q.running > 0 || (q.autoRun && q.pending > 0);
}

export function agentState({ meta, queue }: { meta: SessionMeta; queue: NonNullable<SessionMeta["queue"]> }, now = Date.now()): AgentState {
	if (meta.status === "waiting") return "needs_input";
	if (meta.status === "starting") return "starting";
	if (meta.status === "working") return "working";
	// A start time is a person's decision to run the queue then; it wins over an earlier interruption.
	if (queue.pending > 0 && !queue.autoRun && queue.startAt !== undefined) return queue.startAt > now ? "scheduled" : "queued";
	// Interrupted queued tasks stop the queue (auto-run off) until a person restarts them.
	if (queue.running === 0 && !queue.autoRun && queue.interrupted) return "interrupted";
	if (meta.status === "stopped") return queue.pending > 0 && queue.autoRun ? "queued" : "stopped";
	if (queueBusy(queue)) return "working";
	return "idle";
}
