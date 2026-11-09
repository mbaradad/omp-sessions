// Formatting, a small safe Markdown renderer (React elements, never HTML strings) and icons.
import type { Session, State } from "./api";
import { type Child, h, type ReactElement } from "./react";

export function cx(...names: Array<string | false | null | undefined>): string {
	return names.filter(Boolean).join(" ");
}

/** Epoch ms or s → ms. */
function ms(t: number): number {
	return t < 1e12 ? t * 1000 : t;
}

export function ago(t: number | null | undefined, now = Date.now()): string {
	if (!t) return "";
	const s = Math.round((now - ms(t)) / 1000);
	// A timestamp slightly ahead of this clock (another machine's, or written after the last tick) is "now".
	if (s < -120) return until(t, now);
	if (s < 45) return "just now";
	if (s < 90 * 60) return `${Math.max(1, Math.round(s / 60))}m ago`;
	if (s < 36 * 3600) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

export function until(t: number, now = Date.now()): string {
	const s = Math.round((ms(t) - now) / 1000);
	if (s <= 30) return "any moment";
	if (s < 90 * 60) return `in ${Math.max(1, Math.round(s / 60))}m`;
	if (s < 36 * 3600) return `in ${Math.round(s / 3600)}h`;
	return `in ${Math.round(s / 86400)}d`;
}

export function clock(t: number): string {
	const d = new Date(ms(t));
	const today = new Date();
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === today.toDateString()) return time;
	return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

/** A one-line excerpt with its Markdown marks removed (code ticks, emphasis, headings, link targets). */
export function plain(excerpt: string): string {
	return excerpt.replace(/[`*#>]+|\[|\]\([^)]*\)/g, "");
}

export function money(cost: number): string {
	if (!cost || cost < 0.005) return "";
	return `$${cost < 10 ? cost.toFixed(2) : cost.toFixed(0)}`;
}

/** AO ids (`<project>-<n>`) in full; a legacy omp Sessions id (no `-`, 14 characters) by its first 8. */
export function shortId(id: string): string {
	return !id.includes("-") && id.length > 12 ? id.slice(0, 8) : id;
}

export const STATE_LABEL: Record<State, string> = {
	needs_input: "Needs you",
	working: "Working",
	starting: "Starting",
	queued: "Queued",
	scheduled: "Scheduled",
	idle: "Done",
	interrupted: "Interrupted",
	stopped: "Stopped",
};

/** The card's status line: what the session is doing in a few words. */
export function stateText(s: Session, now = Date.now()): string {
	switch (s.state) {
		case "needs_input":
			return s.question?.kind === "select" && /^allow tool/i.test(s.question.title) ? "Approval needed" : "Question";
		case "working":
			return s.queue.total > 1 ? `Task ${Math.min(s.queue.done + 1, s.queue.total)} of ${s.queue.total}` : "Working";
		case "starting":
			return "Starting";
		case "queued":
			return s.waiting ? `Waiting for a slot${s.waiting.position ? ` · #${s.waiting.position}` : ""}` : "Queued";
		case "scheduled":
			return s.startAt ? `Starts ${until(s.startAt, now)}` : "Scheduled";
		case "idle":
			return "Done for now";
		case "interrupted":
			return "Interrupted (crash or reboot)";
		case "stopped":
			return s.queue.total > 0 && s.queue.done >= s.queue.total ? "Finished" : "Stopped";
	}
}

// ---------- Markdown (subset): headings, lists, quotes, rules, tables, fenced code, inline code, bold, italics, links ----------

function inline(text: string, key: string): Child[] {
	const out: Child[] = [];
	const re = /(`[^`]+`)|\*\*(.+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
	let last = 0;
	let i = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		if (m.index > last) out.push(text.slice(last, m.index));
		const k = `${key}-${i++}`;
		if (m[1]) out.push(h("code", { key: k }, m[1].slice(1, -1)));
		else if (m[2]) out.push(h("strong", { key: k }, ...inline(m[2], k)));
		else if (m[3]) out.push(h("em", { key: k }, ...inline(m[3], k)));
		else if (m[4] && m[5]) out.push(h("a", { key: k, href: m[5], target: "_blank", rel: "noreferrer noopener" }, m[4].slice(1, m[4].indexOf("]"))));
		last = m.index + m[0].length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map(c => c.trim());
}

export function markdown(text: string): ReactElement[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: ReactElement[] = [];
	let i = 0;
	let n = 0;
	while (i < lines.length) {
		const line = lines[i];
		const key = `b${n++}`;
		const fence = /^\s*```(\S*)/.exec(line);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
			i++;
			blocks.push(h("pre", { key }, h("code", null, body.join("\n"))));
			continue;
		}
		if (RULE.test(line)) {
			blocks.push(h("hr", { key }));
			i++;
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
			const head = cells(line);
			const rows: string[][] = [];
			i += 2;
			while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
			blocks.push(
				h(
					"div",
					{ key, className: "omps-md-table" },
					h(
						"table",
						null,
						h("thead", null, h("tr", null, ...head.map((c, j) => h("th", { key: j }, ...inline(c, `${key}-h${j}`))))),
						h("tbody", null, ...rows.map((r, ri) => h("tr", { key: ri }, ...r.map((c, j) => h("td", { key: j }, ...inline(c, `${key}-${ri}-${j}`)))))),
					),
				),
			);
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			blocks.push(h(`h${Math.min(6, heading[1].length + 3)}`, { key }, ...inline(heading[2], key)));
			i++;
			continue;
		}
		if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
			const ordered = /^\s*\d/.test(line);
			const items: ReactElement[] = [];
			while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
				const content = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
				items.push(h("li", { key: `${key}-${items.length}` }, ...inline(content, `${key}-${items.length}`)));
				i++;
			}
			blocks.push(h(ordered ? "ol" : "ul", { key }, ...items));
			continue;
		}
		if (/^\s*>/.test(line)) {
			const quote: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
			blocks.push(h("blockquote", { key }, ...inline(quote.join(" "), key)));
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		const para: string[] = [];
		while (i < lines.length && lines[i].trim() && !RULE.test(lines[i]) && !/^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i])) para.push(lines[i++]);
		if (para.length === 0) para.push(lines[i++]);
		blocks.push(h("p", { key }, ...inline(para.join(" "), key)));
	}
	return blocks;
}

// ---------- icons (24×24 strokes) ----------

const PATHS = {
	plus: "M12 5v14M5 12h14",
	search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
	x: "M6 6l12 12M18 6L6 18",
	folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
	kanban: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z",
	clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
	stop: "M7 7h10v10H7z",
	send: "M4 12l16-8-6 16-2-6z",
	check: "M5 12l5 5 9-10",
	alert: "M12 4l9 16H3zM12 10v4M12 17v.5",
	ask: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5V14M12 17.5v.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
	refresh: "M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4",
	server: "M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01",
	slots: "M4 6h16M4 12h16M4 18h10",
	lane: "M5 4v16M12 4v16M19 4v16",
	dollar: "M12 3v18M16 7.5c0-1.4-1.8-2.5-4-2.5s-4 1.1-4 2.5S9.8 10 12 10s4 1.1 4 2.5S14.2 15 12 15s-4-1.1-4-2.5",
	file: "M6 3h8l4 4v14H6zM14 3v4h4",
	chevron: "M9 6l6 6-6 6",
	terminal: "M4 6l6 6-6 6M12 18h8",
	sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
	external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
	pause: "M8 5v14M16 5v14",
	tag: "M3 12V4h8l10 10-8 8z M7.5 7.5h.01",
} as const;
export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 14, title?: string): ReactElement {
	return h(
		"svg",
		{
			className: "omps-icon",
			width: size,
			height: size,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": title ? undefined : true,
			role: title ? "img" : undefined,
			"aria-label": title,
		},
		h("path", { d: PATHS[name] }),
	);
}

/** The omp Sessions app mark (as in the extension icon): the π glyph in the brand gradient on a
 *  dark rounded tile with a corner glow, so it reads at sidebar sizes on light and dark themes. */
export function logo(size = 22): ReactElement {
	return h(
		"svg",
		{ className: "omps-logo", width: size, height: size, viewBox: "0 0 64 64", "aria-hidden": true },
		h(
			"defs",
			null,
			h("linearGradient", { id: "omps-logo-tile", x1: 0, y1: 0, x2: 0.4, y2: 1 }, h("stop", { offset: 0, stopColor: "#2b1a45" }), h("stop", { offset: 1, stopColor: "#0d0914" })),
			h(
				"radialGradient",
				{ id: "omps-logo-glow", cx: 1, cy: 1, r: 0.75 },
				h("stop", { offset: 0, stopColor: "#ed4abf", stopOpacity: 0.75 }),
				h("stop", { offset: 0.45, stopColor: "#7b5cff", stopOpacity: 0.35 }),
				h("stop", { offset: 1, stopColor: "#7b5cff", stopOpacity: 0 }),
			),
			h(
				"linearGradient",
				{ id: "omps-logo-glyph", x1: 0, y1: 0, x2: 1, y2: 1 },
				h("stop", { offset: 0, stopColor: "#f06ccb" }),
				h("stop", { offset: 0.5, stopColor: "#b07bff" }),
				h("stop", { offset: 1, stopColor: "#6fe0ec" }),
			),
		),
		h("rect", { x: 2, y: 2, width: 60, height: 60, rx: 15, fill: "url(#omps-logo-tile)" }),
		h("rect", { x: 2, y: 2, width: 60, height: 60, rx: 15, fill: "url(#omps-logo-glow)" }),
		h("rect", { x: 2.5, y: 2.5, width: 59, height: 59, rx: 14.5, fill: "none", stroke: "rgba(255,255,255,0.16)" }),
		h("path", { d: "M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z", fill: "url(#omps-logo-glyph)", transform: "translate(3.2 0.6) scale(0.9)" }),
	);
}
