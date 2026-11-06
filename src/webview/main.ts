// Chat UI for one omp session: transcript, tool cards with structured diffs, omp dialogs,
// attachments, and a composer with slash-command / @file completion.
import { Marked, type Tokens } from "marked";
import { type FileDiff, diffTexts, parseOmpDiff } from "../shared/diff";
import type { FileChange, OmpFrame, SessionMeta, UiRequest } from "../shared/protocol";
import type { DiffsByPath, PanelCommand, SlashCommand, SlimState, ToWebview } from "../shared/webview";
import { hasAnsi, renderAnsi } from "./ansi";
import { AttachmentTray } from "./attachments";
import { renderFileDiff } from "./diffview";
import { copyButton, escapeHtml, h, icon, post, rec, str, vscode } from "./dom";
import { fileLink, installLinkHandler, linkify, onPathsResolved, splitLine } from "./links";

// ---------- markdown ----------
const md = new Marked({ gfm: true, breaks: false });
md.use({
	renderer: {
		html(token: Tokens.HTML | Tokens.Tag) {
			return escapeHtml(token.text);
		},
		link(token: Tokens.Link) {
			const text = this.parser.parseInline(token.tokens);
			const href = (token.href ?? "").trim();
			return `<a class="ext-link" data-url="${escapeHtml(href)}" title="${escapeHtml(href)}">${text}</a>`;
		},
		image(token: Tokens.Image) {
			const href = token.href ?? "";
			if (/^(https?:|data:image\/)/.test(href)) return `<img class="md-img" src="${escapeHtml(href)}" alt="${escapeHtml(token.text)}">`;
			return `<a class="ext-link" data-url="${escapeHtml(href)}">${escapeHtml(token.text || href)}</a>`;
		},
		code(token: Tokens.Code) {
			const lang = (token.lang ?? "").split(/\s/)[0];
			return `<div class="codeblock"><div class="code-head"><span>${escapeHtml(lang || "text")}</span><span class="code-actions"></span></div><pre><code>${escapeHtml(token.text)}</code></pre></div>`;
		},
	},
});

function renderMarkdownInto(el: HTMLElement, text: string): void {
	try {
		el.innerHTML = md.parse(text, { async: false });
	} catch {
		el.replaceChildren(h("pre", {}, text));
	}
	for (const block of el.querySelectorAll<HTMLElement>(".codeblock")) {
		const code = block.querySelector("code");
		block.querySelector(".code-actions")?.append(copyButton(() => code?.textContent ?? "", "Copy code"));
	}
}

function renderText(el: HTMLElement, text: string): void {
	if (hasAnsi(text)) renderAnsi(text, el);
	else el.textContent = text;
}

// ---------- state ----------
let meta: SessionMeta | null = null;
let state: SlimState | null = null;
let commands: SlashCommand[] = [];
let connected = false;
let home = "";
const changesByTool = new Map<string, FileChange>();
const diffsByTool = new Map<string, DiffsByPath>();
const pendingUi = new Map<string, UiRequest>();
const widgets = new Map<string, string[]>();
const statuses = new Map<string, string>();
let agentBusy = false;
let totalCost = 0;
const logoUrl = document.body.dataset.logo ?? "";

// ---------- layout ----------
const app = document.getElementById("app") as HTMLElement;
const header = h("div", { class: "header" });
const banner = h("div", { class: "banner hidden" });
const transcript = h("div", { class: "transcript" });
const emptyState = h(
	"div",
	{ class: "empty" },
	logoUrl ? h("img", { class: "empty-logo", src: logoUrl, alt: "" }) : "",
	h("div", { class: "empty-title" }, "What should omp do?"),
	h("div", { class: "empty-hints" }, "Runs in the background on this machine — close the laptop, come back later.", h("br"), "/ commands · @ files · ! shell · paste images & files"),
);
const jumpBtn = h("button", { class: "jump hidden", title: "Scroll to bottom", onclick: () => scrollToBottom(true) }, "↓");
const dialogs = h("div", { class: "dialogs" });
const todoBox = h("div", { class: "todos hidden" });
const widgetBox = h("div", { class: "widgets hidden" });
const queueBox = h("div", { class: "queue hidden" });
const popup = h("div", { class: "popup hidden" });
const input = h("textarea", { class: "input", rows: "1", placeholder: "Ask omp…   / commands · @ files · ! shell · paste images or files" });
const attachBtn = h("button", { class: "icon-btn attach", title: "Attach images or files" }, icon("clip"));
const sendBtn = h("button", { class: "send", title: "Send (Enter)" }, icon("send"));
const stopBtn = h("button", { class: "stop hidden", title: "Interrupt (Esc)" }, icon("stop"));
const footer = h("div", { class: "footer" });
const tray = new AttachmentTray(
	() => updateSendState(),
	msg => appendNotice(msg, "warning"),
);
const inputBox = h("div", { class: "input-box" }, tray.el, input, h("div", { class: "input-actions" }, attachBtn, h("span", { class: "spacer" }), stopBtn, sendBtn));
const composer = h("div", { class: "composer" }, popup, queueBox, inputBox, footer);
const main = h("div", { class: "main" }, transcript, jumpBtn);
app.append(header, banner, main, dialogs, todoBox, widgetBox, composer);
installLinkHandler();

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

function shortPath(p: string): string {
	const cwd = meta?.cwd ?? "";
	if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
	if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
	return p;
}

function absPath(p: string): string {
	if (p.startsWith("/")) return p;
	if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
	return `${meta?.cwd ?? ""}/${p.replace(/^\.\//, "")}`;
}

function updateEmpty(): void {
	const has = transcript.querySelector(".msg, .notice, .tool, .command-output, .side-q");
	emptyState.classList.toggle("hidden", !!has);
	if (!emptyState.isConnected) transcript.prepend(emptyState);
}

// ---------- tool cards ----------
interface ToolCard {
	id: string;
	name: string;
	el: HTMLDetailsElement;
	statusEl: HTMLElement;
	summary: HTMLElement;
	badges: HTMLElement;
	body: HTMLElement;
	args: Record<string, unknown>;
	intent?: string;
	status: "pending" | "running" | "done" | "error";
	result?: { content?: unknown; details?: Record<string, unknown> };
	live?: string;
	subagents: Map<string, Record<string, unknown>>;
	userToggled?: boolean;
}
const cards = new Map<string, ToolCard>();

const TOOL_GLYPH: Record<string, string> = {
	read: "◱",
	write: "✚",
	edit: "✎",
	ast_edit: "✎",
	bash: "❯",
	grep: "⌕",
	glob: "⌕",
	find: "⌕",
	task: "⧉",
	web_search: "◍",
	todo: "☑",
	ask: "?",
	lsp: "λ",
	eval: "λ",
	browser: "◍",
	notebook: "▤",
	wait: "◷",
	debug: "⚑",
};
const EDIT_TOOLS: Record<string, true> = { edit: true, ast_edit: true, write: true, notebook: true };

function editPaths(args: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const k of ["path", "file", "file_path"]) if (typeof args[k] === "string") out.push(String(args[k]));
	const inputText = str(args.input) || str(args.patch);
	for (const m of inputText.matchAll(/^\[([^\]\n#]+)#[0-9A-Za-z]{2,8}\]/gm)) out.push(m[1].trim());
	for (const m of inputText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
	return [...new Set(out)];
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

function toolSummary(card: ToolCard): Array<Node | string> {
	const a = card.args;
	const pathArg = str(a.path) || str(a.file) || str(a.file_path);
	switch (card.name) {
		case "read": {
			if (!pathArg) return [];
			if (/^[a-z][a-z0-9+.-]+:\/\//i.test(pathArg)) return [h("a", { class: "ext-link", "data-url": pathArg }, pathArg)];
			const clean = pathArg.replace(/:raw$/, "");
			const { file, line } = splitLine(clean.replace(/:(\d+)[-+,].*$/, ":$1"));
			return [fileLink(absPath(file), shortPath(clean), line)];
		}
		case "write":
		case "edit":
		case "ast_edit":
		case "notebook": {
			const ps = editPaths(a);
			const out: Array<Node | string> = [];
			ps.forEach((p, i) => {
				if (i) out.push(h("span", { class: "dim" }, ", "));
				out.push(fileLink(absPath(p), shortPath(p)));
			});
			return out;
		}
		case "bash":
			return [h("code", { class: "no-link" }, str(a.command).split("\n")[0].slice(0, 240))];
		case "grep":
			return [h("code", {}, str(a.pattern)), a.path ? h("span", { class: "dim" }, ` in ${str(a.path)}`) : ""];
		case "glob":
			return [h("code", {}, str(a.path) || str(a.pattern))];
		case "web_search":
			return [h("span", {}, str(a.query))];
		case "task": {
			const tasks = Array.isArray(a.tasks) ? a.tasks.length : 0;
			return [h("span", { class: "dim" }, tasks ? `${tasks} subagent${tasks === 1 ? "" : "s"}` : str(a.agent))];
		}
		default: {
			const first = Object.entries(a).find(([k, v]) => k !== "i" && typeof v === "string" && v.length < 200);
			return first ? [h("span", { class: "dim" }, String(first[1]))] : [];
		}
	}
}

function getCard(id: string, name: string): ToolCard {
	const existing = cards.get(id);
	if (existing) return existing;
	const statusEl = h("span", { class: "tstatus pending" });
	const summary = h("span", { class: "tsummary" });
	const badges = h("span", { class: "tbadges" });
	const head = h("div", { class: "thead" }, statusEl, h("span", { class: "tglyph" }, TOOL_GLYPH[name] ?? "•"), h("span", { class: "tname" }, name), summary, badges);
	const body = h("div", { class: "tbody" });
	const el = h("details", { class: `tool tool-${name}` }, h("summary", {}, head), body);
	const card: ToolCard = { id, name, el, statusEl, summary, badges, body, args: {}, status: "pending", subagents: new Map() };
	el.addEventListener("toggle", () => {
		card.userToggled = true;
	});
	if (EDIT_TOOLS[name] || name === "ask") el.open = true;
	cards.set(id, card);
	return card;
}

/** Structured diffs for a card: extension-computed when available, else omp's diff rows. */
function cardDiffs(card: ToolCard): Array<{ path: string; diff: FileDiff; line?: number }> {
	const fromExt = diffsByTool.get(card.id);
	if (fromExt && Object.keys(fromExt).length) return Object.entries(fromExt).map(([path, diff]) => ({ path, diff, line: diff.hunks[0]?.lines.find(l => l.t !== " ")?.n }));
	const d = card.result?.details ?? {};
	const entries = Array.isArray(d.perFileResults) ? d.perFileResults.map(f => rec(f) ?? {}) : d.diff ? [d] : [];
	const out = entries
		.filter(e => typeof e.diff === "string" && e.diff)
		.map(e => ({ path: absPath(str(e.path) || editPaths(card.args)[0] || ""), diff: parseOmpDiff(str(e.diff)), line: typeof e.firstChangedLine === "number" ? e.firstChangedLine : undefined }));
	if (out.length) return out;
	if (card.name === "write" && typeof card.args.content === "string" && card.status !== "done") {
		const p = editPaths(card.args)[0];
		if (p) return [{ path: absPath(p), diff: diffTexts("", card.args.content) }];
	}
	return [];
}

function fileHeader(card: ToolCard, path: string, diff: FileDiff | undefined, line?: number): HTMLElement {
	const change = changesByTool.get(card.id)?.files.find(f => f.path === path);
	const op = change?.op === "create" ? "new" : change?.op === "delete" ? "deleted" : "";
	return h(
		"div",
		{ class: "file-head" },
		icon("file", "dim"),
		fileLink(path, shortPath(path), line),
		op ? h("span", { class: `op op-${op}` }, op) : "",
		diff ? h("span", { class: "stats" }, h("span", { class: "add" }, `+${diff.added}`), h("span", { class: "del" }, `−${diff.removed}`)) : "",
		h("span", { class: "spacer" }),
		h("button", { class: "mini", title: "Open in VS Code's diff editor", onclick: (e: Event) => (e.preventDefault(), post({ type: "openDiff", toolCallId: card.id, path })) }, icon("diff"), "Diff"),
		h("button", { class: "mini ghost", title: "Open file", onclick: (e: Event) => (e.preventDefault(), post({ type: "openFile", path, line })) }, "Open"),
	);
}

function outputBlock(text: string, error = false): HTMLElement {
	const pre = h("pre", { class: `out${error ? " error" : ""}` });
	renderText(pre, text);
	return h("div", { class: "out-wrap" }, pre, copyButton(() => text, "Copy output"));
}

function updateCard(card: ToolCard): void {
	card.statusEl.className = `tstatus ${card.status}`;
	card.summary.replaceChildren(...(card.intent ? [h("span", { class: "intent" }, card.intent)] : []), ...toolSummary(card));
	const body = card.body;
	body.replaceChildren();
	card.badges.replaceChildren();
	const a = card.args;
	const details = card.result?.details ?? {};
	const resultText = contentText(card.result?.content);

	if (EDIT_TOOLS[card.name]) {
		const diffs = cardDiffs(card);
		let added = 0;
		let removed = 0;
		for (const { path, diff, line } of diffs) {
			added += diff.added;
			removed += diff.removed;
			body.append(h("div", { class: "file-block" }, fileHeader(card, path, diff, line), renderFileDiff(diff, { onLine: n => post({ type: "openFile", path, line: n }) })));
		}
		if (!diffs.length) {
			const change = changesByTool.get(card.id);
			for (const f of change?.files ?? []) body.append(h("div", { class: "file-block" }, fileHeader(card, f.path, undefined)));
			if (!change && str(a.input) && card.status !== "done") body.append(h("pre", { class: "out dim" }, str(a.input).slice(0, 4000)));
		}
		if (diffs.length) card.badges.append(h("span", { class: "add" }, `+${added}`), h("span", { class: "del" }, `−${removed}`));
		if (details.diagnosticsSummary) body.append(h("div", { class: "diag" }, str(details.diagnosticsSummary)));
		if (card.status === "error" && resultText) body.append(outputBlock(resultText, true));
	} else if (card.name === "bash") {
		const cmd = h("pre", { class: "cmd no-link" }, `$ ${str(a.command)}`);
		body.append(cmd);
		const out = card.status === "running" ? (card.live ?? "") : resultText;
		if (out) body.append(outputBlock(out, card.status === "error"));
		const exit = details.exitCode;
		if (typeof exit === "number" && exit !== 0) card.badges.append(h("span", { class: "del" }, `exit ${exit}`));
	} else if (card.name === "task") {
		const list = h("div", { class: "subagents" });
		for (const s of card.subagents.values()) {
			const p = rec(s.progress) ?? {};
			const status = str(p.status) || str(s.status) || "running";
			list.append(
				h(
					"div",
					{ class: `subagent ${status}` },
					h("span", { class: `tstatus ${status === "completed" ? "done" : status === "failed" || status === "aborted" ? "error" : "running"}` }),
					h("span", { class: "sa-name" }, `${str(s.agent)}`),
					h("span", { class: "sa-desc" }, str(p.description) || str(s.description) || str(p.task).slice(0, 120)),
					h("span", { class: "sa-now dim" }, [str(p.lastIntent) || (p.currentTool ? `${str(p.currentTool)}…` : ""), typeof p.toolCount === "number" ? `${p.toolCount} tools` : ""].filter(Boolean).join(" · ")),
				),
			);
		}
		if (card.subagents.size) body.append(list);
		const out = card.status === "running" ? (card.live ?? "") : resultText;
		if (out) {
			const mdEl = h("div", { class: "md task-out" });
			renderMarkdownInto(mdEl, out.length > 40000 ? `${out.slice(0, 40000)}\n\n…` : out);
			body.append(mdEl);
		}
	} else if (card.name === "ask") {
		const qs = Array.isArray(a.questions) ? a.questions : [];
		for (const q of qs) body.append(h("div", { class: "small" }, str(rec(q)?.question)));
		if (resultText) body.append(outputBlock(resultText));
	} else {
		const shown = Object.fromEntries(Object.entries(a).filter(([k]) => k !== "i"));
		const argText = JSON.stringify(shown, null, 2);
		if (argText && argText !== "{}") body.append(h("pre", { class: "args" }, argText.length > 6000 ? `${argText.slice(0, 6000)}\n…` : argText));
		const out = card.status === "running" ? (card.live ?? "") : resultText;
		if (out) body.append(outputBlock(out, card.status === "error"));
	}
	linkify(body);
}

const cardFrames = new Map<string, number>();
function scheduleCard(card: ToolCard): void {
	if (cardFrames.has(card.id)) return;
	cardFrames.set(
		card.id,
		requestAnimationFrame(() => {
			cardFrames.delete(card.id);
			updateCard(card);
			queueScroll();
		}),
	);
}

function attachCard(card: ToolCard): void {
	if (!card.el.isConnected) transcript.append(h("div", { class: "msg assistant" }, card.el));
}

// ---------- messages ----------
const messageEls = new Map<string, HTMLElement>();
let anonSeq = 0;

function renderUser(m: Record<string, unknown>): HTMLElement {
	const text = contentText(m.content);
	const el = h("div", { class: `msg user${m.attribution === "agent" ? " agent-authored" : ""}` });
	const bubble = h("div", { class: "bubble" });
	renderMarkdownInto(bubble, text);
	const imgs = Array.isArray(m.content) ? m.content.map(b => rec(b)).filter(b => b?.type === "image") : [];
	if (imgs.length) {
		const row = h("div", { class: "user-images" });
		for (const r of imgs) row.append(typeof r?.data === "string" ? h("img", { class: "thumb", src: `data:${str(r.mimeType)};base64,${r.data}` }) : h("span", { class: "thumb ph" }, "image"));
		bubble.append(row);
	}
	el.append(bubble, h("div", { class: "msg-actions" }, copyButton(() => text, "Copy message")));
	linkify(bubble);
	return el;
}

function renderAssistantInto(el: HTMLElement, m: Record<string, unknown>, live: boolean): void {
	const blocks = Array.isArray(m.content) ? m.content : [];
	let host = el.querySelector<HTMLElement>(":scope > .blocks");
	if (!host) {
		host = h("div", { class: "blocks" });
		el.prepend(host);
	}
	blocks.forEach((raw, i) => {
		const b = rec(raw) ?? {};
		const kind = str(b.type);
		let child = host.children[i] as HTMLElement | undefined;
		if (child && child.dataset.kind !== kind) {
			child.remove();
			child = undefined;
		}
		if (kind === "text") {
			const text = str(b.text);
			if (!child) {
				child = h("div", { class: "md", "data-kind": kind });
				host.insertBefore(child, host.children[i] ?? null);
			}
			if (child.dataset.src !== text) {
				child.dataset.src = text;
				renderMarkdownInto(child, text);
				if (!live) linkify(child);
			}
		} else if (kind === "thinking") {
			const text = str(b.thinking).trim();
			if (!child) {
				child = h("details", { class: "thinking", "data-kind": kind }, h("summary", {}, "Thinking"), h("div", { class: "md" }));
				host.insertBefore(child, host.children[i] ?? null);
			}
			const sum = child.querySelector("summary") as HTMLElement;
			sum.textContent = live && i === blocks.length - 1 ? "Thinking…" : "Thinking";
			const body = child.querySelector(".md") as HTMLElement;
			if (body.dataset.src !== text) {
				body.dataset.src = text;
				renderMarkdownInto(body, text);
			}
			child.classList.toggle("hidden", !text);
		} else if (kind === "toolCall") {
			const card = getCard(str(b.id), str(b.name));
			card.args = rec(b.arguments) ?? {};
			card.intent = str(b.intent) || card.intent;
			card.el.dataset.kind = kind;
			if (child !== card.el) {
				child?.remove();
				host.insertBefore(card.el, host.children[i] ?? null);
			}
			scheduleCard(card);
		} else if (!child) {
			host.insertBefore(h("div", { "data-kind": kind }), host.children[i] ?? null);
		}
	});
	while (host.children.length > blocks.length) host.lastElementChild?.remove();
	el.querySelectorAll(":scope > .msg-error, :scope > .msg-aborted, :scope > .msg-actions").forEach(e => e.remove());
	if (!live && m.stopReason === "error") el.append(h("div", { class: "msg-error" }, `⚠ ${str(m.errorMessage) || "The model request failed."}`));
	if (!live && m.stopReason === "aborted") el.append(h("div", { class: "msg-aborted" }, "Interrupted"));
	const text = blocks.map(b => rec(b)).filter(b => b?.type === "text").map(b => str(b?.text)).join("\n\n");
	if (!live && text.trim()) el.append(h("div", { class: "msg-actions" }, copyButton(() => text, "Copy response")));
}

function applyToolResult(m: Record<string, unknown>): void {
	const id = str(m.toolCallId);
	const card = getCard(id, str(m.toolName) || "tool");
	attachCard(card);
	card.result = { content: m.content, details: rec(m.details) };
	card.status = m.isError ? "error" : "done";
	scheduleCard(card);
}

function renderOther(m: Record<string, unknown>): HTMLElement | null {
	if (m.display === false) return null;
	const role = str(m.role);
	const text = contentText(m.content) || str(m.summary) || str(m.output);
	if (role === "compactionSummary" || role === "branchSummary") return h("div", { class: "divider" }, role === "compactionSummary" ? "Context compacted" : "Branch summary");
	if (role === "bashExecution") return bashCard(str(m.command), str(m.output), typeof m.exitCode === "number" ? m.exitCode : undefined);
	if (!text.trim()) return null;
	const label = str(m.customType) || role || "note";
	const body = h("div", { class: "md" });
	renderMarkdownInto(body, text.slice(0, 20000));
	return h("details", { class: "note" }, h("summary", {}, label), body);
}

function bashCard(command: string, output: string, exitCode?: number, cancelled?: boolean): HTMLElement {
	const card = h(
		"details",
		{ class: "tool tool-bash user-bash", open: true },
		h(
			"summary",
			{},
			h(
				"div",
				{ class: "thead" },
				h("span", { class: `tstatus ${exitCode && exitCode !== 0 ? "error" : "done"}` }),
				h("span", { class: "tglyph" }, "!"),
				h("span", { class: "tname" }, "shell"),
				h("code", { class: "tsummary no-link" }, command),
				exitCode && exitCode !== 0 ? h("span", { class: "tbadges" }, h("span", { class: "del" }, `exit ${exitCode}`)) : "",
				cancelled ? h("span", { class: "tbadges dim" }, "cancelled") : "",
			),
		),
		h("div", { class: "tbody" }, output ? outputBlock(output, !!exitCode) : h("div", { class: "dim small" }, "(no output)")),
	);
	linkify(card);
	return card;
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
	updateEmpty();
	queueScroll();
}

function appendNotice(text: string, level: "info" | "warning" | "error" = "info", markdown = false): void {
	const el = h("div", { class: `notice ${level}` });
	if (markdown) {
		el.classList.add("md");
		renderMarkdownInto(el, text);
	} else renderText(el, text);
	linkify(el);
	transcript.append(el);
	updateEmpty();
	queueScroll();
}

// ---------- side questions (/btw) ----------
const sideQuestions = new Map<string, { el: HTMLElement; answer: HTMLElement; text: string }>();
function onBtwRecord(record: Record<string, unknown>): void {
	const id = str(record.id);
	let sq = sideQuestions.get(id);
	if (!sq) {
		const answer = h("div", { class: "md" });
		const el = h("div", { class: "side-q" }, h("div", { class: "side-q-head" }, h("span", { class: "chip" }, "side question"), h("span", {}, str(record.question))), answer);
		sq = { el, answer, text: "" };
		sideQuestions.set(id, sq);
		transcript.append(el);
	}
	const followUps = Array.isArray(record.followUps) ? record.followUps.map(f => rec(f) ?? {}) : [];
	const latest = followUps.length ? followUps[followUps.length - 1] : record;
	sq.text = str(latest.answer) || sq.text;
	renderMarkdownInto(sq.answer, sq.text || (record.status === "running" ? "…" : ""));
	if (record.status === "error") sq.answer.append(h("div", { class: "msg-error" }, str(record.error) || "failed"));
	if (record.status !== "running") linkify(sq.answer);
	updateEmpty();
	queueScroll();
}
function onBtwDelta(recordId: string, delta: string): void {
	const sq = sideQuestions.get(recordId);
	if (!sq) return;
	sq.text += delta;
	renderMarkdownInto(sq.answer, sq.text);
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
			const field = req.method === "editor" ? h("textarea", { class: "dinput", rows: "6" }) : h("input", { class: "dinput", type: "text", placeholder: str(req.placeholder) });
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
			const submitAsk = () =>
				respond(req.id, {
					answers: questions.map((q, i) => ({ id: str(q.id), selectedOptions: [...answers[i].selected], ...(answers[i].custom.trim() ? { customInput: answers[i].custom.trim() } : {}) })),
				});
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
						h("span", { class: "olabel" }, label, q.recommended === oi ? h("span", { class: "rec" }, "recommended") : ""),
						o.description ? h("span", { class: "odesc" }, str(o.description)) : "",
					);
					btn.dataset.label = label;
					buttons.push(btn);
					list.append(btn);
				});
				const other = h("input", { class: "dinput", type: "text", placeholder: "Other (type your own)…" });
				other.addEventListener("input", () => {
					answers[qi].custom = other.value;
				});
				other.addEventListener("keydown", e => {
					if ((e as KeyboardEvent).key === "Enter") {
						e.preventDefault();
						submitAsk();
					}
				});
				wrap.append(list, other);
				box.append(wrap);
			});
			box.append(h("div", { class: "dactions" }, h("button", { onclick: submitAsk }, "Submit"), cancel));
			break;
		}
		default:
			box.append(h("div", { class: "dtitle" }, req.method), h("div", { class: "dactions" }, cancel));
	}
	return box;
}

// ---------- menus ----------
let menuEl: (HTMLElement & { refill?: () => void }) | null = null;
function closeMenus(): void {
	menuEl?.remove();
	menuEl = null;
}
document.addEventListener("mousedown", e => {
	if (menuEl && !menuEl.contains(e.target as Node)) closeMenus();
});

type MenuItem = [string, () => void, string?] | null;
function openMenu(anchor: HTMLElement, groups: MenuItem[]): void {
	closeMenus();
	const menu = h("div", { class: "menu" });
	for (const it of groups) {
		if (!it) menu.append(h("div", { class: "sep" }));
		else menu.append(h("button", { onclick: () => (closeMenus(), it[1]()) }, h("span", {}, it[0]), it[2] ? h("span", { class: "kbd" }, it[2]) : ""));
	}
	document.body.append(menu);
	const r = anchor.getBoundingClientRect();
	menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
	menu.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
	menuEl = menu;
}

const cmd = (name: PanelCommand) => () => post({ type: "command", name });

function renderHeader(): void {
	const status = meta?.status ?? "starting";
	const label = status === "waiting" ? "needs input" : status;
	const stopped = status === "stopped";
	const menuBtn = h("button", { class: "icon-btn menu-btn", title: "Session actions" }, icon("more"));
	menuBtn.addEventListener("click", () =>
		openMenu(menuBtn, [
			["Review changes", cmd("reviewChanges"), "/changes"],
			["Rewind to a message…", cmd("rewind"), "/tree"],
			["Fork conversation", cmd("fork"), "/fork"],
			["New conversation (same session)", cmd("newInPlace"), "/new"],
			["Switch to earlier transcript…", cmd("resumeTranscript"), "/resume"],
			null,
			["Compact context", cmd("compact"), "/compact"],
			["Goal…", cmd("goal"), "/goal"],
			["Subagents…", cmd("agents"), "/agents"],
			[`Fast mode: ${state?.fastModeEnabled ? "on" : "off"}`, cmd("toggleFast"), "/fast"],
			[`Auto-compaction: ${state?.autoCompactionEnabled === false ? "off" : "on"}`, cmd("toggleAutoCompact")],
			null,
			["Copy last response", cmd("copyLast"), "/copy"],
			["Session stats", cmd("stats"), "/cost"],
			["Export HTML", cmd("export"), "/export"],
			["Rename…", cmd("rename")],
			null,
			["Log in to provider…", cmd("login"), "/login"],
			["Log out…", cmd("logout"), "/logout"],
			["omp settings", cmd("settings"), "/settings"],
			["Help", cmd("help"), "/help"],
			null,
			["New background session here", cmd("newSession")],
			stopped ? ["Resume session", cmd("resumeSession")] : ["Stop session", cmd("stopSession"), "/exit"],
			["Open host log", cmd("openLog")],
		]),
	);
	const files = meta?.changedFiles ?? 0;
	header.replaceChildren(
		h("span", { class: `dot ${status}`, title: label }),
		h("span", { class: "title", title: meta?.cwd ?? "" }, meta?.title ?? "omp"),
		h("span", { class: "cwd" }, meta ? meta.cwd.replace(home, "~") : ""),
		h("span", { class: "spacer" }),
		files > 0 ? h("button", { class: "chip-btn", title: "Review every change in a multi-file diff", onclick: cmd("reviewChanges") }, icon("diff"), `${files} file${files === 1 ? "" : "s"} changed`) : "",
		menuBtn,
	);
	if (stopped) {
		banner.className = "banner";
		banner.replaceChildren(
			h("span", {}, `Session stopped${meta?.exitReason && meta.exitReason !== "stopped" ? ` (${meta.exitReason})` : ""} — transcript is read-only.`),
			h("button", { onclick: cmd("resumeSession") }, "Resume"),
		);
	} else if (!connected) {
		banner.className = "banner warn";
		banner.replaceChildren(h("span", { class: "spinner" }), h("span", {}, "Connecting to the session host…"));
	} else banner.className = "banner hidden";
	input.disabled = stopped;
	updateSendState();
	vscode.setState({ sessionId: meta?.id });
}

function renderFooter(): void {
	const model = state?.model;
	const modelBtn = h("button", { class: "model-btn", title: "Model & thinking level" }, model ? model.name || model.id : "model", state?.thinkingLevel ? h("span", { class: "dim" }, ` · ${state.thinkingLevel}`) : "");
	modelBtn.addEventListener("click", () => {
		post({ type: "getModels" });
		showModelPicker(modelBtn);
	});
	const ctx = state?.contextUsage;
	const pct = ctx ? Math.round(ctx.percent) : null;
	const busy = agentBusy || !!state?.isStreaming;
	const goal = rec(state?.goal);
	footer.replaceChildren(
		modelBtn,
		pct !== null ? h("span", { class: `pill${pct > 80 ? " warn" : ""}`, title: `${ctx?.tokens?.toLocaleString()} / ${ctx?.contextWindow?.toLocaleString()} tokens` }, h("span", { class: "meter" }, h("span", { style: `width:${Math.min(100, pct)}%` })), `${pct}%`) : "",
		totalCost > 0 ? h("span", { class: "pill", title: "Cost of the messages shown" }, `$${totalCost.toFixed(2)}`) : "",
		state?.fastModeEnabled ? h("span", { class: "pill accent" }, "fast") : "",
		goal ? h("span", { class: "pill accent", title: str(goal.objective) }, `goal: ${str(goal.status) || "active"}`) : "",
		...[...statuses.values()].filter(Boolean).map(s => h("span", { class: "pill dim" }, s)),
		h("span", { class: "spacer" }),
		busy ? h("span", { class: "working" }, h("span", { class: "spinner" }), state?.isCompacting ? "compacting" : "working") : h("span", { class: "dim" }, meta?.status === "stopped" ? "stopped" : "ready"),
	);
	stopBtn.classList.toggle("hidden", !busy);
	sendBtn.title = busy ? "Steer the running agent (Enter)" : "Send (Enter)";
}

function updateSendState(): void {
	const stopped = meta?.status === "stopped";
	sendBtn.disabled = stopped || (!input.value.trim() && tray.count === 0);
	attachBtn.disabled = stopped;
}

function renderQueue(steering: string[], followUp: string[]): void {
	const chips = [...steering.map(t => ({ t, q: "steering" as const })), ...followUp.map(t => ({ t, q: "followUp" as const }))];
	queueBox.classList.toggle("hidden", chips.length === 0);
	queueBox.replaceChildren(
		...chips.map(c =>
			h(
				"span",
				{ class: "qchip", title: c.q === "steering" ? "Injected into the running turn" : "Runs after this turn" },
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
	const glyph: Record<string, string> = { completed: "✔", in_progress: "◐", pending: "○", abandoned: "✕", blocked: "⛔" };
	const wasOpen = todoBox.querySelector("details")?.open ?? false;
	todoBox.classList.remove("hidden");
	todoBox.replaceChildren(
		h(
			"details",
			{ open: wasOpen },
			h("summary", {}, h("span", { class: "meter wide" }, h("span", { style: `width:${Math.round((done / tasks.length) * 100)}%` })), `Todos ${done}/${tasks.length}`, current ? h("span", { class: "dim" }, ` — ${current.content}`) : ""),
			...phases.map(p => h("div", { class: "phase" }, phases.length > 1 ? h("div", { class: "pname" }, p.name) : "", ...p.tasks.map(t => h("div", { class: `todo ${t.status}` }, `${glyph[t.status] ?? "○"} ${t.content}`)))),
		),
	);
}

function renderWidgets(): void {
	const lines = [...widgets.values()].flat();
	widgetBox.classList.toggle("hidden", lines.length === 0);
	widgetBox.replaceChildren(...lines.map(l => h("div", {}, l)));
}

// ---------- model picker ----------
let modelsCache: Array<{ provider: string; id: string; name?: string }> = [];
let levelsCache: string[] = [];
function showModelPicker(anchor: HTMLElement): void {
	closeMenus();
	const menu: HTMLElement & { refill?: () => void } = h("div", { class: "menu picker" });
	const filter = h("input", { class: "dinput", type: "text", placeholder: "Filter models…" });
	const list = h("div", { class: "plist" });
	const levels = h("div", { class: "levels" });
	const fill = () => {
		const q = filter.value.toLowerCase();
		list.replaceChildren(
			...modelsCache
				.filter(m => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(q))
				.slice(0, 300)
				.map(m =>
					h(
						"button",
						{ class: state?.model?.id === m.id && state?.model?.provider === m.provider ? "current" : "", onclick: () => (closeMenus(), post({ type: "setModel", provider: m.provider, id: m.id })) },
						h("span", {}, m.name ?? m.id),
						h("span", { class: "kbd" }, m.provider),
					),
				),
		);
		if (!modelsCache.length) list.append(h("div", { class: "dim small pad" }, "Loading models…"));
		levels.replaceChildren(...levelsCache.map(l => h("button", { class: `lvl${state?.thinkingLevel === l ? " current" : ""}`, onclick: () => (closeMenus(), post({ type: "setThinking", level: l })) }, l)));
	};
	filter.addEventListener("input", fill);
	filter.addEventListener("keydown", e => {
		if (e.key === "Escape") closeMenus();
	});
	menu.append(h("div", { class: "small dim pad" }, "Thinking"), levels, filter, list);
	const r = anchor.getBoundingClientRect();
	menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
	menu.style.left = `${r.left}px`;
	document.body.append(menu);
	menuEl = menu;
	menu.refill = fill;
	fill();
	filter.focus();
}

// ---------- composer ----------
let popupKind: "slash" | "file" | null = null;
let popupItems: Array<{ label: string; detail?: string; insert: string; badge?: string }> = [];
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
				it.badge ? h("span", { class: "pbadge" }, it.badge) : "",
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
			.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
			.slice(0, 60)
			.map(c => ({ label: `/${c.name}${c.input?.hint ? ` ${c.input.hint}` : ""}`, detail: c.description, insert: `/${c.name}`, badge: c.local ? "vscode" : undefined }));
		showPopup("slash", items);
		return;
	}
	const at = /(?:^|\s)@([\w./-]*)$/.exec(before);
	if (at) {
		clearTimeout(fileTimer);
		const q = at[1];
		fileTimer = window.setTimeout(() => post({ type: "suggestFiles", reqId: ++fileReq, query: q }), 120);
		return;
	}
	if (popupKind) hidePopup();
}

function autosize(): void {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
	updateSendState();
}

function send(): void {
	const text = input.value.trim();
	if ((!text && tray.count === 0) || meta?.status === "stopped") return;
	const { images, files } = tray.take();
	post({ type: "prompt", text, images, files });
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
			showPopup(popupKind, popupItems);
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
input.addEventListener("paste", e => {
	const files = [...(e.clipboardData?.files ?? [])];
	if (!files.length) return;
	e.preventDefault();
	void tray.addFiles(files);
});
for (const target of [inputBox, transcript]) {
	target.addEventListener("dragover", e => {
		e.preventDefault();
		inputBox.classList.add("drop");
	});
	target.addEventListener("dragleave", () => inputBox.classList.remove("drop"));
	target.addEventListener("drop", e => {
		e.preventDefault();
		inputBox.classList.remove("drop");
		const dt = e.dataTransfer;
		if (!dt) return;
		if (dt.files.length) {
			void tray.addFiles([...dt.files]);
			return;
		}
		// Files dragged from VS Code's explorer arrive as URIs on the remote.
		const uris = (dt.getData("text/uri-list") || dt.getData("text/plain"))
			.split(/\r?\n/)
			.map(s => s.trim())
			.filter(s => s && !s.startsWith("#"));
		if (uris.length) {
			const refs = uris.map(u => `@${shortPath(decodeURIComponent(u.replace(/^[a-z-]+:\/\/[^/]*/, "")))}`).join(" ");
			input.value = `${input.value}${input.value && !input.value.endsWith(" ") ? " " : ""}${refs} `;
			autosize();
			input.focus();
		}
	});
}
attachBtn.addEventListener("click", () => post({ type: "pickFiles" }));
sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => post({ type: "abort" }));
document.addEventListener("keydown", e => {
	if (e.key === "Escape" && menuEl) {
		e.preventDefault();
		closeMenus();
		input.focus();
	}
});

// ---------- events from omp ----------
function resetTranscript(): void {
	transcript.replaceChildren(emptyState);
	messageEls.clear();
	cards.clear();
	sideQuestions.clear();
	totalCost = 0;
}

function onSubagentFrame(payload: Record<string, unknown>, lifecycle: boolean): void {
	const parent = str(payload.parentToolCallId);
	const card = parent ? cards.get(parent) : undefined;
	if (!card) return;
	const key = str(payload.id) || `${str(payload.agent)}#${String(payload.index)}`;
	const prev = card.subagents.get(key) ?? {};
	card.subagents.set(key, lifecycle ? { ...prev, ...payload } : { ...prev, ...payload, progress: payload.progress });
	scheduleCard(card);
}

function handleEvent(ev: OmpFrame): void {
	switch (ev.type) {
		case "message_start":
		case "message_update":
			addMessage(ev.message, str(ev.messageId), true);
			return;
		case "message_end": {
			addMessage(ev.message, str(ev.messageId), false);
			const el = messageEls.get(str(ev.messageId));
			if (el) linkify(el);
			return;
		}
		case "tool_execution_start": {
			const card = getCard(str(ev.toolCallId), str(ev.toolName));
			card.args = rec(ev.args) ?? card.args;
			card.intent = str(ev.intent) || card.intent;
			card.status = "running";
			attachCard(card);
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
			const card = getCard(str(ev.toolCallId), str(ev.toolName));
			const r = rec(ev.result);
			card.result = { content: r?.content, details: rec(r?.details) };
			card.status = ev.isError ? "error" : "done";
			attachCard(card);
			scheduleCard(card);
			return;
		}
		case "subagent_lifecycle":
		case "subagent_progress":
			onSubagentFrame(rec(ev.payload) ?? {}, ev.type === "subagent_lifecycle");
			return;
		case "btw_record":
			onBtwRecord(rec(ev.record) ?? {});
			return;
		case "btw_delta":
			onBtwDelta(str(ev.recordId), str(ev.delta));
			return;
		case "agent_start":
			agentBusy = true;
			renderFooter();
			return;
		case "session_settled":
			agentBusy = false;
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
		case "command_output": {
			const pre = h("pre", { class: "command-output" });
			renderText(pre, str(ev.text));
			linkify(pre);
			transcript.append(pre);
			updateEmpty();
			queueScroll();
			return;
		}
		case "queue_update":
			renderQueue(Array.isArray(ev.steering) ? ev.steering.map(String) : [], Array.isArray(ev.followUp) ? ev.followUp.map(String) : []);
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
			appendNotice(`${str(req.instructions) || "Opened in your browser:"} ${str(req.launchUrl) || str(req.url)}`);
			return;
	}
}

function applyDiffs(all: Record<string, DiffsByPath>): void {
	diffsByTool.clear();
	for (const [id, d] of Object.entries(all)) diffsByTool.set(id, d);
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
			applyDiffs(msg.diffs);
			resetTranscript();
			for (const m of msg.messages) addMessage(m);
			if (msg.inflight) addMessage(msg.inflight.message, msg.inflight.messageId, true);
			for (const t of msg.runningTools) {
				const card = getCard(t.toolCallId, t.toolName);
				card.args = rec(t.args) ?? {};
				card.intent = t.intent;
				card.status = "running";
				card.live = contentText(rec(t.partialResult)?.content);
				attachCard(card);
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
			linkify(transcript);
			updateEmpty();
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
		case "change": {
			changesByTool.set(msg.change.toolCallId, msg.change);
			diffsByTool.set(msg.change.toolCallId, msg.diffs);
			const card = cards.get(msg.change.toolCallId);
			if (card) scheduleCard(card);
			if (meta) {
				const files = new Set<string>();
				for (const c of changesByTool.values()) for (const f of c.files) files.add(f.path);
				meta = { ...meta, changedFiles: Math.max(meta.changedFiles, files.size) };
				renderHeader();
			}
			return;
		}
		case "diffs": {
			diffsByTool.set(msg.toolCallId, msg.diffs);
			const card = cards.get(msg.toolCallId);
			if (card) scheduleCard(card);
			return;
		}
		case "uiResolved":
			pendingUi.delete(msg.id);
			renderDialogs();
			return;
		case "reset":
			state = msg.state;
			applyDiffs(msg.diffs);
			resetTranscript();
			for (const m of msg.messages) addMessage(m);
			linkify(transcript);
			updateEmpty();
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
		case "models":
			modelsCache = msg.models;
			levelsCache = msg.levels;
			menuEl?.refill?.();
			return;
		case "commands":
			commands = msg.commands;
			return;
		case "insertText": {
			const pos = input.selectionStart ?? input.value.length;
			const sep = pos > 0 && !/\s$/.test(input.value.slice(0, pos)) ? "\n" : "";
			input.value = `${input.value.slice(0, pos)}${sep}${msg.text}${input.value.slice(pos)}`;
			autosize();
			input.focus();
			return;
		}
		case "attachFiles":
			tray.add({ images: msg.images, files: msg.files });
			input.focus();
			return;
		case "focusComposer":
			input.focus();
			return;
		case "bashResult":
			transcript.append(bashCard(msg.command, msg.output, msg.exitCode, msg.cancelled));
			updateEmpty();
			queueScroll();
			return;
		case "notice":
			appendNotice(msg.text, msg.level, msg.markdown);
			return;
		case "error":
			appendNotice(`⚠ ${msg.message}`, "error");
			return;
	}
});

window.addEventListener("focus", () => {
	if (meta?.status !== "stopped" && !document.activeElement?.closest(".dialog, .menu")) input.focus();
});

transcript.append(emptyState);
renderHeader();
renderFooter();
post({ type: "ready" });
