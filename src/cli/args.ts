// Argument parsing for `omp-sessions` (no side effects, unit-tested).

export class UsageError extends Error {}

/** Flags that take a value; everything else is boolean. */
const VALUE_FLAGS = new Set(["title", "model", "prompt", "task", "sub", "priority", "lines", "mode", "bind", "port", "tag", "at", "timeout", "dir", "notes", "group", "profile", "url", "project", "cwd", "state", "authority", "question", "folder", "after", "usage", "worktree", "session"]);
const MULTI_FLAGS = new Set(["sub", "tag", "profile", "after"]);
const SHORT: Record<string, string> = { p: "prompt", a: "all", f: "follow", y: "yes", n: "lines", t: "title", m: "model", h: "help", w: "wait", d: "detach" };

export interface Args {
	_: string[];
	/** The words after a bare `--` (also in `_`). */
	dashes: string[];
	flags: Map<string, string | true>;
	multi: Map<string, string[]>;
}

export function parseArgs(argv: readonly string[]): Args {
	const out: Args = { _: [], dashes: [], flags: new Map(), multi: new Map() };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			// Positional from here on; `dashes` also keeps them apart (`new <dir> -- <omp flags>`).
			out.dashes = argv.slice(i + 1);
			out._.push(...out.dashes);
			break;
		}
		let name: string | undefined;
		let value: string | undefined;
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			name = eq > 0 ? a.slice(2, eq) : a.slice(2);
			if (eq > 0) value = a.slice(eq + 1);
		} else if (/^-[a-zA-Z]$/.test(a)) name = SHORT[a[1]] ?? a[1];
		if (name === undefined) {
			out._.push(a);
			continue;
		}
		if (VALUE_FLAGS.has(name)) {
			if (value === undefined) {
				value = argv[++i];
				if (value === undefined) throw new UsageError(`--${name} needs a value`);
				// `--title --json` is a forgotten value, not a title; `--title=--x` passes one on purpose.
				if (value.startsWith("--")) throw new UsageError(`--${name} needs a value (got ${value}; use --${name}=${value} if you mean it)`);
			}
			if (MULTI_FLAGS.has(name)) out.multi.set(name, [...(out.multi.get(name) ?? []), value]);
			else out.flags.set(name, value);
		} else out.flags.set(name, value ?? true);
	}
	return out;
}

/** Throws a UsageError for any flag `command` doesn't take (`help` is always allowed). */
export function checkFlags(args: Args, command: string, allowed: readonly string[]): void {
	for (const name of [...args.flags.keys(), ...args.multi.keys()]) {
		if (name === "help" || allowed.includes(name)) continue;
		const hint = allowed.length ? ` (${allowed.map(f => `--${f}`).join(", ")})` : "";
		throw new UsageError(`${command} doesn't take --${name}${hint}`);
	}
}

export function flag(args: Args, name: string): boolean {
	const v = args.flags.get(name);
	return v !== undefined && v !== "false" && v !== "0";
}

export function value(args: Args, name: string): string | undefined {
	const v = args.flags.get(name);
	return typeof v === "string" ? v : undefined;
}

/** "+30m", "+2h", "14:30" (next occurrence), or an ISO date/time → epoch ms; throws a UsageError on anything else or a past time. */
export function parseWhen(text: string, now = Date.now()): number {
	const t = text.trim();
	const rel = /^\+(\d+)\s*([smhd])$/.exec(t);
	const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	if (rel) return now + Number(rel[1]) * (unit[rel[2]] ?? 0);
	const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
	if (hm) {
		const hours = Number(hm[1]);
		const minutes = Number(hm[2]);
		if (hours > 23 || minutes > 59) throw new UsageError(`${t} is not a time of day (00:00-23:59)`);
		const d = new Date(now);
		d.setHours(hours, minutes, 0, 0);
		if (d.getTime() <= now) d.setDate(d.getDate() + 1);
		return d.getTime();
	}
	const at = /^\d{4}-\d{2}-\d{2}/.test(t) ? Date.parse(t) : Number.NaN;
	if (!Number.isFinite(at)) throw new UsageError(`can't read "${t}" as a time: use +30m, +2h, 14:30 or an ISO time like 2025-01-31T08:00`);
	if (at <= now) throw new UsageError(`${t} is in the past`);
	return at;
}
