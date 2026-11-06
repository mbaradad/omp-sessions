// Compact, model-friendly text for bridge tool results: paths relative to the session cwd,
// `path:line:col` positions, hover markdown cleaned, counts and sizes capped.
import * as path from "node:path";
import { type BCall, type BDiag, type BLoc, type BSignature, type BSym, isInside, LIMITS, type ToolResult } from "../shared/bridge";

export function relPath(p: string, cwd: string): string {
	if (!path.isAbsolute(p)) return p;
	if (!isInside(cwd, p)) return p;
	return path.relative(cwd, p) || ".";
}

export function fmtLoc(l: BLoc, cwd: string): string {
	return `${relPath(l.path, cwd)}:${l.line}:${l.col}`;
}

export function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function more(shown: number, total: number): string {
	return shown < total ? `\n… ${total - shown} more` : "";
}

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };

/** Hover markdown → plain-ish markdown: no HTML, command links, rules or escapes; fences kept. */
export function cleanHover(md: string, max: number = LIMITS.hoverChars): string {
	const out: string[] = [];
	let inFence = false;
	for (const raw of md.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
		if (/^\s*(```|~~~)/.test(raw)) {
			inFence = !inFence;
			out.push(raw.trimEnd());
			continue;
		}
		if (inFence) {
			out.push(raw.trimEnd());
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
			out.push("");
			continue;
		}
		const line = raw
			.replace(/<br\s*\/?>/gi, " ")
			.replace(/<\/?[a-z][^>]*>/gi, "")
			.replace(/&(nbsp|lt|gt|amp|quot|#39);/g, m => ENTITIES[m] ?? m)
			.replace(/\[([^\]]*)\]\((?:command|vscode|file):[^)]*\)/g, "$1")
			.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1")
			.trimEnd();
		out.push(line);
	}
	const text = out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return clip(text, max);
}

function symLine(s: BSym, cwd: string): string {
	const container = s.container ? ` in ${s.container}` : "";
	const detail = s.detail ? ` — ${clip(s.detail.replace(/\s+/g, " "), 100)}` : "";
	return `${s.kind} ${s.name}${container}${detail} — ${fmtLoc(s.loc, cwd)}`;
}

function outline(symbols: BSym[], depth: number, lines: string[]): void {
	for (const s of symbols) {
		const detail = s.detail ? ` — ${clip(s.detail.replace(/\s+/g, " "), 80)}` : "";
		lines.push(`${"  ".repeat(depth)}L${s.loc.line} ${s.kind} ${s.name}${detail}`);
		if (s.children?.length) outline(s.children, depth + 1, lines);
	}
}

function signatures(sigs: BSignature[], active: number, activeParam: number): string[] {
	const lines: string[] = [];
	sigs.forEach((s, i) => {
		lines.push(`${i === active ? "▶ " : "  "}${s.label}`);
		if (s.doc) lines.push(...cleanHover(s.doc, 1500).split("\n").map(l => `    ${l}`));
		s.params.forEach((p, j) => {
			const mark = i === active && j === activeParam ? " (current)" : "";
			lines.push(`    - ${p.label}${mark}${p.doc ? ` — ${clip(cleanHover(p.doc, 400).replace(/\n+/g, " "), 300)}` : ""}`);
		});
	});
	return lines;
}

function calls(label: string, list: BCall[] | undefined, cwd: string): string[] {
	if (!list) return [];
	if (!list.length) return [`${label}: none`];
	return [
		`${label} (${list.length}):`,
		...list.map(c => {
			const sites = c.at.length ? `; at ${c.at.slice(0, 8).map(a => `${relPath(a.path, cwd)}:${a.line}`).join(", ")}${c.at.length > 8 ? ", …" : ""}` : "";
			return `  ${symLine(c.sym, cwd)}${sites}`;
		}),
	];
}

function diag(d: BDiag, cwd: string): string {
	const code = d.code ? ` ${d.code}` : "";
	const source = d.source ? ` [${d.source}]` : "";
	const msg = clip(d.message.trim(), 400).replace(/\n/g, "\n    ");
	return `${fmtLoc(d.loc, cwd)} ${d.severity}${code}: ${msg}${source}`;
}

function countBy(items: BDiag[]): string {
	const counts = new Map<string, number>();
	for (const d of items) counts.set(d.severity, (counts.get(d.severity) ?? 0) + 1);
	return [...counts].map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ");
}

function body(r: ToolResult, cwd: string): string {
	switch (r.kind) {
		case "locations": {
			const head = `${r.what}${r.target ? ` at ${fmtLoc(r.target, cwd)}` : ""}`;
			if (!r.locations.length) return `${head}: none found`;
			return `${head}: ${r.total} result${r.total === 1 ? "" : "s"}\n${r.locations.map(l => (l.text ? `${fmtLoc(l, cwd)}  ${l.text}` : fmtLoc(l, cwd))).join("\n")}${more(r.locations.length, r.total)}`;
		}
		case "symbols":
			if (!r.symbols.length) return `No workspace symbols match "${r.query}".`;
			return `${r.total} symbol${r.total === 1 ? "" : "s"} matching "${r.query}":\n${r.symbols.map(s => symLine(s, cwd)).join("\n")}${more(r.symbols.length, r.total)}`;
		case "outline": {
			if (!r.symbols.length) return `${relPath(r.path, cwd)}: no symbols (no language support for this file, or it is empty).`;
			const lines: string[] = [];
			outline(r.symbols, 0, lines);
			return `${relPath(r.path, cwd)} outline (${r.total} symbols):\n${lines.join("\n")}${r.total > lines.length ? `\n… ${r.total - lines.length} more (deeper or beyond the cap)` : ""}`;
		}
		case "hover": {
			const text = r.contents.map(c => cleanHover(c)).filter(Boolean).join("\n\n");
			return text ? `Hover at ${fmtLoc(r.target, cwd)}${r.target.text ? `  (${r.target.text})` : ""}:\n${clip(text, LIMITS.hoverChars)}` : `No hover information at ${fmtLoc(r.target, cwd)}.`;
		}
		case "signature":
			if (!r.signatures.length) return `No signature help at ${fmtLoc(r.target, cwd)} (target a position inside a call's parentheses).`;
			return `Signature help at ${fmtLoc(r.target, cwd)}:\n${signatures(r.signatures, r.activeSignature, r.activeParameter).join("\n")}`;
		case "calls": {
			if (!r.items.length) return `No call hierarchy at ${fmtLoc(r.target, cwd)}.`;
			const parts = r.items.map(i => [`Call hierarchy for ${symLine(i.sym, cwd)}`, ...calls("incoming calls", i.incoming, cwd), ...calls("outgoing calls", i.outgoing, cwd)].join("\n"));
			return parts.join("\n\n");
		}
		case "diagnostics": {
			const scope = relPath(r.scope, cwd);
			if (!r.items.length) return `No diagnostics for ${scope} at the requested severity.`;
			return `Diagnostics for ${scope}: ${r.total} (${countBy(r.items)}${r.total > r.items.length ? " shown" : ""})\n${r.items.map(d => diag(d, cwd)).join("\n")}${more(r.items.length, r.total)}`;
		}
		case "editor": {
			const lines: string[] = [];
			const a = r.active;
			if (a) {
				lines.push(`Active editor: ${relPath(a.path, cwd)} (${a.languageId}${a.dirty ? ", unsaved changes" : ""})`);
				for (const s of a.selections) {
					const empty = s.start.line === s.end.line && s.start.col === s.end.col;
					lines.push(empty ? `Cursor: ${s.start.line}:${s.start.col}` : `Selection: ${s.start.line}:${s.start.col}–${s.end.line}:${s.end.col}`);
				}
				if (a.visible) lines.push(`Visible lines: ${a.visible.from}–${a.visible.to}`);
				if (a.selectedText) lines.push(`Selected text:\n\`\`\`${a.languageId}\n${a.selectedText}\n\`\`\``);
			} else lines.push("No active text editor.");
			if (r.open.length) lines.push(`Open editors (${r.open.length}): ${r.open.map(e => `${relPath(e.path, cwd)}${e.dirty ? " (unsaved)" : ""}`).join(", ")}`);
			return lines.join("\n");
		}
		case "docs": {
			const lines = [r.definition ? symLine(r.definition, cwd) : `${r.symbol} (definition not found in the workspace)`];
			if (r.signatures?.length) lines.push(...signatures(r.signatures, 0, -1));
			const text = r.contents.map(c => cleanHover(c)).filter(Boolean).join("\n\n");
			lines.push(text || "No documentation available.");
			return lines.join("\n");
		}
	}
}

/** Final tool text; `note` (e.g. window fallback) goes first; the whole thing is capped. */
export function formatResult(r: ToolResult, cwd: string, note?: string): string {
	const text = `${note ? `${note}\n` : ""}${body(r, cwd)}`;
	return text.length > LIMITS.outputChars ? `${text.slice(0, LIMITS.outputChars)}\n… (output truncated)` : text;
}
