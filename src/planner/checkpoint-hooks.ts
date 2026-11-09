// What the planner asks of the Switchyard checkpoints (src/shared/checkpoints.ts, the omp extension's store):
// - `undone(task)`: did a person undo the task's turn (`/undo`)? The planner keeps such a task `done` but stops
//   counting it as finished for the tasks that wait on it.
// - `rewind(task)`: undo the task's earlier turn before a clean retry (`requeue {clean: true}`), so the retry starts
//   from the files and the conversation as they were before the failed attempt.
// Both read AO through a lazily connected client (the planner's own process has the AO env); main.ts passes
// `...checkpointHooks()` in the Planner options.
import { type AoClient, AoClient as AoClientClass, isOmpHarness } from "../ao/client";
import { interruptAndWait, isBusy, planUndo, runCheckpointCommand } from "../shared/checkpoint-ops";
import { aoCheckpointDir, aoTurns, readState, turnStatuses } from "../shared/checkpoints";
import type { Task } from "./types";

/** What the hooks read of a planner `Task`: the AO session it ran in and the AO turn of its latest run. */
export type TaskRef = Pick<Task, "session"> & { turn?: string };

export interface CheckpointHooks {
	undone(task: TaskRef): Promise<boolean>;
	rewind(task: TaskRef): Promise<void>;
}

/** `connect` is for tests; the default finds the AO daemon the way every client does. */
export function checkpointHooks(connect: () => Promise<AoClient> = () => AoClientClass.connect()): CheckpointHooks {
	let client: Promise<AoClient> | undefined;
	const ao = () =>
		(client ??= connect().catch(err => {
			client = undefined;
			throw err;
		}));

	return {
		async undone(task) {
			if (!task.session || !task.turn) return false;
			const state = readState(aoCheckpointDir(task.session));
			if (!state) return false;
			const conversation = await (await ao()).getConversation(task.session);
			return turnStatuses(aoTurns(conversation), state.prompts).get(task.turn) === "undone";
		},

		async rewind(task) {
			if (!task.session || !task.turn) throw new Error("the task has no recorded session and turn");
			const sessionId = task.session;
			const client = await ao();
			const [view, conversation] = await Promise.all([client.getSession(sessionId), client.getConversation(sessionId)]);
			if (!isOmpHarness(view.harness)) throw new Error(`a clean retry undoes the earlier attempt with /undo checkpoints, which are omp-only (Switchyard's omp extension); this session runs ${view.harness}`);
			const state = readState(aoCheckpointDir(sessionId));
			if (!state) throw new Error("the session has no checkpoints (the Switchyard omp extension was not loaded when it started)");
			// Already undone (by a person, or by an earlier clean retry that failed later): nothing left to rewind.
			if (turnStatuses(aoTurns(conversation), state.prompts).get(task.turn) === "undone") return;
			const plan = planUndo(sessionId, conversation, { turnId: task.turn });
			if ("error" in plan) throw new Error(plan.error);
			if (plan.rewound.length > 1) throw new Error(`undoing it would also undo ${plan.rewound.length - 1} later prompt${plan.rewound.length === 2 ? "" : "s"} of the session`);
			if (isBusy(view, conversation) && !(await interruptAndWait(client, sessionId))) throw new Error("omp did not stop");
			const result = await runCheckpointCommand(client, sessionId, plan.command);
			if (!result) throw new Error("omp did not answer /undo in time");
			// Never --force: overlapping later changes are for a person to decide. Name every file, not only the first few of the message.
			if (!result.ok) throw new Error(result.conflicts.length ? `${result.message} Conflicting files: ${result.conflicts.join(", ")}` : result.message);
		},
	};
}
