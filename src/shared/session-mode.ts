// Permission modes for AO sessions (GAPS.md G7, MAPPING.md Q4/D11). AO fixes omp's approval mode at
// launch, so Switchyard starts omp in AO's `bypass-permissions` and gates tool calls itself, in the
// Switchyard omp extension (src/omp-extension/mode.ts), from one small file per session:
//   <Switchyard state folder>/sessions/<AO session id>/mode      `ask` | `edits` | `plan` | `auto`
// Switching is rewriting that file; the gate reads it on every tool call, so it is live and works
// with no client open. No file = the session is not Switchyard-managed (started from AO's own UI):
// the gate does nothing and AO's mode applies. Node-only, no omp or AO imports (the omp bundle uses it).
import * as fs from "node:fs";
import * as path from "node:path";
import { switchyardHome } from "../ao/native";
import { writeFileAtomic } from "./checkpoints";
import { EDIT_TOOLS, PERMISSION_MODES, type PermissionMode, isPermissionMode } from "./permissions";

export { PERMISSION_MODES, type PermissionMode, isPermissionMode };

export function modeFile(aoSessionId: string, home = switchyardHome()): string {
	return path.join(home, "sessions", aoSessionId, "mode");
}

/** The session's mode, or undefined when it has no (valid) mode file. */
export function readMode(aoSessionId: string, home = switchyardHome()): PermissionMode | undefined {
	try {
		const text = fs.readFileSync(modeFile(aoSessionId, home), "utf8").trim();
		return isPermissionMode(text) ? text : undefined;
	} catch {
		return undefined;
	}
}

export function writeMode(aoSessionId: string, mode: PermissionMode, home = switchyardHome()): void {
	const file = modeFile(aoSessionId, home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomic(file, `${mode}\n`);
}

/** Tools the gate asks about besides the edit tools: they run commands. */
const COMMAND_TOOLS: Readonly<Record<string, true>> = { bash: true, eval: true, ssh: true };

/** What the gate does with one tool call: let it run, ask the person, or refuse it. */
export type GateDecision = "allow" | "ask" | "block";

/**
 * `ask`: asks before edits and commands (omp's read-only tools never asked); `edits`: edits go
 * through, commands ask; `plan`: edits are refused, commands ask; `auto`: everything goes through.
 * Subagents (`sub`) can't ask anyone: in `plan` their edits are refused too, otherwise they run.
 */
export function gateDecision(mode: PermissionMode, tool: string, sub = false): GateDecision {
	if (mode === "auto") return "allow";
	if (EDIT_TOOLS[tool]) {
		if (mode === "plan") return "block";
		if (mode === "edits" || sub) return "allow";
		return "ask";
	}
	if (COMMAND_TOOLS[tool] && !sub) return "ask";
	return "allow";
}

/** What a tool call does, for the question's text: the command, or the path(s) an edit touches. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
	const text = (v: unknown) => (typeof v === "string" ? v : undefined);
	const detail = text(input.command) ?? text(input.path) ?? text(input.file_path) ?? text(input.notebook_path) ?? text(input.input) ?? text(input.patch);
	const first = detail?.split("\n")[0]?.slice(0, 200);
	return first ? `${tool}: ${first}` : tool;
}

export const APPROVE = "Approve";
export const APPROVE_SESSION = "Approve for this session";
export const DENY = "Deny";
export const REFUSED_IN_PLAN = "Plan mode: read-only. Explore and reply with a plan; file edits are refused until the mode is switched.";
