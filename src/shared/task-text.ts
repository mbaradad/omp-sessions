// Text formats around the task queue: markdown checklists (import/export), TODO/FIXME comments,
// and human start times ("22:00", "in 90m", "tomorrow 9:00"). Pure; no vscode, no fs.
import type { QueueTaskOptions, TaskQueue } from "./protocol";

/** Short badges for a task's options: model id, thinking, fresh, retries, time limit. */
export function describeOptions(o: QueueTaskOptions | undefined): string[] {
	if (!o) return [];
	return [
		o.model ? `⚙ ${o.model.slice(o.model.indexOf("/") + 1)}` : "",
		o.thinking ? `🧠 ${o.thinking}` : "",
		o.freshContext ? "✦ fresh" : "",
		o.retries ? `↻×${o.retries}` : "",
		o.timeoutMinutes ? `⏱ ${o.timeoutMinutes}m` : "",
	].filter(Boolean);
}

export interface ParsedTask {
	title: string;
	done: boolean;
	notes?: string;
	subtasks: Array<{ title: string; done: boolean }>;
}

const CHECKBOX = /^([ \t]*)[-*+] \[([ xX])\][ \t]+(.*\S)[ \t]*$/;

function indentOf(line: string): number {
	let n = 0;
	for (const ch of line) {
		if (ch === " ") n++;
		else if (ch === "\t") n += 4;
		else break;
	}
	return n;
}

/** Strips up to `n` columns of leading whitespace (tabs count 4). */
function dedent(line: string, n: number): string {
	let col = 0;
	let i = 0;
	while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) {
		col += line[i] === "\t" ? 4 : 1;
		i++;
	}
	return line.slice(i);
}

/**
 * Markdown checklist → tasks. `- [ ] x` lines start tasks; checkbox lines indented under a task
 * become its subtasks (deeper levels flattened); other lines indented under a task become its
 * notes. `[x]` marks done. Anything else (headings, prose, plain bullets at task level) is ignored.
 */
export function parseMarkdownTasks(text: string): ParsedTask[] {
	const tasks: ParsedTask[] = [];
	let current: { task: ParsedTask; indent: number; notes: string[]; noteIndent: number } | undefined;
	const close = () => {
		if (!current) return;
		while (current.notes.length && !current.notes[current.notes.length - 1].trim()) current.notes.pop();
		if (current.notes.length) current.task.notes = current.notes.join("\n");
		tasks.push(current.task);
		current = undefined;
	};
	// Status markers written by queueToMarkdown (`<!-- failed -->`) aren't part of the title.
	const titleOf = (raw: string) => raw.replace(/\s*<!--.*?-->\s*/g, " ").trim();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) {
			// Blank lines inside a task's notes are kept; trailing ones are trimmed on close.
			if (current?.notes.length) current.notes.push("");
			continue;
		}
		const indent = indentOf(line);
		const m = CHECKBOX.exec(line);
		if (current && indent > current.indent) {
			if (m) {
				if (titleOf(m[3])) current.task.subtasks.push({ title: titleOf(m[3]), done: m[2] !== " " });
			} else {
				if (!current.notes.length) current.noteIndent = indent;
				current.notes.push(dedent(line, Math.min(indent, current.noteIndent)).trimEnd());
			}
			continue;
		}
		close();
		if (m && titleOf(m[3])) current = { task: { title: titleOf(m[3]), done: m[2] !== " ", subtasks: [] }, indent, notes: [], noteIndent: 0 };
	}
	close();
	return tasks;
}

/** Queue → markdown checklist that `parseMarkdownTasks` reads back (done ⇔ `[x]`). */
export function queueToMarkdown(queue: TaskQueue, heading?: string): string {
	const out: string[] = [];
	if (heading) out.push(`# ${heading}`, "");
	for (const t of queue.tasks) {
		const mark = t.status === "done" || t.status === "skipped" ? "x" : " ";
		const status = t.status === "failed" || t.status === "skipped" || t.status === "running" ? ` <!-- ${t.status} -->` : "";
		out.push(`- [${mark}] ${t.title}${status}`);
		for (const s of t.subtasks) out.push(`  - [${s.done ? "x" : " "}] ${s.title}`);
		if (t.notes) for (const l of t.notes.split("\n")) out.push(l.trim() ? `  ${l}` : "");
	}
	return `${out.join("\n")}\n`;
}

export interface TodoComment {
	/** 0-based line. */
	line: number;
	tag: "TODO" | "FIXME";
	text: string;
}

const TODO = /\b(TODO|FIXME)(?:\([^)\n]*\))?:[ \t]*(.*)$/;

/** `TODO:` / `FIXME:` (optionally `TODO(name):`) comments with non-empty text. */
export function findTodoComments(text: string): TodoComment[] {
	const out: TodoComment[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const m = TODO.exec(lines[i]);
		if (!m) continue;
		// Drop comment closers and decoration that trail the text.
		const body = m[2].replace(/\s*(\*\/|-->|#>|\*\)|%>)\s*$/, "").trim();
		if (body) out.push({ line: i, tag: m[1] === "FIXME" ? "FIXME" : "TODO", text: body });
	}
	return out;
}

/** Compact local label: "22:00", "tomorrow 09:00", "Sat 7 Nov 09:00". */
export function formatStartTime(at: number, now = new Date()): string {
	const d = new Date(at);
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
	if (dayDiff === 0) return hm;
	if (dayDiff === 1) return `tomorrow ${hm}`;
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${hm}`;
}

/**
 * Why queued work is held, with when it lifts: "rate-limit anthropic until 14:05", "budget day 21.50/20 USD until 18:30",
 * "retry backoff until 14:05". Reasons that already name the time (limits, usage windows) don't repeat it.
 */
export function holdText(reason: string | undefined, until: number | undefined, now = new Date()): string {
	const why = reason || "held";
	return until && !/\buntil\b/.test(why) ? `${why} until ${formatStartTime(until, now)}` : why;
}

/** "1m 05s", "2h 03m", "12s". */
export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
