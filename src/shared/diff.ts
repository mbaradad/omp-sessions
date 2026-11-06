// Line diff (Myers, O((N+M)D)) and unified hunks with context, for inline diff cards.

export interface DiffLine {
	/** " " context, "-" removed, "+" added */
	t: " " | "-" | "+";
	/** 1-based line number in the old file (context/removed). */
	o?: number;
	/** 1-based line number in the new file (context/added). */
	n?: number;
	s: string;
}

export interface Hunk {
	oldStart: number;
	newStart: number;
	/** Unchanged lines skipped before this hunk. */
	skipped: number;
	lines: DiffLine[];
}

export interface FileDiff {
	hunks: Hunk[];
	added: number;
	removed: number;
	/** Unchanged lines after the last hunk. */
	trailing: number;
	/** Diff gave up (too many edits); hunks hold a whole-file replace. */
	coarse?: boolean;
}

const MAX_EDIT_DISTANCE = 4000;

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Edit script between `a` and `b` as a sequence of ops over the trimmed middle. */
function myers(a: string[], b: string[]): Array<" " | "-" | "+"> | null {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const offset = max + 1;
	let v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		if (d > MAX_EDIT_DISTANCE) return null;
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				// backtrack
				const ops: Array<" " | "-" | "+"> = [];
				let cx = n;
				let cy = m;
				for (let dd = d; dd > 0; dd--) {
					const pv = trace[dd];
					const kk = cx - cy;
					const prevK = kk === -dd || (kk !== dd && pv[offset + kk - 1] < pv[offset + kk + 1]) ? kk + 1 : kk - 1;
					const px = pv[offset + prevK];
					const py = px - prevK;
					while (cx > px && cy > py) {
						ops.push(" ");
						cx--;
						cy--;
					}
					if (cx === px) {
						ops.push("+");
						cy--;
					} else {
						ops.push("-");
						cx--;
					}
				}
				while (cx > 0 && cy > 0) {
					ops.push(" ");
					cx--;
					cy--;
				}
				return ops.reverse();
			}
		}
		v = v.slice();
	}
	return null;
}

export function diffTexts(oldText: string, newText: string, context = 3): FileDiff {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const midA = a.slice(pre, a.length - suf);
	const midB = b.slice(pre, b.length - suf);
	let ops = myers(midA, midB);
	let coarse = false;
	if (!ops) {
		coarse = true;
		ops = [...midA.map(() => "-" as const), ...midB.map(() => "+" as const)];
	}
	const all: DiffLine[] = [];
	for (let i = 0; i < pre; i++) all.push({ t: " ", o: i + 1, n: i + 1, s: a[i] });
	let ai = pre;
	let bi = pre;
	for (const op of ops) {
		if (op === " ") all.push({ t: " ", o: ++ai, n: ++bi, s: a[ai - 1] });
		else if (op === "-") all.push({ t: "-", o: ++ai, s: a[ai - 1] });
		else all.push({ t: "+", n: ++bi, s: b[bi - 1] });
	}
	for (let i = 0; i < suf; i++) {
		ai++;
		bi++;
		all.push({ t: " ", o: ai, n: bi, s: a[ai - 1] });
	}
	return toHunks(all, context, coarse);
}

function toHunks(all: DiffLine[], context: number, coarse: boolean): FileDiff {
	const hunks: Hunk[] = [];
	let added = 0;
	let removed = 0;
	const changed: number[] = [];
	all.forEach((l, i) => {
		if (l.t === "+") added++;
		if (l.t === "-") removed++;
		if (l.t !== " ") changed.push(i);
	});
	let lastEnd = 0;
	let i = 0;
	while (i < changed.length) {
		const start = Math.max(changed[i] - context, lastEnd);
		let end = changed[i];
		while (i + 1 < changed.length && changed[i + 1] - end <= context * 2 + 1) end = changed[++i];
		i++;
		const stop = Math.min(end + context + 1, all.length);
		const lines = all.slice(start, stop);
		const first = lines[0];
		hunks.push({
			oldStart: first.o ?? (lines.find(l => l.o)?.o ?? 1),
			newStart: first.n ?? (lines.find(l => l.n)?.n ?? 1),
			skipped: start - lastEnd,
			lines,
		});
		lastEnd = stop;
	}
	return { hunks, added, removed, trailing: all.length - lastEnd, coarse: coarse || undefined };
}

/** Parse omp's tool diff rows (" 12|ctx", "-3|old", "+3|new", "…") into hunks. */
export function parseOmpDiff(diff: string): FileDiff {
	const hunks: Hunk[] = [];
	let cur: Hunk | null = null;
	let added = 0;
	let removed = 0;
	let lastOld = 0;
	let lastNew = 0;
	for (const raw of diff.split("\n")) {
		const m = /^([+\- ])\s*(\d+)\|(.*)$/.exec(raw);
		if (!m) {
			cur = null;
			continue;
		}
		const t = m[1] as " " | "-" | "+";
		const num = Number(m[2]);
		let line: DiffLine;
		if (t === "-") {
			line = { t, o: num, s: m[3] };
			lastOld = num;
			removed++;
		} else if (t === "+") {
			line = { t, n: num, s: m[3] };
			lastNew = num;
			added++;
		} else {
			// omp prints the new-file number for context rows
			const delta = lastNew - lastOld;
			line = { t, n: num, o: num - delta, s: m[3] };
			lastNew = num;
			lastOld = num - delta;
		}
		if (!cur) {
			cur = { oldStart: line.o ?? 1, newStart: line.n ?? 1, skipped: hunks.length ? 1 : 0, lines: [] };
			hunks.push(cur);
		}
		cur.lines.push(line);
	}
	return { hunks, added, removed, trailing: 0 };
}
