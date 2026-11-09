// omp's own todo plan (phases → tasks) for sessions AO runs. AO keeps only a flattened, per-turn
// copy of it (GAPS.md G2), so the Switchyard omp extension `src/omp-extension/todos.ts` mirrors omp's
// state to `<switchyard home>/sessions/<AO session id>/todos.json` (beside `omp.json` and
// `checkpoints/`), and clients edit it by sending omp's own `/todo import <file>` with the phases as
// omp's Markdown checklist.
// Formats follow omp's `tools/todo.ts` (`phasesToMarkdown`, `canonicalTodoPhases`). Node-only (fs).
import * as fs from "node:fs";
import * as path from "node:path";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** Why a blocked task is blocked. */
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

/** What the omp extension writes. */
export interface TodoMirror {
	aoSessionId: string;
	/** omp's own session id (changes when omp switches transcripts). */
	ompSessionId?: string;
	/** Epoch ms of the write. */
	updatedAt: number;
	phases: TodoPhase[];
}

const STATUSES: Record<TodoStatus, string> = { pending: " ", in_progress: "/", completed: "x", abandoned: "-", blocked: "!" };
/** omp's custom entry type for todos edited by `/todo` commands (tools/todo.ts USER_TODO_EDIT_CUSTOM_TYPE). */
const USER_TODO_EDIT = "user_todo_edit";

function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Well-formed phases, or undefined when `raw` isn't a phase list. Unknown statuses read as pending. */
export function normalizePhases(raw: unknown): TodoPhase[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: TodoPhase[] = [];
	for (const p of raw) {
		const r = rec(p);
		if (!r || typeof r.name !== "string" || !Array.isArray(r.tasks)) continue;
		const tasks: TodoItem[] = [];
		for (const t of r.tasks) {
			const tr = rec(t);
			if (!tr || typeof tr.content !== "string" || !tr.content.trim()) continue;
			const status = typeof tr.status === "string" && tr.status in STATUSES ? (tr.status as TodoStatus) : "pending";
			const item: TodoItem = { content: tr.content, status };
			if (status === "blocked" && typeof tr.blocker === "string" && tr.blocker) item.blocker = tr.blocker;
			tasks.push(item);
		}
		out.push({ name: r.name, tasks });
	}
	return out;
}

/** Todo phases a transcript entry records (a `todo` tool result or a `/todo` edit), else undefined. */
function entryPhases(entry: unknown): TodoPhase[] | undefined {
	const e = rec(entry);
	if (!e) return undefined;
	if (e.type === "custom" && e.customType === USER_TODO_EDIT) return normalizePhases(rec(e.data)?.phases);
	if (e.type !== "message") return undefined;
	const m = rec(e.message);
	if (m?.role !== "toolResult" || m.toolName !== "todo" || m.isError === true) return undefined;
	const details = rec(m.details);
	if (details?.op === "view") return undefined;
	return normalizePhases(details?.phases);
}

/** omp's current todo phases on a branch (entries oldest first): the latest snapshot wins; none → []. */
export function latestTodoPhases(entries: readonly unknown[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = entryPhases(entries[i]);
		if (phases) return phases;
	}
	return [];
}

/** omp's Markdown checklist (what `/todo import` reads back). */
export function phasesToMarkdown(phases: readonly TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	phases.forEach((phase, i) => {
		if (i > 0) out.push("");
		out.push(`# ${oneLine(phase.name) || "Todos"}`);
		for (const task of phase.tasks) {
			const note = task.status === "blocked" && task.blocker ? ` <!-- blocker: ${oneLine(task.blocker).replace(/-->/g, "—>")} -->` : "";
			out.push(`- [${STATUSES[task.status]}] ${oneLine(task.content)}${note}`);
		}
	});
	return `${out.join("\n")}\n`;
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** AO session ids are slugs (`project-3`, `standalone-1`); anything else can't name a folder. */
function safeId(id: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith(".")) throw new Error(`unexpected AO session id: ${id}`);
	return id;
}

/** The session's Switchyard folder (`<switchyard home>/sessions/<AO session id>`). */
export function todoSessionDir(home: string, aoSessionId: string): string {
	return path.join(home, "sessions", safeId(aoSessionId));
}

export function todoMirrorFile(home: string, aoSessionId: string): string {
	return path.join(todoSessionDir(home, aoSessionId), "todos.json");
}

/** Where a client writes the Markdown it asks omp to `/todo import`. */
export function todoImportFile(home: string, aoSessionId: string): string {
	return path.join(todoSessionDir(home, aoSessionId), "todos.import.md");
}

export function readTodoMirror(file: string): TodoMirror | undefined {
	try {
		const r = rec(JSON.parse(fs.readFileSync(file, "utf8")));
		const phases = normalizePhases(r?.phases);
		if (!r || typeof r.aoSessionId !== "string" || !phases) return undefined;
		return { aoSessionId: r.aoSessionId, ompSessionId: typeof r.ompSessionId === "string" ? r.ompSessionId : undefined, updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0, phases };
	} catch {
		return undefined;
	}
}

/** Atomic write (temp file + rename), creating the folder. */
export function writeFileAtomic(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}

/** The text a client sends to the session so omp replaces its todos with `phases`. */
export function todoImportCommand(file: string): string {
	return `/todo import ${file}`;
}
