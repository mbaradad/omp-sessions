#!/usr/bin/env node
// Scripted stand-in for `omp --mode rpc-ui`: speaks the JSONL RPC framing (ready, responses,
// agent/message/tool events stamped with messageId) without calling any model.
//
// Prompt text drives the behaviour:
//   echo <text>                     stream <text> back as assistant text
//   write <relpath> <content...>    `write` tool call that really writes the file
//   edit <relpath> <old> => <new>   `edit` tool call that really replaces the first <old>
//   ask                             `ask` dialog (alpha/beta); answers "chose <label>"
//   slow <ms>                       bash-like tool running <ms> with partial updates; abortable
//   /<word> ...                     slash command: command_output only, agentInvoked:false
//   fail [message]                  model request error: stopReason "error", prompt_result status "error"
//   anything else                   echoed back
//   [Task i/n from the queue] <title>…  (host task-queue wrapper) scripted by <title> as above
//
// Env:
//   FAKE_OMP_SESSIONS  directory for transcript files (default: <tmp>/fake-omp-sessions)
//   FAKE_OMP_LOG       append argv and every received command (JSONL) here, for assertions
//   FAKE_OMP_DELAY     ms between streamed frames (default 15)
//   FAKE_OMP_CHUNK_BYTES  after protocol v2 is negotiated, frames larger than this are sent as
//                      rpc_chunk pieces (default 1 MiB, the real limit)
//   FAKE_OMP_TOOL_DELAY  ms between tool_execution_start and the tool touching files (default 30;
//                      0 = same tick, like a fast real tool)
//   FAKE_OMP_READY_DELAY  ms to wait before emitting `ready` (default 0), to simulate slow startup
//   FAKE_OMP_NO_MODELS=1  `get_available_models` returns none (like a fresh install with no login)
//   FAKE_OMP_DISABLED_EXTENSIONS  JSON array `omp config get disabledExtensions --json` reports (default [])
//   FAKE_OMP_NO_LIVE=1    `live_start` fails like an omp without realtime voice (default: scripted live_* frames)
//   FAKE_OMP_REPLIES      JSON file of scripted replies per prompt (see runReply), for demos
//   FAKE_OMP_DEMO=1       real-looking model names and token prices, for screenshots
//   FAKE_OMP_AUTO_TITLE=1 name the session after the first prompt ("Auto: <prompt>") unless a client
//                      set a name, like omp's title generator (which a user-set name disables)
//
// `--approval-mode always-ask` (what the host passes) makes write/edit/bash tool calls wait for an
// approval `select` ("Allow tool: <name>", Approve / … / Deny) like omp does.
//
// `--restore` with `--mode` exits 2 with omp's error, like real omp (restore is interactive-only).

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

// ---------- args / env ----------
const argv = process.argv.slice(2);
function flag(name) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}
const cwd = path.resolve(flag("--cwd") ?? process.cwd());
const resumeFile = flag("--resume");
const approvalMode = flag("--approval-mode");
const sessionsDir = process.env.FAKE_OMP_SESSIONS || path.join(os.tmpdir(), "fake-omp-sessions");
const logFile = process.env.FAKE_OMP_LOG;
const DELAY = Number(process.env.FAKE_OMP_DELAY ?? 15);
const CHUNK_BYTES = Number(process.env.FAKE_OMP_CHUNK_BYTES ?? 1024 * 1024);
const TOOL_DELAY = Number(process.env.FAKE_OMP_TOOL_DELAY ?? 30);
const READY_DELAY = Number(process.env.FAKE_OMP_READY_DELAY ?? 0);
fs.mkdirSync(sessionsDir, { recursive: true });

// `mono`: ms on the system's monotonic clock (process.hrtime), comparable across processes and immune to
// wall-clock steps (NTP, WSL2), for ordering and interval assertions.
function debug(entry) {
	if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ mono: Number(process.hrtime.bigint()) / 1e6, pid: process.pid, ...entry })}\n`);
}
// `omp config get <key> --json` (the host reads disabledExtensions for session overlays).
if (argv[0] === "config") {
	debug({ kind: "config", argv });
	const value = argv[2] === "disabledExtensions" ? JSON.parse(process.env.FAKE_OMP_DISABLED_EXTENSIONS || "[]") : null;
	process.stdout.write(`${JSON.stringify({ key: argv[2], value })}\n`);
	process.exit(0);
}
debug({ kind: "argv", argv, cwd: process.cwd() });
if (argv.includes("--restore") && argv.includes("--mode")) {
	process.stderr.write("Error: --restore requires an interactive terminal (not --print or --mode).\n");
	process.exit(2);
}

// ---------- models ----------
const DEMO = process.env.FAKE_OMP_DEMO === "1";
const MODELS = DEMO
	? [
			{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", api: "fake", contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
			{ provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5", api: "fake", contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
			{ provider: "openai", id: "gpt-5.1", name: "GPT-5.1", api: "fake", contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
			{ provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro", api: "fake", contextWindow: 1000000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
		]
	: [
			{ provider: "fake", id: "fake-model", name: "Fake Model", api: "fake", contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ["text", "image"] },
			{ provider: "fake", id: "fake-mini", name: "Fake Mini", api: "fake", contextWindow: 100000, maxTokens: 8000, reasoning: false, input: ["text"] },
		];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
// `--model provider/id` (or a bare id) picks the starting model, like omp's flag.
let model = MODELS.find(m => [`${m.provider}/${m.id}`, m.id].includes(flag("--model") ?? "")) ?? MODELS[0];
let thinkingLevel = "medium";
// `omp models [find <pattern>] --json` (the omp-sessions models list).
if (argv[0] === "models") {
	const pattern = argv[1] === "find" ? (argv[2] ?? "").toLowerCase() : "";
	const models = MODELS.filter(m => !pattern || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(pattern)).map(m => ({ ...m, kind: "chat", selector: `${m.provider}/${m.id}` }));
	process.stdout.write(`${JSON.stringify({ models })}\n`);
	process.exit(0);
}

// ---------- session file ----------
let sessionFile = "";
let sessionId = "";
let sessionName;
let messages = [];
let entryIds = [];
let goal;

function newId() {
	return crypto.randomBytes(4).toString("hex");
}

function startSession(initial = [], parentSession) {
	sessionId = crypto.randomUUID();
	sessionFile = path.join(sessionsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
	sessionName = undefined;
	messages = [];
	entryIds = [];
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd, parentSession })}\n`);
	for (const m of initial) persistMessage(m);
}

function loadSession(file) {
	sessionFile = path.resolve(file);
	messages = [];
	entryIds = [];
	const lines = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
	for (const line of lines) {
		const entry = JSON.parse(line);
		if (entry.type === "session") sessionId = entry.id ?? crypto.randomUUID();
		else if (entry.type === "message") {
			messages.push(entry.message);
			entryIds.push(entry.id ?? newId());
		} else if (entry.type === "session_info") sessionName = entry.name;
	}
}

function appendEntry(entry) {
	fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

function persistMessage(message) {
	const id = newId();
	messages.push(message);
	entryIds.push(id);
	appendEntry({ type: "message", id, timestamp: new Date().toISOString(), message });
}

if (resumeFile && fs.existsSync(resumeFile)) loadSession(resumeFile);
else startSession();

// ---------- output ----------
let protocolV2 = false;
let chunkSeq = 0;
function out(frame) {
	const line = Buffer.from(JSON.stringify(frame));
	if (!protocolV2 || line.length <= CHUNK_BYTES) {
		process.stdout.write(`${line}\n`);
		return;
	}
	// Protocol v2: oversized frames go out as base64 rpc_chunk pieces, like real omp.
	const chunkId = `chunk-${++chunkSeq}`;
	const count = Math.ceil(line.length / CHUNK_BYTES);
	for (let index = 0; index < count; index++) {
		const data = line.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64");
		process.stdout.write(`${JSON.stringify({ type: "rpc_chunk", chunkId, index, count, byteLength: line.length, data })}\n`);
	}
}
function respond(cmd, data, extra = {}) {
	out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data === undefined ? {} : { data }), ...extra });
}
function fail(cmd, error) {
	out({ id: cmd.id, type: "response", command: cmd.type, success: false, error });
}

let msgSeq = 0;
function mintMessageId() {
	return `fake-${process.pid}-${++msgSeq}`;
}

// ---------- state ----------
let streaming = false;
let abortCtl = null;
const queue = [];
const uiWaiters = new Map();

function contextUsage() {
	const tokens = (messages.reduce((n, m) => n + JSON.stringify(m).length / 4, 0) | 0) + (DEMO ? 46_000 : 0);
	return { tokens, contextWindow: model.contextWindow, percent: Math.round((tokens / model.contextWindow) * 1000) / 10 };
}

function getState() {
	return {
		model,
		thinkingLevel,
		isStreaming: streaming,
		isCompacting: false,
		...(DEMO ? { tokensPerSecond: 84.6 } : {}),
		isSettled: !streaming && queue.length === 0,
		sessionFile,
		sessionId,
		sessionName,
		autoCompactionEnabled: true,
		fastModeEnabled: false,
		messageCount: messages.length,
		queuedMessages: { steering: [], followUp: queue.map(q => q.text) },
		todoPhases: [],
		contextUsage: contextUsage(),
		...(goal ? { goal } : {}),
	};
}

function usage(text) {
	const output = Math.max(1, Math.ceil(text.length / 4));
	if (DEMO) {
		// FAKE_OMP_DEMO: plausible token counts and prices for screenshots.
		const input = 18_000 + messages.length * 900;
		const cost = { input: input * 3e-6, output: output * 15e-6, cacheRead: 0, cacheWrite: 0 };
		return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { ...cost, total: cost.input + cost.output } };
	}
	return { input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output, cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0003 } };
}

function assistant(content, stopReason = "stop", extra = {}) {
	const text = content.filter(c => c.type === "text").map(c => c.text).join("");
	return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: usage(text), stopReason, timestamp: Date.now(), ...extra };
}

class Aborted extends Error {}
/** A failed model request: prompt_result status "error". */
class ModelError extends Error {}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Aborted());
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new Aborted());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** message_start → message_end for a complete (non-streamed) message. */
function emitWhole(message) {
	const messageId = mintMessageId();
	out({ type: "message_start", messageId, message });
	out({ type: "message_end", messageId, message });
	persistMessage(message);
}

/** Streams assistant text in up to three chunks. */
async function streamText(text, signal) {
	const messageId = mintMessageId();
	const partial = assistant([{ type: "text", text: "" }]);
	out({ type: "message_start", messageId, message: partial });
	const size = Math.max(1, Math.ceil(text.length / 3));
	let sent = "";
	try {
		for (let i = 0; i < text.length; i += size) {
			await sleep(DELAY, signal);
			const delta = text.slice(i, i + size);
			sent += delta;
			const message = assistant([{ type: "text", text: sent }]);
			out({ type: "message_update", messageId, message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message } });
		}
	} catch (err) {
		if (err instanceof Aborted) {
			const message = assistant([{ type: "text", text: sent }], "aborted", { errorMessage: "Request was aborted" });
			out({ type: "message_end", messageId, message });
			persistMessage(message);
		}
		throw err;
	}
	const message = assistant([{ type: "text", text }]);
	out({ type: "message_end", messageId, message });
	persistMessage(message);
	return message;
}

/** Assistant tool call + tool execution events around `run`, which returns {text, details, isError?}. */
async function toolCall(toolName, args, run, signal) {
	const toolCallId = `call_${newId()}`;
	emitWhole(assistant([{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }], "toolUse"));
	out({ type: "tool_execution_start", toolCallId, toolName, args });
	// Gap between announcing the tool and touching files; 0 runs the tool in the same tick.
	if (TOOL_DELAY > 0) await sleep(TOOL_DELAY);
	const denied = await approve(toolName, args, signal ?? new AbortController().signal);
	let result;
	let isError = false;
	let abortedErr;
	try {
		const r = denied ? { text: `Tool call denied: ${toolName}`, isError: true } : await run(toolCallId, signal);
		result = { content: [{ type: "text", text: r.text }], details: r.details };
		isError = !!r.isError;
	} catch (err) {
		if (!(err instanceof Aborted)) throw err;
		abortedErr = err;
		result = { content: [{ type: "text", text: "Tool execution was aborted" }] };
		isError = true;
	}
	out({ type: "tool_execution_end", toolCallId, toolName, args, result, isError });
	emitWhole({ role: "toolResult", toolCallId, toolName, content: result.content, details: result.details, isError, timestamp: Date.now() });
	if (abortedErr) throw abortedErr;
	return result;
}

// `--approval-mode always-ask`: like omp, ask before write- and exec-tier tools (read-only ones run).
const APPROVAL_TIER = { write: "write", edit: "write", bash: "exec" };
/** True when the call was denied; resolves once the host answers the approval select. */
async function approve(toolName, args, signal) {
	if (approvalMode !== "always-ask" || !APPROVAL_TIER[toolName]) return false;
	const id = `approve-${newId()}`;
	const detail = toolName === "bash" ? `Command: ${args.command}` : `Path: ${args.path ?? "(edit)"}`;
	out({ type: "extension_ui_request", id, method: "select", title: `Allow tool: ${toolName}\n${detail}`, options: ["Approve", `Approve ${toolName} for this session`, "Deny"] });
	const res = await waitUi(id, signal);
	return !(typeof res.value === "string" && res.value.startsWith("Approve"));
}

function waitUi(id, signal) {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			uiWaiters.delete(id);
			out({ type: "extension_ui_request", id: `cancel-${id}`, method: "cancel", targetId: id });
			reject(new Aborted());
		};
		uiWaiters.set(id, res => {
			signal.removeEventListener("abort", onAbort);
			resolve(res);
		});
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

// FAKE_OMP_REPLIES=<file.json>: { "<prompt>": [step…] } with steps {text}, {write: [rel, content]},
// {edit: [rel, old, new]}, {bash: [command, output]}, {ask: [question, [option…]]}, {sleep: ms}, for
// realistic demos (screenshots).
const REPLIES = process.env.FAKE_OMP_REPLIES ? JSON.parse(fs.readFileSync(process.env.FAKE_OMP_REPLIES, "utf8")) : {};

async function runReply(steps, signal) {
	for (const step of steps) {
		if (typeof step.text === "string") await streamText(step.text, signal);
		else if (Array.isArray(step.write)) await writeTool(step.write[0], step.write[1]);
		else if (Array.isArray(step.edit)) await editTool(step.edit[0], step.edit[1], step.edit[2]);
		else if (Array.isArray(step.bash)) {
			const [command, output] = step.bash;
			await toolCall("bash", { command }, async () => ({ text: output, details: { exitCode: 0 } }), signal);
		} else if (Array.isArray(step.ask)) await askTool(step.ask[0], step.ask[1], signal);
		else if (typeof step.sleep === "number") await sleep(step.sleep, signal);
	}
}

/** An `ask` tool call with one question; resolves to the label the user chose (or typed). */
async function askTool(question, options, signal) {
	let label = "";
	const questions = [{ id: "q1", question, options: options.map(o => ({ label: o })) }];
	await toolCall(
		"ask",
		{ questions },
		async (_id, sig) => {
			const id = `ui-${newId()}`;
			out({ type: "extension_ui_request", id, method: "ask", questions });
			const res = await waitUi(id, sig);
			label = res.cancelled ? "nothing" : (res.answers?.[0]?.selectedOptions?.[0] ?? res.answers?.[0]?.customInput ?? "nothing");
			return { text: `User chose: ${label}`, details: { answers: res.answers ?? [] } };
		},
		signal,
	);
	return label;
}

async function writeTool(rel, content) {
	const abs = path.resolve(cwd, rel);
	await toolCall("write", { path: rel, content }, async () => {
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
		return { text: `Wrote ${Buffer.byteLength(content)} bytes to ${rel}`, details: { resolvedPath: abs } };
	});
}

/** `edit` tool call replacing the first `oldText` (one line) with `newText`, with omp-style diff details. */
async function editTool(rel, oldText, newText) {
	const abs = path.resolve(cwd, rel);
	const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
	const at = before.indexOf(oldText);
	const lineNo = at >= 0 ? before.slice(0, at).split("\n").length : 1;
	const oldLines = before.split("\n");
	const input = `[${rel}#ABCD]\nPUT ${lineNo}.=${lineNo}:\n+${(oldLines[lineNo - 1] ?? "").replace(oldText, newText)}`;
	await toolCall("edit", { input }, async () => {
		if (!oldText || at < 0) return { text: `Text not found in ${rel}: ${oldText}`, isError: true };
		const after = before.slice(0, at) + newText + before.slice(at + oldText.length);
		fs.writeFileSync(abs, after);
		const newLines = after.split("\n");
		const rows = [];
		if (lineNo > 1) rows.push(` ${lineNo - 1}|${oldLines[lineNo - 2]}`);
		rows.push(`-${lineNo}|${oldLines[lineNo - 1]}`);
		rows.push(`+${lineNo}|${newLines[lineNo - 1]}`);
		if (lineNo < newLines.length && newLines[lineNo] !== undefined && newLines[lineNo] !== "") rows.push(` ${lineNo + 1}|${newLines[lineNo]}`);
		return {
			text: `Updated ${rel}`,
			details: { path: abs, diff: rows.join("\n"), oldText: before, newText: after, firstChangedLine: lineNo, op: "update" },
		};
	});
}

// ---------- scripts ----------
async function runScript(text, signal) {
	const reply = REPLIES[text.trim()];
	if (reply) return runReply(reply, signal);
	const [word, ...rest] = text.trim().split(/\s+/);
	const arg = text.trim().slice(word.length).trim();
	switch (word) {
		case "echo":
			await streamText(arg, signal);
			return;
		case "write": {
			const [rel, ...words] = rest;
			await writeTool(rel, `${words.join(" ")}\n`);
			await streamText(`Wrote ${rel}`, signal);
			return;
		}
		case "edit": {
			const rel = rest[0];
			const body = arg.slice(rel.length).trim();
			const sep = body.indexOf(" => ");
			await editTool(rel, sep >= 0 ? body.slice(0, sep) : body, sep >= 0 ? body.slice(sep + 4) : "");
			await streamText(`Edited ${rel}`, signal);
			return;
		}
		case "ask": {
			const label = await askTool("Pick one", ["alpha", "beta"], signal);
			await streamText(`chose ${label}`, signal);
			return;
		}
		case "slow": {
			const ms = Number(rest[0]) || 1000;
			const command = `sleep ${ms / 1000}`;
			await toolCall(
				"bash",
				{ command },
				async (toolCallId, sig) => {
					const started = Date.now();
					let output = "";
					let tick = 0;
					while (Date.now() - started < ms) {
						await sleep(Math.min(100, ms - (Date.now() - started)), sig);
						output += `tick ${++tick}\n`;
						out({ type: "tool_execution_update", toolCallId, toolName: "bash", args: { command }, partialResult: { content: [{ type: "text", text: output }] } });
					}
					return { text: output, details: { exitCode: 0 } };
				},
				signal,
			);
			await streamText(`slept ${ms}ms`, signal);
			return;
		}
		case "fail":
			throw new ModelError(arg || "fake provider error");
		default:
			await streamText(word === undefined ? "" : text.trim(), signal);
	}
}

async function runPrompt(cmd, text) {
	streaming = true;
	abortCtl = new AbortController();
	const signal = abortCtl.signal;
	out({ type: "agent_start" });
	const turnStart = messages.length;
	emitWhole({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	out({ type: "turn_start" });
	let status = "completed";
	let error;
	try {
		// Queue tasks arrive wrapped: "[Task i/n from the queue] <title>\n…" → script on the title;
		// plan-mode prompts carry the host's "[Plan mode: …]" preamble first.
		const unplanned = text.replace(/^\[Plan mode:[^\]]*\]\n\n/, "");
		const task = /^\[Task \d+\/\d+[^\]]*\] (.*)/.exec(unplanned);
		await runScript(task ? task[1] : unplanned, signal);
	} catch (err) {
		if (err instanceof ModelError) {
			status = "error";
			error = { message: err.message, provider: model.provider, model: model.id, retryable: false };
			emitWhole(assistant([], "error", { errorMessage: err.message }));
		} else if (err instanceof Aborted) {
			status = "aborted";
			const last = messages[messages.length - 1];
			if (last?.role !== "assistant" || last.stopReason !== "aborted") {
				emitWhole(assistant([], "aborted", { errorMessage: "Request was aborted" }));
			}
		} else throw err;
	}
	const turn = messages.slice(turnStart);
	const lastAssistant = [...turn].reverse().find(m => m.role === "assistant");
	out({ type: "turn_end", message: lastAssistant, toolResults: turn.filter(m => m.role === "toolResult") });
	streaming = false;
	abortCtl = null;
	const next = queue.shift();
	out({ type: "agent_end", messages: turn });
	out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status, ...(error ? { error } : {}), sessionSettled: !next });
	if (next) {
		out({ type: "queue_update", steering: [], followUp: queue.map(q => q.text) });
		void runPrompt(next.cmd, next.text);
	} else out({ type: "session_settled" });
}

function onPrompt(cmd) {
	const text = typeof cmd.message === "string" ? cmd.message : "";
	if (/^\/\w/.test(text)) {
		const name = text.slice(1).split(/\s+/)[0];
		out({ type: "command_output", text: `fake /${name}: session ${sessionId}\nfile ${sessionFile}` });
		respond(cmd, { agentInvoked: false });
		out({ type: "prompt_result", id: cmd.id, agentInvoked: false, status: "completed", sessionSettled: !streaming });
		return;
	}
	respond(cmd, { agentInvoked: true });
	// omp's title generator names an unnamed session from its first prompt; a client-set name stops it.
	if (process.env.FAKE_OMP_AUTO_TITLE === "1" && sessionName === undefined) {
		sessionName = `Auto: ${text.split("\n")[0].slice(0, 40)}`;
		appendEntry({ type: "session_info", name: sessionName, timestamp: new Date().toISOString() });
	}
	if (streaming) {
		queue.push({ cmd, text });
		out({ type: "queue_update", steering: [], followUp: queue.map(q => q.text) });
		return;
	}
	void runPrompt(cmd, text);
}

// ---------- commands ----------
function runBash(cmd) {
	const child = spawn("/bin/sh", ["-c", String(cmd.command ?? "")], { cwd, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", d => (output += d));
	child.stderr.on("data", d => (output += d));
	child.on("close", code => {
		const data = { output, exitCode: code ?? 1, cancelled: false };
		persistMessage({ role: "bashExecution", command: cmd.command, ...data, timestamp: Date.now() });
		respond(cmd, data);
	});
}

function textOfMessage(m) {
	if (typeof m.content === "string") return m.content;
	return (m.content ?? []).filter(c => c.type === "text").map(c => c.text).join("");
}

function handle(cmd) {
	switch (cmd.type) {
		case "negotiate_protocol":
			if (cmd.protocolVersion !== 2) return fail(cmd, `Unsupported protocol version: ${cmd.protocolVersion}`);
			respond(cmd, { protocolVersion: 2 });
			protocolV2 = true;
			return;
		case "set_ask_dialog":
			return respond(cmd, { enabled: cmd.enabled !== false });
		case "set_subagent_subscription":
			return respond(cmd, { level: cmd.level ?? "off" });
		case "get_state":
			return respond(cmd, getState());
		case "get_messages":
			return respond(cmd, { messages });
		case "set_session_name":
			sessionName = String(cmd.name ?? "");
			appendEntry({ type: "session_info", name: sessionName, timestamp: new Date().toISOString() });
			return respond(cmd);
		case "get_available_models":
			return respond(cmd, { models: process.env.FAKE_OMP_NO_MODELS === "1" ? [] : MODELS });
		case "get_available_thinking_levels":
			return respond(cmd, { levels: THINKING_LEVELS });
		case "set_model": {
			const next = MODELS.find(m => m.provider === cmd.provider && m.id === cmd.modelId);
			if (!next) return fail(cmd, `Model not found: ${cmd.provider}/${cmd.modelId}`);
			model = next;
			respond(cmd, model);
			return out({ type: "model_changed", model });
		}
		case "set_thinking_level":
			if (!THINKING_LEVELS.includes(cmd.level)) return fail(cmd, `Invalid thinking level: ${cmd.level}`);
			thinkingLevel = cmd.level;
			respond(cmd);
			return out({ type: "thinking_level_changed", level: thinkingLevel });
		case "prompt":
			return onPrompt(cmd);
		case "abort":
			queue.length = 0;
			abortCtl?.abort();
			return respond(cmd);
		case "bash":
			return runBash(cmd);
		case "get_branch_messages":
			return respond(cmd, {
				messages: messages.flatMap((m, i) => (m.role === "user" ? [{ entryId: entryIds[i], text: textOfMessage(m) }] : [])),
			});
		case "switch_session":
			if (typeof cmd.sessionPath !== "string" || !fs.existsSync(cmd.sessionPath)) return fail(cmd, `Session file not found: ${cmd.sessionPath}`);
			loadSession(cmd.sessionPath);
			return respond(cmd, { cancelled: false });
		case "branch":
		case "fork": {
			const idx = cmd.entryId === undefined ? messages.length : entryIds.indexOf(cmd.entryId);
			if (idx < 0) return fail(cmd, `Entry not found: ${cmd.entryId}`);
			const text = cmd.entryId === undefined ? "" : textOfMessage(messages[idx]);
			const parent = sessionFile;
			// branch: retry from before that user message; fork: copy up to and including it.
			const keep = messages.slice(0, cmd.type === "branch" ? idx : cmd.entryId === undefined ? idx : idx + 1);
			startSession(keep, parent);
			return respond(cmd, cmd.type === "branch" ? { text, cancelled: false } : { cancelled: false });
		}
		case "new_session":
			startSession([], sessionFile);
			return respond(cmd, { cancelled: false });
		case "get_session_stats": {
			const count = role => messages.filter(m => m.role === role).length;
			const toolCalls = messages.reduce((n, m) => n + (m.role === "assistant" ? m.content.filter(c => c.type === "toolCall").length : 0), 0);
			const cost = messages.reduce((n, m) => n + (m.usage?.cost?.total ?? 0), 0);
			return respond(cmd, {
				sessionFile,
				sessionId,
				userMessages: count("user"),
				assistantMessages: count("assistant"),
				toolCalls,
				toolResults: count("toolResult"),
				totalMessages: messages.length,
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				premiumRequests: 0,
				cost,
			});
		}
		case "get_last_assistant_text": {
			const last = [...messages].reverse().find(m => m.role === "assistant" && textOfMessage(m));
			return respond(cmd, { text: last ? textOfMessage(last) : null });
		}
		case "compact": {
			const tokensBefore = contextUsage().tokens;
			const summary = `Fake summary of ${messages.length} messages`;
			out({ type: "auto_compaction_start", reason: "manual" });
			messages = [{ role: "compactionSummary", summary, tokensBefore, timestamp: Date.now() }];
			entryIds = [newId()];
			appendEntry({ type: "compaction", id: entryIds[0], summary, tokensBefore, timestamp: new Date().toISOString() });
			respond(cmd, { summary, firstKeptEntryId: entryIds[0], tokensBefore });
			return out({ type: "auto_compaction_end", result: { summary, tokensBefore }, aborted: false });
		}
		case "goal":
			if (cmd.op === "create") {
				goal = { objective: String(cmd.objective ?? ""), status: "active", enabled: true };
				respond(cmd, { goal });
				return out({ type: "goal_updated", goal });
			}
			return fail(cmd, `Unsupported goal op: ${cmd.op}`);
		case "live_start":
			return liveStart(cmd);
		case "live_stop":
			return liveStop(cmd);
		case "live_mute":
			if (!live) return fail(cmd, "No live session is active");
			live.muted = typeof cmd.muted === "boolean" ? cmd.muted : !live.muted;
			respond(cmd, { muted: live.muted });
			return out({ type: "live_phase", phase: live.muted ? "muted" : "listening" });
		case "extension_ui_response": {
			const waiter = uiWaiters.get(cmd.id);
			uiWaiters.delete(cmd.id);
			waiter?.(cmd);
			return;
		}
		default:
			return fail(cmd, `Unknown command: ${cmd.type}`);
	}
}

// ---------- live voice (FAKE_OMP_NO_LIVE=1: unsupported, like an omp without it) ----------
let live = null;
function liveStart(cmd) {
	if (process.env.FAKE_OMP_NO_LIVE === "1") return fail(cmd, `Unknown command: ${cmd.type}`);
	if (live) return fail(cmd, "A live session is already active");
	live = { muted: false, timer: undefined };
	out({ type: "live_phase", phase: "connecting" });
	respond(cmd, { voice: typeof cmd.voice === "string" && cmd.voice ? cmd.voice : "sol" });
	out({ type: "live_phase", phase: "listening" });
	let tick = 0;
	live.timer = setInterval(() => {
		tick++;
		out({ type: "live_levels", input: live?.muted ? 0 : (tick % 5) / 10, output: tick % 7 === 0 ? 0.3 : 0 });
		if (tick === 3) out({ type: "live_transcript", role: "user", turn: 1, text: "fake spoken words", final: true });
		if (tick === 5) {
			out({ type: "live_phase", phase: "speaking" });
			out({ type: "live_transcript", role: "assistant", turn: 1, text: "fake spoken reply", final: true });
		}
		if (tick === 7) out({ type: "live_phase", phase: "listening" });
	}, 50);
}
function liveStop(cmd) {
	if (live) {
		clearInterval(live.timer);
		live = null;
		out({ type: "live_end" });
	}
	respond(cmd);
}

// ---------- main ----------
const readyFrame = { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1024 * 1024, maxReassembledFrameBytes: 64 * 1024 * 1024 };
if (READY_DELAY > 0) setTimeout(() => out(readyFrame), READY_DELAY);
else out(readyFrame);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", line => {
	if (!line.trim()) return;
	let cmd;
	try {
		cmd = JSON.parse(line);
	} catch {
		out({ type: "response", command: "parse", success: false, error: `Invalid JSON: ${line.slice(0, 100)}` });
		return;
	}
	debug({ kind: "cmd", cmd });
	try {
		handle(cmd);
	} catch (err) {
		fail(cmd, String(err?.message ?? err));
	}
});
rl.on("close", () => {
	debug({ kind: "exit" });
	process.exit(0);
});
process.on("SIGTERM", () => process.exit(0));
