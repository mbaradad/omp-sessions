// Turns URLs, omp internal URLs and existing file paths in rendered text into clickable links.
import { h, post } from "./dom";

const URL_RE = /\b(?:(?:https?|file|mailto):|(?:artifact|local|skill|omp|agent|mcp|history|memory|rule|issue|pr|proc|xd|vault|security|conflict):\/\/)[^\s<>"'`)\]}]+/g;
const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10}(?::\d+(?:[:-]\d+)?)?|(?:~\/|\/)(?:[\w@.+-]+\/)*[\w@.+-]+/g;

const pathCache = new Map<string, string | null>();
const waiting = new Map<number, string[]>();
let reqSeq = 0;

export function splitLine(candidate: string): { file: string; line?: number; col?: number } {
	const m = /^(.*?)(?::(\d+)(?:[:-](\d+))?)?(?:#L(\d+))?$/.exec(candidate);
	if (!m) return { file: candidate };
	const line = m[2] ?? m[4];
	return { file: m[1], line: line ? Number(line) : undefined, col: m[3] && candidate.includes(`:${m[2]}:`) ? Number(m[3]) : undefined };
}

function trimToken(token: string): string {
	return token.replace(/[.,;:!?]+$/, "");
}

/** Wraps URL-ish and path-ish tokens under `root`, then asks the extension which paths exist. */
export function linkify(root: HTMLElement): void {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent || parent.closest("a, .file-link, .ext-link, .maybe-path, button, .diff, .no-link")) return NodeFilter.FILTER_REJECT;
			return /[./:]/.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		},
	});
	const nodes: Text[] = [];
	while (walker.nextNode()) nodes.push(walker.currentNode as Text);
	for (const node of nodes.slice(0, 600)) {
		const text = node.nodeValue ?? "";
		const spans: Array<{ start: number; end: number; el: HTMLElement }> = [];
		URL_RE.lastIndex = 0;
		for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
			const token = trimToken(m[0]);
			spans.push({ start: m.index, end: m.index + token.length, el: h("a", { class: "ext-link", "data-url": token, title: token }, token) });
		}
		PATH_RE.lastIndex = 0;
		for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
			const token = trimToken(m[0]);
			const start = m.index;
			if (spans.some(s => start < s.end && start + token.length > s.start)) continue;
			if (token.length < 3 || /^v?\d+(\.\d+)*$/.test(token) || token.startsWith("//")) continue;
			const { file } = splitLine(token);
			if (!file.includes("/") && !/\.[A-Za-z][A-Za-z0-9]{0,6}$/.test(file)) continue;
			spans.push({ start, end: start + token.length, el: h("span", { class: "maybe-path", "data-candidate": token }, token) });
		}
		if (!spans.length) continue;
		spans.sort((a, b) => a.start - b.start);
		const frag = document.createDocumentFragment();
		let last = 0;
		for (const s of spans) {
			frag.append(text.slice(last, s.start), s.el);
			last = s.end;
		}
		frag.append(text.slice(last));
		node.replaceWith(frag);
	}
	for (const code of root.querySelectorAll<HTMLElement>("code")) {
		if (code.closest("pre, a, .ext-link") || code.querySelector(".maybe-path, .ext-link")) continue;
		const t = (code.textContent ?? "").trim();
		if (t && t.length < 300 && !/\s/.test(t) && /[./]/.test(t)) {
			code.classList.add("maybe-path");
			code.dataset.candidate = t;
		}
	}
	resolvePending(root);
}

function resolvePending(root: ParentNode): void {
	const want: string[] = [];
	for (const el of root.querySelectorAll<HTMLElement>(".maybe-path")) {
		const { file } = splitLine(el.dataset.candidate ?? "");
		if (pathCache.has(file)) apply(el, pathCache.get(file) ?? null);
		else if (!want.includes(file)) want.push(file);
	}
	if (!want.length) return;
	const reqId = ++reqSeq;
	waiting.set(reqId, want);
	post({ type: "resolvePaths", reqId, candidates: want });
}

function apply(el: HTMLElement, abs: string | null): void {
	el.classList.remove("maybe-path");
	if (!abs) return;
	const { line, col } = splitLine(el.dataset.candidate ?? "");
	el.classList.add("file-link");
	el.dataset.path = abs;
	if (line) el.dataset.line = String(line);
	if (col) el.dataset.col = String(col);
	el.title = `${abs}${line ? `:${line}` : ""}`;
}

export function onPathsResolved(reqId: number, resolved: Record<string, string>): void {
	for (const c of waiting.get(reqId) ?? []) pathCache.set(c, resolved[c] ?? null);
	waiting.delete(reqId);
	resolvePending(document);
}

/** Global click routing for every link kind. */
export function installLinkHandler(): void {
	document.addEventListener("click", ev => {
		const target = ev.target as HTMLElement | null;
		const fileEl = target?.closest<HTMLElement>(".file-link");
		if (fileEl?.dataset.path) {
			ev.preventDefault();
			post({ type: "openFile", path: fileEl.dataset.path, line: fileEl.dataset.line ? Number(fileEl.dataset.line) : undefined, column: fileEl.dataset.col ? Number(fileEl.dataset.col) : undefined });
			return;
		}
		const urlEl = target?.closest<HTMLElement>(".ext-link");
		if (urlEl?.dataset.url) {
			ev.preventDefault();
			post({ type: "openLink", url: urlEl.dataset.url });
		}
	});
}

export function fileLink(rawPath: string, label: string, line?: number): HTMLElement {
	const el = h("a", { class: "file-link", "data-path": rawPath, title: rawPath }, label);
	if (line) el.dataset.line = String(line);
	return el;
}
