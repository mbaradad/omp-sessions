// Switching a Switchyard session's permission mode through AO, for every client (VS Code, CLI, Hermes,
// the planner). The gate itself runs in the omp extension (src/omp-extension/mode.ts) from the mode
// file; this adds what only a client can do: omp's own plan option, and declining the gate's
// question that the switch left behind (AO keeps it pending, which would show the session as
// needing input). Node-only.
import type { AoClient } from "../ao/client";
import { pendingActivities } from "../ao/model";
import { type PermissionMode, readMode, writeMode } from "./session-mode";

/** Requests of the gate's questions ("Allow tool: …") still waiting for an answer. */
async function gateQuestions(ao: AoClient, sessionId: string): Promise<string[]> {
	const out: string[] = [];
	for (const a of pendingActivities(await ao.getConversation(sessionId))) {
		const detail = typeof a.detail === "object" && a.detail !== null ? (a.detail as Record<string, unknown>) : {};
		if (a.activityKind === "user_input" && a.requestId && typeof detail.message === "string" && detail.message.startsWith("Allow tool: ")) out.push(a.requestId);
	}
	return out;
}

/**
 * Sets the session's mode: writes the mode file (live; the omp extension reads it on every tool
 * call and withdraws a question already waiting, asking again if the new mode still asks), sets
 * omp's own `mode` option to `plan` or back to `default`, and declines the questions that were
 * open before the switch: AO keeps a withdrawn question pending, which would show the session as
 * needing input. Questions the new mode raises have new request ids and are left alone.
 */
export async function setSessionMode(ao: AoClient, sessionId: string, mode: PermissionMode): Promise<{ previous: PermissionMode | undefined }> {
	const previous = readMode(sessionId);
	const stale = await gateQuestions(ao, sessionId);
	writeMode(sessionId, mode);
	if ((mode === "plan") !== (previous === "plan")) {
		await ao.setConfigOption(sessionId, "mode", { value: mode === "plan" ? "plan" : "default" }).catch(() => undefined);
	}
	if (stale.length) {
		// Give the extension its poll interval to withdraw them, then close what AO still lists.
		await new Promise(resolve => setTimeout(resolve, 1200));
		for (const requestId of stale) await ao.resolveInput(sessionId, requestId, { action: "decline" }).catch(() => undefined);
	}
	return { previous };
}
