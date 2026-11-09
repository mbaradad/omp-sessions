// The omp session behind an AO session (GAPS.md G9). AO keeps omp's own session id internal, so the
// Switchyard omp extension, which runs inside `omp acp` with AO_SESSION_ID in its environment, records
// it in `<switchyard home>/sessions/<AO session id>/omp.json`. Clients read it here for what needs
// omp's transcript: continue in omp's TUI, export, usage and cost from the transcript, history search.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AoNativeSession {
	aoSessionId: string;
	/** omp's session id (`omp --resume <id>`). */
	ompSessionId?: string;
	/** omp's transcript file (JSONL). */
	sessionFile?: string;
	cwd?: string;
}

/** Switchyard's state dir: SWITCHYARD_HOME, default ~/.switchyard. */
export function switchyardHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.SWITCHYARD_HOME ? path.resolve(env.SWITCHYARD_HOME) : path.join(os.homedir(), ".switchyard");
}

export function nativeSessionFile(aoSessionId: string, home = switchyardHome()): string {
	return path.join(home, "sessions", aoSessionId, "omp.json");
}

/** What the extension recorded for this AO session, or undefined before it ran (or for a non-omp session). */
export function readNativeSession(aoSessionId: string, home = switchyardHome()): AoNativeSession | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(nativeSessionFile(aoSessionId, home), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null) return undefined;
	// Written by our own extension; each field is still checked before use.
	const record = raw as Partial<Record<keyof AoNativeSession, unknown>>;
	const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
	const ompSessionId = text(record.ompSessionId);
	const sessionFile = text(record.sessionFile);
	const cwd = text(record.cwd);
	return { aoSessionId, ...(ompSessionId && { ompSessionId }), ...(sessionFile && { sessionFile }), ...(cwd && { cwd }) };
}
