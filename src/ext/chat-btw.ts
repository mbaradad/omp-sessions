// `/btw <question>`: ask a side question without interrupting the agent. AO forks the omp conversation
// into a side chat (`conversation/side-chats`; omp advertises `fork_current`, so the fork carries the
// whole context), the question runs there, and the main conversation never notices. The webview draws
// each side chat as a "side question" card from a record `{id, question, answer, status}`.
import { randomUUID } from "node:crypto";
import { type AoClient, type AoSchemas, unwrap } from "../ao/client";

type SideSnapshot = AoSchemas["SideSnapshot"];

/** What the webview's side-question card renders (`btw_record`). */
export interface BtwRecord {
	id: string;
	question: string;
	answer: string;
	status: "running" | "done" | "error";
	error?: string;
	/** Later questions asked in the same side chat. */
	followUps: Array<{ question: string; answer: string }>;
}

const PENDING_TURNS: Readonly<Record<string, true>> = { queued: true, running: true, pending: true };
/** How long a side chat may take to open or answer. */
const SIDE_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 400;

/** The card for a side chat: its user messages are the questions, the assistant messages the answers, in order. */
export function btwRecord(snapshot: SideSnapshot): BtwRecord | undefined {
	const turns = [...snapshot.turns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	if (turns.length === 0) return undefined;
	const answerOf = (turnId: string) =>
		snapshot.messages
			.filter(m => m.turnId === turnId && m.role === "assistant")
			.sort((a, b) => a.sequence - b.sequence)
			.map(m => m.text)
			.join("\n\n");
	const [first, ...rest] = turns;
	const last = turns[turns.length - 1];
	const failed = last.state === "failed" || last.state === "cancelled";
	return {
		id: snapshot.side.id,
		question: first.text,
		answer: answerOf(first.id),
		status: failed ? "error" : PENDING_TURNS[last.state] ? "running" : "done",
		...(failed && { error: last.errorMessage || `The side question ${last.state}.` }),
		followUps: rest.map(t => ({ question: t.text, answer: answerOf(t.id) })),
	};
}

async function readSide(ao: AoClient, sessionId: string, sideId: string): Promise<SideSnapshot> {
	return (await unwrap(ao.api.GET("/api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}", { params: { path: { sessionId, sideId } } }))).snapshot;
}

/**
 * Opens a side chat on `sessionId`, asks `question` in it and reports the card after every change until
 * the answer is complete (or fails). Resolves with the final card.
 */
export async function askSideQuestion(ao: AoClient, sessionId: string, question: string, onRecord: (record: BtwRecord) => void): Promise<BtwRecord> {
	const deadline = Date.now() + SIDE_TIMEOUT_MS;
	const { side } = await unwrap(ao.api.POST("/api/v1/sessions/{sessionId}/conversation/side-chats", { params: { path: { sessionId } }, body: { idempotencyKey: randomUUID(), label: question.slice(0, 60), forceNew: true } }));
	const card = (state: BtwRecord["status"], error?: string): BtwRecord => ({ id: side.id, question, answer: "", status: state, ...(error && { error }), followUps: [] });
	onRecord(card("running"));
	const wait = () => new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
	// The side chat forks omp's session first; a question sent while it is `opening` is refused.
	let snapshot = await readSide(ao, sessionId, side.id);
	while (snapshot.side.state === "opening") {
		if (Date.now() > deadline) return finish(onRecord, card("error", "The side chat did not open in time."));
		await wait();
		snapshot = await readSide(ao, sessionId, side.id);
	}
	if (snapshot.side.state !== "ready") return finish(onRecord, card("error", snapshot.side.errorMessage || `The side chat is ${snapshot.side.state}.`));
	await unwrap(ao.api.POST("/api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/messages", { params: { path: { sessionId, sideId: side.id } }, body: { clientMessageId: randomUUID(), text: question } }));
	let shown = "";
	for (;;) {
		snapshot = await readSide(ao, sessionId, side.id);
		const record = btwRecord(snapshot);
		if (record) {
			const key = JSON.stringify(record);
			if (key !== shown) {
				shown = key;
				onRecord(record);
			}
			if (record.status !== "running") return record;
		}
		if (Date.now() > deadline) return finish(onRecord, { ...(record ?? card("running")), status: "error", error: "The side question timed out." });
		await wait();
	}
}

function finish(onRecord: (record: BtwRecord) => void, record: BtwRecord): BtwRecord {
	onRecord(record);
	return record;
}

/** The cards of the side chats this session already has, oldest first (a reload rebuilds them). */
export async function sideRecords(ao: AoClient, sessionId: string, limit = 20): Promise<BtwRecord[]> {
	const { sides } = await unwrap(ao.api.GET("/api/v1/sessions/{sessionId}/conversation/side-chats", { params: { path: { sessionId } } }));
	const recent = [...sides].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit);
	const records: BtwRecord[] = [];
	for (const side of recent) {
		try {
			const record = btwRecord(await readSide(ao, sessionId, side.id));
			if (record) records.push(record);
		} catch {
			// A side chat AO has already cleaned up.
		}
	}
	return records;
}
