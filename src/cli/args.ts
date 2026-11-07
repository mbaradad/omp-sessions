// Argument parsing for `omp-vs` (no side effects, unit-tested).

export class UsageError extends Error {}

/** Flags that take a value; everything else is boolean. */
const VALUE_FLAGS = new Set(["title", "model", "prompt", "task", "sub", "priority", "lines", "mode", "bind", "port", "tag", "at", "timeout", "dir", "notes", "group", "profile", "url"]);
const MULTI_FLAGS = new Set(["sub", "tag", "profile"]);
const SHORT: Record<string, string> = { p: "prompt", a: "all", f: "follow", y: "yes", n: "lines", t: "title", m: "model", h: "help", w: "wait", d: "detach" };

export interface Args {
	_: string[];
	flags: Map<string, string | true>;
	multi: Map<string, string[]>;
}

export function parseArgs(argv: readonly string[]): Args {
	const out: Args = { _: [], flags: new Map(), multi: new Map() };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			out._.push(...argv.slice(i + 1));
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
			}
			if (MULTI_FLAGS.has(name)) out.multi.set(name, [...(out.multi.get(name) ?? []), value]);
			else out.flags.set(name, value);
		} else out.flags.set(name, value ?? true);
	}
	return out;
}

export function flag(args: Args, name: string): boolean {
	const v = args.flags.get(name);
	return v !== undefined && v !== "false" && v !== "0";
}

export function value(args: Args, name: string): string | undefined {
	const v = args.flags.get(name);
	return typeof v === "string" ? v : undefined;
}

/** "+30m", "+2h", "14:30" (next occurrence), or an ISO date/time → epoch ms. */
export function parseWhen(text: string, now = Date.now()): number | undefined {
	const rel = /^\+(\d+)\s*([smhd])$/.exec(text.trim());
	const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	if (rel) return now + Number(rel[1]) * (unit[rel[2]] ?? 0);
	const hm = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	if (hm) {
		const d = new Date(now);
		d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
		if (d.getTime() <= now) d.setDate(d.getDate() + 1);
		return d.getTime();
	}
	const t = Date.parse(text);
	return Number.isFinite(t) ? t : undefined;
}
