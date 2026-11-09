// omp extension shipped by Switchyard: checkpoints. Every prompt is one.
// - Snapshots: `tool_call` stores the content of every file an edit tool (edit, write, ast_edit,
//   notebook, apply_patch) is about to change, `tool_result` the content after, as one line of
//   `changes.jsonl` tagged with the prompt the call belongs to (subagents' calls count for the
//   main session's prompt).
// - `/undo [prompt entry id]` rewinds the conversation to before the last prompt (or that one) with
//   omp's tree navigation, which keeps the same transcript and session id (so AO's `session/load`
//   still finds it), and writes back every file those prompts' edits changed. A marker entry
//   (`switchyard.checkpoint`, not part of the model's context) is appended so the rewound position
//   survives a reload; it carries the redo stack.
// - `/redo` navigates back to where the undo started, rewrites the files, and appends a new marker.
//   Any new entry after the marker (a prompt, a compaction) ends the redo history.
// - `state.json` mirrors the prompts and the redo stack for clients (see src/shared/checkpoints.ts).
// - For AO sessions, `omp.json` records omp's own session id and transcript (GAPS.md G9).
// It works whichever client drives omp: the TUI, `omp acp` under AO, RPC.
import * as fs from "node:fs";
import * as path from "node:path";
import { type AoNativeSession, nativeSessionFile } from "../ao/native";
import {
	type CheckpointFile,
	type CheckpointResult,
	type FileChange,
	type FileChangeEntry,
	MARKER_TYPE,
	type MarkerData,
	type SessionEntryLike,
	aoCheckpointDir,
	appendChange,
	candidatePaths,
	currentPrompt,
	detailPaths,
	fileMatches,
	isPromptEntry,
	listPrompts,
	messageText,
	ompCheckpointDir,
	planRestore,
	readChanges,
	readState,
	redoStack,
	snapshotFile,
	storeBlob,
	undoTarget,
	writeFileAtomic,
	writeSnapshots,
	writeState,
} from "../shared/checkpoints";
import { EDIT_TOOLS } from "../shared/permissions";

/** The slice of omp's extension API this module uses (types only; omp passes the real objects). */
interface SessionManagerLike {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getCwd(): string;
	getLeafId(): string | null;
	getEntry(id: string): SessionEntryLike | undefined;
	getBranch(): SessionEntryLike[];
	getEntries(): SessionEntryLike[];
}
interface ContextLike {
	cwd: string;
	mode?: string;
	hasUI?: boolean;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void; confirm(title: string, message: string): Promise<boolean> };
	sessionManager: SessionManagerLike;
	agent?: { kind: "main" | "sub" };
	isIdle(): boolean;
}
interface CommandContextLike extends ContextLike {
	waitForIdle(): Promise<void>;
	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
}
interface ToolEventLike {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	details?: unknown;
}
interface ExtensionApiLike {
	on(event: string, handler: (event: never, ctx: ContextLike) => unknown): void;
	registerCommand(name: string, options: { description: string; handler: (args: string, ctx: CommandContextLike) => Promise<void> }): void;
	appendEntry(customType: string, data: unknown): void;
	logger?: { warn(message: string, meta?: unknown): void };
}

interface PendingCall {
	dir: string;
	prompt: string | undefined;
	before: Map<string, string | null>;
	at: number;
}

// Module state is shared by every session this process binds the extension to (main and subagents).
/** The main session: subagents' edits count for its current prompt. */
let mainSession: SessionManagerLike | undefined;
/** Before-snapshots of running edit calls, by tool call id. */
const pending = new Map<string, PendingCall>();

function storeDir(sm: SessionManagerLike): string {
	const ao = process.env.AO_SESSION_ID?.trim();
	return ao ? aoCheckpointDir(ao) : ompCheckpointDir(sm.getSessionId());
}

function listNames(paths: readonly string[], cwd: string): string {
	const names = paths.map(p => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p));
	return names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ");
}

export default function switchyardCheckpoints(pi: ExtensionApiLike): void {
	const warn = (message: string, err: unknown) => pi.logger?.warn(`switchyard checkpoints: ${message}`, { error: String(err) });

	/** The session whose prompts a call in `ctx` belongs to. */
	const ownerOf = (ctx: ContextLike) => (ctx.agent?.kind === "sub" ? mainSession : ctx.sessionManager);

	/** Rewrites state.json; omp sessions AO did not start get a store only once they edit a file. */
	const syncState = (sm: SessionManagerLike, last?: CheckpointResult) => {
		try {
			const dir = storeDir(sm);
			if (!process.env.AO_SESSION_ID && !fs.existsSync(dir)) return;
			const changes = readChanges(dir);
			writeState(dir, {
				version: 1,
				ompSessionId: sm.getSessionId(),
				sessionFile: sm.getSessionFile(),
				cwd: sm.getCwd(),
				updatedAt: Date.now(),
				prompts: listPrompts(sm.getEntries(), sm.getBranch(), changes),
				redo: redoStack(sm.getBranch())
					.toReversed()
					.map(e => ({ prompt: e.prompt.slice(0, 500), files: e.files })),
				last: last ?? readState(dir)?.last,
			});
		} catch (err) {
			warn("could not write state.json", err);
		}
	};

	/** For AO sessions, records omp's own session id and transcript (AO keeps them internal; GAPS.md G9, src/ao/native.ts). */
	const recordNative = (sm: SessionManagerLike) => {
		const aoSessionId = process.env.AO_SESSION_ID?.trim();
		if (!aoSessionId) return;
		try {
			const file = nativeSessionFile(aoSessionId);
			const record: AoNativeSession = { aoSessionId, ompSessionId: sm.getSessionId(), sessionFile: sm.getSessionFile(), cwd: sm.getCwd() };
			const content = `${JSON.stringify(record)}\n`;
			if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomic(file, content);
		} catch (err) {
			warn("could not record the omp session", err);
		}
	};

	const onSession = (_event: never, ctx: ContextLike) => {
		if (ctx.agent?.kind === "sub") return;
		mainSession = ctx.sessionManager;
		recordNative(ctx.sessionManager);
		syncState(ctx.sessionManager);
	};
	pi.on("session_start", onSession);
	pi.on("session_switch", onSession);
	pi.on("session_branch", onSession);
	pi.on("session_tree", onSession);
	pi.on("agent_end", (event: never, ctx) => {
		// Calls a hook or the approval gate blocked never reach tool_result; background subagents may still run.
		for (const [id, call] of pending) if (Date.now() - call.at > 600_000) pending.delete(id);
		onSession(event, ctx);
	});

	pi.on("tool_call", (event: ToolEventLike, ctx) => {
		// Never throws and never returns a value: a failing tool_call handler would block the edit.
		try {
			if (!EDIT_TOOLS[event.toolName] || pending.has(event.toolCallId)) return;
			const sm = ownerOf(ctx);
			if (!sm) return;
			const dir = storeDir(sm);
			const before = new Map<string, string | null>();
			for (const p of candidatePaths(event.input, ctx.cwd)) {
				const hash = snapshotFile(dir, p);
				if (hash !== undefined) before.set(p, hash);
			}
			pending.set(event.toolCallId, { dir, prompt: currentPrompt(sm.getBranch()), before, at: Date.now() });
		} catch (err) {
			warn("before-snapshot failed", err);
		}
	});

	pi.on("tool_result", (event: ToolEventLike, ctx) => {
		try {
			if (!EDIT_TOOLS[event.toolName]) return;
			const call = pending.get(event.toolCallId);
			pending.delete(event.toolCallId);
			const sm = ownerOf(ctx);
			if (!call || !sm) return;
			const fromDetails = detailPaths(event.details, ctx.cwd);
			const files: FileChangeEntry[] = [];
			for (const p of new Set([...call.before.keys(), ...fromDetails.paths])) {
				// omp's own oldText is authoritative when present; the snapshot covers everything else.
				const old = fromDetails.oldText.get(p);
				const before = old !== undefined ? storeBlob(call.dir, Buffer.from(old)) : call.before.get(p);
				const after = snapshotFile(call.dir, p);
				if (after === undefined || before === undefined || before === after) continue;
				files.push({ path: p, op: before === null ? "create" : after === null ? "delete" : "update", before, after });
			}
			if (!files.length) return;
			const change: FileChange = { toolCallId: event.toolCallId, toolName: event.toolName, timestamp: Date.now(), files, prompt: call.prompt, ompSession: sm.getSessionId() };
			appendChange(call.dir, change);
		} catch (err) {
			warn("after-snapshot failed", err);
		}
	});

	/** Tells the person (TUI) and records the outcome for clients that cannot see omp's notices (ACP). */
	const report = (ctx: ContextLike, result: Omit<CheckpointResult, "at">) => {
		ctx.ui.notify(result.message, result.ok ? (result.failed.length || result.overwritten.length ? "warning" : "info") : "warning");
		syncState(ctx.sessionManager, { ...result, at: Date.now() });
	};

	/** In the TUI, asks before overwriting files changed since omp wrote them; other clients ask before sending. */
	const confirmOverwrite = async (ctx: ContextLike, title: string, paths: string[]) =>
		!paths.length || ctx.mode !== "tui" || !ctx.hasUI || (await ctx.ui.confirm(title, `Changed since omp last wrote them (your edits are overwritten): ${listNames(paths, ctx.cwd)}.`));

	pi.registerCommand("undo", {
		description: "Undo the last prompt: rewind the conversation to before it and put back the files omp's edits changed since (/redo brings both back)",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) await ctx.waitForIdle();
			const sm = ctx.sessionManager;
			const dir = storeDir(sm);
			const fail = (message: string) => report(ctx, { op: "undo", ok: false, message, restored: [], failed: [], overwritten: [] });
			const branch = sm.getBranch();
			const target = undoTarget(branch, args.trim() || undefined);
			if (!target) return fail(args.trim() ? "That prompt is not on the current branch: nothing undone." : "Nothing to undo: no prompt on the current branch.");
			const leaf = sm.getLeafId();
			if (!leaf) return fail("Nothing to undo.");
			const prompt = messageText(target.prompt);
			const files = planRestore(readChanges(dir), target.rewound);
			const overwritten = files.filter(f => !fileMatches(dir, f.path, f.after)).map(f => f.path);
			if (!(await confirmOverwrite(ctx, "Undo the last prompt?", overwritten))) return;
			const nav = await ctx.navigateTree(String(target.prompt.id));
			if (nav.cancelled) return fail("omp cancelled the rewind: nothing undone.");
			const failed = writeSnapshots(dir, files, "before");
			const marker: MarkerData = { v: 1, op: "undo", redo: [...redoStack(branch), { leaf, prompt, files }] };
			pi.appendEntry(MARKER_TYPE, marker);
			const restored = files.map(f => f.path).filter(p => !failed.includes(p));
			report(ctx, {
				op: "undo",
				ok: true,
				prompt,
				restored,
				failed,
				overwritten,
				message: `Undone: the conversation is back to before that prompt${restored.length ? `; restored ${listNames(restored, ctx.cwd)}` : "; no file edits to revert"}.${failed.length ? ` Could not write ${listNames(failed, ctx.cwd)}.` : ""} /redo brings it back.`,
			});
		},
	});

	pi.registerCommand("redo", {
		description: "Redo what the last /undo removed: the conversation and the files",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) await ctx.waitForIdle();
			const sm = ctx.sessionManager;
			const dir = storeDir(sm);
			const fail = (message: string) => report(ctx, { op: "redo", ok: false, message, restored: [], failed: [], overwritten: [] });
			const stack = redoStack(sm.getBranch());
			const top = stack.at(-1);
			if (!top) return fail("Nothing to redo.");
			const target = sm.getEntry(top.leaf);
			if (!target) return fail("The undone conversation is gone from the transcript: nothing redone.");
			const files: CheckpointFile[] = top.files;
			const overwritten = files.filter(f => !fileMatches(dir, f.path, f.before)).map(f => f.path);
			if (!(await confirmOverwrite(ctx, "Redo?", overwritten))) return;
			// Navigating onto a prompt rewinds past it, so a prompt that never got a reply comes back as files only.
			const nav = await ctx.navigateTree(top.leaf);
			if (nav.cancelled) return fail("omp cancelled the navigation: nothing redone.");
			const failed = writeSnapshots(dir, files, "after");
			const marker: MarkerData = { v: 1, op: "redo", redo: stack.slice(0, -1) };
			pi.appendEntry(MARKER_TYPE, marker);
			const restored = files.map(f => f.path).filter(p => !failed.includes(p));
			report(ctx, {
				op: "redo",
				ok: true,
				restored,
				failed,
				overwritten,
				message: `Redone: the conversation is back${restored.length ? ` and so are ${listNames(restored, ctx.cwd)}` : ""}.${isPromptEntry(target) ? " (The prompt had no reply, so only its files came back.)" : ""}${failed.length ? ` Could not write ${listNames(failed, ctx.cwd)}.` : ""}`,
			});
		},
	});
}
