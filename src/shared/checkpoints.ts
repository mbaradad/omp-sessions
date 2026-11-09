// Checkpoints: every prompt is one. The omp extension `src/omp-extension/checkpoints.ts` records a
// before/after snapshot of every file omp's edit tools change, and its `/undo` / `/redo` commands
// rewind the conversation (omp tree navigation, same transcript) and put those files back. Clients
// (the VS Code extension) read what it writes: the edits for Review Changes and inline diffs, and
// which prompts are undone, to hide those turns that AO's timeline still shows.
//
// Store layout: `<Switchyard state folder>/sessions/<AO session id>/checkpoints/` (`SWITCHYARD_HOME`,
// default ~/.switchyard; src/ao/native.ts keeps `omp.json` one level up, see GAPS.md G9):
//   changes.jsonl   one FileChange per edit tool call, in order
//   blobs/<sha1>    file contents (EMPTY_BLOB stands for an empty file, null for absent)
//   state.json      CheckpointState: the session's prompts and the redo stack
// Node-only (fs); no VS Code and no omp imports, so the omp extension bundles it.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AoConversation } from "../ao/client";
import { switchyardHome } from "../ao/native";

export const EMPTY_BLOB = "empty";
/** Larger files are not snapshotted (their edits are not undone). */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** Session entry type of the marker `/undo` and `/redo` append; it carries the redo stack. */
export const MARKER_TYPE = "switchyard.checkpoint";
/** The commands the extension registers; AO turns sending them are not conversation turns. */
export const CHECKPOINT_COMMANDS = ["undo", "redo"] as const;

export interface FileChangeEntry {
	path: string;
	op: "create" | "update" | "delete";
	/** Content hash before the tool call; null when the file did not exist. */
	before: string | null;
	/** Content hash after the tool call; null when the tool deleted it. */
	after: string | null;
}

/** One edit tool call's effect on the files it touched. */
export interface FileChange {
	toolCallId: string;
	toolName: string;
	timestamp: number;
	files: FileChangeEntry[];
	/** omp session entry id of the prompt the call belongs to (subagent calls count for the parent's). */
	prompt?: string;
	/** omp session id the call ran in. */
	ompSession?: string;
}

/** A file a restore puts back: `before` is its hash before the first change, `after` after the last. */
export interface CheckpointFile {
	path: string;
	before: string | null;
	after: string | null;
}

/** A prompt the person sent, as omp recorded it. */
export interface CheckpointPrompt {
	/** omp session entry id. */
	id: string;
	/** Text (first 500 characters). */
	text: string;
	/** Epoch ms omp recorded it. */
	at: number;
	/** On the conversation's current branch; false once undone. */
	active: boolean;
	/** Files its edit tool calls changed. */
	files: number;
}

/** What `/redo` brings back next, newest first. */
export interface RedoSummary {
	prompt: string;
	/** The files it rewrites, with the content they get back (`after`) and have now (`before`). */
	files: CheckpointFile[];
}

export interface CheckpointState {
	version: 1;
	ompSessionId: string;
	sessionFile?: string;
	cwd: string;
	updatedAt: number;
	/** Every prompt in the transcript, in order. */
	prompts: CheckpointPrompt[];
	redo: RedoSummary[];
	/** Result of the last `/undo` or `/redo`, for clients that cannot see omp's notices. */
	last?: CheckpointResult;
}

export interface CheckpointResult {
	op: "undo" | "redo";
	ok: boolean;
	at: number;
	message: string;
	/** Files written back. */
	restored: string[];
	/** Files that could not be written. */
	failed: string[];
	/** Files that had changed since omp last wrote them (overwritten anyway). */
	overwritten: string[];
	/** The prompt the undo rewound (its text goes back into the composer). */
	prompt?: string;
}

/** One undo, as stored in the marker entry: enough to redo it. */
export interface RedoEntry {
	/** Leaf entry before the undo. */
	leaf: string;
	/** Text of the undone prompt. */
	prompt: string;
	files: CheckpointFile[];
}

export interface MarkerData {
	v: 1;
	op: "undo" | "redo";
	redo: RedoEntry[];
}

// ---------- paths ----------

function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Ids become folder names: one path segment, nothing else. */
function segment(id: string): string {
	if (!id || id === "." || id === ".." || /[/\\\0]/.test(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
	return id;
}

/** Store of an AO session. */
export function aoCheckpointDir(aoSessionId: string, home = switchyardHome()): string {
	return path.join(home, "sessions", segment(aoSessionId), "checkpoints");
}

export function changesFile(dir: string): string {
	return path.join(dir, "changes.jsonl");
}

export function stateFile(dir: string): string {
	return path.join(dir, "state.json");
}

export function blobFile(dir: string, hash: string): string {
	return path.join(dir, "blobs", hash);
}

// ---------- reading and writing ----------

export function readChanges(dir: string): FileChange[] {
	let raw = "";
	try {
		raw = fs.readFileSync(changesFile(dir), "utf8");
	} catch {
		return [];
	}
	const out: FileChange[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line) as FileChange);
		} catch {
			/* torn write */
		}
	}
	return out;
}

export function readState(dir: string): CheckpointState | undefined {
	try {
		const state = JSON.parse(fs.readFileSync(stateFile(dir), "utf8")) as CheckpointState;
		return state?.version === 1 && Array.isArray(state.prompts) ? state : undefined;
	} catch {
		return undefined;
	}
}

/** The edits still in effect: those made for prompts `/undo` took back are left out. */
export function liveChanges(dir: string): FileChange[] {
	const undone = new Set(readState(dir)?.prompts.filter(p => !p.active).map(p => p.id));
	return readChanges(dir).filter(c => !c.prompt || !undone.has(c.prompt));
}

/** Content of a snapshot; throws when the blob is missing. */
export function readBlob(dir: string, hash: string): Buffer {
	return hash === EMPTY_BLOB ? Buffer.alloc(0) : fs.readFileSync(blobFile(dir, hash));
}

export function storeBlob(dir: string, content: Buffer): string {
	if (content.length === 0) return EMPTY_BLOB;
	const hash = crypto.createHash("sha1").update(content).digest("hex");
	const file = blobFile(dir, hash);
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeFileAtomic(file, content);
	}
	return hash;
}

export function appendChange(dir: string, change: FileChange): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.appendFileSync(changesFile(dir), `${JSON.stringify(change)}\n`);
}

export function writeState(dir: string, state: CheckpointState): void {
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomic(stateFile(dir), `${JSON.stringify(state)}\n`);
}

export function writeFileAtomic(file: string, content: string | Buffer): void {
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}

/** Hash of `file`'s content (stored as a blob); null when absent; undefined when unreadable or too large. */
export function snapshotFile(dir: string, file: string): string | null | undefined {
	try {
		const st = fs.statSync(file);
		if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return undefined;
		return storeBlob(dir, fs.readFileSync(file));
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? null : undefined;
	}
}

/** Whether `file` on disk holds snapshot `hash` (null: absent). */
export function fileMatches(dir: string, file: string, hash: string | null): boolean {
	try {
		if (hash === null) return !fs.existsSync(file);
		return fs.existsSync(file) && fs.readFileSync(file).equals(readBlob(dir, hash));
	} catch {
		return false;
	}
}

/** Writes each file's `side` snapshot, deleting files that did not exist; returns the failed paths. */
export function writeSnapshots(dir: string, files: readonly CheckpointFile[], side: "before" | "after"): string[] {
	const failed: string[] = [];
	for (const f of files) {
		const hash = f[side];
		try {
			if (hash === null) fs.rmSync(f.path, { force: true });
			else {
				const content = readBlob(dir, hash);
				fs.mkdirSync(path.dirname(f.path), { recursive: true });
				fs.writeFileSync(f.path, content);
			}
		} catch {
			failed.push(f.path);
		}
	}
	return failed;
}

// ---------- which files a tool call touches ----------

function expand(p: string, cwd: string, home: string): string {
	return path.resolve(cwd, p.startsWith("~/") ? path.join(home, p.slice(2)) : p);
}

function isLocalPath(v: unknown): v is string {
	return typeof v === "string" && v.length > 0 && !v.includes("://");
}

/** Paths an edit tool call may change, read from its arguments (before it runs). */
export function candidatePaths(toolArgs: unknown, cwd: string, home = os.homedir()): string[] {
	const out = new Set<string>();
	const r = rec(toolArgs) ?? {};
	for (const key of ["path", "file", "file_path", "notebook_path", "notebook"]) if (isLocalPath(r[key])) out.add(expand(r[key], cwd, home));
	if (Array.isArray(r.paths)) for (const v of r.paths) if (isLocalPath(v)) out.add(expand(v, cwd, home));
	const input = r.input ?? r.patch;
	if (typeof input === "string") {
		// hashline edit sections `[path#TAG]`, apply_patch headers, hashline moves.
		for (const m of input.matchAll(/^\[([^\]\n#]+)#[0-9A-Za-z]{2,8}\]/gm)) out.add(expand(m[1].trim(), cwd, home));
		for (const m of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.add(expand(m[1].trim(), cwd, home));
		for (const m of input.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.add(expand(m[1].trim(), cwd, home));
		for (const m of input.matchAll(/^MV\s+"?([^"\n]+)"?\s*$/gm)) out.add(expand(m[1].trim(), cwd, home));
	}
	return [...out];
}

/** Paths an edit tool reported in its result details, and the old text it reports per path. */
export function detailPaths(details: unknown, cwd: string, home = os.homedir()): { paths: string[]; oldText: Map<string, string> } {
	const paths = new Set<string>();
	const oldText = new Map<string, string>();
	const visit = (d: unknown) => {
		const r = rec(d);
		if (!r) return;
		for (const key of ["path", "sourcePath", "resolvedPath", "move"]) if (isLocalPath(r[key])) paths.add(expand(r[key], cwd, home));
		if (typeof r.path === "string" && typeof r.oldText === "string") oldText.set(expand(isLocalPath(r.sourcePath) ? r.sourcePath : r.path, cwd, home), r.oldText);
		if (Array.isArray(r.perFileResults)) for (const f of r.perFileResults) visit(f);
	};
	visit(details);
	return { paths: [...paths], oldText };
}

// ---------- transcript entries (omp's session entries, as the extension sees them) ----------

/** A session entry: `{ type, id, parentId, message?, customType?, data? }`. */
export type SessionEntryLike = Record<string, unknown>;

/** A prompt the person sent: a user message omp did not attribute to an agent. */
export function isPromptEntry(entry: SessionEntryLike | undefined): boolean {
	if (entry?.type !== "message") return false;
	const m = rec(entry.message);
	return m?.role === "user" && m.attribution !== "agent";
}

export function messageText(entry: SessionEntryLike): string {
	const content = rec(entry.message)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(b => rec(b))
		.filter(b => b?.type === "text" && typeof b.text === "string")
		.map(b => String(b?.text))
		.join("");
}

function entryTime(entry: SessionEntryLike): number {
	const ts = rec(entry.message)?.timestamp;
	if (typeof ts === "number") return ts;
	const iso = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isFinite(iso) ? iso : 0;
}

/** Id of the prompt the branch's latest entries belong to: the last prompt on it. */
export function currentPrompt(branch: readonly SessionEntryLike[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) if (isPromptEntry(branch[i])) return String(branch[i].id);
	return undefined;
}

/** Every prompt in the transcript (all branches), marking the ones on the current branch. */
export function listPrompts(entries: readonly SessionEntryLike[], branch: readonly SessionEntryLike[], changes: readonly FileChange[]): CheckpointPrompt[] {
	const onBranch = new Set(branch.map(e => String(e.id)));
	const files = new Map<string, Set<string>>();
	for (const c of changes) {
		if (!c.prompt) continue;
		const set = files.get(c.prompt) ?? new Set<string>();
		for (const f of c.files) set.add(f.path);
		files.set(c.prompt, set);
	}
	return entries.filter(isPromptEntry).map(e => {
		const id = String(e.id);
		return { id, text: messageText(e).slice(0, 500), at: entryTime(e), active: onBranch.has(id), files: files.get(id)?.size ?? 0 };
	});
}

/** Entries that carry conversation; any other entry (omp's `session_exit`, model changes, labels) is metadata. */
const CONTENT_ENTRIES: Record<string, true> = { message: true, custom_message: true, compaction: true, branch_summary: true };

/**
 * The redo stack in effect at the end of `branch` (root to leaf): the latest checkpoint marker's,
 * unless conversation was added after it (a new prompt ends the redo history). Metadata omp appends
 * on its own, such as the `session_exit` entry of a restart, does not.
 */
export function redoStack(branch: readonly SessionEntryLike[]): RedoEntry[] {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === MARKER_TYPE) {
			const data = rec(entry.data);
			return Array.isArray(data?.redo) ? (data.redo as RedoEntry[]) : [];
		}
		if (CONTENT_ENTRIES[String(entry.type)]) return [];
	}
	return [];
}

// ---------- planning ----------

/**
 * Files to put back when undoing the prompts `prompts` (and every edit made for them): each file
 * changed by their calls, at its content before the first such change and after the last.
 * Files that end where they started are left alone.
 */
export function planRestore(changes: readonly FileChange[], prompts: ReadonlySet<string>): CheckpointFile[] {
	const files = new Map<string, CheckpointFile>();
	const ordered = changes.filter(c => c.prompt && prompts.has(c.prompt)).sort((a, b) => a.timestamp - b.timestamp);
	for (const change of ordered) {
		for (const f of change.files) {
			const known = files.get(f.path);
			if (known) known.after = f.after;
			else files.set(f.path, { path: f.path, before: f.before, after: f.after });
		}
	}
	return [...files.values()].filter(f => f.before !== f.after);
}

/** What `/undo [prompt id]` rewinds: the target prompt and every later prompt on the branch. */
export function undoTarget(branch: readonly SessionEntryLike[], promptId?: string): { prompt: SessionEntryLike; rewound: Set<string> } | undefined {
	const index = promptId ? branch.findIndex(e => e.id === promptId && isPromptEntry(e)) : branch.findLastIndex(e => isPromptEntry(e));
	if (index < 0) return undefined;
	const rewound = new Set(branch.slice(index).filter(isPromptEntry).map(e => String(e.id)));
	return { prompt: branch[index], rewound };
}

// ---------- AO turns ----------

/** Whether an AO turn's prompt is one of the checkpoint commands (`/undo`, `/redo [...]`). */
export function isCheckpointCommand(text: string): boolean {
	const m = /^\/([a-z]+)(?:\s|$)/.exec(text.trim());
	return !!m && (CHECKPOINT_COMMANDS as readonly string[]).includes(m[1]);
}

export interface TurnLike {
	id: string;
	/** The person's prompt text. */
	text: string;
	/** Epoch ms the turn started (or was requested). */
	at: number;
}

/** The person's prompts in an AO conversation: each turn's first human message. */
export function aoTurns(conversation: AoConversation): TurnLike[] {
	const text = new Map<string, string>();
	for (const m of conversation.messages) if (m.kind === "message" && m.role === "user" && m.turnId && !text.has(m.turnId)) text.set(m.turnId, m.text);
	return conversation.turns.flatMap(t => {
		const prompt = text.get(t.id);
		return prompt === undefined ? [] : [{ id: t.id, text: prompt, at: Date.parse(t.startedAt ?? t.requestedAt ?? "") || 0 }];
	});
}

export type TurnStatus = "undone" | "command";

/** How far apart AO's turn start and omp's prompt record can be and still be the same prompt. */
const MATCH_WINDOW_MS = 120_000;

/**
 * AO keeps every turn in its timeline; omp's transcript is the truth about the prompts. Each AO turn
 * is matched to omp's record of the same prompt: same text, closest in time (a prompt resent after
 * undoing it matches its own turn). Turns that never reached omp, and `/undo` / `/redo`, match none.
 */
export function matchTurns(turns: readonly TurnLike[], prompts: readonly CheckpointPrompt[]): Map<string, CheckpointPrompt> {
	const pairs: Array<{ turn: TurnLike; prompt: CheckpointPrompt; dt: number }> = [];
	for (const turn of turns) {
		if (isCheckpointCommand(turn.text)) continue;
		const text = turn.text.trim();
		for (const prompt of prompts) {
			const p = prompt.text.trim();
			// The state keeps 500 characters of each prompt.
			if (p !== text && !(prompt.text.length >= 500 && text.startsWith(p))) continue;
			const dt = Math.abs(turn.at - prompt.at);
			if (dt <= MATCH_WINDOW_MS) pairs.push({ turn, prompt, dt });
		}
	}
	pairs.sort((a, b) => a.dt - b.dt);
	const out = new Map<string, CheckpointPrompt>();
	const usedPrompts = new Set<string>();
	for (const { turn, prompt } of pairs) {
		if (out.has(turn.id) || usedPrompts.has(prompt.id)) continue;
		out.set(turn.id, prompt);
		usedPrompts.add(prompt.id);
	}
	return out;
}

/**
 * Which AO turns a client should not show as live conversation: `undone` when the matched prompt is
 * off omp's current branch, `command` for `/undo` and `/redo` themselves. Others are left out.
 */
export function turnStatuses(turns: readonly TurnLike[], prompts: readonly CheckpointPrompt[]): Map<string, TurnStatus> {
	const out = new Map<string, TurnStatus>();
	for (const turn of turns) if (isCheckpointCommand(turn.text)) out.set(turn.id, "command");
	for (const [turnId, prompt] of matchTurns(turns, prompts)) if (!prompt.active) out.set(turnId, "undone");
	return out;
}
