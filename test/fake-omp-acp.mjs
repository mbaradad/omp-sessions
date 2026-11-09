#!/usr/bin/env node
// Scripted stand-in for `omp acp` (omp 18.12.x), the ACP agent AO's `ompacp` Chat driver runs.
// Speaks JSON-RPC 2.0 over newline-delimited stdio with omp's wire shapes (initialize, session/new,
// load with history replay, resume, list, fork, close, prompt, cancel, set_config_option, set_mode,
// `_session/steering`) and asks the client through `session/request_permission` and
// `elicitation/create`, without calling any model.
//
// Also answers the other commands AO and the planner run: `omp --version` (version probe,
// `omp/<version>`), `omp models [find <pattern>] --json` (AO's model catalog) and `omp usage --json`
// (provider limit windows, from FAKE_OMP_USAGE).
//
// The prompt is a script: each line that starts with a command below is one step, run in order;
// other lines (a task title, parents' results a planner appends) are ignored. A prompt with no
// command line is echoed back whole.
//   echo <text>             stream <text> as assistant text (several agent_message_chunk)
//   think <text>            stream <text> as reasoning (agent_thought_chunk)
//   prompt                  stream the whole prompt text received (to assert what a client sent)
//   bash <command>          `bash` tool call (kind execute) that really runs <command> with sh in the
//                           session cwd (a non-zero exit fails the call); asks session/request_permission
//                           first unless --approval-mode yolo or an earlier "allow_always"
//   commit <message>        `bash` tool call running `git add -A && git commit -m <message>` in the cwd
//   resolve [union|ours|theirs]  finishes the merge in progress in the cwd as an agent would: rewrites
//                           every conflicted file (union keeps both sides, ours first), `git add`, `git
//                           commit --no-edit`; a `bash` tool call, gated like bash. Typical resolve task:
//                           `bash git merge <branch>` (fails on the conflict) then `resolve union`
//   write <relpath> <text>  `write` tool call (kind edit) that really writes <cwd>/<relpath>; no
//                           permission, like omp (normal edits are not gated)
//   append <relpath> <text> `edit` tool call adding the line <text> to <cwd>/<relpath>
//   edit <relpath> <old> => <new>  `edit` tool call replacing the first <old> (fails when it's missing)
//                           (<text>, <old>, <new>: `\n` is a newline)
//   delete <relpath>        `delete` tool call (kind delete); always asks permission, then removes the file
//   ask [question] [| a | b ...]  `ask` tool: form elicitation (default question "Pick one", options
//                           alpha/beta, plus q0__other); replies "chose <answer>" or "ask cancelled"
//   slow <ms>               long-running `bash` tool with progress updates every 100 ms; cancellable.
//                           Steering sent meanwhile is injected and answered "steered: <text>"
//   plan <a>; <b>; ...      plan update (first entry in_progress, the rest pending)
//   title <text>            session_info_update with a title (persisted, listed by session/list)
//   cost <usd>              add <usd> to this turn's cost (usage_update carries the session total, as omp)
//   fail [message]          provider error after omp's own retries: the message as one assistant
//                           chunk, stopReason end_turn (as omp: AO records a *completed* turn); ends the script
//   limited <secs> [key]    first time per key (marker file in PI_CODING_AGENT_DIR): `fail` with a 429
//                           usage-limit error "… Please try again in <secs>s."; later: "ok after limit"
//   refuse                  stopReason refusal
//   error [message]         session/prompt answered with JSON-RPC -32603 (omp's internal errors): AO
//                           records a *failed* turn
//   crash [code]            the omp process exits mid-turn (default code 1)
//   /compact                (whole prompt) compaction command: "Compacted" text, end_turn
//   /<other>                (whole prompt) "Unknown command: /<other>"
//
// Prompts a test doesn't write itself (a planner's follow-ups, resolve tasks) are scripted with
// FAKE_OMP_RULES: the first rule whose regex matches the prompt runs its script instead.
//
// Flags (`omp acp ...`): --model <provider/id|id>, --thinking <level>, --approval-mode
// default|write|yolo|always-ask (also FAKE_OMP_APPROVAL_MODE, as a user's omp config would set it), --yolo;
// others are accepted and ignored. With always-ask, write/append/edit first ask through elicitation/create
// ("Allow tool: <name>", enum [Approve, Approve <name> for this session, Deny]), like real omp.
//
// Env:
//   PI_CODING_AGENT_DIR   session store root, like omp: <dir>/sessions/<encodedCwd>/<ts>_<id>.jsonl
//                         (default <tmp>/fake-omp-acp-agent: never the real ~/.omp)
//   FAKE_OMP_LOG          append argv and every frame in/out (JSONL {mono,pid,dir,msg}) here
//   FAKE_OMP_DELAY        ms between streamed chunks (default 10)
//   FAKE_OMP_VERSION      version `--version` and initialize report (default 18.12.6)
//   FAKE_OMP_NO_STEERING=1   initialize omits `_meta.steering` (AO then has no Steer)
//   FAKE_OMP_NO_MODELS=1  no models: `models --json` is empty and session/new has no `model` option
//   FAKE_OMP_USAGE        JSON file `omp usage --json` reports: omp's payload ({reports}) or compact
//                         windows [{provider, id, label?, usedPercent, resetsAt?}]; read on every call
//   FAKE_OMP_RULES        JSON file [{match, flags?, script}]: `script` replaces a prompt that `match`
//                         (a regex) matches, `$1`…`$9` = its groups; read on every prompt

import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const VERSION = process.env.FAKE_OMP_VERSION || "18.12.6";
const DELAY = Number(process.env.FAKE_OMP_DELAY ?? 10);
const logFile = process.env.FAKE_OMP_LOG;
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.tmpdir(), "fake-omp-acp-agent");
const sessionsRoot = path.join(agentDir, "sessions");

const argv = process.argv.slice(2);
function flag(name) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}
function debug(entry) {
	if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ mono: Number(process.hrtime.bigint()) / 1e6, pid: process.pid, ...entry })}\n`);
}

// ---------- models ----------
const MODELS = process.env.FAKE_OMP_NO_MODELS === "1"
	? []
	: [
			{ provider: "fake", id: "fake-model", name: "Fake Model", contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ["text", "image"] },
			{ provider: "fake", id: "fake-mini", name: "Fake Mini", contextWindow: 100000, maxTokens: 8000, reasoning: false, input: ["text"] },
		];
const selector = m => `${m.provider}/${m.id}`;
function findModel(value) {
	return MODELS.find(m => selector(m) === value || m.id === value);
}

if (argv[0] === "--version" || argv[0] === "-v") {
	process.stdout.write(`omp/${VERSION}\n`);
	process.exit(0);
}
if (argv[0] === "models") {
	const pattern = argv[1] === "find" ? (argv[2] ?? "").toLowerCase() : "";
	const models = MODELS.filter(m => !pattern || `${selector(m)} ${m.name}`.toLowerCase().includes(pattern)).map(m => ({ ...m, kind: "chat", selector: selector(m) }));
	process.stdout.write(`${JSON.stringify({ models })}\n`);
	process.exit(0);
}
// `omp usage --json`: provider limit windows (what a planner gates on), from FAKE_OMP_USAGE.
if (argv[0] === "usage") {
	debug({ dir: "argv", argv });
	let spec = [];
	try {
		if (process.env.FAKE_OMP_USAGE) spec = JSON.parse(fs.readFileSync(process.env.FAKE_OMP_USAGE, "utf8"));
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	const now = Date.now();
	// Either omp's own payload ({reports: [...]}) or compact windows [{provider, id, label?, usedPercent, resetsAt?}].
	const reports = Array.isArray(spec)
		? [...new Set(spec.map(w => w.provider))].map(provider => ({
				provider,
				fetchedAt: now,
				limits: spec
					.filter(w => w.provider === provider)
					.map(w => ({
						id: w.id,
						label: w.label ?? w.id,
						scope: { provider, windowId: w.id },
						window: { id: w.id, label: w.label ?? w.id, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) },
						amount: { usedFraction: w.usedPercent / 100, remainingFraction: 1 - w.usedPercent / 100, unit: "percent" },
					})),
			}))
		: (spec.reports ?? []);
	process.stdout.write(`${JSON.stringify({ generatedAt: now, reports, accountsWithoutUsage: [], disabledCredentials: [], capacity: {} }, null, 2)}\n`);
	process.exit(0);
}
if (argv[0] !== "acp") {
	process.stderr.write(`fake-omp-acp: only \`acp\`, \`--version\`, \`models\` and \`usage\` are scripted (got: ${argv.join(" ")})\n`);
	process.exit(2);
}
debug({ dir: "argv", argv, cwd: process.cwd() });

const approvalMode = argv.includes("--yolo") || argv.includes("--auto-approve") ? "yolo" : (flag("--approval-mode") ?? process.env.FAKE_OMP_APPROVAL_MODE ?? "default");
/** omp's `always-ask` modes: write/edit also ask (through elicitation), besides bash. AO never passes it; a user's omp config can. */
const alwaysAsk = approvalMode === "always-ask" || approvalMode === "always-ask-cached";
const startModel = findModel(flag("--model") ?? "") ?? MODELS[0];
const THINKING = ["off", "auto", "minimal", "low", "medium", "high"];
const startThinking = THINKING.includes(flag("--thinking") ?? "") ? flag("--thinking") : "off";
const MODES = [
	{ id: "default", name: "Default", description: "Standard ACP headless mode" },
	{ id: "plan", name: "Plan", description: "Read-only planning mode that drafts a plan to a markdown file before any code changes" },
];
const COMMANDS = [
	{ name: "compact", description: "Compact the conversation", input: { hint: "[focus instructions]" } },
	{ name: "todo", description: "Manage todos" },
];

// ---------- wire ----------
function send(msg) {
	debug({ dir: "out", msg });
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}
function notify(method, params) {
	send({ method, params });
}
function update(sessionId, upd) {
	notify("session/update", { sessionId, update: upd });
}

class RpcError extends Error {
	constructor(code, message, data) {
		super(message);
		this.code = code;
		this.data = data;
	}
}
/** omp turns a plain thrown Error into -32603 "Internal error" with the text in data.details. */
const internal = details => new RpcError(-32603, "Internal error", { details });
const invalidParams = (method, msg) => new RpcError(-32602, `Invalid params: ${msg}`, { method });

let nextRequestId = 0;
const pendingClient = new Map();
/** Agent → client request; resolves with the result, rejects on an error response or abort. */
function request(method, params, signal) {
	const id = nextRequestId++;
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			pendingClient.delete(id);
			reject(new Cancelled());
		};
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		pendingClient.set(id, {
			resolve: v => {
				signal?.removeEventListener("abort", onAbort);
				resolve(v);
			},
			reject: e => {
				signal?.removeEventListener("abort", onAbort);
				reject(e);
			},
		});
		send({ id, method, params });
	});
}

class Cancelled extends Error {}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Cancelled());
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new Cancelled());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ---------- session store ----------
// File: line 1 {"type":"session",id,cwd,timestamp}; then {"type":"title",title},
// {"type":"user"|"assistant",messageId,text,thought?}, {"type":"tool",toolCallId,title,kind,status,rawInput,content}.
function encodeCwd(cwd) {
	return `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}
function sessionFiles() {
	const files = [];
	let dirs = [];
	try {
		dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		for (const f of fs.readdirSync(path.join(sessionsRoot, d.name))) if (f.endsWith(".jsonl")) files.push(path.join(sessionsRoot, d.name, f));
	}
	return files;
}
function fileFor(id) {
	return sessionFiles().find(f => path.basename(f).endsWith(`_${id}.jsonl`));
}
const MESSAGE_TYPES = new Set(["user", "assistant", "tool"]);
function readStore(file) {
	const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
	const header = entries.find(e => e.type === "session");
	let title;
	let cost = 0;
	for (const e of entries) {
		if (e.type === "title") title = e.title;
		else if (e.type === "cost") cost += e.amount;
	}
	return { header, title, cost, entries: entries.filter(e => MESSAGE_TYPES.has(e.type)) };
}

/** Open sessions of this process, by id. */
const sessions = new Map();

function openSession({ id, cwd, file, title, entries, cost = 0 }) {
	const s = { id, cwd, file, title, entries, cost, model: startModel, thinking: startThinking, mode: "default", allowAlways: new Set(), rejectAlways: new Set(), turn: null, queue: Promise.resolve() };
	sessions.set(id, s);
	return s;
}
function append(s, entry) {
	fs.appendFileSync(s.file, `${JSON.stringify(entry)}\n`);
	if (MESSAGE_TYPES.has(entry.type)) s.entries.push(entry);
}
function newSession(cwd, history = []) {
	const id = crypto.randomUUID();
	const ts = new Date().toISOString();
	const dir = path.join(sessionsRoot, encodeCwd(cwd));
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${ts.replace(/[:.]/g, "-")}_${id}.jsonl`);
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: ts })}\n`);
	const s = openSession({ id, cwd, file, title: undefined, entries: [] });
	for (const e of history) append(s, e);
	return s;
}
function requireAbsolute(cwd) {
	if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw internal(`ACP cwd must be absolute: ${cwd}`);
}
function loadStored(id, cwd) {
	const open = sessions.get(id);
	if (open) {
		if (open.cwd !== cwd) throw internal(`ACP session ${id} is already loaded for ${open.cwd}, not ${cwd}`);
		return open;
	}
	const file = fileFor(id);
	if (!file) throw internal(`ACP session not found: ${id}`);
	const { header, title, cost, entries } = readStore(file);
	return openSession({ id, cwd: header?.cwd ?? cwd, file, title, entries, cost });
}
function sessionOf(params) {
	const s = sessions.get(params?.sessionId);
	if (!s) throw internal(`Unsupported ACP session: ${params?.sessionId}`);
	return s;
}

// ---------- config options ----------
function configOptions(s) {
	const opts = [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: MODES.map(m => ({ value: m.id, name: m.name, description: m.description })) }];
	if (s.model) opts.push({ id: "model", name: "Model", category: "model", type: "select", currentValue: selector(s.model), options: MODELS.map(m => ({ value: selector(m), name: m.name, description: selector(m) })) });
	const levels = s.model?.reasoning ? THINKING : ["off", "auto"];
	opts.push({ id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: s.thinking, options: levels.map(v => (v === "off" ? { value: v, name: "Off" } : v === "auto" ? { value: v, name: "Auto", description: "Auto-detect per prompt" } : { value: v, name: v })) });
	return opts;
}
function sessionSetup(s) {
	return { configOptions: configOptions(s), modes: { availableModes: MODES, currentModeId: s.mode } };
}
/** omp sends these 50 ms after new/load/resume/fork answers. */
function bootstrap(s) {
	setTimeout(() => {
		update(s.id, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
		update(s.id, { sessionUpdate: "session_info_update", updatedAt: new Date().toISOString(), ...(s.title ? { title: s.title } : {}) });
	}, 50);
}
function setConfig(s, configId, value) {
	if (typeof value === "boolean") throw internal("Unsupported boolean ACP config option");
	if (configId === "model") {
		const m = findModel(value);
		if (!m) throw internal(`Unknown ACP model: ${value}`);
		s.model = m;
		if (!m.reasoning && !["off", "auto"].includes(s.thinking)) s.thinking = "off";
	} else if (configId === "thinking") {
		const level = THINKING.find(l => l === value || (value.length >= 3 && l.startsWith(value)));
		if (!level) throw internal(`Unknown ACP thinking level: ${value}`);
		s.thinking = level;
	} else if (configId === "mode") {
		setMode(s, value);
		return;
	} else throw internal(`Unknown ACP config option: ${configId}`);
	update(s.id, { sessionUpdate: "config_option_update", configOptions: configOptions(s) });
}
function setMode(s, modeId) {
	if (!MODES.some(m => m.id === modeId)) throw internal(`Unsupported ACP mode: ${modeId}`);
	s.mode = modeId;
	update(s.id, { sessionUpdate: "current_mode_update", currentModeId: modeId });
	update(s.id, { sessionUpdate: "config_option_update", configOptions: configOptions(s) });
}

// ---------- history replay (session/load) ----------
function replay(s) {
	for (const e of s.entries) {
		if (e.type === "user") update(s.id, { sessionUpdate: "user_message_chunk", content: { type: "text", text: e.text }, messageId: e.messageId });
		else if (e.type === "assistant") {
			if (e.thought) update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.thought }, messageId: e.messageId });
			if (e.text) update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.text }, messageId: e.messageId });
		} else if (e.type === "tool") {
			update(s.id, { sessionUpdate: "tool_call", toolCallId: e.toolCallId, title: e.title, kind: e.kind, status: "pending", rawInput: e.rawInput });
			update(s.id, { sessionUpdate: "tool_call_update", toolCallId: e.toolCallId, status: e.status, content: e.content });
		}
	}
}

// ---------- turns ----------
const textBlock = text => ({ type: "content", content: { type: "text", text } });

function promptText(prompt) {
	if (typeof prompt === "string") return prompt;
	return (prompt ?? [])
		.map(b => {
			if (b.type === "text") return b.text;
			if (b.type === "resource") return b.resource?.text ?? `[embedded resource: ${b.resource?.uri}]`;
			if (b.type === "resource_link") return b.title ?? b.name ?? b.uri;
			if (b.type === "image") return "[image]";
			if (b.type === "audio") return "[audio omitted]";
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

/** One assistant message streamed in chunks of a few words. */
async function streamMessage(s, turn, text, kind = "agent_message_chunk") {
	const messageId = crypto.randomUUID();
	const words = text.match(/\S+\s*/g) ?? [text];
	const per = Math.max(1, Math.ceil(words.length / 3));
	let sent = "";
	try {
		for (let i = 0; i < words.length; i += per) {
			await sleep(DELAY, turn.signal);
			const delta = words.slice(i, i + per).join("");
			sent += delta;
			update(s.id, { sessionUpdate: kind, content: { type: "text", text: delta }, messageId });
		}
	} finally {
		if (sent) append(s, kind === "agent_thought_chunk" ? { type: "assistant", messageId, text: "", thought: sent } : { type: "assistant", messageId, text: sent });
		turn.outputChars += sent.length;
	}
}

/**
 * A tool call: `tool_call` (pending), optional permission, `in_progress`, then `run(progress)` →
 * {text, diff?} and a terminal `tool_call_update`. Returns false when the call failed.
 */
async function toolCall(s, turn, { name, kind, title, rawInput, locations, gate, uiApproval, run }) {
	const toolCallId = `toolu_${crypto.randomBytes(8).toString("hex")}`;
	const base = { toolCallId, title, kind, rawInput, ...(locations ? { locations } : {}) };
	update(s.id, { sessionUpdate: "tool_call", ...base, status: "pending", ...(kind === "execute" ? { content: [textBlock(title)] } : {}) });
	const finish = (status, content, rawOutput) => {
		update(s.id, { sessionUpdate: "tool_call_update", toolCallId, status, content, rawOutput, ...(locations ? { locations } : {}) });
		append(s, { type: "tool", toolCallId, title, kind, status, rawInput, content });
		return status === "completed";
	};
	if (gate) {
		const key = gate === "edit:delete" ? gate : name;
		if (s.rejectAlways.has(key)) return finish("failed", [textBlock(`Tool call rejected by user (${name})`)]);
		if (!s.allowAlways.has(key)) {
			let res;
			try {
				res = await request(
					"session/request_permission",
					{
						sessionId: s.id,
						toolCall: { ...base, status: "pending", content: kind === "execute" ? [textBlock(title)] : [], locations: locations ?? [] },
						options: [
							{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
							{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
							{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
							{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
						],
					},
					turn.signal,
				);
			} catch (err) {
				if (err instanceof Cancelled) {
					finish("failed", [textBlock("Permission request cancelled")]);
					throw err;
				}
				res = { outcome: { outcome: "cancelled" } };
			}
			const outcome = res?.outcome;
			if (outcome?.outcome !== "selected") return finish("failed", [textBlock("Permission request cancelled")]);
			const optionId = outcome.optionId;
			if (!["allow_once", "allow_always", "reject_once", "reject_always"].includes(optionId)) return finish("failed", [textBlock(`Tool permission response used unknown option ID: ${optionId}`)]);
			if (optionId === "allow_always") s.allowAlways.add(key);
			if (optionId === "reject_always") s.rejectAlways.add(key);
			if (optionId.startsWith("reject")) return finish("failed", [textBlock(`Tool call rejected by user (${name})`)]);
		}
	}
	// `--approval-mode always-ask`: tools above the read tier that omp doesn't gate through
	// session/request_permission (write, edit…) ask through elicitation/create, as a single-value form
	// "Allow tool: <name>" with enum [Approve, Approve <name> for this session, Deny] (AO: a `user_input` activity).
	if (uiApproval && alwaysAsk && !s.allowAlways.has(`ui:${name}`)) {
		const sessionLabel = `Approve ${name} for this session`;
		let res;
		try {
			res = await request(
				"elicitation/create",
				{
					mode: "form",
					sessionId: s.id,
					message: `Allow tool: ${name}\n${uiApproval}`,
					requestedSchema: { type: "object", properties: { value: { type: "string", enum: ["Approve", sessionLabel, "Deny"] } }, required: ["value"] },
				},
				turn.signal,
			);
		} catch (err) {
			if (err instanceof Cancelled) {
				finish("failed", [textBlock("Approval request cancelled")]);
				throw err;
			}
			res = { action: "cancel" };
		}
		const value = res?.action === "accept" ? res.content?.value : undefined;
		if (typeof value !== "string" || !value.startsWith("Approve")) return finish("failed", [textBlock(`Tool call rejected by user (${name})`)]);
		if (value === sessionLabel) s.allowAlways.add(`ui:${name}`);
	}
	update(s.id, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
	try {
		const r = await run(partial => update(s.id, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", rawOutput: { content: [{ type: "text", text: partial }] } }));
		const content = [...(r.diff ? [{ type: "diff", ...r.diff }] : []), textBlock(r.text)];
		return finish(r.failed ? "failed" : "completed", content, { content: [{ type: "text", text: r.text }] });
	} catch (err) {
		if (err instanceof Cancelled) finish("failed", [textBlock("Tool execution was aborted")]);
		throw err;
	}
}

function resolveIn(s, rel) {
	const abs = path.resolve(s.cwd, rel);
	return { abs, rel: path.relative(s.cwd, abs) || rel };
}

const shellQuote = text => `'${text.replace(/'/g, `'\\''`)}'`;
/** Script text escapes: `\n` is a newline, `\\` a backslash. */
const unescapeText = text => text.replace(/\\(n|\\)/g, (_, c) => (c === "n" ? "\n" : "\\"));

/** Runs `command` with sh in `cwd` (killed if the turn is cancelled): its exit code and combined output. */
function runShell(command, cwd, signal) {
	const { promise, resolve, reject } = Promise.withResolvers();
	if (signal.aborted) {
		reject(new Cancelled());
		return promise;
	}
	const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", d => (output += d));
	child.stderr.on("data", d => (output += d));
	const onAbort = () => child.kill("SIGKILL");
	signal.addEventListener("abort", onAbort, { once: true });
	child.once("error", err => {
		signal.removeEventListener("abort", onAbort);
		resolve({ code: 127, output: String(err) });
	});
	child.once("close", code => {
		signal.removeEventListener("abort", onAbort);
		if (signal.aborted) reject(new Cancelled());
		else resolve({ code: code ?? 1, output });
	});
	return promise;
}

/** omp's `bash` tool: really runs `command` in the session cwd; asks permission unless yolo. A non-zero exit fails the tool call. */
function shellTool(s, turn, command) {
	return toolCall(s, turn, {
		name: "bash",
		kind: "execute",
		title: `$ ${command}`.slice(0, 82),
		rawInput: { command },
		gate: approvalMode === "yolo" ? undefined : "bash",
		run: async () => {
			const { code, output } = await runShell(command, s.cwd, turn.signal);
			const text = `${output.slice(-4000)}${code === 0 ? "" : `\nexit code ${code}`}`.trim() || "(no output)";
			return { text, failed: code !== 0 };
		},
	});
}

/** A write/edit tool call on `rel`: `change(oldText|null)` returns the new text, or {error}. Not gated, like omp's normal edits. */
function fileTool(s, turn, name, rel, rawInput, change) {
	const { abs, rel: shown } = resolveIn(s, rel);
	return toolCall(s, turn, {
		name,
		kind: "edit",
		title: `${name}: ${shown}`,
		rawInput,
		locations: [{ path: abs }],
		uiApproval: `Path: ${shown}`,
		run: async () => {
			const oldText = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
			const newText = change(oldText);
			if (typeof newText !== "string") return { text: newText.error, failed: true };
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, newText);
			return { text: `${name === "write" ? "Wrote" : "Edited"} ${shown}`, diff: { path: shown, oldText, newText } };
		},
	});
}

/** Keeps one or both sides of every conflict block (`<<<<<<<` … `>>>>>>>`, diff3 base dropped). */
function resolveConflicts(text, strategy) {
	return text.replace(/^<<<<<<< [^\n]*\n([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\n]*\n[\s\S]*?)?^=======\n([\s\S]*?)^>>>>>>> [^\n]*(?:\n|$)/gm, (_, ours, theirs) =>
		strategy === "ours" ? ours : strategy === "theirs" ? theirs : ours + theirs,
	);
}

/**
 * Resolves the merge in progress in the session cwd, as an agent would by editing the conflicted
 * files and committing: `union` keeps both sides (ours first), `ours`/`theirs` one side. Gated like bash.
 */
function resolveTool(s, turn, strategy) {
	const git = (...args) => spawnSync("git", args, { cwd: s.cwd, encoding: "utf8" });
	return toolCall(s, turn, {
		name: "bash",
		kind: "execute",
		title: `$ git commit --no-edit  # resolve conflicts (${strategy})`,
		rawInput: { command: `resolve conflicts (${strategy}) && git commit --no-edit` },
		gate: approvalMode === "yolo" ? undefined : "bash",
		run: async () => {
			const files = git("diff", "--name-only", "--diff-filter=U").stdout.split("\n").filter(Boolean);
			if (files.length === 0) return { text: "no conflicted files", failed: true };
			for (const f of files) {
				const abs = path.join(s.cwd, f);
				fs.writeFileSync(abs, resolveConflicts(fs.readFileSync(abs, "utf8"), strategy));
			}
			git("add", "--", ...files);
			const commit = git("commit", "-q", "--no-edit");
			return commit.status === 0 ? { text: `resolved ${files.join(", ")} (${strategy}) and committed` } : { text: `${commit.stdout}${commit.stderr}`, failed: true };
		},
	});
}

async function runAsk(s, turn, line) {
	const parts = line
		.slice(3)
		.split("|")
		.map(p => p.trim());
	const question = parts[0] || "Pick one";
	const options = parts.length > 1 ? parts.slice(1).filter(Boolean) : ["alpha", "beta"];
	let answer;
	await toolCall(s, turn, {
		name: "ask",
		kind: "other",
		title: `ask: ${question}`,
		rawInput: { questions: [{ id: "q0", question, options: options.map(label => ({ label })) }] },
		run: async () => {
			let res;
			try {
				res = await request(
					"elicitation/create",
					{
						mode: "form",
						sessionId: s.id,
						message: question,
						requestedSchema: {
							type: "object",
							properties: {
								q0: { type: "string", title: question, oneOf: options.map(o => ({ const: o, title: o })), default: options[0] },
								q0__other: { type: "string", title: "Other (type your own)" },
							},
						},
					},
					turn.signal,
				);
			} catch (err) {
				if (err instanceof Cancelled) throw err;
				res = { action: "cancel" };
			}
			if (res?.action === "accept") answer = (res.content?.q0__other || "").trim() || res.content?.q0;
			return answer ? { text: `User answered: ${answer}` } : { text: "User cancelled the question", failed: true };
		},
	});
	await streamMessage(s, turn, answer ? `chose ${answer}` : "ask cancelled");
}

async function runStep(s, turn, line) {
	const [cmd] = line.split(/\s+/, 1);
	const rest = line.slice(cmd.length).trim();
	switch (cmd) {
		case "echo":
			return streamMessage(s, turn, rest);
		case "think":
			return streamMessage(s, turn, rest, "agent_thought_chunk");
		case "bash":
			await shellTool(s, turn, rest);
			return;
		case "commit":
			// What an agent does to commit: `git add -A && git commit` through its bash tool.
			await shellTool(s, turn, `git add -A && git commit -q -m ${shellQuote(rest || "fake omp commit")}`);
			return;
		case "resolve":
			await resolveTool(s, turn, rest || "union");
			return;
		case "slow": {
			const ms = Number(rest) || 1000;
			await toolCall(s, turn, {
				name: "bash",
				kind: "execute",
				title: `$ sleep ${ms / 1000}`,
				rawInput: { command: `sleep ${ms / 1000}` },
				run: async progress => {
					const start = Date.now();
					while (Date.now() - start < ms) {
						await sleep(Math.min(100, ms - (Date.now() - start)), turn.signal);
						progress(`${Date.now() - start} ms`);
					}
					return { text: `slept ${ms} ms` };
				},
			});
			return;
		}
		case "write": {
			const [rel, ...words] = rest.split(/\s+/);
			const content = unescapeText(words.join(" "));
			await fileTool(s, turn, "write", rel, { path: rel, content }, () => content);
			return;
		}
		case "append": {
			const [rel, ...words] = rest.split(/\s+/);
			const line = `${unescapeText(words.join(" "))}\n`;
			await fileTool(s, turn, "edit", rel, { path: rel, append: line }, old => (old && !old.endsWith("\n") ? `${old}\n` : (old ?? "")) + line);
			return;
		}
		case "edit": {
			const m = /^(\S+)\s+([\s\S]*?)\s+=>\s+([\s\S]*)$/.exec(rest);
			if (!m) throw internal(`fake omp: edit <path> <old> => <new>, got: ${rest}`);
			const [, rel, from, to] = m;
			await fileTool(s, turn, "edit", rel, { path: rel, oldText: from, newText: to }, old => {
				if (old === null || !old.includes(unescapeText(from))) return { error: `edit: "${from}" not found in ${rel}` };
				return old.replace(unescapeText(from), unescapeText(to));
			});
			return;
		}
		case "delete": {
			const { abs, rel: shown } = resolveIn(s, rest);
			await toolCall(s, turn, {
				name: "delete",
				kind: "delete",
				title: `Delete ${shown}`,
				rawInput: { path: rest },
				locations: [{ path: abs }],
				gate: "edit:delete",
				run: async () => {
					const oldText = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
					fs.rmSync(abs, { force: true });
					return { text: `Deleted ${shown}`, diff: { path: shown, oldText, newText: "" } };
				},
			});
			return;
		}
		case "ask":
			return runAsk(s, turn, line);
		case "plan": {
			const items = rest
				.split(";")
				.map(t => t.trim())
				.filter(Boolean);
			update(s.id, { sessionUpdate: "plan", entries: items.map((content, i) => ({ content, priority: "medium", status: i === 0 ? "in_progress" : "pending" })) });
			return;
		}
		case "title":
			s.title = rest;
			append(s, { type: "title", title: rest });
			update(s.id, { sessionUpdate: "session_info_update", title: rest, updatedAt: new Date().toISOString() });
			return;
		case "fail": {
			// A provider error after omp's own retries: omp sends the error text whole, ends the turn with
			// end_turn (not an error), and skips the rest of the script.
			const messageId = crypto.randomUUID();
			const text = rest || "Error: fake provider failure";
			update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId });
			append(s, { type: "assistant", messageId, text });
			turn.ended = true;
			return;
		}
		case "limited": {
			const [secs = "2", key = "default"] = rest.split(/\s+/).filter(Boolean);
			const marker = path.join(agentDir, `limited-${key.replace(/[^\w.-]/g, "_")}`);
			if (fs.existsSync(marker)) return streamMessage(s, turn, "ok after limit");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.writeFileSync(marker, String(Date.now()));
			return runStep(s, turn, `fail 429 {"type":"error","error":{"type":"rate_limit_error","message":"Usage limit reached for this account. Please try again in ${secs}s."}}`);
		}
		case "refuse":
			turn.stopReason = "refusal";
			return;
		case "prompt":
			return streamMessage(s, turn, turn.text);
		case "cost":
			turn.extraCost += Number(rest) || 0;
			return;
		case "error":
			throw internal(rest || "fake internal error");
		case "crash":
			debug({ dir: "exit", code: Number(rest) || 1 });
			process.exit(Number(rest) || 1);
	}
}

const COMMAND_RE = /^(echo|think|bash|commit|resolve|slow|write|append|edit|delete|ask|plan|title|fail|limited|refuse|prompt|cost|error|crash)(\s|$)/;

/**
 * FAKE_OMP_RULES (read on every prompt): [{match, flags?, script}]. The first rule whose regex matches
 * the prompt runs `script` instead (`$1`…`$9` = its groups): how a test scripts replies to prompts it
 * doesn't write itself, such as a planner's follow-ups.
 */
function ruleScript(text) {
	if (!process.env.FAKE_OMP_RULES) return undefined;
	let rules;
	try {
		rules = JSON.parse(fs.readFileSync(process.env.FAKE_OMP_RULES, "utf8"));
	} catch (err) {
		if (err.code === "ENOENT") return undefined;
		throw err;
	}
	for (const rule of rules) {
		const m = new RegExp(rule.match, rule.flags ?? "").exec(text);
		if (m) return rule.script.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "");
	}
	return undefined;
}

async function runTurn(s, turn, text) {
	append(s, { type: "user", messageId: turn.messageId, text });
	if (text.startsWith("/")) {
		const name = text.slice(1).split(/\s+/, 1)[0];
		await streamMessage(s, turn, name === "compact" ? "Compacted" : `Unknown command: /${name}`);
		return;
	}
	const script = ruleScript(text) ?? text;
	const lines = script
		.split("\n")
		.map(l => l.trim())
		.filter(l => l && l !== "---");
	// A script runs its command lines and ignores the prose around them (a task title, parents'
	// results a planner appends); a prompt with no command line is echoed whole.
	const steps = lines.some(l => COMMAND_RE.test(l)) ? lines.filter(l => COMMAND_RE.test(l)) : [`echo ${script}`];
	for (const line of steps) {
		if (turn.stopReason || turn.ended) break;
		await runStep(s, turn, line);
		await drainSteering(s, turn);
	}
	await drainSteering(s, turn);
}
async function drainSteering(s, turn) {
	while (turn.steering.length && !turn.signal.aborted) {
		const steered = turn.steering.shift();
		append(s, { type: "user", messageId: crypto.randomUUID(), text: steered });
		await streamMessage(s, turn, `steered: ${steered}`);
	}
}

async function prompt(params) {
	const s = sessionOf(params);
	// A prompt while a turn streams cancels it, like omp; the new turn queues behind it.
	s.turn?.cancel();
	const prev = s.queue;
	let release;
	s.queue = new Promise(r => (release = r));
	await prev;
	const ctl = new AbortController();
	const text = promptText(params.prompt);
	const turn = { signal: ctl.signal, text, steering: [], outputChars: 0, extraCost: 0, stopReason: undefined, ended: false, messageId: params.messageId ?? crypto.randomUUID() };
	let resolveCancelled;
	const cancelled = new Promise(r => (resolveCancelled = r));
	turn.cancel = () => {
		if (ctl.signal.aborted) return;
		ctl.abort();
		resolveCancelled();
	};
	s.turn = turn;
	try {
		const run = runTurn(s, turn, text).catch(err => {
			if (!(err instanceof Cancelled)) throw err;
		});
		await Promise.race([run, cancelled]);
		if (ctl.signal.aborted) run.catch(() => {});
		else await run;
	} finally {
		if (s.turn === turn) s.turn = null;
		release();
	}
	const usage = { inputTokens: 100 + Math.ceil(text.length / 4), outputTokens: Math.max(1, Math.ceil(turn.outputChars / 4)) };
	usage.totalTokens = usage.inputTokens + usage.outputTokens;
	if (ctl.signal.aborted) return { stopReason: "cancelled", usage };
	// usage_update carries the session's cumulative cost, like omp (getUsageStatistics().cost).
	const amount = usage.totalTokens * 1e-6 + turn.extraCost;
	append(s, { type: "cost", amount });
	s.cost += amount;
	const ctx = s.model?.contextWindow ?? 200000;
	const used = s.entries.reduce((n, e) => n + Math.ceil(JSON.stringify(e).length / 4), 0);
	update(s.id, { sessionUpdate: "usage_update", size: ctx, used, cost: { amount: s.cost, currency: "USD" } });
	update(s.id, { sessionUpdate: "session_info_update", updatedAt: new Date().toISOString(), ...(s.title ? { title: s.title } : {}) });
	return { stopReason: turn.stopReason ?? "end_turn", usage };
}

function steer(params) {
	const method = "_session/steering";
	if (!params?.sessionId) throw invalidParams(method, "sessionId required");
	const s = sessions.get(params.sessionId);
	if (!s) throw invalidParams(method, `unknown session: ${params.sessionId}`);
	const text = promptText(params.prompt);
	if (!text.trim()) throw invalidParams(method, "prompt is empty");
	const queue = params._meta?.steering?.queue === "followUp" ? "followUp" : "steering";
	if (!s.turn || s.turn.signal.aborted) return { outcome: "promptRequired", queue };
	s.turn.steering.push(text);
	return { outcome: "injected", queue };
}

function list(params) {
	const all = sessionFiles()
		.map(file => {
			const { header, title, entries } = readStore(file);
			return { file, header, title, messageCount: entries.length, stat: fs.statSync(file) };
		})
		.filter(x => x.header && (!params?.cwd || x.header.cwd === params.cwd))
		.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
	const start = params?.cursor ? Number(params.cursor) : 0;
	if (!Number.isInteger(start) || start < 0) throw internal(`Invalid ACP session cursor: ${params.cursor}`);
	const page = all.slice(start, start + 50);
	return {
		sessions: page.map(x => ({ sessionId: x.header.id, cwd: x.header.cwd, ...(x.title ? { title: x.title } : {}), updatedAt: x.stat.mtime.toISOString(), _meta: { messageCount: x.messageCount, size: x.stat.size } })),
		...(start + 50 < all.length ? { nextCursor: String(start + 50) } : {}),
	};
}

// ---------- dispatch ----------
const handlers = {
	initialize: () => ({
		protocolVersion: 1,
		agentInfo: { name: "omp", title: "omp", version: VERSION },
		authMethods: [{ id: "agent", name: "Use existing local credentials", description: "Authenticate via the provider keys/OAuth state already configured under ~/.omp." }],
		agentCapabilities: {
			loadSession: true,
			mcpCapabilities: { http: true, sse: true },
			promptCapabilities: { embeddedContext: true, image: true },
			sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} },
		},
		...(process.env.FAKE_OMP_NO_STEERING === "1" ? {} : { _meta: { steering: { supported: true } } }),
	}),
	authenticate: p => {
		if (p?.methodId !== "agent") throw internal(`Unknown ACP auth method: ${p?.methodId}`);
		return {};
	},
	"session/new": p => {
		requireAbsolute(p?.cwd);
		const s = newSession(p.cwd);
		bootstrap(s);
		return { sessionId: s.id, ...sessionSetup(s) };
	},
	"session/load": p => {
		requireAbsolute(p?.cwd);
		const s = loadStored(p.sessionId, p.cwd);
		replay(s);
		bootstrap(s);
		return sessionSetup(s);
	},
	"session/resume": p => {
		requireAbsolute(p?.cwd);
		const s = loadStored(p.sessionId, p.cwd);
		bootstrap(s);
		return sessionSetup(s);
	},
	"session/fork": p => {
		requireAbsolute(p?.cwd);
		const src = loadStored(p.sessionId, p.cwd);
		if (src.turn) throw internal(`Cannot fork ACP session ${src.id} while a prompt is running`);
		const s = newSession(p.cwd, src.entries);
		bootstrap(s);
		return { sessionId: s.id, ...sessionSetup(s) };
	},
	"session/close": p => {
		const s = sessions.get(p?.sessionId);
		s?.turn?.cancel();
		sessions.delete(p?.sessionId);
		return {};
	},
	"session/list": p => list(p),
	"session/prompt": p => prompt(p),
	"session/set_config_option": p => {
		const s = sessionOf(p);
		setConfig(s, p.configId, p.value);
		return { configOptions: configOptions(s) };
	},
	"session/set_mode": p => {
		setMode(sessionOf(p), p.modeId);
		return {};
	},
	"_session/steering": p => steer(p),
};

async function onRequest(msg) {
	const handler = handlers[msg.method];
	try {
		if (!handler) {
			if (msg.method.startsWith("_")) throw internal(`Unknown ACP ext method: ${msg.method}`);
			throw new RpcError(-32601, `"Method not found": ${msg.method}`, { method: msg.method });
		}
		const result = await handler(msg.params ?? {});
		send({ id: msg.id, result: result ?? {} });
	} catch (err) {
		if (err instanceof RpcError) send({ id: msg.id, error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) } });
		else send({ id: msg.id, error: { code: -32603, message: "Internal error", data: { details: String(err?.message ?? err) } } });
	}
}

function onMessage(msg) {
	if (msg.method && msg.id !== undefined && msg.id !== null) return void onRequest(msg);
	if (msg.method) {
		if (msg.method === "session/cancel") sessions.get(msg.params?.sessionId)?.turn?.cancel();
		return; // other notifications ($/cancel_request, unknown) are ignored, like omp
	}
	const waiter = pendingClient.get(msg.id);
	if (!waiter) return;
	pendingClient.delete(msg.id);
	if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
	else waiter.resolve(msg.result);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
	if (!line.trim()) return;
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		send({ id: null, error: { code: -32700, message: "Parse error" } });
		return;
	}
	debug({ dir: "in", msg });
	onMessage(msg);
});
rl.on("close", () => process.exit(0));
