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
// - `omp.json` records omp's own session id and transcript (GAPS.md G9).
// It works whichever client drives the omp of an AO session (AO's chat through `omp acp`, AO's
// terminal mode, `omp --resume` with AO_SESSION_ID set) and does nothing without AO_SESSION_ID
// (MAPPING.md D6): a person's own omp sessions are left alone.
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
	applyFileRestore,
	candidatePaths,
	currentPrompt,
	detailPaths,
	isPromptEntry,
	listPrompts,
	messageText,
	planFileRestore,
	planRestore,
	readChanges,
	readState,
	redoStack,
	snapshotFile,
	storeBlob,
	undoTarget,
	writeFileAtomic,
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
	prompt: string | undefined;
	before: Map<string, string | null>;
	at: number;
}

// Module state is shared by every session this process binds the extension to (main and subagents).
/** The main session: subagents' edits count for its current prompt. */
let mainSession: SessionManagerLike | undefined;
/** Before-snapshots of running edit calls, by tool call id. */
const pending = new Map<string, PendingCall>();

function listNames(paths: readonly string[], cwd: string): string {
	const names = paths.map(p => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p));
	return names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ");
}

export default function switchyardCheckpoints(pi: ExtensionApiLike): void {
	const aoSessionId = process.env.AO_SESSION_ID?.trim();
	if (!aoSessionId) return;
	const dir = aoCheckpointDir(aoSessionId);
	const warn = (message: string, err: unknown) => pi.logger?.warn(`switchyard checkpoints: ${message}`, { error: String(err) });

	/** The session whose prompts a call in `ctx` belongs to. */
	const ownerOf = (ctx: ContextLike) => (ctx.agent?.kind === "sub" ? mainSession : ctx.sessionManager);

	/** Rewrites state.json. */
	const syncState = (sm: SessionManagerLike, last?: CheckpointResult) => {
		try {
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

	/** Records omp's own session id and transcript (AO keeps them internal; GAPS.md G9, src/ao/native.ts). */
	const recordNative = (sm: SessionManagerLike) => {
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
			const before = new Map<string, string | null>();
			for (const p of candidatePaths(event.input, ctx.cwd)) {
				const hash = snapshotFile(dir, p);
				if (hash !== undefined) before.set(p, hash);
			}
			pending.set(event.toolCallId, { prompt: currentPrompt(sm.getBranch()), before, at: Date.now() });
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
				const before = old !== undefined ? storeBlob(dir, Buffer.from(old)) : call.before.get(p);
				const after = snapshotFile(dir, p);
				if (after === undefined || before === undefined || before === after) continue;
				files.push({ path: p, op: before === null ? "create" : after === null ? "delete" : "update", before, after });
			}
			if (!files.length) return;
			const change: FileChange = { toolCallId: event.toolCallId, toolName: event.toolName, timestamp: Date.now(), files, prompt: call.prompt, ompSession: sm.getSessionId() };
			appendChange(dir, change);
		} catch (err) {
			warn("after-snapshot failed", err);
		}
	});

	/** Tells the person (TUI) and records the outcome for clients that cannot see omp's notices (ACP). */
	const report = (ctx: ContextLike, result: Omit<CheckpointResult, "at">) => {
		ctx.ui.notify(result.message, result.ok && !result.failed.length && !(result.forced && result.conflicts.length) ? "info" : "warning");
		syncState(ctx.sessionManager, { ...result, at: Date.now() });
	};

	/**
	 * The file side of an undo (`to: "before"`) or redo. Later changes to the files are kept by a
	 * 3-way merge; overlapping ones are conflicts, overwritten only with `--force` (or, in the TUI,
	 * when the person says so). Undefined `plan` = refused because of conflicts.
	 */
	const restoreFor = async (ctx: ContextLike, files: readonly CheckpointFile[], to: "before" | "after", force: boolean, title: string) => {
		const plan = planFileRestore(dir, files, to, force);
		if (!plan.conflicts.length || force) return { plan, forced: force, conflicts: plan.conflicts };
		const ask = ctx.mode === "tui" && ctx.hasUI && (await ctx.ui.confirm(title, `Changed since omp wrote them, overlapping its edits: ${listNames(plan.conflicts, ctx.cwd)}. Overwrite them?`));
		return ask ? { plan: planFileRestore(dir, files, to, true), forced: true, conflicts: plan.conflicts } : { plan: undefined, forced: false, conflicts: plan.conflicts };
	};

	const outcome = (files: readonly CheckpointFile[], failed: string[], merged: string[], cwd: string) => {
		const restored = files.map(f => f.path).filter(p => !failed.includes(p));
		const text = `${merged.length ? ` Kept the later changes to ${listNames(merged, cwd)}.` : ""}${failed.length ? ` Could not write ${listNames(failed, cwd)}.` : ""}`;
		return { restored, text };
	};

	/** `--force` and the remaining argument of a command line. */
	const parseArgs = (args: string) => {
		const words = args.trim().split(/\s+/).filter(Boolean);
		return { force: words.includes("--force"), rest: words.filter(w => w !== "--force").join(" ") || undefined };
	};

	pi.registerCommand("undo", {
		description: "Undo the last prompt: rewind the conversation to before it and put back the files omp's edits changed since (/redo brings both back)",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) await ctx.waitForIdle();
			const sm = ctx.sessionManager;
			const { force, rest } = parseArgs(args);
			const fail = (message: string, conflicts: string[] = []) => report(ctx, { op: "undo", ok: false, message, restored: [], failed: [], merged: [], conflicts });
			const branch = sm.getBranch();
			const target = undoTarget(branch, rest);
			if (!target) return fail(rest ? "That prompt is not on the current branch: nothing undone." : "Nothing to undo: no prompt on the current branch.");
			const leaf = sm.getLeafId();
			if (!leaf) return fail("Nothing to undo.");
			const prompt = messageText(target.prompt);
			const files = planRestore(readChanges(dir), target.rewound);
			const { plan, forced, conflicts } = await restoreFor(ctx, files, "before", force, "Undo the last prompt?");
			if (!plan) return fail(`Nothing undone: ${listNames(conflicts, ctx.cwd)} changed since omp edited them, and the changes overlap. /undo --force${rest ? ` ${rest}` : ""} overwrites them.`, conflicts);
			const nav = await ctx.navigateTree(String(target.prompt.id));
			if (nav.cancelled) return fail("omp cancelled the rewind: nothing undone.");
			const failed = applyFileRestore(plan);
			const marker: MarkerData = { v: 1, op: "undo", redo: [...redoStack(branch), { leaf, prompt, files }] };
			pi.appendEntry(MARKER_TYPE, marker);
			const { restored, text } = outcome(files, failed, plan.merged, ctx.cwd);
			report(ctx, {
				op: "undo",
				ok: true,
				prompt,
				restored,
				failed,
				merged: plan.merged,
				conflicts: forced ? conflicts : [],
				forced,
				message: `Undone: the conversation is back to before that prompt${restored.length ? `; restored ${listNames(restored, ctx.cwd)}` : "; no file edits to revert"}.${text}${forced && conflicts.length ? ` Overwrote ${listNames(conflicts, ctx.cwd)}.` : ""} /redo brings it back.`,
			});
		},
	});

	pi.registerCommand("redo", {
		description: "Redo what the last /undo removed: the conversation and the files",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) await ctx.waitForIdle();
			const sm = ctx.sessionManager;
			const { force } = parseArgs(args);
			const fail = (message: string, conflicts: string[] = []) => report(ctx, { op: "redo", ok: false, message, restored: [], failed: [], merged: [], conflicts });
			const stack = redoStack(sm.getBranch());
			const top = stack.at(-1);
			if (!top) return fail("Nothing to redo.");
			const target = sm.getEntry(top.leaf);
			if (!target) return fail("The undone conversation is gone from the transcript: nothing redone.");
			const { plan, forced, conflicts } = await restoreFor(ctx, top.files, "after", force, "Redo?");
			if (!plan) return fail(`Nothing redone: ${listNames(conflicts, ctx.cwd)} changed since the undo, and the changes overlap. /redo --force overwrites them.`, conflicts);
			// Navigating onto a prompt rewinds past it, so a prompt that never got a reply comes back as files only.
			const nav = await ctx.navigateTree(top.leaf);
			if (nav.cancelled) return fail("omp cancelled the navigation: nothing redone.");
			const failed = applyFileRestore(plan);
			const marker: MarkerData = { v: 1, op: "redo", redo: stack.slice(0, -1) };
			pi.appendEntry(MARKER_TYPE, marker);
			const { restored, text } = outcome(top.files, failed, plan.merged, ctx.cwd);
			report(ctx, {
				op: "redo",
				ok: true,
				restored,
				failed,
				merged: plan.merged,
				conflicts: forced ? conflicts : [],
				forced,
				message: `Redone: the conversation is back${restored.length ? ` and so are ${listNames(restored, ctx.cwd)}` : ""}.${isPromptEntry(target) ? " (The prompt had no reply, so only its files came back.)" : ""}${text}${forced && conflicts.length ? ` Overwrote ${listNames(conflicts, ctx.cwd)}.` : ""}`,
			});
		},
	});
}
