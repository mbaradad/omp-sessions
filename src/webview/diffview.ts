// Renders structured diffs (from the extension's line diff, or omp's own diff rows).
import type { DiffLine, FileDiff } from "../shared/diff";
import { h } from "./dom";
import { highlight } from "./highlight";

const INITIAL_LINES = 80;

/** Character range [start, end) that differs between a and b, or null when the whole line changed. */
function changedSpan(a: string, b: string): [number, number, number, number] | null {
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p++;
	let s = 0;
	while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
	const aMid = a.length - p - s;
	const bMid = b.length - p - s;
	if (p + s < 3 || aMid > a.length * 0.8 || bMid > b.length * 0.8) return null;
	return [p, a.length - s, p, b.length - s];
}

function textCell(text: string, span: [number, number] | undefined, language: string | undefined): HTMLElement {
	const tx = h("span", { class: "tx" });
	if (span && span[0] < span[1]) {
		tx.append(text.slice(0, span[0]), h("mark", { class: "wd" }, text.slice(span[0], span[1])), text.slice(span[1]));
		return tx;
	}
	const html = highlight(text, language);
	if (html) tx.innerHTML = html || " ";
	else tx.textContent = text || " ";
	return tx;
}

/** Pairs removed/added runs inside a hunk to highlight word-level changes. */
function intraLine(lines: DiffLine[]): Map<DiffLine, [number, number]> {
	const out = new Map<DiffLine, [number, number]>();
	let i = 0;
	while (i < lines.length) {
		if (lines[i].t !== "-") {
			i++;
			continue;
		}
		const dels: DiffLine[] = [];
		while (i < lines.length && lines[i].t === "-") dels.push(lines[i++]);
		const adds: DiffLine[] = [];
		while (i < lines.length && lines[i].t === "+") adds.push(lines[i++]);
		const n = Math.min(dels.length, adds.length);
		for (let k = 0; k < n; k++) {
			const span = changedSpan(dels[k].s, adds[k].s);
			if (!span) continue;
			out.set(dels[k], [span[0], span[1]]);
			out.set(adds[k], [span[2], span[3]]);
		}
	}
	return out;
}

export interface DiffViewOptions {
	/** Open the file at a new-file line number. */
	onLine?: (line: number) => void;
	maxInitialLines?: number;
	/** highlight.js language id for per-line syntax colors. */
	language?: string;
}

export function renderFileDiff(diff: FileDiff, opts: DiffViewOptions = {}): HTMLElement {
	const box = h("div", { class: "diff" });
	const rows: HTMLElement[] = [];
	const lineRow = (l: DiffLine, marks: Map<DiffLine, [number, number]>) => {
		const cls = l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx";
		const row = h(
			"div",
			{ class: `dl ${cls}` },
			h("span", { class: "ln" }, l.o ? String(l.o) : ""),
			h("span", { class: "ln" }, l.n ? String(l.n) : ""),
			h("span", { class: "sg" }, l.t === " " ? "" : l.t === "-" ? "−" : "+"),
			textCell(l.s, marks.get(l), opts.language),
		);
		const target = l.n ?? l.o;
		if (opts.onLine && target) {
			row.title = `Open at line ${target}`;
			row.addEventListener("click", () => opts.onLine?.(target));
		}
		return row;
	};
	for (const hunk of diff.hunks) {
		if (hunk.skipped > 0) rows.push(h("div", { class: "gap" }, `⋯ ${hunk.skipped} unchanged line${hunk.skipped === 1 ? "" : "s"}`));
		const marks = intraLine(hunk.lines);
		for (const l of hunk.lines) rows.push(lineRow(l, marks));
	}
	if (diff.trailing > 0) rows.push(h("div", { class: "gap" }, `⋯ ${diff.trailing} unchanged line${diff.trailing === 1 ? "" : "s"}`));
	const limit = opts.maxInitialLines ?? INITIAL_LINES;
	box.append(...rows.slice(0, limit));
	if (rows.length > limit) {
		const more = h("button", { class: "show-more" }, `Show ${rows.length - limit} more lines`);
		more.addEventListener("click", e => {
			e.preventDefault();
			more.replaceWith(...rows.slice(limit));
		});
		box.append(more);
	}
	if (!diff.hunks.length) box.append(h("div", { class: "gap" }, "No textual changes"));
	return box;
}
