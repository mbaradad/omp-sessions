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
