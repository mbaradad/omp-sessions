// What SessionManager.queue() / editQueue() delegate to (the chat panel's task queue strip): the old
// per-session queue API on top of the planner. `get` reads the live plan synchronously; `edit` sends
// the old QueueOps to the planner's compatible `queue` op, which creates the session's lane (paused)
// on the first add. One PlannerStore per window (tasks-deps.ts) is shared with the Tasks view.
import type * as vscode from "vscode";
import type { QueueOp as PlannerQueueOp } from "../planner/types";
import { laneForSession, queueOf } from "../shared/plan-queue";
import type { QueueOp, TaskQueue } from "../shared/protocol";
import type { PlannerStore } from "./planner-store";

export class SessionQueues {
	constructor(private readonly planner: PlannerStore) {}

	/** The session's queue in the old shape; empty and paused when it has none or the planner is unreachable. */
	get(aoSessionId: string): TaskQueue {
		return queueOf(this.planner.plan, aoSessionId);
	}

	/** Applies old-style queue edits; rejects with the planner's reason when it refuses them. */
	async edit(aoSessionId: string, ops: QueueOp[]): Promise<void> {
		// A lane that continues the session under another id (a planner lane `l_…` with `session` set) is the queue.
		const lane = laneForSession(this.planner.plan, aoSessionId)?.id ?? aoSessionId;
		await this.planner.queue(lane, ops as PlannerQueueOp[]);
	}

	/** Fires when the plan changes (any queue may have): re-read `get`. */
	onDidChange(listener: () => void): vscode.Disposable {
		return this.planner.onDidChange(listener);
	}
}
