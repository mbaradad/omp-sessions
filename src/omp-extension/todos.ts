// omp extension shipped by omp Sessions (installed into omp's agent folder by the VS Code
// extension, see src/ext/omp-extension.ts). In omp processes AO runs (`AO_SESSION_ID` is set), it
// mirrors omp's todo phases to `<AO data dir>/omp-sessions/todos/<AO session id>.json` whenever they
// change, so the Tasks view shows them exactly (AO's own copy drops phases; GAPS.md G2). Anywhere
// else it does nothing.
//
// The plan changes through the todo tool and through `/todo` commands; both append a transcript
// entry and move the branch leaf, so a cheap leaf-id check on a short timer catches every change.
import { type TodoMirror, aoDataDir, latestTodoPhases, todoMirrorFile, writeFileAtomic } from "../shared/omp-todos";

/** The slice of omp's ExtensionAPI this module uses (types only; omp passes the real object). */
interface SessionManagerLike {
	getLeafId(): string | null | undefined;
	getBranch(): unknown[];
	getSessionId(): string;
}
interface ContextLike {
	sessionManager: SessionManagerLike;
	agent?: { kind: "main" | "sub" };
	setInterval(fn: () => void, ms: number): unknown;
}
interface ExtensionApiLike {
	on(event: string, handler: (event: unknown, ctx: ContextLike) => unknown): void;
}

const POLL_MS = 1000;

export default function ompSessionsTodos(pi: ExtensionApiLike): void {
	const aoSessionId = process.env.AO_SESSION_ID?.trim();
	if (!aoSessionId) return;
	let file: string;
	try {
		file = todoMirrorFile(aoDataDir(), aoSessionId);
	} catch {
		return;
	}
	let leaf: string | null | undefined;
	let written: string | undefined;
	let polling = false;

	const sync = (ctx: ContextLike, force = false) => {
		const sm = ctx.sessionManager;
		const next = sm.getLeafId();
		if (!force && next === leaf && written !== undefined) return;
		leaf = next;
		const phases = latestTodoPhases(sm.getBranch());
		const key = JSON.stringify(phases);
		if (key === written) return;
		const mirror: TodoMirror = { aoSessionId, ompSessionId: sm.getSessionId(), updatedAt: Date.now(), phases };
		writeFileAtomic(file, `${JSON.stringify(mirror)}\n`);
		written = key;
	};

	pi.on("session_start", (_event, ctx) => {
		// Subagents share the process (and AO_SESSION_ID) but have their own todo lists.
		if (ctx.agent && ctx.agent.kind !== "main") return;
		sync(ctx, true);
		if (polling) return;
		polling = true;
		ctx.setInterval(() => sync(ctx), POLL_MS);
	});
	for (const event of ["session_switch", "session_branch", "session_tree"]) {
		pi.on(event, (_event, ctx) => {
			if (!ctx.agent || ctx.agent.kind === "main") sync(ctx, true);
		});
	}
}
