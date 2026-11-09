// `omp-sessions attach`: a terminal chat on an AO session, and the read-only follower behind
// `omp-sessions tail -f` and `send --wait`. AO's event stream only says that a session changed; each
// change refetches the conversation tail and prints what is new (render.ts ConversationFollower).
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { type AoClient, type AoConversation, type AoSessionView, unwrap } from "../ao/client";
import { type AoQuestion, answerFor, followConversation, questionsOf, sessionModel } from "../ao/model";
import { ConversationFollower, itemLines, timeline } from "./render";
import type { Session } from "./sessions";
import { c, oneLine, termWidth } from "./term";

export interface AttachOptions {
	/** Timeline entries (messages and tool calls) of history to print first. */
	history: number;
	/** Follow output only (no prompt; questions are left to other clients). */
	readOnly: boolean;
	/**
	 * For `send --wait`: send this prompt, then leave once its turn is over and nothing else runs (0),
	 * a question waits (3) or the agent stops (4), like `wait`.
	 */
	prompt?: string;
	/** With `prompt`: steer the running turn (default: a follow-up after it). */
	steer?: boolean;
}

/** Messages read per refetch: enough to cover what changed since the last one. */
const TAIL = 40;
/** Fallback refetch period: the event stream is the fast path. */
const POLL_MS = 2000;
/** AO hibernates a chat nobody views after 90 s; a view lease (30 s) keeps it warm while attached. */
const VIEW_LEASE_MS = 20_000;

const STATE_COLOR: Record<string, (s: string) => string> = { working: c.yellow, starting: c.dim, needs_input: c.magenta, idle: c.green, stopped: c.dim, interrupted: c.red, queued: c.blue, scheduled: c.blue };

function header(s: Session): string {
	return `${c.bold(s.title)}  ${c.dim(s.id)}  ${(STATE_COLOR[s.state] ?? c.dim)(s.state.replace("_", " "))}  ${c.dim(s.cwd)}${s.model.model ? `  ${c.dim(s.model.model)}` : ""}`;
}

/** A question's lines: the title, the message, numbered choices per field. */
function describe(q: AoQuestion): string[] {
	const out = [c.magenta(c.bold(`? ${oneLine((q.message ?? q.title).split("\n")[0]) || "Question"}`))];
	const rest = (q.message ?? "").split("\n").slice(1).join("\n").trim();
	if (rest) out.push(rest);
	if (q.kind === "approval") {
		(q.options ?? []).forEach((o, i) => out.push(`  ${c.bold(String(i + 1))}. ${o}`));
		out.push(c.dim("  number or text; empty to leave it for later"));
		return out;
	}
	const fields = q.questions ?? [];
	for (const f of fields) {
		if (fields.length > 1 || (f.question && f.question !== q.title)) out.push(c.bold(f.question));
		f.options.forEach((o, i) => out.push(`  ${c.bold(String(i + 1))}. ${o}`));
		if (f.type === "boolean") out.push(c.dim("  y/n"));
		else if (f.options.length) out.push(c.dim(f.multi ? "  numbers separated by commas" : "  number or text"));
	}
	if (fields.length > 1) out.push(c.dim("  one answer per line; empty to dismiss"));
	else out.push(c.dim("  empty to dismiss"));
	return out;
}

/** Resolves with the exit code once detached, the agent stopped (`send --wait`) or the question needs someone else. */
export async function attach(client: AoClient, session: Session, opts: AttachOptions): Promise<number> {
	const id = session.id;
	const { promise: done, resolve: finish } = Promise.withResolvers<number>();
	const interactive = !opts.readOnly && opts.prompt === undefined && !!process.stdin.isTTY;
	const echoed = new Set<string>();
	let promptVisible = false;
	let rl: readline.Interface | undefined;
	let finished = false;
	const out = (s: string) => {
		if (promptVisible) {
			process.stdout.write("\r\x1b[K");
			promptVisible = false;
		}
		process.stdout.write(s);
	};
	const follower = new ConversationFollower(out, termWidth, echoed);

	// ---------- prompt and questions ----------
	let dialog: { q: AoQuestion; answers: string[] } | undefined;
	/** Questions shown here, by request id (a question answered elsewhere disappears from AO's pending list). */
	const shown = new Set<string>();
	/** Answered or dismissed here: AO may still list them until its next snapshot. */
	const settled = new Set<string>();
	let promptTimer: NodeJS.Timeout | undefined;
	const showPrompt = () => {
		if (!rl) return;
		clearTimeout(promptTimer);
		promptTimer = setTimeout(() => {
			if (!rl || promptVisible || follower.isMidLine()) return;
			rl.setPrompt(dialog ? c.magenta("? ") : c.cyan("› "));
			rl.prompt(true);
			promptVisible = true;
		}, 40);
	};
	const say = (s: string) => {
		follower.endLine();
		out(`${s}\n`);
		showPrompt();
	};

	const answer = async (q: AoQuestion, text: string) => {
		const resolved = answerFor(q, text);
		if ("error" in resolved) {
			say(c.red(`  ${resolved.error}`));
			return false;
		}
		try {
			if (resolved.kind === "approval") await client.resolveApproval(id, q.id, resolved.decisionId);
			else await client.resolveInput(id, q.id, resolved.body);
			return true;
		} catch (err) {
			say(c.red(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
			return false;
		}
	};
	const dismiss = async (q: AoQuestion) => {
		dialog = undefined;
		settled.add(q.id);
		// An approval has no dismiss: it stays pending for VS Code, the phone or `omp-sessions answer`.
		if (q.kind === "input") await client.resolveInput(id, q.id, { action: "cancel" }).catch(() => undefined);
		say(c.dim(q.kind === "input" ? "  (dismissed)" : "  (left for later)"));
	};
	const onLine = async (line: string) => {
		if (!dialog) return;
		const { q } = dialog;
		const fields = q.kind === "input" ? Math.max(1, q.questions?.length ?? 0) : 1;
		if (!line.trim() && dialog.answers.length === 0) return dismiss(q);
		dialog.answers.push(line);
		if (dialog.answers.length < fields) return showPrompt();
		const text = dialog.answers.join(" | ");
		dialog.answers = [];
		if (await answer(q, text)) {
			dialog = undefined;
			settled.add(q.id);
		}
		showPrompt();
	};

	const onQuestions = (questions: AoQuestion[]) => {
		const pending = new Set(questions.map(q => q.id));
		if (dialog && !pending.has(dialog.q.id)) {
			dialog = undefined;
			say(c.dim("  (answered elsewhere)"));
		}
		for (const q of questions) {
			if (shown.has(q.id)) continue;
			shown.add(q.id);
			if (!interactive) {
				say(c.magenta(`? ${oneLine((q.message ?? q.title).split("\n")[0])} — waiting for an answer`));
				if (opts.prompt !== undefined) {
					say(c.dim(`answer: omp-sessions answer ${id} <choice>`));
					finish(3);
				}
				continue;
			}
			if (!dialog) {
				dialog = { q, answers: [] };
				for (const l of describe(q)) say(l);
			}
		}
		// The next one once the current is answered.
		if (interactive && !dialog) {
			const next = questions.find(q => shown.has(q.id) && !settled.has(q.id));
			if (next) {
				dialog = { q: next, answers: [] };
				for (const l of describe(next)) say(l);
			}
		}
	};

	process.stdout.write(`${header(session)}\n`);
	// ---------- history, then live: src/ao reads the conversation's changes as AO reports them ----------
	/** `send --wait`: the turn we started; we leave once it is over. */
	let ourTurn: string | undefined;
	let sawRunning = false;
	let stoppedSaid = false;
	let started = false;
	let checking = false;
	let conversation: AoConversation | undefined;
	/** The session's state needs its AO view too (an exited agent shows there, not in the conversation). */
	const check = async () => {
		const conv = conversation;
		if (finished || checking || !conv) return;
		checking = true;
		try {
			const state = sessionModel(await client.getSession(id), conv).state;
			if (state === "stopped" && !stoppedSaid) {
				stoppedSaid = true;
				say(c.dim("session stopped"));
				if (opts.prompt !== undefined || opts.readOnly) finish(opts.prompt !== undefined ? 4 : 0);
			} else if (state !== "stopped") stoppedSaid = false;
			if (opts.prompt !== undefined) {
				const busy = conv.turns.some(t => t.state === "running" || t.state === "queued");
				if (busy) sawRunning = true;
				const mine = ourTurn ? conv.turns.find(t => t.id === ourTurn) : undefined;
				const over = mine ? mine.state !== "running" && mine.state !== "queued" : sawRunning;
				if (over && !busy && state !== "needs_input") finish(0);
			}
		} catch {
			// The daemon restarted or the session is gone; the next change or poll checks again.
		} finally {
			checking = false;
		}
	};
	const follow = followConversation(client, id, {
		limit: Math.max(TAIL, opts.history),
		onUpdate: ({ conversation: conv }) => {
			conversation = conv;
			// The first snapshot is the history, printed below.
			if (!started || finished) return;
			follower.update(conv);
			onQuestions(questionsOf(conv));
			void check();
			if (!follower.isMidLine()) showPrompt();
		},
	});
	let first: AoConversation;
	try {
		first = await follow.ready;
	} catch (err) {
		follow.close();
		process.stderr.write(`${c.red("omp-sessions:")} ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
	conversation ??= first;
	// A reply still streaming is left out of the history: the follower prints it and then its growth.
	const live = first.messages.at(-1)?.streaming ? first.messages.at(-1) : undefined;
	const before = live ? { ...first, messages: first.messages.filter(m => m !== live) } : first;
	const items = timeline(before).filter(i => itemLines(i, termWidth()).length > 0);
	const history = opts.history > 0 ? items.slice(-opts.history) : [];
	if (items.length > history.length || first.hasMoreBefore) process.stdout.write(c.dim("… earlier messages\n"));
	for (const item of history) for (const l of itemLines(item, termWidth())) follower.write(`${l}\n`);
	follower.seen(before);
	started = true;
	follower.update(conversation);
	onQuestions(questionsOf(conversation));
	// Changes AO's feed doesn't carry for this session (its agent exiting) still show within a few seconds.
	const poll = setInterval(() => void check(), POLL_MS);
	const viewId = `omp-sessions-cli-${randomUUID()}`;
	const lease = (active: boolean) => unwrap(client.api.POST("/api/v1/sessions/{sessionId}/chat-view", { params: { path: { sessionId: id } }, body: { viewId, active } })).catch(() => undefined);
	void lease(true);
	const leaseTimer = setInterval(() => void lease(true), VIEW_LEASE_MS);

	const busyNow = () => !!conversation?.turns.some(t => t.state === "running");
	const send = async (text: string, steer: boolean) => {
		if (steer && busyNow()) {
			await client.steerOrSend(id, { text });
			return undefined;
		}
		return (await client.sendMessage(id, { text })).turnId;
	};

	if (opts.prompt !== undefined) {
		try {
			ourTurn = await send(opts.prompt, !!opts.steer);
		} catch (err) {
			process.stderr.write(`${c.red("omp-sessions:")} ${err instanceof Error ? err.message : String(err)}\n`);
			finish(1);
		}
		void check();
	}

	if (interactive) {
		rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: c.cyan("› ") });
		let lastInterrupt = 0;
		rl.on("line", line => {
			promptVisible = false;
			if (dialog) {
				void onLine(line);
				return;
			}
			const text = line.trim();
			if (!text) return showPrompt();
			if (text === "/detach" || text === "/q" || text === "/exit") return finish(0);
			if (text === "/abort") {
				void client.interrupt(id).catch(err => say(c.red(`✗ ${err instanceof Error ? err.message : String(err)}`)));
				return showPrompt();
			}
			if (text === "/stop") {
				void client.exitAgent(id).then(
					() => say(c.dim("stopped (omp-sessions resume to continue)")),
					err => say(c.red(`✗ ${err instanceof Error ? err.message : String(err)}`)),
				);
				return;
			}
			if (text === "/help") {
				say(c.dim("Type to prompt (steers while omp works). /abort  /stop  /detach   Ctrl-C aborts a turn, Ctrl-D detaches."));
				return;
			}
			echoed.add(text);
			void send(text, true).catch(err => say(c.red(`✗ ${err instanceof Error ? err.message : String(err)}`)));
		});
		rl.on("SIGINT", () => {
			if (dialog) {
				void dismiss(dialog.q);
				return;
			}
			if (busyNow()) {
				void client.interrupt(id).catch(() => undefined);
				say(c.yellow("(aborting)"));
				return;
			}
			if (Date.now() - lastInterrupt < 1500) return finish(0);
			lastInterrupt = Date.now();
			say(c.dim("(Ctrl-C again, Ctrl-D or /detach to leave; the session keeps running)"));
		});
		rl.on("close", () => finish(0));
		say(c.dim("Attached. Ctrl-D detaches (the session keeps running), /help for commands."));
	} else if (!opts.readOnly && opts.prompt === undefined) {
		process.stderr.write(c.dim("stdin is not a terminal: following output only\n"));
	}
	if (session.model.view.isTerminated && opts.prompt === undefined) say(c.dim("session stopped (omp-sessions resume to continue)"));

	const code = await done;
	finished = true;
	clearTimeout(promptTimer);
	clearInterval(poll);
	clearInterval(leaseTimer);
	follow.close();
	rl?.close();
	follower.endLine();
	await lease(false);
	return code;
}
