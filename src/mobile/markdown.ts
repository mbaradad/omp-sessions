// Basic markdown for assistant/user text: paragraphs, headings, lists, quotes, fenced code,
// tables, inline code, bold, italic and http(s) links. Built from DOM nodes (never innerHTML).
import { type Child, h } from "./dom";

const INLINE =
	/(`+)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;

function link(href: string, text: string): HTMLAnchorElement {
	return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
}

/** Inline spans of one paragraph; single newlines become line breaks (chat text, not prose). */
export function inline(text: string): Child[] {
	const out: Child[] = [];
	let last = 0;
	const pushText = (s: string) => {
		s.split("\n").forEach((part, i) => {
			if (i) out.push(h("br"));
			if (part) out.push(part);
		});
	};
	for (const m of text.matchAll(INLINE)) {
		const at = m.index ?? 0;
		pushText(text.slice(last, at));
		last = at + m[0].length;
		if (m[2] !== undefined) out.push(h("code", {}, m[2].replace(/^ (.*) $/, "$1")));
		else if (m[3] !== undefined || m[4] !== undefined) out.push(h("strong", {}, ...inline(m[3] ?? m[4] ?? "")));
		else if (m[5] !== undefined || m[6] !== undefined) out.push(h("em", {}, ...inline(m[5] ?? m[6] ?? "")));
		else if (m[7] !== undefined && m[8] !== undefined) out.push(link(m[8], m[7]));
		else if (m[9] !== undefined) out.push(link(m[9], m[9]));
	}
	pushText(text.slice(last));
	return out;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map(c => c.trim());
}

export function renderMarkdown(text: string): DocumentFragment {
	const frag = document.createDocumentFragment();
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	let para: string[] = [];
	const flush = () => {
		if (para.length) frag.append(h("p", {}, ...inline(para.join("\n"))));
		para = [];
	};
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const fence = FENCE.exec(line);
		if (fence) {
			flush();
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
			i++;
			frag.append(h("pre", { class: "code" }, h("code", { "data-lang": fence[2] || undefined }, body.join("\n"))));
			continue;
		}
		if (!line.trim()) {
			flush();
			i++;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			const level = heading[1].length;
			frag.append(h(level === 1 ? "h3" : level === 2 ? "h4" : "h5", {}, ...inline(heading[2])));
			i++;
			continue;
		}
		if (RULE.test(line)) {
			flush();
			frag.append(h("hr"));
			i++;
			continue;
		}
		if (/^\s{0,3}>/.test(line)) {
			flush();
			const quoted: string[] = [];
			while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
			frag.append(h("blockquote", {}, renderMarkdown(quoted.join("\n"))));
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
			flush();
			const head = cells(line);
			i += 2;
			const body: string[][] = [];
			while (i < lines.length && lines[i].includes("|") && lines[i].trim()) body.push(cells(lines[i++]));
			frag.append(
				h(
					"div",
					{ class: "table-wrap" },
					h("table", {}, h("thead", {}, h("tr", {}, ...head.map(c => h("th", {}, ...inline(c))))), h("tbody", {}, ...body.map(r => h("tr", {}, ...r.map(c => h("td", {}, ...inline(c))))))),
				),
			);
			continue;
		}
		const item = LIST_ITEM.exec(line);
		if (item) {
			flush();
			const ordered = /\d/.test(item[2]);
			const indent = item[1].length;
			const items: string[] = [];
			while (i < lines.length) {
				const m = LIST_ITEM.exec(lines[i]);
				if (m && m[1].length <= indent + 1 && /\d/.test(m[2]) === ordered) {
					items.push(m[3]);
					i++;
				} else if (items.length && lines[i].trim() && /^\s+/.test(lines[i])) {
					items[items.length - 1] += `\n${lines[i].replace(/^\s{1,4}/, "")}`;
					i++;
				} else break;
			}
			const start = ordered ? Number.parseInt(item[2], 10) : 1;
			const list = ordered ? h("ol", { start: start !== 1 ? start : undefined }) : h("ul");
			for (const it of items) {
				const nested = it.includes("\n") && LIST_ITEM.test(it.split("\n").slice(1).join("\n"));
				list.append(h("li", {}, ...(nested ? [renderMarkdown(it)] : inline(it))));
			}
			frag.append(list);
			continue;
		}
		para.push(line);
		i++;
	}
	flush();
	return frag;
}
