// omp extension shipped by Switchyard: the permission-mode gate (GAPS.md G7, MAPPING.md Q4).
// AO starts omp in its `bypass-permissions` mode; this module is the only gate. Before every tool
// call it reads the session's mode file (src/shared/session-mode.ts) and lets the call run, asks
// the person, or refuses it. Asking uses omp's own dialog, which under `omp acp` becomes an AO
// question (a `user_input` activity) in AO's UI, the VS Code chat, the CLI and Hermes. Rewriting the
// mode file switches live; a question already waiting is withdrawn (and answered by the new mode)
// when the file changes. No mode file (a session started from AO's own UI): does nothing.
// Active only with AO_SESSION_ID (MAPPING.md D6).
import * as fs from "node:fs";
import { APPROVE, APPROVE_SESSION, DENY, REFUSED_IN_PLAN, type PermissionMode, describeCall, gateDecision, modeFile, readMode, targetsOnlyInternal } from "../shared/session-mode";

/** The slice of omp's extension API this module uses (types only; omp passes the real objects). */
interface ContextLike {
	agent?: { kind: "main" | "sub" };
	hasUI?: boolean;
	ui: { select(title: string, options: string[], dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined> };
}
interface ToolCallEventLike {
	toolName: string;
	input: Record<string, unknown>;
}
interface ExtensionApiLike {
	on(event: "tool_call", handler: (event: ToolCallEventLike, ctx: ContextLike) => Promise<{ block: true; reason: string } | undefined>): void;
}

const POLL_MS = 500;

export default function switchyardMode(pi: ExtensionApiLike): void {
	const aoSessionId = process.env.AO_SESSION_ID?.trim();
	if (!aoSessionId) return;
	/** Tools the person approved "for this session" in the current mode. */
	let approved = new Set<string>();
	let approvedIn: PermissionMode | undefined;

	/** Waits for the person's answer, withdrawing the question when the mode file changes meanwhile. */
	const ask = async (ctx: ContextLike, title: string, mode: PermissionMode): Promise<string | undefined> => {
		const abort = new AbortController();
		const file = modeFile(aoSessionId);
		const stamp = () => {
			try {
				return String(fs.statSync(file).mtimeMs);
			} catch {
				return "";
			}
		};
		const started = stamp();
		const timer = setInterval(() => {
			if (stamp() !== started && readMode(aoSessionId) !== mode) abort.abort();
		}, POLL_MS);
		try {
			return await ctx.ui.select(title, [APPROVE, APPROVE_SESSION, DENY], { signal: abort.signal });
		} catch (err) {
			// A withdrawn dialog may reject instead of resolving undefined; anything else is a refusal.
			if (abort.signal.aborted) return undefined;
			throw err;
		} finally {
			clearInterval(timer);
		}
	};

	pi.on("tool_call", async (event, ctx) => {
		const sub = ctx.agent?.kind === "sub";
		// A fresh look at the mode each time, and again after a question that a mode switch withdrew.
		for (let attempt = 0; attempt < 5; attempt++) {
			const mode = readMode(aoSessionId);
			if (!mode) return undefined;
			if (mode !== approvedIn) {
				approved = new Set();
				approvedIn = mode;
			}
			const decision = gateDecision(mode, event.toolName, sub, targetsOnlyInternal(event.input));
			if (decision === "allow" || approved.has(event.toolName)) return undefined;
			if (decision === "block") return { block: true, reason: REFUSED_IN_PLAN };
			if (!ctx.hasUI) return { block: true, reason: `${mode} mode asks before ${event.toolName}, and no one can be asked here.` };
			const answer = await ask(ctx, `Allow tool: ${describeCall(event.toolName, event.input)}`, mode);
			if (readMode(aoSessionId) !== mode) continue;
			if (answer === APPROVE) return undefined;
			if (answer === APPROVE_SESSION) {
				approved.add(event.toolName);
				return undefined;
			}
			return { block: true, reason: "Denied by the person." };
		}
		return { block: true, reason: "The permission mode kept changing; try again." };
	});
}
