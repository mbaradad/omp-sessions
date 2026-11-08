// Session health rules shared by the session host, the extension and the doctor report. Pure.

import type { SessionMeta } from "./protocol";

/** exitReason of a session whose host died mid-turn: a person's next resume asks omp to continue that turn. */
export const HOST_CRASHED = "host crashed";
/** exitReason of a session whose host died while nothing was running. */
export const HOST_DIED = "host process died";

/** Statuses in which a turn is in flight, so a dead host leaves unfinished work behind. */
const MID_TURN: Partial<Record<SessionMeta["status"], true>> = { working: true, waiting: true };

/**
 * The session as it really is: meta.json still claiming to run although its host process is
 * gone (killed, machine rebooted, out of memory) means stopped. Returns `meta` unchanged otherwise.
 */
export function settleDeadHost(meta: SessionMeta, hostAlive: boolean): SessionMeta {
	if (meta.status === "stopped" || hostAlive) return meta;
	return { ...meta, status: "stopped", exitReason: MID_TURN[meta.status] ? HOST_CRASHED : (meta.exitReason ?? HOST_DIED) };
}

/** A running session whose host was started by another extension version (or one too old to say). */
export function isOutdated(meta: SessionMeta, extensionVersion: string): boolean {
	return meta.status !== "stopped" && meta.hostVersion !== extensionVersion;
}

const AUTH_PATTERNS = [
	/no api key/i,
	/api key (?:was )?(?:rejected|invalid|missing|not (?:found|set|configured))/i,
	/invalid (?:x-)?api[ -_]?key/i,
	/\/login\b/,
	/\bomp login\b/,
	/not logged in/i,
	/no credentials/i,
	/could not authenticate/i,
	/authentication (?:failed|required)/i,
	/\bunauthori[sz]ed\b/i,
	/no models? (?:is )?(?:available|selected|configured)/i,
	/no model is currently selected/i,
];

/** Whether an omp error means no provider is usable (not logged in, missing/rejected API key). */
export function isAuthError(text: string | undefined): boolean {
	return !!text && AUTH_PATTERNS.some(re => re.test(text));
}
