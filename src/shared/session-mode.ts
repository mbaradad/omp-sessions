// Permission modes for AO sessions (GAPS.md G7, MAPPING.md Q4/D11). AO fixes omp's approval mode at
// launch, so Switchyard starts omp in AO's `bypass-permissions` and gates tool calls itself, in the
// Switchyard omp extension (src/omp-extension/mode.ts), from one small file per session:
//   <Switchyard state folder>/sessions/<AO session id>/mode      `ask` | `edits` | `plan` | `auto`
// Switching is rewriting that file; the gate reads it on every tool call, so it is live and works
// with no client open. No file = the session is not Switchyard-managed (started from AO's own UI):
// the gate does nothing and AO's mode applies. Node-only. Self-contained on purpose: with session-mode-ops.ts it can
// be taken without the rest of the checkpoints code; it imports only src/ao/native.ts and ./permissions.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { sessionStateFile, switchyardHome } from "../ao/native";
import { EDIT_TOOLS, PERMISSION_MODES, type PermissionMode, isPermissionMode } from "./permissions";

export { PERMISSION_MODES, type PermissionMode, isPermissionMode };

export function modeFile(aoSessionId: string, home = switchyardHome()): string {
	return sessionStateFile(aoSessionId, "mode", home);
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

/** Temp file + rename, so the gate (reading on every tool call) never sees a half-written mode. */
function writeFileAtomic(file: string, content: string): void {
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
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
export function gateDecision(mode: PermissionMode, tool: string, sub = false, internalOnly = false): GateDecision {
	if (mode === "auto") return "allow";
	if (EDIT_TOOLS[tool]) {
		// omp's own plan file (`local://…`) and its propose step (`xd://propose`) are how it presents a plan: plan mode lets them through.
		if (mode === "plan") return internalOnly ? "allow" : "block";
		if (mode === "edits" || sub) return "allow";
		return "ask";
	}
	if (COMMAND_TOOLS[tool] && !sub) return "ask";
	return "allow";
}

const INTERNAL_TARGET = /^(local|xd):\/\//;

/** Every path an edit call names: path arguments, and the headers of hashline edits and patches. */
function namedPaths(input: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ["path", "file", "file_path", "notebook_path", "notebook"]) if (typeof input[key] === "string" && input[key]) out.push(input[key]);
	if (Array.isArray(input.paths)) for (const v of input.paths) if (typeof v === "string") out.push(v);
	const text = input.input ?? input.patch;
	if (typeof text === "string") {
		for (const m of text.matchAll(/^\[([^\]\n#]+)#[0-9A-Za-z]{2,8}\]/gm)) out.push(m[1].trim());
		for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
		for (const m of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push(m[1].trim());
		for (const m of text.matchAll(/^MV\s+"?([^"\n]+)"?\s*$/gm)) out.push(m[1].trim());
	}
	return out;
}

/** The call writes only omp's internal `local://` and `xd://` targets (and names at least one). */
export function targetsOnlyInternal(input: Record<string, unknown>): boolean {
	const paths = namedPaths(input);
	return paths.length > 0 && paths.every(p => INTERNAL_TARGET.test(p));
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
