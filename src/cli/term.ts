// Terminal output helpers for `switchyard`: ANSI colors (off for NO_COLOR, non-TTY, TERM=dumb or
// --no-color), width-aware truncation, relative times, prompts. Node built-ins only.
import * as readline from "node:readline";

let colorOn = !process.env.NO_COLOR && process.env.TERM !== "dumb" && !!process.stdout.isTTY;
if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") colorOn = true;

export function setColor(on: boolean): void {
	colorOn = on;
}

export function colorEnabled(): boolean {
	return colorOn;
}

function sgr(open: number, close: number): (s: string) => string {
	return s => (colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const c = {
	bold: sgr(1, 22),
	dim: sgr(2, 22),
	italic: sgr(3, 23),
	underline: sgr(4, 24),
	inverse: sgr(7, 27),
	red: sgr(31, 39),
	green: sgr(32, 39),
	yellow: sgr(33, 39),
	blue: sgr(34, 39),
	magenta: sgr(35, 39),
	cyan: sgr(36, 39),
	gray: sgr(90, 39),
};

/** Visible terminal width (80 when unknown, e.g. piped). */
export function termWidth(): number {
	return Math.max(40, process.stdout.columns || 80);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** Display width (code points; ANSI escapes ignored). */
export function visibleLength(s: string): number {
	return [...stripAnsi(s)].length;
}

/** Truncates plain text to `width` columns with an ellipsis. */
export function truncate(s: string, width: number): string {
	const chars = [...s];
	if (chars.length <= width) return s;
	return width <= 1 ? chars.slice(0, width).join("") : `${chars.slice(0, width - 1).join("")}…`;
}

/** Pads text that may contain ANSI escapes to `width` visible columns. */
export function pad(s: string, width: number): string {
	const n = visibleLength(s);
	return n >= width ? s : s + " ".repeat(width - n);
}

/** One line: newlines/tabs collapsed. */
export function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** "12s", "5m", "3h", "2d" ago-style compact duration. */
export function ago(ms: number, now = Date.now()): string {
	return duration(Math.max(0, now - ms));
}

export function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

/** Asks a question on the TTY; resolves with the answer (empty string on EOF). */
export function ask(question: string): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
	let answered = false;
	rl.question(question, answer => {
		answered = true;
		rl.close();
		resolve(answer);
	});
	rl.on("close", () => {
		if (!answered) resolve("");
	});
	return promise;
}

/** y/N confirmation; `assumeYes` (--yes) skips the question. Non-interactive stdin → false. */
export async function confirm(question: string, assumeYes = false): Promise<boolean> {
	if (assumeYes) return true;
	if (!process.stdin.isTTY) return false;
	return /^y(es)?$/i.test((await ask(`${question} ${c.dim("[y/N]")} `)).trim());
}

/** Error to stderr with the switchyard prefix. */
export function errorLine(message: string): void {
	process.stderr.write(`${c.red("switchyard:")} ${message}\n`);
}

export const PRIORITY_MARK: Record<string, string> = { urgent: "!!", high: "! ", normal: "  ", low: "↓ " };

export function priorityLabel(p: string): string {
	if (p === "urgent") return c.red(c.bold("urgent"));
	if (p === "high") return c.yellow("high");
	if (p === "low") return c.gray("low");
	return c.dim("normal");
}
