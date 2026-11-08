// `omp-sessions attach`: a terminal chat on a running session (straight to its host socket), and the
// read-only follower behind `omp-sessions tail -f`.
import * as readline from "node:readline";
import { type Snapshot, HostConnection, isBusy } from "../shared/host-conn";
import { DIALOG_METHODS, type HostToClient, type SessionMeta, type UiRequest } from "../shared/protocol";
import { LiveRenderer, textOf } from "./render";
import { STATUS_COLOR, c, oneLine, termWidth } from "./term";

export interface AttachOptions {
	/** Messages of history to print first. */
	history: number;
	/** Follow output only (no prompt, dialogs left to other clients). */
	readOnly: boolean;
	/** For `send --wait`-style use: leave once omp is idle again after this prompt. */
	prompt?: string;
}

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function header(meta: SessionMeta): string {
	const status = (STATUS_COLOR[meta.status] ?? c.dim)(meta.status);
	return `${c.bold(meta.title)}  ${c.dim(meta.id.slice(0, 8))}  ${status}  ${c.dim(meta.cwd)}${meta.model ? `  ${c.dim(meta.model)}` : ""}`;
}

/** Resolves with the exit code once detached or the host is gone. */
export async function attach(meta: SessionMeta, opts: AttachOptions): Promise<number> {
	let opened: { conn: HostConnection; snapshot: Snapshot };
	try {
		opened = await HostConnection.open(meta.socket, opts.readOnly ? "omp-sessions-tail" : "omp-sessions");
	} catch (err) {
		process.stderr.write(`${c.red("omp-sessions:")} ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
	const { conn, snapshot } = opened;
	let current = snapshot.meta;
	let state: unknown = snapshot.state;
	const { promise: done, resolve: finish } = Promise.withResolvers<number>();
	const interactive = !opts.readOnly && !!process.stdin.isTTY;
	/** We left on purpose: our own close of the connection is not news. */
	let detached = false;
	/** Prompts typed here (readline already echoed them). */
	const echoed = new Set<string>();

	let promptVisible = false;
	let rl: readline.Interface | undefined;
	const renderer = new LiveRenderer(s => {
		if (promptVisible) {
			process.stdout.write("\r\x1b[K");
			promptVisible = false;
		}
		process.stdout.write(s);
	}, termWidth);

	// ---------- prompt / dialogs ----------
	const dialogs: UiRequest[] = [];
	let dialogStep: { req: UiRequest; question: number; answers: Array<Record<string, unknown>> } | undefined;
	let promptTimer: NodeJS.Timeout | undefined;
	const promptText = () => (dialogStep ? c.magenta("? ") : c.cyan("› "));

	const showPrompt = () => {
		if (!rl) return;
		clearTimeout(promptTimer);
		promptTimer = setTimeout(() => {
			if (!rl || renderer.isMidLine()) return;
			rl.setPrompt(promptText());
			rl.prompt(true);
			promptVisible = true;
		}, 40);
	};

	const say = (s: string) => {
		renderer.endLine();
		renderer.write(`${s}\n`);
		showPrompt();
	};

	const respond = (id: string, res: Record<string, unknown>) => {
		conn.write({ t: "ui_response", res: { id, ...res } });
	};

	const describeDialog = () => {
		if (!dialogStep) return;
		const { req, question } = dialogStep;
		switch (req.method) {
			case "select": {
				const options = Array.isArray(req.options) ? req.options.map(String) : [];
				say(c.magenta(c.bold(str(req.title) || "Choose")));
				options.forEach((o, i) => say(`  ${c.bold(String(i + 1))}. ${o}`));
				say(c.dim("  number or text; empty to dismiss"));
				return;
			}
			case "confirm":
				say(`${c.magenta(c.bold(str(req.title) || "Confirm"))}${req.message ? `\n${str(req.message)}` : ""}`);
				say(c.dim("  y/n"));
				return;
			case "input":
			case "editor":
				say(c.magenta(c.bold(str(req.title) || "Input")));
				if (str(req.prefill)) say(c.dim(`  default: ${oneLine(str(req.prefill))} (empty line keeps it)`));
				return;
			case "ask": {
				const q = rec((Array.isArray(req.questions) ? req.questions : [])[question]);
				const options = (Array.isArray(q.options) ? q.options : []).map(o => str(rec(o).label));
				say(`${q.header ? c.dim(`[${str(q.header)}] `) : ""}${c.magenta(c.bold(str(q.question)))}`);
				options.forEach((o, i) => say(`  ${c.bold(String(i + 1))}. ${o}${q.recommended === i ? c.dim(" (recommended)") : ""}`));
				say(c.dim(q.multi ? "  numbers separated by commas, or your own answer" : "  number, or your own answer"));
				return;
			}
		}
	};

	const nextDialog = () => {
		if (dialogStep || !interactive) return;
		const req = dialogs.shift();
		if (!req) return;
		dialogStep = { req, question: 0, answers: [] };
		describeDialog();
	};

	const answerDialog = (line: string) => {
		if (!dialogStep) return;
		const { req } = dialogStep;
		const text = line.trim();
		const finishDialog = (res: Record<string, unknown>) => {
			respond(req.id, res);
			dialogStep = undefined;
			nextDialog();
			showPrompt();
		};
		switch (req.method) {
			case "select": {
				const options = Array.isArray(req.options) ? req.options.map(String) : [];
				if (!text) return finishDialog({ cancelled: true });
				const n = Number(text);
				const value = Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : (options.find(o => o.toLowerCase() === text.toLowerCase()) ?? text);
				return finishDialog({ value });
			}
			case "confirm":
				if (/^y(es)?$/i.test(text)) return finishDialog({ confirmed: true });
				if (/^no?$/i.test(text)) return finishDialog({ confirmed: false });
				say(c.dim("  y or n"));
				return;
			case "input":
			case "editor":
				return finishDialog({ value: text || str(req.prefill) });
			case "ask": {
				const questions = (Array.isArray(req.questions) ? req.questions : []).map(rec);
				const q = questions[dialogStep.question];
				const options = (Array.isArray(q.options) ? q.options : []).map(o => str(rec(o).label));
				const picks = text.split(",").map(s => Number(s.trim()));
				const answer: Record<string, unknown> = { id: str(q.id), selectedOptions: [] };
				if (text && picks.every(n => Number.isInteger(n) && n >= 1 && n <= options.length)) answer.selectedOptions = [...new Set(picks.map(n => options[n - 1]))];
				else if (text) answer.customInput = text;
				else if (typeof q.recommended === "number" && options[q.recommended]) answer.selectedOptions = [options[q.recommended]];
				dialogStep.answers.push(answer);
				dialogStep.question++;
				if (dialogStep.question < questions.length) {
					describeDialog();
					showPrompt();
					return;
				}
				return finishDialog({ answers: dialogStep.answers });
			}
			default:
				return finishDialog({ cancelled: true });
		}
	};

	const onUiRequest = (req: UiRequest) => {
		if (DIALOG_METHODS[req.method]) {
			if (!interactive) {
				say(c.magenta(`? ${str(req.title) || req.method} — waiting for an answer (attach to answer)`));
				return;
			}
			dialogs.push(req);
			nextDialog();
			showPrompt();
		} else if (req.method === "notify" && str(req.message)) say(c.blue(`ⓘ ${oneLine(str(req.message))}`));
	};

	// ---------- history ----------
	process.stdout.write(`${header(current)}\n`);
	const history = opts.history > 0 ? snapshot.messages.slice(-opts.history) : [];
	if (snapshot.messages.length > history.length) process.stdout.write(c.dim(`… ${snapshot.messages.length - history.length} earlier messages\n`));
	for (const m of history) renderer.message(m);
	if (snapshot.inflight) renderer.message(snapshot.inflight.message);
	for (const req of snapshot.pendingUi) onUiRequest(req);

	// ---------- live ----------
	let sawBusy = isBusy(current, state);
	const onMessage = (msg: HostToClient) => {
		switch (msg.t) {
			case "event": {
				const ev = msg.ev;
				const m = ev.type === "message_end" ? rec(ev.message) : undefined;
				// The prompt line typed here is already on screen.
				if (m?.role === "user" && echoed.has(textOf(m.content))) echoed.delete(textOf(m.content));
				else renderer.event(ev);
				if (msg.ev.type === "extension_ui_request") onUiRequest({ ...msg.ev, type: "extension_ui_request", id: str(msg.ev.id), method: str(msg.ev.method) });
				if (!renderer.isMidLine()) showPrompt();
				return;
			}
			case "ui_resolved": {
				const i = dialogs.findIndex(d => d.id === msg.id);
				if (i >= 0) dialogs.splice(i, 1);
				if (dialogStep?.req.id === msg.id) {
					dialogStep = undefined;
					say(c.dim("  (answered elsewhere)"));
					nextDialog();
				}
				return;
			}
			case "meta": {
				const prev = current.status;
				current = msg.meta;
				if (current.status !== prev && current.status !== "working") {
					renderer.endLine();
					if (current.status === "stopped") say(c.dim(`session stopped${current.exitReason ? `: ${current.exitReason}` : ""}`));
				}
				if (isBusy(current, state)) sawBusy = true;
				else if (opts.prompt !== undefined && sawBusy && current.status === "idle") finish(0);
				return;
			}
			case "state":
				state = msg.state;
				return;
			case "reset":
				renderer.endLine();
				say(c.dim("── session reloaded ──"));
				return;
		}
	};
	conn.onMessage(onMessage);
	conn.onClose(() => {
		renderer.endLine();
		if (!detached) process.stdout.write(c.dim("session host closed the connection\n"));
		finish(0);
	});

	if (opts.prompt !== undefined) {
		const res = await conn.rpc({ type: "prompt", message: opts.prompt, ...(isBusy(current, state) ? { streamingBehavior: "followUp" } : {}) });
		if (!res.success) {
			process.stderr.write(`${c.red("omp-sessions:")} ${String(res.error ?? "omp rejected the prompt")}\n`);
			conn.close();
			return 1;
		}
	}

	if (interactive) {
		rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: promptText() });
		let lastInterrupt = 0;
		rl.on("line", line => {
			promptVisible = false;
			if (dialogStep) {
				answerDialog(line);
				return;
			}
			const text = line.trim();
			if (!text) return showPrompt();
			if (text === "/detach" || text === "/q" || text === "/exit") {
				finish(0);
				return;
			}
			if (text === "/abort") {
				void conn.rpc({ type: "abort" });
				return showPrompt();
			}
			if (text === "/stop") {
				conn.write({ t: "stop" });
				return;
			}
			if (text === "/help") {
				say(c.dim("Type to prompt (steers while omp works). /abort  /stop  /detach   Ctrl-C aborts a turn, Ctrl-D detaches."));
				return;
			}
			echoed.add(line);
			void conn.rpc({ type: "prompt", message: line, ...(isBusy(current, state) ? { streamingBehavior: "steer" } : {}) }).then(res => {
				if (!res.success) say(c.red(`✗ ${String(res.error ?? "omp rejected the prompt")}`));
			});
		});
		rl.on("SIGINT", () => {
			if (dialogStep) {
				respond(dialogStep.req.id, { cancelled: true });
				dialogStep = undefined;
				say(c.dim("  (dismissed)"));
				nextDialog();
				return;
			}
			if (isBusy(current, state)) {
				void conn.rpc({ type: "abort" });
				say(c.yellow("(aborting)"));
				return;
			}
			if (Date.now() - lastInterrupt < 1500) {
				finish(0);
				return;
			}
			lastInterrupt = Date.now();
			say(c.dim("(Ctrl-C again, Ctrl-D or /detach to leave; the session keeps running)"));
		});
		rl.on("close", () => finish(0));
		say(c.dim("Attached. Ctrl-D detaches (the session keeps running), /help for commands."));
	} else if (!opts.readOnly && opts.prompt === undefined) {
		process.stderr.write(c.dim("stdin is not a terminal: following output only\n"));
	}

	const code = await done;
	detached = true;
	clearTimeout(promptTimer);
	rl?.close();
	renderer.endLine();
	conn.close();
	return code;
}
