// Chat UI for one omp session. Renders the transcript, tool cards with inline diffs,
// interactive omp dialogs, and a composer with slash-command and @file completion.
import { Marked, type Tokens } from "marked";
import type { FileChange, OmpFrame, SessionMeta, UiRequest } from "../shared/protocol";
import type { FromWebview, SlashCommand, SlimState, ToWebview } from "../shared/webview";

interface VsCodeApi {
	postMessage(msg: FromWebview): void;
	setState(state: unknown): void;
	getState(): unknown;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
const post = (msg: FromWebview) => vscode.postMessage(msg);

// ---------- small DOM helpers ----------
type Attrs = Record<string, string | boolean | undefined | ((ev: Event) => void)>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === false) continue;
		if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
		else if (k === "class") el.className = String(v);
		else if (v === true) el.setAttribute(k, "");
		else el.setAttribute(k, v);
	}
	for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
	return el;
}
function rec(v: unknown): Record<string, unknown> | undefined {
	// Plain JSON objects from the extension; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}
function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

// ---------- markdown ----------
const md = new Marked({ gfm: true, breaks: false });
md.use({
	renderer: {
		html(token: Tokens.HTML | Tokens.Tag) {
			return escapeHtml(token.text);
		},
		link(token: Tokens.Link) {
			const text = this.parser.parseInline(token.tokens);
			const href = token.href ?? "";
			if (/^https?:/i.test(href)) return `<a class="ext-link" data-url="${escapeHtml(href)}" title="${escapeHtml(href)}">${text}</a>`;
			return `<span class="maybe-path" data-candidate="${escapeHtml(href.replace(/^file:\/\//, ""))}">${text}</span>`;
		},
		image(token: Tokens.Image) {
			return escapeHtml(`![${token.text}](${token.href})`);
		},
	},
});
function renderMarkdown(text: string): string {
	try {
		return md.parse(text, { async: false });
	} catch {
		return `<pre>${escapeHtml(text)}</pre>`;
	}
}

// ---------- state ----------
let meta: SessionMeta | null = null;
let state: SlimState | null = null;
let commands: SlashCommand[] = [];
let connected = false;
let home = "";
const changesByTool = new Map<string, FileChange>();
const pendingUi = new Map<string, UiRequest>();
const widgets = new Map<string, string[]>();
const statuses = new Map<string, string>();
let agentBusy = false;
let totalCost = 0;

// ---------- layout ----------
const app = document.getElementById("app") as HTMLElement;
const header = h("div", { class: "header" });
const banner = h("div", { class: "banner hidden" });
const transcript = h("div", { class: "transcript" });
const jumpBtn = h("button", { class: "jump hidden", title: "Scroll to bottom", onclick: () => scrollToBottom(true) }, "↓");
const dialogs = h("div", { class: "dialogs" });
const todoBox = h("div", { class: "todos hidden" });
const widgetBox = h("div", { class: "widgets hidden" });
const queueBox = h("div", { class: "queue hidden" });
const popup = h("div", { class: "popup hidden" });
const input = h("textarea", { class: "input", rows: "1", placeholder: "Ask omp…  (Enter send · Shift+Enter newline · / commands · @ files)" });
const sendBtn = h("button", { class: "send", title: "Send (Enter)" }, "Send");
const stopBtn = h("button", { class: "stop hidden", title: "Interrupt (Esc)" }, "Stop");
const footer = h("div", { class: "footer" });
const composer = h("div", { class: "composer" }, popup, queueBox, h("div", { class: "input-row" }, input, h("div", { class: "buttons" }, stopBtn, sendBtn)), footer);
const main = h("div", { class: "main" }, transcript, jumpBtn);
app.append(header, banner, main, dialogs, todoBox, widgetBox, composer);

// ---------- scrolling ----------
let stickToBottom = true;
transcript.addEventListener("scroll", () => {
	stickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
	jumpBtn.classList.toggle("hidden", stickToBottom);
});
function scrollToBottom(force = false): void {
	if (force) stickToBottom = true;
	if (stickToBottom) transcript.scrollTop = transcript.scrollHeight;
	jumpBtn.classList.toggle("hidden", stickToBottom);
}
let scrollQueued = false;
function queueScroll(): void {
	if (scrollQueued) return;
	scrollQueued = true;
	requestAnimationFrame(() => {
		scrollQueued = false;
		scrollToBottom();
	});
}

// ---------- path linking ----------
const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10}(?::\d+(?:[:-]\d+)?)?|(?:~\/|\/)(?:[\w@.+-]+\/)*[\w@.+-]+/g;
const pathCache = new Map<string, string | null>();
const pathWaiters = new Map<number, string[]>();
let pathReq = 0;

function splitLine(candidate: string): { file: string; line?: number; col?: number } {
	const m = /^(.*?)(?::(\d+)(?:[:-](\d+))?)?$/.exec(candidate);
	if (!m) return { file: candidate };
	return { file: m[1], line: m[2] ? Number(m[2]) : undefined, col: m[3] && candidate.includes(`:${m[2]}:`) ? Number(m[3]) : undefined };
}

/** Wraps path-looking tokens in text nodes under `root` and asks the extension which exist. */
function linkifyPaths(root: HTMLElement): void {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent || parent.closest("a, .file-link, .maybe-path, button, .diff")) return NodeFilter.FILTER_REJECT;
			return /[./]/.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		},
	});
	const nodes: Text[] = [];
	while (walker.nextNode()) nodes.push(walker.currentNode as Text);
	for (const node of nodes.slice(0, 400)) {
		const text = node.nodeValue ?? "";
		PATH_RE.lastIndex = 0;
		let last = 0;
		let m: RegExpExecArray | null;
		const frag = document.createDocumentFragment();
		let found = false;
		while ((m = PATH_RE.exec(text))) {
			const token = m[0].replace(/[.,;:)]+$/, "");
			if (token.length < 3 || /^\d+(\.\d+)*$/.test(token) || /^v?\d/.test(token) || token.startsWith("//")) continue;
			const { file } = splitLine(token);
			if (!file.includes("/") && !/\.[A-Za-z]{1,6}$/.test(file)) continue;
			found = true;
			frag.append(text.slice(last, m.index));
			frag.append(h("span", { class: "maybe-path", "data-candidate": token }, token));
			last = m.index + token.length;
		}
		if (!found) continue;
		frag.append(text.slice(last));
		node.replaceWith(frag);
	}
	for (const code of root.querySelectorAll<HTMLElement>("code")) {
		if (code.closest("pre") || code.querySelector(".maybe-path")) continue;
		const t = (code.textContent ?? "").trim();
		if (t && t.length < 300 && !/\s/.test(t) && /[./]/.test(t)) {
			code.classList.add("maybe-path");
			code.dataset.candidate = t;
		}
	}
	resolveCandidates(root);
}

function resolveCandidates(root: HTMLElement): void {
	const want: string[] = [];
	for (const el of root.querySelectorAll<HTMLElement>(".maybe-path")) {
		const c = el.dataset.candidate ?? "";
		const { file } = splitLine(c);
		if (pathCache.has(file)) applyResolution(el, pathCache.get(file) ?? null);
		else if (!want.includes(file)) want.push(file);
	}
	if (want.length === 0) return;
	const reqId = ++pathReq;
	pathWaiters.set(reqId, want);
	post({ type: "resolvePaths", reqId, candidates: want });
}

function applyResolution(el: HTMLElement, abs: string | null): void {
	if (!abs) {
		el.classList.remove("maybe-path");
		return;
	}
	const { line, col } = splitLine(el.dataset.candidate ?? "");
	el.classList.remove("maybe-path");
	el.classList.add("file-link");
	el.dataset.path = abs;
	if (line) el.dataset.line = String(line);
	if (col) el.dataset.col = String(col);
	el.title = `${abs}${line ? `:${line}` : ""} — click to open`;
}

function onPathsResolved(reqId: number, resolved: Record<string, string>): void {
	const asked = pathWaiters.get(reqId) ?? [];
	pathWaiters.delete(reqId);
	for (const c of asked) pathCache.set(c, resolved[c] ?? null);
	for (const el of document.querySelectorAll<HTMLElement>(".maybe-path")) {
		const { file } = splitLine(el.dataset.candidate ?? "");
		if (pathCache.has(file)) applyResolution(el, pathCache.get(file) ?? null);
	}
}

function fileLink(rawPath: string, label?: string, line?: number): HTMLElement {
	const el = h("a", { class: "file-link", "data-path": rawPath, title: `${rawPath} — click to open` }, label ?? shortPath(rawPath));
	if (line) el.dataset.line = String(line);
	return el;
}

function shortPath(p: string): string {
	const cwd = meta?.cwd ?? "";
	if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
	if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
	return p;
}

document.addEventListener("click", ev => {
	const target = ev.target as HTMLElement | null;
	const link = target?.closest<HTMLElement>(".file-link");
	if (link?.dataset.path) {
		ev.preventDefault();
		post({ type: "openFile", path: link.dataset.path, line: link.dataset.line ? Number(link.dataset.line) : undefined, column: link.dataset.col ? Number(link.dataset.col) : undefined });
		return;
	}
	const ext = target?.closest<HTMLElement>(".ext-link");
	if (ext?.dataset.url) {
		ev.preventDefault();
		post({ type: "openUrl", url: ext.dataset.url });
		return;
	}
	if (!target?.closest(".popup, .menu, .menu-btn, .model-btn")) closeMenus();
});

// ---------- diff rendering ----------
function renderDiff(diff: string, maxLines = 400): HTMLElement {
	const box = h("div", { class: "diff" });
	const lines = diff.split("\n");
	for (const line of lines.slice(0, maxLines)) {
		const sign = line[0];
		const cls = sign === "+" ? "add" : sign === "-" ? "del" : line.startsWith("@@") || line.startsWith("…") ? "hunk" : "ctx";
		// omp diff rows look like "+12|code" / " 3|code"
		const m = /^([+\- ])\s*(\d+)\|(.*)$/.exec(line);
		if (m) box.append(h("div", { class: `dl ${cls}` }, h("span", { class: "ln" }, m[2]), h("span", { class: "sg" }, m[1] === " " ? " " : m[1]), h("span", { class: "tx" }, m[3])));
		else box.append(h("div", { class: `dl ${cls}` }, h("span", { class: "ln" }, ""), h("span", { class: "sg" }, sign === "+" || sign === "-" ? sign : " "), h("span", { class: "tx" }, sign === "+" || sign === "-" ? line.slice(1) : line)));
	}
	if (lines.length > maxLines) box.append(h("div", { class: "dl hunk" }, `… ${lines.length - maxLines} more lines — open the diff to see everything`));
	return box;
}

function diffStats(diff: string): { add: number; del: number } {
	let add = 0;
	let del = 0;
	for (const l of diff.split("\n")) {
		if (l.startsWith("+")) add++;
		else if (l.startsWith("-")) del++;
	}
	return { add, del };
}

// ---------- tool cards ----------
interface ToolCard {
	id: string;
	name: string;
	el: HTMLElement;
	head: HTMLElement;
	summary: HTMLElement;
	statusEl: HTMLElement;
	body: HTMLElement;
	args: Record<string, unknown>;
	intent?: string;
	status: "pending" | "running" | "done" | "error";
	result?: { content?: unknown; details?: Record<string, unknown> };
	live?: string;
}
const cards = new Map<string, ToolCard>();

const TOOL_ICON: Record<string, string> = {
	read: "📄",
	write: "📝",
	edit: "✏️",
	ast_edit: "✏️",
	bash: "❯",
	grep: "🔎",
	glob: "🗂",
	find: "🔎",
	task: "🤖",
	web_search: "🌐",
	todo: "☑",
	ask: "❓",
	lsp: "🧠",
	eval: "λ",
	browser: "🧭",
	notebook: "📓",
	wait: "⏳",
	debug: "🐞",
};
const AUTO_OPEN: Record<string, true> = { edit: true, write: true, ast_edit: true, ask: true };

function editPaths(args: Record<string, unknown>): string[] {
	const out: string[] = [];
	if (typeof args.path === "string") out.push(args.path);
	const inputText = str(args.input) || str(args.patch);
	for (const m of inputText.matchAll(/^\[([^\]\n#]+)#[0-9A-Za-z]{2,8}\]/gm)) out.push(m[1].trim());
	for (const m of inputText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
	return [...new Set(out)];
}

function toolSummary(card: ToolCard): Array<Node | string> {
	const a = card.args;
	const name = card.name;
	const parts: Array<Node | string> = [];
	const pathArg = str(a.path) || str(a.file) || str(a.file_path);
	switch (name) {
		case "read": {
			if (pathArg && !pathArg.includes("://")) parts.push(fileLink(pathArg.replace(/:[\d+,-]+(?::raw)?$/, ""), pathArg));
			else if (pathArg) parts.push(pathArg);
			break;
		}
		case "write":
			if (pathArg) parts.push(fileLink(pathArg));
			break;
		case "edit":
		case "ast_edit": {
			const ps = editPaths(a);
			ps.forEach((p, i) => {
				if (i) parts.push(", ");
				parts.push(fileLink(p));
			});
			if (!ps.length && str(a.input)) parts.push(h("span", { class: "dim" }, "…"));
			break;
		}
		case "bash":
			parts.push(h("code", {}, str(a.command).split("\n")[0].slice(0, 200)));
			break;
		case "grep":
			parts.push(h("code", {}, str(a.pattern)), a.path ? " in " : "", a.path ? str(a.path) : "");
			break;
		case "glob":
			parts.push(h("code", {}, str(a.path) || str(a.pattern)));
			break;
		case "web_search":
			parts.push(str(a.query));
			break;
		default: {
			const first = Object.entries(a).find(([k, v]) => k !== "i" && typeof v === "string" && v.length < 160);
			if (first) parts.push(h("span", { class: "dim" }, String(first[1])));
		}
	}
	return parts;
}

function getCard(id: string, name: string): ToolCard {
	let card = cards.get(id);
	if (card) return card;
	const statusEl = h("span", { class: "tstatus pending" });
	const summary = h("span", { class: "tsummary" });
	const head = h("div", { class: "thead" }, statusEl, h("span", { class: "ticon" }, TOOL_ICON[name] ?? "⚙"), h("span", { class: "tname" }, name), summary);
	const body = h("div", { class: "tbody" });
	const el = h("details", { class: `tool tool-${name}` }, h("summary", {}, head), body);
	if (AUTO_OPEN[name]) el.setAttribute("open", "");
	card = { id, name, el, head, summary, statusEl, body, args: {}, status: "pending" };
	cards.set(id, card);
	return card;
}

function updateCard(card: ToolCard): void {
	card.statusEl.className = `tstatus ${card.status}`;
	card.summary.replaceChildren(...(card.intent ? [h("span", { class: "intent" }, card.intent), " "] : []), ...toolSummary(card));
	const body = card.body;
	body.replaceChildren();
	const a = card.args;
	const details = card.result?.details ?? {};
	const resultText = contentText(card.result?.content);
	const change = changesByTool.get(card.id);

	if (card.name === "edit" || card.name === "ast_edit" || card.name === "write") {
		const files = Array.isArray(details.perFileResults) ? details.perFileResults.map(f => rec(f) ?? {}) : details.diff ? [details] : [];
		if (files.length) {
			for (const f of files) {
				const p = str(f.path);
				const diff = str(f.diff);
				const stats = diffStats(diff);
				body.append(
					h(
						"div",
						{ class: "file-head" },
						p ? fileLink(p, undefined, typeof f.firstChangedLine === "number" ? f.firstChangedLine : undefined) : "",
						h("span", { class: "stats" }, h("span", { class: "add" }, `+${stats.add}`), " ", h("span", { class: "del" }, `-${stats.del}`)),
						h("button", { class: "mini", onclick: (e: Event) => (e.preventDefault(), post({ type: "openDiff", toolCallId: card.id, path: p })) }, "Open diff"),
					),
				);
				if (diff) body.append(renderDiff(diff, 60));
			}
		} else if (card.name === "write" && typeof a.content === "string") {
			const p = str(a.path);
			const lines = a.content.split("\n");
			body.append(
				h(
					"div",
					{ class: "file-head" },
					p ? fileLink(p) : "",
					h("span", { class: "stats" }, h("span", { class: "add" }, `${lines.length} lines`)),
					change ? h("button", { class: "mini", onclick: (e: Event) => (e.preventDefault(), post({ type: "openDiff", toolCallId: card.id, path: p })) }, "Open diff") : "",
				),
				renderDiff(lines.slice(0, 40).map(l => `+${l}`).join("\n") + (lines.length > 40 ? `\n… ${lines.length - 40} more lines` : ""), 41),
			);
		} else if (str(a.input)) {
			body.append(h("pre", { class: "out" }, str(a.input).slice(0, 4000)));
		}
		if (details.diagnosticsSummary) body.append(h("div", { class: "dim small" }, str(details.diagnosticsSummary)));
		if (card.status === "error" && resultText) body.append(h("pre", { class: "out error" }, resultText));
	} else if (card.name === "bash") {
		body.append(h("pre", { class: "cmd" }, `$ ${str(a.command)}`));
		const out = card.status === "running" ? card.live ?? "" : resultText;
		if (out) body.append(h("pre", { class: `out${card.status === "error" ? " error" : ""}` }, out));
	} else if (card.name === "ask") {
		const qs = Array.isArray(a.questions) ? a.questions : [];
		for (const q of qs) body.append(h("div", { class: "small" }, `❓ ${str(rec(q)?.question)}`));
		if (resultText) body.append(h("pre", { class: "out" }, resultText));
	} else {
		const argText = JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => k !== "i")), null, 2);
		if (argText && argText !== "{}") body.append(h("pre", { class: "args" }, argText.length > 6000 ? `${argText.slice(0, 6000)}\n…` : argText));
		const out = card.status === "running" ? card.live ?? "" : resultText;
		if (out) body.append(h("pre", { class: `out${card.status === "error" ? " error" : ""}` }, out));
	}
	if (change && !body.querySelector(".mini")) {
		for (const f of change.files) {
			body.append(
				h(
					"div",
					{ class: "file-head" },
					fileLink(f.path),
					h("span", { class: "dim" }, f.op),
					h("button", { class: "mini", onclick: (e: Event) => (e.preventDefault(), post({ type: "openDiff", toolCallId: card.id, path: f.path })) }, "Open diff"),
				),
			);
		}
	}
	linkifyPaths(body);
	resolveCandidates(card.summary);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(b => rec(b))
		.filter(b => b?.type === "text")
		.map(b => str(b?.text))
		.join("\n");
}

let cardTimers = new Map<string, number>();
function scheduleCard(card: ToolCard): void {
	if (cardTimers.has(card.id)) return;
	cardTimers.set(
		card.id,
		requestAnimationFrame(() => {
			cardTimers.delete(card.id);
			updateCard(card);
			queueScroll();
		}),
	);
}

// ---------- messages ----------
const messageEls = new Map<string, HTMLElement>();
let anonSeq = 0;

function renderUser(m: Record<string, unknown>): HTMLElement {
	const text = contentText(m.content);
	const agentAuthored = m.attribution === "agent";
	const el = h("div", { class: `msg user${agentAuthored ? " agent-authored" : ""}` });
	const bubble = h("div", { class: "bubble" });
	bubble.innerHTML = renderMarkdown(text);
	el.append(bubble);
	if (Array.isArray(m.content)) {
		for (const b of m.content) {
			const r = rec(b);
			if (r?.type === "image" && typeof r.data === "string") el.append(h("img", { class: "thumb", src: `data:${str(r.mimeType)};base64,${r.data}` }));
		}
	}
	linkifyPaths(bubble);
	return el;
}

function renderAssistantInto(el: HTMLElement, m: Record<string, unknown>, live: boolean): void {
	const blocks = Array.isArray(m.content) ? m.content : [];
	// Keep children aligned with content indexes; reuse tool cards.
	blocks.forEach((raw, i) => {
		const b = rec(raw) ?? {};
		let child = el.children[i] as HTMLElement | undefined;
		const kind = str(b.type);
		if (child && child.dataset.kind !== kind) {
			child.remove();
			child = undefined;
		}
		if (kind === "text") {
			const text = str(b.text);
			if (!child) {
				child = h("div", { class: "md", "data-kind": kind });
				el.insertBefore(child, el.children[i] ?? null);
			}
			if (child.dataset.src !== text) {
				child.dataset.src = text;
				child.innerHTML = renderMarkdown(text);
				if (!live) linkifyPaths(child);
			}
		} else if (kind === "thinking") {
			const text = str(b.thinking).trim();
			if (!child) {
				child = h("details", { class: "thinking", "data-kind": kind }, h("summary", {}, "Thinking"), h("div", { class: "md" }));
				el.insertBefore(child, el.children[i] ?? null);
			}
			const sum = child.querySelector("summary") as HTMLElement;
			sum.textContent = live && i === blocks.length - 1 ? "Thinking…" : "Thinking";
			const body = child.querySelector(".md") as HTMLElement;
			if (body.dataset.src !== text) {
				body.dataset.src = text;
				body.innerHTML = renderMarkdown(text);
			}
			child.classList.toggle("hidden", !text);
		} else if (kind === "toolCall") {
			const id = str(b.id);
			const card = getCard(id, str(b.name));
			card.args = rec(b.arguments) ?? {};
			card.intent = str(b.intent) || card.intent;
			card.el.dataset.kind = kind;
			if (child !== card.el) {
				if (child) child.remove();
				el.insertBefore(card.el, el.children[i] ?? null);
			}
			scheduleCard(card);
		} else if (!child) {
			el.insertBefore(h("div", { "data-kind": kind }), el.children[i] ?? null);
		}
	});
	while (el.children.length > blocks.length) {
		const extra = el.lastElementChild;
		if (!extra || extra.classList.contains("msg-error") || extra.classList.contains("msg-aborted")) break;
		extra.remove();
	}
	el.querySelectorAll(":scope > .msg-error, :scope > .msg-aborted").forEach(e => e.remove());
	if (!live && m.stopReason === "error") el.append(h("div", { class: "msg-error" }, `⚠ ${str(m.errorMessage) || "The model request failed."}`));
	if (!live && m.stopReason === "aborted") el.append(h("div", { class: "msg-aborted" }, "Interrupted"));
}

function applyToolResult(m: Record<string, unknown>): void {
	const id = str(m.toolCallId);
	const card = cards.get(id) ?? getCard(id, str(m.toolName) || "tool");
	if (!card.el.isConnected) transcript.append(h("div", { class: "msg assistant" }, card.el));
	card.result = { content: m.content, details: rec(m.details) };
	card.status = m.isError ? "error" : "done";
	scheduleCard(card);
}

function renderOther(m: Record<string, unknown>): HTMLElement | null {
	if (m.display === false) return null;
	const role = str(m.role);
	const text = contentText(m.content) || str(m.summary) || str(m.output);
	if (role === "compactionSummary" || role === "branchSummary") {
		return h("div", { class: "divider" }, role === "compactionSummary" ? "Context compacted" : "Branch summary");
	}
	if (role === "bashExecution") {
		return h("details", { class: "tool tool-bash" }, h("summary", {}, h("div", { class: "thead" }, h("span", { class: "tstatus done" }), h("span", { class: "ticon" }, "!"), h("code", {}, str(m.command)))), h("pre", { class: "out" }, str(m.output)));
	}
	if (!text.trim()) return null;
	const label = str(m.customType) || role || "note";
	return h("details", { class: "note" }, h("summary", {}, `ℹ ${label}`), h("pre", { class: "out" }, text.slice(0, 20000)));
}

function addMessage(message: unknown, messageId?: string, live = false): void {
	const m = rec(message);
	if (!m) return;
	const role = str(m.role);
	if (role === "toolResult") {
		applyToolResult(m);
		return;
	}
	const key = messageId ?? `anon-${++anonSeq}`;
	let el = messageEls.get(key);
	if (role === "user") {
		if (!el) {
			el = renderUser(m);
			messageEls.set(key, el);
			transcript.append(el);
		}
	} else if (role === "assistant") {
		if (!el) {
			el = h("div", { class: "msg assistant" });
			messageEls.set(key, el);
			transcript.append(el);
		}
		renderAssistantInto(el, m, live);
		const cost = rec(m.usage)?.cost;
		if (!live && typeof cost === "number") {
			totalCost += cost;
			renderFooter();
		}
	} else if (!el) {
		const other = renderOther(m);
		if (other) {
			messageEls.set(key, other);
			transcript.append(other);
		}
	}
	queueScroll();
}

function appendNotice(text: string, level: "info" | "warning" | "error" = "info"): void {
	transcript.append(h("div", { class: `notice ${level}` }, text));
	queueScroll();
}

// ---------- dialogs (omp UI requests) ----------
function renderDialogs(): void {
	dialogs.replaceChildren(...[...pendingUi.values()].map(renderDialog));
	if (pendingUi.size) queueScroll();
}

function respond(id: string, res: Record<string, unknown>): void {
	post({ type: "uiResponse", res: { id, ...res } });
	pendingUi.delete(id);
	renderDialogs();
}

function renderDialog(req: UiRequest): HTMLElement {
	const box = h("div", { class: "dialog" });
	const cancel = h("button", { class: "secondary", onclick: () => respond(req.id, { cancelled: true }) }, "Dismiss");
	switch (req.method) {
		case "select": {
			box.append(h("div", { class: "dtitle" }, str(req.title)));
			const options = Array.isArray(req.options) ? req.options.map(String) : [];
			const detailsList = Array.isArray(req.optionDetails) ? req.optionDetails : [];
			const list = h("div", { class: "options" });
			options.forEach((opt, i) => {
				const desc = str(rec(detailsList[i])?.description);
				list.append(h("button", { class: "option", onclick: () => respond(req.id, { value: opt }) }, h("span", { class: "olabel" }, opt), desc ? h("span", { class: "odesc" }, desc) : ""));
			});
			box.append(list, h("div", { class: "dactions" }, cancel));
			break;
		}
		case "confirm":
			box.append(
				h("div", { class: "dtitle" }, str(req.title)),
				h("div", { class: "dmsg" }, str(req.message)),
				h("div", { class: "dactions" }, h("button", { onclick: () => respond(req.id, { confirmed: true }) }, "Yes"), h("button", { class: "secondary", onclick: () => respond(req.id, { confirmed: false }) }, "No")),
			);
			break;
		case "input":
		case "editor": {
			const field =
				req.method === "editor"
					? h("textarea", { class: "dinput", rows: "6" })
					: h("input", { class: "dinput", type: "text", placeholder: str(req.placeholder) });
			field.value = str(req.prefill);
			const submit = () => respond(req.id, { value: field.value });
			field.addEventListener("keydown", e => {
				const ke = e as KeyboardEvent;
				if (ke.key === "Enter" && (req.method === "input" || ke.metaKey || ke.ctrlKey)) {
					e.preventDefault();
					submit();
				}
			});
			box.append(h("div", { class: "dtitle" }, str(req.title)), field, h("div", { class: "dactions" }, h("button", { onclick: submit }, "Submit"), cancel));
			setTimeout(() => field.focus(), 0);
			break;
		}
		case "ask": {
			const questions = Array.isArray(req.questions) ? req.questions.map(q => rec(q) ?? {}) : [];
			const answers = questions.map(() => ({ selected: new Set<string>(), custom: "" }));
			questions.forEach((q, qi) => {
				const multi = !!q.multi;
				const opts = Array.isArray(q.options) ? q.options.map(o => rec(o) ?? {}) : [];
				const wrap = h("div", { class: "question" }, q.header ? h("span", { class: "chip" }, str(q.header)) : "", h("div", { class: "dtitle" }, str(q.question)));
				const list = h("div", { class: "options" });
				const buttons: HTMLButtonElement[] = [];
				opts.forEach((o, oi) => {
					const label = str(o.label);
					const btn = h(
						"button",
						{
							class: "option",
							onclick: () => {
								const set = answers[qi].selected;
								if (multi) {
									if (set.has(label)) set.delete(label);
									else set.add(label);
								} else {
									set.clear();
									set.add(label);
								}
								buttons.forEach(b => b.classList.toggle("selected", set.has(b.dataset.label ?? "")));
								if (!multi && questions.length === 1) submitAsk();
							},
						},
						h("span", { class: "olabel" }, `${label}${q.recommended === oi ? " (recommended)" : ""}`),
						o.description ? h("span", { class: "odesc" }, str(o.description)) : "",
					);
					btn.dataset.label = label;
					buttons.push(btn);
					list.append(btn);
				});
				const other = h("input", { class: "dinput", type: "text", placeholder: "Other (type your own)…" });
				other.addEventListener("input", () => (answers[qi].custom = other.value));
				other.addEventListener("keydown", e => {
					if ((e as KeyboardEvent).key === "Enter") {
						e.preventDefault();
						submitAsk();
					}
				});
				wrap.append(list, other);
				box.append(wrap);
			});
			const submitAsk = () =>
				respond(req.id, {
					answers: questions.map((q, i) => ({ id: str(q.id), selectedOptions: [...answers[i].selected], ...(answers[i].custom.trim() ? { customInput: answers[i].custom.trim() } : {}) })),
				});
			box.append(h("div", { class: "dactions" }, h("button", { onclick: submitAsk }, "Submit"), cancel));
			break;
		}
		default:
			box.append(h("div", { class: "dtitle" }, `${req.method}`), h("div", { class: "dactions" }, cancel));
	}
	return box;
}

// ---------- header / footer / banners ----------
let menuEl: HTMLElement | null = null;
function closeMenus(): void {
	menuEl?.remove();
	menuEl = null;
	if (!popup.classList.contains("hidden") && popupKind !== "complete") hidePopup();
}

function openMenu(anchor: HTMLElement, items: Array<[string, () => void] | null>): void {
	closeMenus();
	const menu = h("div", { class: "menu" });
	for (const it of items) {
		if (!it) {
			menu.append(h("div", { class: "sep" }));
			continue;
		}
		menu.append(h("button", { onclick: () => (closeMenus(), it[1]()) }, it[0]));
	}
	const r = anchor.getBoundingClientRect();
	menu.style.top = `${r.bottom + 4}px`;
	menu.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
	document.body.append(menu);
	menuEl = menu;
}

function renderHeader(): void {
	const status = meta?.status ?? "starting";
	const label = status === "waiting" ? "needs input" : status;
	const menuBtn = h("button", { class: "menu-btn", title: "Session actions" }, "⋯");
	menuBtn.addEventListener("click", () =>
		openMenu(menuBtn, [
			["Changed files…", () => post({ type: "command", name: "sessionChanges" })],
			["Compact context", () => post({ type: "command", name: "compact" })],
			["Rename session…", () => post({ type: "command", name: "rename" })],
			null,
			["New session in this folder", () => post({ type: "command", name: "newSession" })],
			status === "stopped" ? ["Resume session", () => post({ type: "command", name: "resumeSession" })] : ["Stop session", () => post({ type: "command", name: "stopSession" })],
			["Open host log", () => post({ type: "command", name: "openLog" })],
		]),
	);
	header.replaceChildren(
		h("span", { class: `dot ${status}`, title: label }),
		h("span", { class: "title", title: meta?.cwd ?? "" }, meta?.title ?? "omp"),
		h("span", { class: "cwd" }, meta ? shortPath(meta.cwd) || meta.cwd : ""),
		h("span", { class: "spacer" }),
		meta && meta.changedFiles > 0 ? h("button", { class: "chip-btn", title: "Files changed in this session", onclick: () => post({ type: "command", name: "sessionChanges" }) }, `± ${meta.changedFiles} file${meta.changedFiles === 1 ? "" : "s"}`) : "",
		menuBtn,
	);
	const stopped = status === "stopped";
	if (stopped) {
		banner.className = "banner";
		banner.replaceChildren(
			h("span", {}, `Session stopped${meta?.exitReason && meta.exitReason !== "stopped" ? ` (${meta.exitReason})` : ""}. Transcript is read-only — resume to continue.`),
			h("button", { onclick: () => post({ type: "command", name: "resumeSession" }) }, "Resume"),
		);
	} else if (!connected) {
		banner.className = "banner warn";
		banner.replaceChildren(h("span", { class: "spinner" }), h("span", {}, "Connecting to the session host…"));
	} else {
		banner.className = "banner hidden";
	}
	input.disabled = stopped;
	sendBtn.disabled = stopped;
	vscode.setState({ sessionId: meta?.id });
}

function renderFooter(): void {
	const model = state?.model;
	const modelBtn = h("button", { class: "model-btn", title: "Change model / thinking level" }, model ? model.name || model.id : "model");
	modelBtn.addEventListener("click", () => {
		post({ type: "getModels" });
		showModelPicker(modelBtn);
	});
	const ctx = state?.contextUsage;
	const pct = ctx ? Math.round(ctx.percent) : null;
	const busy = agentBusy || !!state?.isStreaming;
	footer.replaceChildren(
		modelBtn,
		state?.thinkingLevel ? h("span", { class: "pill", title: "Thinking level" }, `🧠 ${state.thinkingLevel}`) : "",
		pct !== null ? h("span", { class: `pill${pct > 80 ? " warn" : ""}`, title: `${ctx?.tokens?.toLocaleString()} / ${ctx?.contextWindow?.toLocaleString()} tokens` }, `ctx ${pct}%`) : "",
		totalCost > 0 ? h("span", { class: "pill", title: "Cost of messages shown" }, `$${totalCost.toFixed(2)}`) : "",
		...[...statuses.values()].filter(Boolean).map(s => h("span", { class: "pill dim" }, s)),
		h("span", { class: "spacer" }),
		busy ? h("span", { class: "working" }, h("span", { class: "spinner" }), state?.isCompacting ? "compacting" : "working") : h("span", { class: "dim" }, meta?.status === "stopped" ? "stopped" : "ready"),
	);
	stopBtn.classList.toggle("hidden", !busy);
	sendBtn.textContent = busy ? (meta ? "Queue" : "Send") : "Send";
	sendBtn.title = busy ? "Steer the running agent (Enter)" : "Send (Enter)";
}

function renderQueue(steering: string[], followUp: string[]): void {
	const chips = [
		...steering.map(t => ({ t, q: "steering" as const })),
		...followUp.map(t => ({ t, q: "followUp" as const })),
	];
	queueBox.classList.toggle("hidden", chips.length === 0);
	queueBox.replaceChildren(
		...chips.map(c =>
			h(
				"span",
				{ class: "qchip", title: c.q === "steering" ? "Will be injected into the running turn" : "Will run after this turn" },
				`${c.q === "steering" ? "↪" : "⏭"} ${c.t.slice(0, 80)}`,
				h("button", { class: "x", title: "Remove", onclick: () => post({ type: "removeQueued", text: c.t, queue: c.q }) }, "×"),
			),
		),
	);
}

function renderTodos(): void {
	const phases = state?.todoPhases ?? [];
	const tasks = phases.flatMap(p => p.tasks);
	if (!tasks.length) {
		todoBox.classList.add("hidden");
		return;
	}
	const done = tasks.filter(t => t.status === "completed" || t.status === "abandoned").length;
	const current = tasks.find(t => t.status === "in_progress");
	const icon: Record<string, string> = { completed: "✔", in_progress: "◐", pending: "○", abandoned: "✕", blocked: "⛔" };
	const wasOpen = todoBox.querySelector("details")?.hasAttribute("open") ?? false;
	const det = h(
		"details",
		{ open: wasOpen },
		h("summary", {}, `Todos ${done}/${tasks.length}`, current ? h("span", { class: "dim" }, ` — ${current.content}`) : ""),
		...phases.map(p => h("div", { class: "phase" }, phases.length > 1 ? h("div", { class: "pname" }, p.name) : "", ...p.tasks.map(t => h("div", { class: `todo ${t.status}` }, `${icon[t.status] ?? "○"} ${t.content}`)))),
	);
	todoBox.classList.remove("hidden");
	todoBox.replaceChildren(det);
}

function renderWidgets(): void {
	const lines = [...widgets.values()].flat();
	widgetBox.classList.toggle("hidden", lines.length === 0);
	widgetBox.replaceChildren(...lines.map(l => h("div", {}, l)));
}

// ---------- model picker ----------
let modelsCache: Array<{ provider: string; id: string; name?: string }> = [];
let levelsCache: string[] = [];
let pickerAnchor: HTMLElement | null = null;
function showModelPicker(anchor: HTMLElement): void {
	closeMenus();
	pickerAnchor = anchor;
	const menu = h("div", { class: "menu picker" });
	const filter = h("input", { class: "dinput", type: "text", placeholder: "Filter models…" });
	const list = h("div", { class: "plist" });
	const levels = h("div", { class: "levels" });
	const fill = () => {
		const q = filter.value.toLowerCase();
		list.replaceChildren(
			...modelsCache
				.filter(m => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(q))
				.slice(0, 200)
				.map(m =>
					h(
						"button",
						{ class: state?.model?.id === m.id && state?.model?.provider === m.provider ? "current" : "", onclick: () => (closeMenus(), post({ type: "setModel", provider: m.provider, id: m.id })) },
						h("span", {}, m.name ?? m.id),
						h("span", { class: "dim" }, ` ${m.provider}`),
					),
				),
		);
		if (!modelsCache.length) list.append(h("div", { class: "dim small" }, "Loading models…"));
		levels.replaceChildren(
			...levelsCache.map(l => h("button", { class: `lvl${state?.thinkingLevel === l ? " current" : ""}`, onclick: () => (closeMenus(), post({ type: "setThinking", level: l })) }, l)),
		);
	};
	filter.addEventListener("input", fill);
	menu.append(h("div", { class: "small dim" }, "Thinking"), levels, filter, list);
	const r = anchor.getBoundingClientRect();
	menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
	menu.style.left = `${r.left}px`;
	document.body.append(menu);
	menuEl = menu;
	(menu as HTMLElement & { refill?: () => void }).refill = fill;
	fill();
	filter.focus();
}

// ---------- composer ----------
let popupKind: "slash" | "file" | "complete" | null = null;
let popupItems: Array<{ label: string; detail?: string; insert: string }> = [];
let popupIndex = 0;
let fileReq = 0;
let fileTimer: number | undefined;

function hidePopup(): void {
	popup.classList.add("hidden");
	popupKind = null;
	popupItems = [];
}

function showPopup(kind: "slash" | "file", items: typeof popupItems): void {
	if (!items.length) {
		hidePopup();
		return;
	}
	popupKind = kind;
	popupItems = items;
	popupIndex = Math.min(popupIndex, items.length - 1);
	popup.classList.remove("hidden");
	popup.replaceChildren(
		...items.map((it, i) =>
			h(
				"div",
				{ class: `pitem${i === popupIndex ? " active" : ""}`, onmousedown: (e: Event) => (e.preventDefault(), acceptPopup(i)) },
				h("span", { class: "plabel" }, it.label),
				it.detail ? h("span", { class: "pdetail" }, it.detail) : "",
			),
		),
	);
	popup.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function acceptPopup(i = popupIndex): void {
	const it = popupItems[i];
	if (!it) return;
	const pos = input.selectionStart ?? input.value.length;
	const before = input.value.slice(0, pos);
	const after = input.value.slice(pos);
	if (popupKind === "slash") {
		input.value = `${it.insert} ${after.trimStart()}`;
		input.selectionStart = input.selectionEnd = it.insert.length + 1;
	} else if (popupKind === "file") {
		const start = before.lastIndexOf("@");
		const next = `${before.slice(0, start)}@${it.insert} `;
		input.value = next + after;
		input.selectionStart = input.selectionEnd = next.length;
	}
	hidePopup();
	autosize();
	input.focus();
}

function updateCompletion(): void {
	const pos = input.selectionStart ?? 0;
	const before = input.value.slice(0, pos);
	const slash = /^\/([\w:.-]*)$/.exec(before);
	if (slash) {
		const q = slash[1].toLowerCase();
		const items = commands
			.filter(c => c.name.toLowerCase().includes(q))
			.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
			.slice(0, 50)
			.map(c => ({ label: `/${c.name}${c.input?.hint ? ` ${c.input.hint}` : ""}`, detail: c.description, insert: `/${c.name}` }));
		showPopup("slash", items);
		return;
	}
	const at = /(?:^|\s)@([\w./-]*)$/.exec(before);
	if (at) {
		clearTimeout(fileTimer);
		const q = at[1];
		fileTimer = window.setTimeout(() => {
			post({ type: "suggestFiles", reqId: ++fileReq, query: q });
		}, 120);
		return;
	}
	if (popupKind) hidePopup();
}

function autosize(): void {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
}

function send(): void {
	const text = input.value.trim();
	if (!text || meta?.status === "stopped") return;
	post({ type: "prompt", text });
	input.value = "";
	autosize();
	hidePopup();
	scrollToBottom(true);
}

input.addEventListener("input", () => {
	autosize();
	updateCompletion();
});
input.addEventListener("keydown", e => {
	if (popupKind && popupItems.length) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			popupIndex = (popupIndex + (e.key === "ArrowDown" ? 1 : -1) + popupItems.length) % popupItems.length;
			showPopup(popupKind as "slash" | "file", popupItems);
			return;
		}
		if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
			e.preventDefault();
			acceptPopup();
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			hidePopup();
			return;
		}
	}
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
		e.preventDefault();
		send();
	} else if (e.key === "Escape" && (agentBusy || state?.isStreaming)) {
		e.preventDefault();
		post({ type: "abort" });
	}
});
sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => post({ type: "abort" }));

// ---------- event handling ----------
function resetTranscript(): void {
	transcript.replaceChildren();
	messageEls.clear();
	cards.clear();
	totalCost = 0;
}

function handleEvent(ev: OmpFrame): void {
	switch (ev.type) {
		case "message_start":
		case "message_update":
			addMessage(ev.message, str(ev.messageId), true);
			return;
		case "message_end":
			addMessage(ev.message, str(ev.messageId), false);
			{
				const el = messageEls.get(str(ev.messageId));
				if (el) linkifyPaths(el);
			}
			return;
		case "tool_execution_start": {
			const card = getCard(str(ev.toolCallId), str(ev.toolName));
			card.args = rec(ev.args) ?? card.args;
			card.intent = str(ev.intent) || card.intent;
			card.status = "running";
			if (!card.el.isConnected) transcript.append(h("div", { class: "msg assistant" }, card.el));
			scheduleCard(card);
			return;
		}
		case "tool_execution_update": {
			const card = cards.get(str(ev.toolCallId));
			if (!card) return;
			card.live = contentText(rec(ev.partialResult)?.content);
			card.status = "running";
			scheduleCard(card);
			return;
		}
		case "tool_execution_end": {
			const card = cards.get(str(ev.toolCallId)) ?? getCard(str(ev.toolCallId), str(ev.toolName));
			const r = rec(ev.result);
			card.result = { content: r?.content, details: rec(r?.details) };
			card.status = ev.isError ? "error" : "done";
			scheduleCard(card);
			return;
		}
		case "agent_start":
			agentBusy = true;
			renderFooter();
			return;
		case "agent_end":
		case "session_settled":
			agentBusy = ev.type === "agent_end" ? agentBusy : false;
			renderFooter();
			return;
		case "prompt_result": {
			if (ev.sessionSettled) agentBusy = false;
			const err = rec(ev.error);
			if (ev.status === "error" && err) appendNotice(`⚠ ${str(err.message)}`, "error");
			renderFooter();
			return;
		}
		case "auto_compaction_start":
			appendNotice("Compacting context…");
			return;
		case "auto_compaction_end":
			if (ev.errorMessage) appendNotice(`Compaction failed: ${str(ev.errorMessage)}`, "warning");
			else if (!ev.aborted && !ev.skipped) transcript.append(h("div", { class: "divider" }, "Context compacted"));
			return;
		case "auto_retry_start":
			appendNotice(`Retrying (${String(ev.attempt)}/${String(ev.maxAttempts)}) in ${Math.round(Number(ev.delayMs) / 1000)}s: ${str(ev.errorMessage)}`, "warning");
			return;
		case "auto_retry_end":
			if (!ev.success && ev.finalError) appendNotice(`Retries exhausted: ${str(ev.finalError)}`, "error");
			return;
		case "retry_fallback_applied":
			appendNotice(`Switched model ${str(ev.from)} → ${str(ev.to)}${ev.reason ? ` (${str(ev.reason)})` : ""}`, "warning");
			return;
		case "notice":
			appendNotice(str(ev.message), (str(ev.level) as "info" | "warning" | "error") || "info");
			return;
		case "command_output":
			transcript.append(h("pre", { class: "command-output" }, str(ev.text)));
			queueScroll();
			return;
		case "queue_update":
			renderQueue(Array.isArray(ev.steering) ? ev.steering.map(String) : [], Array.isArray(ev.followUp) ? ev.followUp.map(String) : []);
			return;
		case "available_commands_update":
			commands = Array.isArray(ev.commands) ? (ev.commands as SlashCommand[]) : commands;
			return;
		case "extension_ui_request":
			handleUiRequest(ev as unknown as UiRequest);
			return;
	}
}

function handleUiRequest(req: UiRequest): void {
	switch (req.method) {
		case "select":
		case "confirm":
		case "input":
		case "editor":
		case "ask":
			pendingUi.set(req.id, req);
			renderDialogs();
			return;
		case "cancel":
			pendingUi.delete(str(req.targetId));
			renderDialogs();
			return;
		case "notify":
			appendNotice(str(req.message), (str(req.notifyType) as "info" | "warning" | "error") || "info");
			return;
		case "setStatus":
			if (req.statusText) statuses.set(str(req.statusKey), str(req.statusText));
			else statuses.delete(str(req.statusKey));
			renderFooter();
			return;
		case "setWidget":
			if (Array.isArray(req.widgetLines) && req.widgetLines.length) widgets.set(str(req.widgetKey), req.widgetLines.map(String));
			else widgets.delete(str(req.widgetKey));
			renderWidgets();
			return;
		case "set_editor_text":
			input.value = str(req.text);
			autosize();
			return;
		case "open_url":
			transcript.append(
				h(
					"div",
					{ class: "notice info" },
					str(req.instructions) || "omp wants to open a URL:",
					" ",
					h("a", { class: "ext-link", "data-url": str(req.url) }, str(req.launchUrl) || str(req.url)),
				),
			);
			queueScroll();
			return;
	}
}

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
	const msg = event.data;
	switch (msg.type) {
		case "init": {
			meta = msg.meta;
			state = msg.state;
			commands = msg.commands;
			connected = msg.connected;
			home = msg.home;
			changesByTool.clear();
			for (const c of msg.changes) changesByTool.set(c.toolCallId, c);
			resetTranscript();
			for (const m of msg.messages) addMessage(m);
			if (msg.inflight) addMessage(msg.inflight.message, msg.inflight.messageId, true);
			for (const t of msg.runningTools) {
				const card = getCard(t.toolCallId, t.toolName);
				card.args = rec(t.args) ?? {};
				card.intent = t.intent;
				card.status = "running";
				card.live = contentText(rec(t.partialResult)?.content);
				if (!card.el.isConnected) transcript.append(h("div", { class: "msg assistant" }, card.el));
				scheduleCard(card);
			}
			pendingUi.clear();
			for (const r of msg.pendingUi) pendingUi.set(r.id, r);
			agentBusy = meta.status === "working";
			renderDialogs();
			renderHeader();
			renderFooter();
			renderTodos();
			renderQueue(state?.queuedMessages?.steering ?? [], state?.queuedMessages?.followUp ?? []);
			linkifyPaths(transcript);
			requestAnimationFrame(() => scrollToBottom(true));
			if (meta.status !== "stopped") input.focus();
			return;
		}
		case "event":
			handleEvent(msg.ev);
			return;
		case "state":
			state = msg.state;
			if (state?.isStreaming === false && meta?.status !== "working") agentBusy = false;
			renderFooter();
			renderTodos();
			renderQueue(state?.queuedMessages?.steering ?? [], state?.queuedMessages?.followUp ?? []);
			return;
		case "meta":
			meta = msg.meta;
			agentBusy = meta.status === "working" || (agentBusy && meta.status !== "idle" && meta.status !== "stopped");
			if (meta.status === "stopped") {
				pendingUi.clear();
				renderDialogs();
			}
			renderHeader();
			renderFooter();
			return;
		case "change":
			changesByTool.set(msg.change.toolCallId, msg.change);
			{
				const card = cards.get(msg.change.toolCallId);
				if (card) scheduleCard(card);
			}
			if (meta) {
				const files = new Set<string>();
				for (const c of changesByTool.values()) for (const f of c.files) files.add(f.path);
				meta = { ...meta, changedFiles: Math.max(meta.changedFiles, files.size) };
				renderHeader();
			}
			return;
		case "uiResolved":
			pendingUi.delete(msg.id);
			renderDialogs();
			return;
		case "reset":
			state = msg.state;
			resetTranscript();
			for (const m of msg.messages) addMessage(m);
			linkifyPaths(transcript);
			renderFooter();
			renderTodos();
			return;
		case "connection":
			connected = msg.connected;
			renderHeader();
			return;
		case "pathsResolved":
			onPathsResolved(msg.reqId, msg.resolved);
			return;
		case "fileSuggestions":
			if (msg.reqId !== fileReq) return;
			showPopup(
				"file",
				msg.files.map(f => ({ label: f, insert: f })),
			);
			return;
		case "models": {
			modelsCache = msg.models;
			levelsCache = msg.levels;
			const refill = (menuEl as (HTMLElement & { refill?: () => void }) | null)?.refill;
			if (refill && pickerAnchor) refill();
			return;
		}
		case "insertText": {
			const pos = input.selectionStart ?? input.value.length;
			const sep = pos > 0 && !/\s$/.test(input.value.slice(0, pos)) ? "\n" : "";
			input.value = `${input.value.slice(0, pos)}${sep}${msg.text}${input.value.slice(pos)}`;
			autosize();
			input.focus();
			return;
		}
		case "focusComposer":
			input.focus();
			return;
		case "error":
			appendNotice(`⚠ ${msg.message}`, "error");
			return;
	}
});

document.addEventListener("keydown", e => {
	if (e.key === "Escape" && menuEl) {
		e.preventDefault();
		closeMenus();
		input.focus();
	}
});

window.addEventListener("focus", () => {
	if (meta?.status !== "stopped" && !document.activeElement?.closest(".dialog, .menu")) input.focus();
});

renderHeader();
renderFooter();
post({ type: "ready" });
