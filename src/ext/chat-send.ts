// Sending to a chat whose omp is down: AO answers 409 CHAT_CONTROLLER_NOT_READY until the agent is
// resumed (it died, or was stopped); `resume-agent` restarts omp on the same conversation.
import { AoClient, AoError } from "../ao/client";

/**
 * Runs `attempt` (a send to `sessionId`); when AO says the agent is down, resumes it (`onResume` first,
 * for a notice) and runs it once more. A chat that is merely hibernated or starting is not resumed: AO
 * wakes it by itself, so its error goes to the caller.
 */
export async function sendResuming(ao: AoClient, sessionId: string, attempt: () => Promise<void>, onResume: () => void = () => {}): Promise<void> {
	try {
		await attempt();
	} catch (err) {
		if (!(err instanceof AoError) || err.code !== "CHAT_CONTROLLER_NOT_READY") throw err;
		const { controller } = await ao.getConversation(sessionId, { limit: 1 });
		if (controller !== "stopped") throw err;
		onResume();
		await ao.resumeAgent(sessionId);
		await attempt();
	}
}

/**
 * Stops the running turn. AO also discards every follow-up queued behind it (they end `interrupted` and
 * never run, GAPS G41), so the queued messages the person typed are sent again, in order, as soon as the
 * interrupt is done. Returns how many were sent again. Attachments of a queued message are not kept: AO
 * returns its text only.
 */
export async function interruptKeepingQueue(ao: AoClient, sessionId: string, queued: ReadonlyArray<{ text: string }>): Promise<number> {
	try {
		await ao.interrupt(sessionId);
	} catch (err) {
		// The turn ended between the keypress and the call: nothing was discarded, nothing to send again.
		if (err instanceof AoError && err.code === "CHAT_NO_ACTIVE_TURN") return 0;
		throw err;
	}
	for (const { text } of queued) await ao.sendMessage(sessionId, { text });
	return queued.length;
}
