// Detached per-session host. Owns one `omp --mode rpc-ui` child, mirrors its transcript,
// snapshots files touched by mutating tools, and fans events out to any number of
// VS Code windows over a Unix socket. Survives VS Code / SSH disconnects.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { isAuthError } from "../shared/health";
import {
	type ClientToHost,
	DIALOG_METHODS,
	EMPTY_BLOB,
	type FileChange,
	type FileChangeEntry,
	type HostToClient,
	type OmpFrame,
	type RunningTool,
	type SessionMeta,
	type UiRequest,
	blobPath,
	sessionDir,
} from "../shared/protocol";
import { QueueRunner } from "./queue-runner";
import { EDIT_TOOLS, PLAN_PROMPT_PREFIX, type PermissionMode, PERMISSION_MODE_INFO, autoApproval, isPermissionMode, permissionModeInArgs, permissionModeOf, withoutApprovalArgs } from "../shared/permissions";
import { applyFlags, readFlags, readOmpSetting, sessionOverlayArgs } from "../shared/session-config";

// ---------- args ----------
interface HostArgs {
	id: string;
	cwd: string;
	omp: string;
	resume?: string;
	/** Resume with `omp --restore`: also continue the interrupted turn and its subagents. */
	restore?: boolean;
	/** Extension version that launched this host, recorded in meta for upgrade checks. */
	hostVersion?: string;
	title?: string;
	goal?: string;
	/** Who started this host (e.g. "scheduler" for the omp-vs server), recorded in meta. */
	launchedBy?: string;
	ompArgs: string[];
}

function parseArgs(argv: string[]): HostArgs {
	const out: Partial<HostArgs> & { ompArgs: string[] } = { ompArgs: [] };
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		const value = argv[i + 1];
		if (value === undefined) throw new Error(`missing value for ${key}`);
		i++;
		if (key === "--id") out.id = value;
		else if (key === "--cwd") out.cwd = value;
		else if (key === "--omp") out.omp = value;
		else if (key === "--resume") out.resume = value;
		else if (key === "--restore") {
			out.resume = value;
			out.restore = true;
		} else if (key === "--host-version") out.hostVersion = value;
		else if (key === "--title") out.title = value;
		else if (key === "--goal") out.goal = value;
		else if (key === "--launched-by") out.launchedBy = value;
		else if (key === "--omp-arg") out.ompArgs.push(value);
		else throw new Error(`unknown argument ${key}`);
	}
	if (!out.id || !out.cwd || !out.omp) throw new Error("--id, --cwd and --omp are required");
	return out as HostArgs;
}

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--daemonize") {
	// Re-exec in a new session and exit, so the host is reparented to init: VS Code killing its
	// extension-host process tree on disconnect/shutdown can no longer reach the host or omp.
	spawn(process.execPath, [process.argv[1], ...rawArgs.slice(1)], { detached: true, stdio: "ignore", env: process.env, windowsHide: true }).unref();
	process.exit(0);
}
const args = parseArgs(rawArgs);
const dir = sessionDir(args.id);
fs.mkdirSync(path.join(dir, "blobs"), { recursive: true, mode: 0o700 });
const logStream = fs.createWriteStream(path.join(dir, "host.log"), { flags: "a" });
function log(...parts: unknown[]): void {
	logStream.write(`[${new Date().toISOString()}] ${parts.map(p => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
}
process.on("uncaughtException", err => log("uncaught", String(err?.stack ?? err)));
process.on("unhandledRejection", err => log("unhandled", String(err)));
process.on("SIGHUP", () => log("SIGHUP ignored"));
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

// ---------- meta ----------
const IS_WINDOWS = process.platform === "win32";
/** Windows uses a named pipe; elsewhere a Unix socket (falling back to a short tmp path when the
 * state dir would exceed the ~104-byte sun_path limit). */
function computeSocketPath(): string {
	if (IS_WINDOWS) return `\\\\.\\pipe\\omp-vscode-${args.id}`;
	const preferred = path.join(dir, "s.sock");
	if (Buffer.byteLength(preferred) < 100) return preferred;
	const short = path.join(os.tmpdir(), `ompv-${process.getuid?.() ?? "u"}`);
	fs.mkdirSync(short, { recursive: true, mode: 0o700 });
	return path.join(short, `${args.id}.sock`);
}
const socketPath = computeSocketPath();
const metaPath = path.join(dir, "meta.json");
const previous = readJson<SessionMeta>(metaPath);
// Never run two hosts (two omp processes) for one session: a double "resume" exits here.
if (previous && previous.status !== "stopped" && previous.pid !== process.pid && pidAlive(previous.pid)) {
	// Synchronous: the log stream isn't open yet and nothing below may run.
	fs.appendFileSync(path.join(dir, "host.log"), `[${new Date().toISOString()}] another host is already running for this session: ${previous.pid}\n`);
	process.exit(0);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return rec(err)?.code === "EPERM";
	}
}
const meta: SessionMeta = {
	id: args.id,
	cwd: args.cwd,
	title: args.title || previous?.title || "New session",
	status: "starting",
	pid: process.pid,
	socket: socketPath,
	createdAt: previous?.createdAt ?? Date.now(),
	cost: previous?.cost,
	updatedAt: Date.now(),
	ompSessionFile: args.resume ?? previous?.ompSessionFile,
	hostVersion: args.hostVersion,
	hostPath: path.resolve(process.argv[1]),
	launchedBy: args.launchedBy,
	userActiveAt: previous?.userActiveAt,
	changedFiles: 0,
};

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function rec(v: unknown): Record<string, unknown> | undefined {
	// Plain JSON object from omp frames; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function messagesOf(data: unknown): unknown[] {
	const m = rec(data)?.messages;
	return Array.isArray(m) ? m : [];
}
function modelLabel(model: unknown): string | undefined {
	const m = rec(model);
	const provider = str(m?.provider);
	const id = str(m?.id);
	return provider && id ? `${provider}/${id}` : undefined;
}

let metaTimer: NodeJS.Timeout | undefined;
function saveMeta(now = false): void {
	meta.updatedAt = Date.now();
	const write = () => {
		metaTimer = undefined;
		const tmp = `${metaPath}.${process.pid}.tmp`;
		// A failed write (session folder deleted, disk full) must not throw out of shutdown and wedge the host.
		try {
			fs.writeFileSync(tmp, JSON.stringify(meta, null, 1));
			fs.renameSync(tmp, metaPath);
		} catch (err) {
			log("meta write failed", String(err));
		}
	};
	if (now) {
		clearTimeout(metaTimer);
		write();
		return;
	}
	metaTimer ??= setTimeout(write, 150);
}

function publishMeta(): void {
	saveMeta();
	broadcast({ t: "meta", meta });
}

// ---------- transcript mirror ----------
let messages: unknown[] = [];
/** Client `bash` requests in flight (rewritten id → command), recorded into the mirror on response. */
const pendingBash = new Map<string, string>();
let inflight: { messageId: string; message: unknown } | null = null;
const running = new Map<string, RunningTool>();
const pendingUi: UiRequest[] = [];
let commands: unknown[] = [];
let state: Record<string, unknown> | null = null;
let agentActive = false;
const changes: FileChange[] = [];
const changesPath = path.join(dir, "changes.jsonl");

// ---------- task queue ----------
// The runner (queue-runner.ts) owns queue.json, dispatch, per-task options, and concurrency slots.
const queueRunner = new QueueRunner(args.id, path.join(dir, "queue.json"), {
	log,
	sendOmp,
	request,
	idle: () => !stopping && !finished && meta.status !== "starting" && !agentActive && pendingUi.length === 0,
	setBusy: busy => {
		agentActive = busy;
		recomputeStatus();
	},
	sessionReset: async () => {
		await resync();
		refreshState();
	},
	notice: (level, message) => {
		messages.push({ role: "notice", level, message, timestamp: Date.now() });
		broadcast({ t: "event", ev: { type: "notice", level, message } });
	},
	changed: (queue, summary) => {
		meta.queue = summary;
		broadcast({ t: "queue", queue });
		publishMeta();
	},
});
for (const line of safeRead(changesPath).split("\n")) {
	if (!line) continue;
	try {
		changes.push(JSON.parse(line) as FileChange);
	} catch {
		/* ignore torn line */
	}
}
const touched = new Set(changes.flatMap(c => c.files.map(f => f.path)));
meta.changedFiles = touched.size;

function safeRead(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function recomputeStatus(): void {
	if (meta.status === "stopped") return;
	const next = pendingUi.length > 0 ? "waiting" : agentActive ? "working" : "idle";
	if (next !== meta.status) {
		meta.status = next;
		publishMeta();
	}
}

// ---------- blobs / file snapshots ----------
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const beforeSnapshots = new Map<string, Map<string, string | null>>();

function storeBlob(content: Buffer): string {
	const hash = crypto.createHash("sha1").update(content).digest("hex");
	const file = blobPath(args.id, hash);
	if (!fs.existsSync(file)) fs.writeFileSync(file, content);
	return hash;
}

/** Hash of current file content; null when absent; undefined when unreadable/too large. */
function snapshotFile(file: string): string | null | undefined {
	try {
		const st = fs.statSync(file);
		if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return undefined;
		const content = fs.readFileSync(file);
		return content.length === 0 ? EMPTY_BLOB : storeBlob(content);
	} catch (err) {
		return rec(err)?.code === "ENOENT" ? null : undefined;
	}
}

function resolvePath(p: string): string {
	const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
	return path.resolve(args.cwd, expanded);
}

function candidatePaths(toolArgs: unknown): string[] {
	const out = new Set<string>();
	const record = rec(toolArgs) ?? {};
	for (const key of ["path", "file", "file_path", "notebook_path", "notebook"]) {
		const value = record[key];
		if (typeof value === "string" && value && !value.includes("://")) out.add(resolvePath(value));
	}
	if (Array.isArray(record.paths)) {
		for (const value of record.paths) if (typeof value === "string" && !value.includes("://")) out.add(resolvePath(value));
	}
	const input = record.input ?? record.patch;
	if (typeof input === "string") {
		for (const m of input.matchAll(/^\[([^\]\n#]+)#[0-9A-Za-z]{2,8}\]/gm)) out.add(resolvePath(m[1].trim()));
		for (const m of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.add(resolvePath(m[1].trim()));
		for (const m of input.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.add(resolvePath(m[1].trim()));
		for (const m of input.matchAll(/^MV\s+"?([^"\n]+)"?\s*$/gm)) out.add(resolvePath(m[1].trim()));
	}
	return [...out];
}

function detailPaths(details: unknown): { paths: string[]; oldText: Map<string, string> } {
	const paths = new Set<string>();
	const oldText = new Map<string, string>();
	const visit = (d: unknown) => {
		const r = rec(d);
		if (!r) return;
		for (const key of ["path", "sourcePath", "resolvedPath", "move"]) {
			const v = r[key];
			if (typeof v === "string" && v && !v.includes("://")) paths.add(resolvePath(v));
		}
		if (typeof r.path === "string" && typeof r.oldText === "string") oldText.set(resolvePath(r.sourcePath && typeof r.sourcePath === "string" ? r.sourcePath : r.path), r.oldText);
		if (Array.isArray(r.perFileResults)) for (const f of r.perFileResults) visit(f);
	};
	visit(details);
	return { paths: [...paths], oldText };
}

/**
 * Takes "before" snapshots for a mutating tool call. Called when the assistant message that
 * contains the call ends (omp runs tools only after that), and again at tool_execution_start as a
 * fallback; the first snapshot wins, so a fast tool can't race the host into a stale "before".
 */
function onToolStart(toolCallId: string, toolName: string, toolArgs: unknown): void {
	if (!EDIT_TOOLS[toolName] || beforeSnapshots.has(toolCallId)) return;
	const snaps = new Map<string, string | null>();
	for (const p of candidatePaths(toolArgs)) {
		const h = snapshotFile(p);
		if (h !== undefined) snaps.set(p, h);
	}
	beforeSnapshots.set(toolCallId, snaps);
}

function onToolEnd(toolCallId: string, toolName: string, result: unknown): void {
	if (!EDIT_TOOLS[toolName]) return;
	const snaps = beforeSnapshots.get(toolCallId) ?? new Map<string, string | null>();
	beforeSnapshots.delete(toolCallId);
	const details = rec(result)?.details;
	const fromDetails = detailPaths(details);
	const all = new Set([...snaps.keys(), ...fromDetails.paths]);
	const files: FileChangeEntry[] = [];
	for (const p of all) {
		// omp's own oldText is authoritative when present; the host snapshot covers everything else.
		const old = fromDetails.oldText.get(p);
		const before = old !== undefined ? (old.length === 0 ? EMPTY_BLOB : storeBlob(Buffer.from(old))) : snaps.get(p);
		const after = snapshotFile(p);
		if (after === undefined || before === undefined || before === after) continue;
		files.push({ path: p, op: before === null ? "create" : after === null ? "delete" : "update", before, after });
	}
	if (files.length === 0) return;
	const change: FileChange = { toolCallId, toolName, timestamp: Date.now(), files };
	changes.push(change);
	fs.appendFileSync(changesPath, `${JSON.stringify(change)}\n`);
	for (const f of files) touched.add(f.path);
	meta.changedFiles = touched.size;
	broadcast({ t: "change", change });
	publishMeta();
}

// ---------- omp child ----------
// The chat panel is an interactive frontend, so goals should keep running between turns as they
// do in the TUI (omp only auto-continues goals for "interactive" by default).
const overlayPath = path.join(dir, "omp-overlay.yml");
fs.writeFileSync(overlayPath, "goal:\n  continuationModes:\n    - interactive\n    - rpc\n");
const ompArgv = [
	"--mode",
	"rpc-ui",
	"--cwd",
	args.cwd,
	"--config",
	overlayPath,
	...(meta.ompSessionFile ? [args.restore ? "--restore" : "--resume", meta.ompSessionFile] : []),
	// The host answers approval prompts by the session's permission mode (extension_ui_request below).
	...withoutApprovalArgs(args.ompArgs),
	"--approval-mode",
	"always-ask",
];
const env = { ...process.env };
// GUI-launched editors (macOS Dock, Windows Start) often lack the shell PATH that holds omp/bun.
const extraPath = [
	path.join(os.homedir(), ".bun", "bin"),
	path.join(os.homedir(), ".local", "bin"),
	path.join(os.homedir(), ".npm-global", "bin"),
	...(IS_WINDOWS ? [] : ["/opt/homebrew/bin", "/usr/local/bin"]),
];
const pathKey = Object.keys(env).find(k => k.toUpperCase() === "PATH") ?? "PATH";
const currentPath = env[pathKey] ?? "";
env[pathKey] = [...extraPath.filter(p => !currentPath.split(path.delimiter).includes(p) && fs.existsSync(p)), currentPath].filter(Boolean).join(path.delimiter);
delete env.ELECTRON_RUN_AS_NODE;
delete env.VSCODE_IPC_HOOK_CLI;
if (!fs.existsSync(args.cwd)) {
	log("folder does not exist:", args.cwd);
	Object.assign(meta, { status: "stopped", exitCode: 1, exitReason: `folder not found: ${args.cwd}` });
	saveMeta(true);
	process.exit(1);
}
// Per-session skills/tools/MCP toggles (omp: Session Settings) as one more settings overlay.
ompArgv.push(...sessionOverlayArgs(dir, args.omp, args.cwd, env, log));
// Starting permission mode: the session's launch flag, else omp's own setting (default yolo = auto).
meta.permissionMode = permissionModeInArgs(args.ompArgs) ?? permissionModeOf(readOmpSetting(args.omp, "tools.approvalMode", args.cwd, env, log)) ?? "auto";
log("spawn", args.omp, ompArgv);
// npm/bun shims on Windows are .cmd files, which need a shell to start.
const child: ChildProcessWithoutNullStreams = spawn(args.omp, ompArgv, { cwd: args.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: IS_WINDOWS && /\.(cmd|bat)$/i.test(args.omp) });
meta.ompPid = child.pid;
saveMeta(true);

child.stderr.on("data", (d: Buffer) => logStream.write(d));
child.stdout.on("error", err => log("stdout error", String(err)));
child.on("error", err => {
	log("child error", String(err));
	finish(null, `failed to start omp: ${err.message}`);
});
child.on("exit", (code, signal) => {
	log("child exit", code, signal);
	finish(code, signal ? `signal ${signal}` : code === 0 ? "exited" : `exit code ${code}`);
});
child.stdin.on("error", err => log("stdin error", String(err)));

function sendOmp(cmd: Record<string, unknown>): void {
	if (child.stdin.writable) child.stdin.write(`${JSON.stringify(cmd)}\n`);
}

let hostSeq = 0;
const hostPending = new Map<string, (res: OmpFrame) => void>();
function request(cmd: Record<string, unknown>): Promise<OmpFrame> {
	const id = `h:${++hostSeq}`;
	const { promise, resolve } = Promise.withResolvers<OmpFrame>();
	hostPending.set(id, resolve);
	sendOmp({ ...cmd, id });
	return promise;
}

// rpc_chunk reassembly (protocol v2)
let chunk: { id: string; count: number; next: number; parts: Buffer[] } | null = null;
function onLine(line: string): void {
	if (!line.trim()) return;
	let frame: OmpFrame;
	try {
		frame = JSON.parse(line) as OmpFrame;
	} catch {
		log("bad frame", line.slice(0, 200));
		return;
	}
	if (frame.type === "rpc_chunk") {
		const index = frame.index as number;
		if (index === 0) chunk = { id: frame.chunkId as string, count: frame.count as number, next: 0, parts: [] };
		if (!chunk || chunk.id !== frame.chunkId || chunk.next !== index) {
			log("chunk sequence error");
			chunk = null;
			return;
		}
		chunk.parts.push(Buffer.from(frame.data as string, "base64"));
		chunk.next++;
		if (chunk.next < chunk.count) return;
		const whole = Buffer.concat(chunk.parts).toString("utf8");
		chunk = null;
		onLine(whole);
		return;
	}
	handleFrame(frame);
}
readline
	.createInterface({ input: child.stdout, crlfDelay: Infinity })
	.on("line", onLine)
	.on("error", err => log("stdout reader error", String(err)));

const STATE_KEYS = [
	"model",
	"thinkingLevel",
	"isStreaming",
	"isCompacting",
	"sessionFile",
	"sessionId",
	"sessionName",
	"fastModeEnabled",
	"autoCompactionEnabled",
	"messageCount",
	"queuedMessages",
	"todoPhases",
	"contextUsage",
	"tokensPerSecond",
	"usageLimit",
	"goal",
	"isSettled",
];
function slimState(data: unknown): Record<string, unknown> {
	const src = rec(data) ?? {};
	const out: Record<string, unknown> = {};
	for (const k of STATE_KEYS) if (src[k] !== undefined) out[k] = src[k];
	const model = rec(src.model);
	if (model) out.model = { provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, reasoning: model.reasoning };
	return out;
}

let stateTimer: NodeJS.Timeout | undefined;
function refreshState(): void {
	stateTimer ??= setTimeout(async () => {
		stateTimer = undefined;
		const res = await request({ type: "get_state" });
		if (!res.success) return;
		const next = slimState(res.data);
		const prevSession = state?.sessionId;
		state = next;
		const label = modelLabel(next.model);
		meta.model = label ?? meta.model;
		meta.ompSessionFile = str(next.sessionFile) ?? meta.ompSessionFile;
		meta.ompSessionId = str(next.sessionId) ?? meta.ompSessionId;
		meta.plan = Array.isArray(next.todoPhases) ? (next.todoPhases as SessionMeta["plan"]) : meta.plan;
		if (typeof next.sessionName === "string" && next.sessionName && next.sessionName !== meta.title) meta.title = next.sessionName;
		publishMeta();
		if (prevSession && next.sessionId && prevSession !== next.sessionId) await resync();
		else broadcast({ t: "state", state });
	}, 120);
}

async function resync(): Promise<void> {
	const res = await request({ type: "get_messages" });
	if (res.success) {
		messages = messagesOf(res.data);
	}
	inflight = null;
	running.clear();
	broadcast({ t: "reset", messages, state });
}

const SESSION_CHANGING: Record<string, true> = { new_session: true, switch_session: true, branch: true, fork: true, open_session: true };

async function onReady(): Promise<void> {
	await request({ type: "negotiate_protocol", protocolVersion: 2 });
	await request({ type: "set_ask_dialog", enabled: true });
	await request({ type: "set_subagent_subscription", level: "progress" });
	const st = await request({ type: "get_state" });
	if (st.success) state = slimState(st.data);
	const msgs = await request({ type: "get_messages" });
	if (msgs.success) messages = messagesOf(msgs.data);
	meta.model = modelLabel(state?.model) ?? meta.model;
	meta.ompSessionFile = str(state?.sessionFile) ?? meta.ompSessionFile;
	meta.ompSessionId = str(state?.sessionId) ?? meta.ompSessionId;
	meta.plan = Array.isArray(state?.todoPhases) ? (state.todoPhases as SessionMeta["plan"]) : meta.plan;
	if (typeof state?.sessionName === "string" && state.sessionName) meta.title = state.sessionName;
	else if (meta.title !== "New session") sendOmp({ type: "set_session_name", name: meta.title });
	meta.status = "idle";
	meta.queue = queueRunner.summary();
	recomputeStatus();
	publishMeta();
	for (const c of clients) if (c.helloed) sendSnapshot(c);
	queueRunner.schedule(1000);
	const models = await request({ type: "get_available_models" });
	const available = rec(models.data)?.models;
	if (models.success && Array.isArray(available) && available.length === 0) noteAuthProblem("no model is available");
	if (args.goal && !previous) {
		if (meta.title === "New session") {
			meta.title = titleFromPrompt(`Goal: ${args.goal}`);
			sendOmp({ type: "set_session_name", name: meta.title });
			publishMeta();
		}
		const res = await request({ type: "goal", op: "create", objective: args.goal });
		if (!res.success) {
			log("goal create failed", res.error);
			broadcast({ t: "event", ev: { type: "notice", level: "error", message: `Could not start goal: ${String(res.error)}` } });
		}
	}
}

/**
 * omp can't use any model (no provider logged in, missing/rejected API key): say so once in the
 * chat with a login link and flag it in meta so the extension can notify. Deferred so the frame
 * that revealed it reaches clients first.
 */
function noteAuthProblem(detail: string): void {
	setImmediate(() => {
		if (meta.authProblem || meta.status === "stopped") return;
		meta.authProblem = detail.slice(0, 300);
		const shown = meta.authProblem.replace(/[\\`*_[\]<>]/g, "\\$&");
		const message = `**omp can't use a model** (${shown}). Log in to a provider with [omp login](command:omp.login) or configure an API key, then send your message again. Still stuck? [Run omp Doctor](command:omp.doctor)`;
		log("auth problem:", detail);
		messages.push({ role: "notice", level: "warning", message, markdown: true, timestamp: Date.now() });
		broadcast({ t: "event", ev: { type: "notice", level: "warning", message, markdown: true } });
		publishMeta();
	});
}

function textOf(message: unknown): string {
	const content = rec(message)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

function handleFrame(frame: OmpFrame): void {
	switch (frame.type) {
		case "ready":
			void onReady();
			return;
		case "response": {
			const id = typeof frame.id === "string" ? frame.id : "";
			if (id.startsWith("h:")) {
				const resolve = hostPending.get(id);
				hostPending.delete(id);
				resolve?.(frame);
				return;
			}
			if (!frame.success && frame.command === "prompt" && isAuthError(str(frame.error))) noteAuthProblem(String(frame.error));
			if (queueRunner.onResponse(frame)) return;
			const m = /^c(\d+):(.*)$/s.exec(id);
			const res = { ...frame, id: m ? m[2] : frame.id };
			const client = m ? clients.find(c => c.num === Number(m[1])) : undefined;
			if (client) send(client, { t: "response", res });
			const bashCommand = pendingBash.get(id);
			if (bashCommand !== undefined) {
				pendingBash.delete(id);
				const data = rec(frame.data);
				// omp records `bash` output in its transcript but emits no message events for it.
				if (frame.success && data) messages.push({ role: "bashExecution", command: bashCommand, output: data.output, exitCode: data.exitCode, cancelled: data.cancelled, timestamp: Date.now() });
			}
			if (frame.success && typeof frame.command === "string") {
				if (SESSION_CHANGING[frame.command]) void resync().then(refreshState);
				else if (!frame.command.startsWith("get_")) refreshState();
			}
			return;
		}
		case "message_start":
			inflight = { messageId: frame.messageId as string, message: frame.message };
			break;
		case "message_update":
			inflight = { messageId: frame.messageId as string, message: frame.message };
			break;
		case "message_end": {
			messages.push(frame.message);
			inflight = null;
			const msg = rec(frame.message);
			if (msg?.role === "assistant") {
				const text = textOf(msg).trim();
				if (text) meta.lastText = text.slice(0, 300);
				const cost = rec(rec(msg.usage)?.cost)?.total;
				if (typeof cost === "number") meta.cost = (meta.cost ?? 0) + cost;
				saveMeta();
				queueRunner.onAssistantMessage(msg);
				if (msg.stopReason === "error" && isAuthError(str(msg.errorMessage))) noteAuthProblem(String(msg.errorMessage));
				else if (msg.stopReason !== "error" && msg.stopReason !== "aborted" && meta.authProblem) {
					meta.authProblem = undefined;
					publishMeta();
				}
				// Snapshot files the upcoming tool calls will touch before omp executes them.
				if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						const b = rec(block);
						if (b?.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") onToolStart(b.id, b.name, b.arguments);
					}
				}
			}
			break;
		}
		case "tool_execution_start":
			running.set(frame.toolCallId as string, {
				toolCallId: frame.toolCallId as string,
				toolName: frame.toolName as string,
				args: frame.args,
				intent: frame.intent as string | undefined,
			});
			onToolStart(frame.toolCallId as string, frame.toolName as string, frame.args);
			break;
		case "tool_execution_update": {
			const r = running.get(frame.toolCallId as string);
			if (r) r.partialResult = frame.partialResult;
			break;
		}
		case "tool_execution_end":
			running.delete(frame.toolCallId as string);
			onToolEnd(frame.toolCallId as string, frame.toolName as string, frame.result);
			break;
		case "agent_start":
			agentActive = true;
			recomputeStatus();
			break;
		case "agent_end": {
			const { messages: _drop, ...rest } = frame;
			broadcast({ t: "event", ev: rest as OmpFrame });
			refreshState();
			return;
		}
		case "prompt_result":
			queueRunner.onPromptResult(frame);
			if (frame.sessionSettled) {
				agentActive = false;
				recomputeStatus();
				queueRunner.schedule();
			}
			refreshState();
			break;
		case "session_settled":
			agentActive = false;
			recomputeStatus();
			queueRunner.onSettled();
			queueRunner.schedule();
			refreshState();
			break;
		case "extension_ui_request": {
			const method = frame.method as string;
			const auto = autoApproval(meta.permissionMode ?? "ask", { ...frame, id: String(frame.id) });
			if (auto) {
				// Answered by the permission mode: never shown, so not broadcast either.
				log("approval", meta.permissionMode, String(frame.title).split("\n")[0], "→", auto.value);
				sendOmp({ type: "extension_ui_response", ...auto });
				return;
			}
			if (DIALOG_METHODS[method]) {
				pendingUi.push(frame as unknown as UiRequest);
				recomputeStatus();
			} else if (method === "cancel") {
				removePending(frame.targetId as string);
			} else if (method === "setTitle" && typeof frame.title === "string" && meta.title === "New session") {
				meta.title = frame.title;
				publishMeta();
			}
			break;
		}
		case "command_output":
			messages.push({ role: "commandOutput", text: frame.text, timestamp: Date.now() });
			break;
		case "notice":
			messages.push({ role: "notice", level: frame.level, message: frame.message, timestamp: Date.now() });
			break;
		case "btw_record": {
			const record = rec(frame.record);
			if (record && record.status !== "running") {
				const existing = messages.findIndex(m => rec(m)?.role === "sideQuestion" && rec(rec(m)?.record)?.id === record.id);
				const entry = { role: "sideQuestion", record, timestamp: Date.now() };
				if (existing >= 0) messages[existing] = entry;
				else messages.push(entry);
			}
			break;
		}
		case "available_commands_update":
			commands = (frame.commands as unknown[]) ?? [];
			break;
		case "goal_updated":
		case "model_changed":
		case "thinking_level_changed":
		case "queue_update":
		case "auto_compaction_end":
			refreshState();
			break;
	}
	broadcast({ t: "event", ev: frame });
}

function removePending(id: string): void {
	const idx = pendingUi.findIndex(r => r.id === id);
	if (idx < 0) return;
	pendingUi.splice(idx, 1);
	broadcast({ t: "ui_resolved", id });
	recomputeStatus();
}

// ---------- socket server ----------
interface Client {
	num: number;
	sock: net.Socket;
	helloed: boolean;
	name: string;
}
const clients: Client[] = [];
let clientSeq = 0;

function send(c: Client, msg: HostToClient): void {
	if (!c.sock.destroyed) c.sock.write(`${JSON.stringify(msg)}\n`);
}
function broadcast(msg: HostToClient): void {
	if (clients.length === 0) return;
	const line = `${JSON.stringify(msg)}\n`;
	for (const c of clients) if (c.helloed && !c.sock.destroyed) c.sock.write(line);
}
function sendSnapshot(c: Client): void {
	send(c, {
		t: "snapshot",
		meta,
		messages,
		inflight,
		runningTools: [...running.values()],
		pendingUi,
		state,
		commands,
		changes,
		queue: queueRunner.queue,
	});
}

function titleFromPrompt(text: string): string {
	const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
	return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Clients that are people looking at the session (chat panels, `omp-vs attach`), not the omp-vs server. */
function updateViewers(): void {
	const viewers = clients.filter(c => c.helloed && !c.name.startsWith("omp-vs-server")).length;
	if ((meta.viewers ?? 0) === viewers) return;
	meta.viewers = viewers;
	publishMeta();
}

function markUserActive(): void {
	meta.userActiveAt = Date.now();
	saveMeta();
}

function onClientMessage(c: Client, msg: ClientToHost): void {
	switch (msg.t) {
		case "hello":
			c.helloed = true;
			c.name = msg.client;
			log("client hello", c.num, c.name);
			sendSnapshot(c);
			updateViewers();
			return;
		case "rpc": {
			const cmd: { type: string; id: string; [k: string]: unknown } = { ...msg.cmd, id: `c${c.num}:${msg.cmd.id ?? ""}` };
			// Queries (get_*) are clients syncing; anything else is a person acting on the session.
			if (!cmd.type.startsWith("get_")) markUserActive();
			const text = msg.cmd.message;
			if (cmd.type === "prompt" && meta.title === "New session" && typeof text === "string" && !text.startsWith("/")) {
				meta.title = titleFromPrompt(text);
				sendOmp({ type: "set_session_name", name: meta.title });
				publishMeta();
			}
			if (cmd.type === "prompt" && meta.permissionMode === "plan" && typeof text === "string" && !/^[/!]/.test(text) && !text.startsWith(PLAN_PROMPT_PREFIX)) cmd.message = PLAN_PROMPT_PREFIX + text;
			if (cmd.type === "bash" && typeof msg.cmd.command === "string") pendingBash.set(cmd.id, msg.cmd.command);
			sendOmp(cmd);
			return;
		}
		case "ui_response":
			sendOmp({ ...msg.res, type: "extension_ui_response" });
			markUserActive();
			removePending(msg.res.id);
			queueRunner.schedule();
			return;
		case "queue":
			queueRunner.apply(msg.ops);
			return;
		case "mode":
			if (isPermissionMode(msg.mode) && msg.mode !== meta.permissionMode) {
				markUserActive();
				setPermissionMode(msg.mode);
			}
			return;
		case "note":
			messages.push({ role: "notice", level: msg.level, message: msg.message, markdown: msg.markdown, timestamp: Date.now() });
			return;
		case "rename":
			meta.title = msg.title;
			sendOmp({ type: "set_session_name", name: msg.title });
			publishMeta();
			return;
		case "stop":
			void stop("client request");
			return;
	}
}

/** Switches the permission mode: persisted as the session's launch flag, applied to waiting prompts. */
function setPermissionMode(mode: PermissionMode): void {
	meta.permissionMode = mode;
	const launchFile = path.join(dir, "launch.json");
	const launch = readJson<Record<string, unknown>>(launchFile) ?? {};
	const current = Array.isArray(launch.ompArgs) ? launch.ompArgs.filter((a): a is string => typeof a === "string") : args.ompArgs;
	try {
		fs.writeFileSync(launchFile, JSON.stringify({ ...launch, ompArgs: applyFlags(current, { ...readFlags(current), approvalMode: mode }) }));
	} catch (err) {
		log("launch.json write failed", String(err));
	}
	const message = `Permission mode: ${PERMISSION_MODE_INFO[mode].label}. ${PERMISSION_MODE_INFO[mode].detail}.`;
	messages.push({ role: "notice", level: "info", message, timestamp: Date.now() });
	broadcast({ t: "event", ev: { type: "notice", level: "info", message } });
	for (const req of [...pendingUi]) {
		const auto = autoApproval(mode, req);
		if (!auto) continue;
		sendOmp({ type: "extension_ui_response", ...auto });
		removePending(req.id);
	}
	publishMeta();
	queueRunner.schedule();
}

if (!IS_WINDOWS) {
	try {
		fs.unlinkSync(socketPath);
	} catch {
		/* not present */
	}
}
const server = net.createServer(sock => {
	const c: Client = { num: ++clientSeq, sock, helloed: false, name: "" };
	clients.push(c);
	const rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
	rl.on("error", () => {});
	rl.on("line", line => {
		if (!line.trim()) return;
		try {
			onClientMessage(c, JSON.parse(line) as ClientToHost);
		} catch (err) {
			log("client message error", String(err));
		}
	});
	const drop = () => {
		const idx = clients.indexOf(c);
		if (idx < 0) return;
		clients.splice(idx, 1);
		updateViewers();
	};
	sock.on("close", drop);
	sock.on("error", drop);
});
server.on("error", err => {
	log("socket server error", String(err));
	if (!finished) void stop("socket unavailable");
});
server.listen(socketPath, () => {
	if (!IS_WINDOWS) {
		try {
			fs.chmodSync(socketPath, 0o600);
		} catch (err) {
			log("chmod failed", String(err));
		}
	}
	log("listening", socketPath);
});

// ---------- shutdown ----------
let stopping = false;
async function stop(reason: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	log("stopping:", reason);
	meta.exitReason = "stopped";
	sendOmp({ type: "abort" });
	setTimeout(() => child.stdin.end(), 300);
	setTimeout(() => child.kill("SIGTERM"), 6000).unref();
	setTimeout(() => child.kill("SIGKILL"), 10000).unref();
}

let finished = false;
function finish(code: number | null, reason: string): void {
	if (finished) return;
	finished = true;
	meta.status = "stopped";
	meta.exitCode = code;
	meta.exitReason = meta.exitReason ?? reason;
	pendingUi.length = 0;
	saveMeta(true);
	broadcast({ t: "meta", meta });
	setTimeout(() => {
		for (const c of clients) c.sock.end();
		server.close();
		if (!IS_WINDOWS) {
			try {
				fs.unlinkSync(socketPath);
			} catch {
				/* gone */
			}
		}
		logStream.end(() => process.exit(0));
		// The log may never flush (its folder is gone, disk full): don't outlive the session regardless.
		setTimeout(() => process.exit(0), 2000);
	}, 200);
}
