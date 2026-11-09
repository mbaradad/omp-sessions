// Chat UI for one omp session: transcript, tool cards with structured diffs, omp dialogs,
// attachments, and a composer with slash-command / @file completion.
import { Marked, type Tokens } from "marked";
import { playSound, unlockAudioOnGesture } from "../shared/completion-sound";
import { type FileDiff, diffTexts, parseOmpDiff } from "../shared/diff";
import { type HermesOrigin, originLabel } from "../shared/hermes-origin";
import { CONTEXT_MENTIONS, findMentions, splitContext } from "../shared/mentions";
import { PERMISSION_MODES, PERMISSION_MODE_INFO, PLAN_PROMPT_PREFIX, type PermissionMode } from "../shared/permissions";
import type { FileChange, OmpFrame, SessionMeta, TaskQueue, UiRequest } from "../shared/protocol";
import { SNIPPET_PREFIX } from "../shared/snippets";
import type { DiffsByPath, PanelCommand, SlashCommand, SlimState, ToWebview } from "../shared/webview";
import { hasAnsi, renderAnsi } from "./ansi";
import { AttachmentTray } from "./attachments";
import { renderFileDiff } from "./diffview";
import { copyButton, escapeHtml, h, icon, post, rec, str, vscode } from "./dom";
import { FindBar, countMatches } from "./find";
import { highlight, languageFor } from "./highlight";
import { fileLink, installLinkHandler, linkify, onPathsResolved, splitLine } from "./links";
import { dayKey, dayLabel, messageTime } from "./time";

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
			if (/^data:image\//.test(href)) return `<img class="md-img" src="${escapeHtml(href)}" alt="${escapeHtml(token.text)}">`;
			// A remote image loads only when clicked: fetching it on render would let the agent send data to any server unseen.
			if (/^https?:/.test(href)) return `<button type="button" class="md-img-load" data-src="${escapeHtml(href)}" data-alt="${escapeHtml(token.text)}" title="Load this image from the web">Load image ${escapeHtml(token.text ? `“${token.text}” ` : "")}from <span class="md-img-url">${escapeHtml(href)}</span></button>`;
			return `<a class="ext-link" data-url="${escapeHtml(href)}">${escapeHtml(token.text || href)}</a>`;
		},
		code(token: Tokens.Code) {
			const lang = (token.lang ?? "").split(/\s/)[0];
			const html = highlight(token.text, lang ? languageFor(lang) : undefined) ?? escapeHtml(token.text);
			return `<div class="codeblock" data-lang="${escapeHtml(lang)}"><div class="code-head"><span>${escapeHtml(lang || "text")}</span><span class="code-actions"></span></div><pre><code class="hljs">${html}</code></pre></div>`;
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
/** Checkpoint restores this chat can redo. */
let redoCount = 0;
/** Where Hermes started this session (its tags); null when it didn't. */
let hermes: HermesOrigin | null = null;
/** `switchyard.chat.toolCardsCollapsed`: new non-edit tool cards start closed. */
let toolCardsCollapsed = true;
const logoUrl = document.body.dataset.logo ?? "";

/** Empty-state cards that fill the composer (context mentions expand when sent). */
const STARTERS: Array<{ title: string; detail: string; prompt: string }> = [
	{ title: "Explain this project", detail: "Purpose, layout, how to build and test", prompt: "Explain this project: what it does, how the code is organized, the main entry points, and how to build, run and test it." },
	{ title: "Find bugs in the open file", detail: "Sends the active editor's file", prompt: "Find bugs in @file. For each one give the line, why it is wrong, and a fix." },
	{ title: "Write tests for…", detail: "Sends your editor selection", prompt: "Write tests for @selection, following this project's existing test setup. Cover edge cases." },
	{ title: "Review my uncommitted changes", detail: "Sends the git diff", prompt: "Review my uncommitted changes for bugs, risky edits and missing tests: @git" },
	{ title: "Plan a feature", detail: "Questions first, then a step-by-step plan", prompt: "Plan this feature before writing any code. Ask me clarifying questions first, then propose a step-by-step plan: " },
];

// ---------- layout ----------
const app = document.getElementById("app") as HTMLElement;
const header = h("div", { class: "header" });
const banner = h("div", { class: "banner hidden" });
const transcript = h("div", { class: "transcript", role: "region", "aria-label": "Conversation", tabindex: "-1" });
const starters = h(
	"div",
	{ class: "starters" },
	...STARTERS.map(s => h("button", { class: "starter", onclick: () => fillComposer(s.prompt) }, h("span", { class: "starter-title" }, s.title), h("span", { class: "starter-detail" }, s.detail))),
);
const emptyState = h(
	"div",
	{ class: "empty" },
	logoUrl ? h("img", { class: "empty-logo", src: logoUrl, alt: "" }) : "",
	h("div", { class: "empty-title" }, "What should omp do?"),
	starters,
	h("div", { class: "empty-hints" }, "Runs in the background on this machine — close the laptop, come back later.", h("br"), "/ commands · @ files & context (@selection @file @problems @git @terminal) · ! shell · paste images & files"),
);
/** Screen-reader announcements for agent status changes (not the streaming text itself). */
const liveRegion = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
const jumpBtn = h("button", { class: "jump hidden", title: "Scroll to bottom", onclick: () => scrollToBottom(true) }, "↓");
const dialogs = h("div", { class: "dialogs" });
const todoBox = h("div", { class: "todos hidden" });
const widgetBox = h("div", { class: "widgets hidden" });
const queueBox = h("div", { class: "queue hidden" });
const taskBar = h("div", { class: "taskbar hidden" });
const popup = h("div", { class: "popup hidden" });
const input = h("textarea", { class: "input", rows: "1", "aria-label": "Message omp", placeholder: "Ask omp…   / commands · @ files & context · ! shell · paste images or files" });
const mentionChips = h("div", { class: "mention-chips hidden", "aria-label": "Context attached when sending" });
const attachBtn = h("button", { class: "icon-btn attach", title: "Attach images or files" }, icon("clip"));
const sendBtn = h("button", { class: "send", title: "Send (Enter)" }, icon("send"));
const stopBtn = h("button", { class: "stop hidden", title: "Interrupt (Esc)" }, icon("stop"));
const footer = h("div", { class: "footer" });
const tray = new AttachmentTray(
	() => updateSendState(),
	msg => appendNotice(msg, "warning"),
);
const inputBox = h("div", { class: "input-box" }, tray.el, mentionChips, input, h("div", { class: "input-actions" }, attachBtn, h("span", { class: "spacer" }), stopBtn, sendBtn));
const composer = h("div", { class: "composer" }, popup, taskBar, queueBox, inputBox, footer);
const findBar = new FindBar(transcript, {
	hiddenMatches: query => countMatches(hiddenMessages, query),
	loadAll: () => {
		while (hiddenMessages.length) showEarlier();
	},
	onClose: () => input.focus(),
});
const main = h("div", { class: "main" }, findBar.el, transcript, jumpBtn);
app.append(header, banner, main, dialogs, todoBox, widgetBox, composer, liveRegion);
installLinkHandler();

let lastAnnounced = "";
function announce(text: string): void {
	if (text === lastAnnounced) return;
	lastAnnounced = text;
	liveRegion.textContent = text;
}

function fillComposer(text: string): void {
	input.value = text;
	autosize();
	input.focus();
	input.selectionStart = input.selectionEnd = input.value.length;
	saveDraft();
}

function setAllCards(open: boolean): void {
	for (const card of cards.values()) card.el.open = open;
}

/** Alt+T / menu: collapse every tool card if any is open, else expand all. */
function toggleAllCards(): void {
	setAllCards(![...cards.values()].some(c => c.el.open));
}

/** Composer chips for the context @mentions that will be expanded when sending. */
function renderMentionChips(): void {
	const kinds = findMentions(input.value);
	mentionChips.classList.toggle("hidden", kinds.length === 0);
	mentionChips.replaceChildren(
		...kinds.map(kind =>
			h(
				"span",
				{ class: "mchip", title: CONTEXT_MENTIONS.find(c => c.name === kind)?.description ?? "" },
				`@${kind}`,
				h(
					"button",
					{
						class: "x",
						title: `Remove @${kind}`,
						onclick: () => {
							input.value = input.value.replace(new RegExp(`(^|[\\s(\\[{,;])@${kind}(?![\\w/-]|\\.\\w) ?`, "g"), "$1");
							autosize();
							saveDraft();
							input.focus();
						},
					},
					"×",
				),
			),
		),
	);
}

// A remote markdown image loads when its placeholder is clicked.
document.addEventListener("click", e => {
	const load = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(".md-img-load");
	const src = load?.dataset.src;
	if (!load || !src) return;
	e.preventDefault();
	load.replaceWith(h("img", { class: "md-img", src, alt: load.dataset.alt ?? "" }));
});

// Click any chat image to view it full size.
document.addEventListener("click", e => {
	const img = (e.target as HTMLElement | null)?.closest<HTMLImageElement>(".thumb, .att-image img, .md-img");
	if (!img?.src) return;
	e.preventDefault();
	const overlay = h("div", { class: "lightbox", title: "Click to close" }, h("img", { src: img.src, alt: "" }));
	overlay.addEventListener("click", () => overlay.remove());
	document.body.append(overlay);
});

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
function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

let turnStartedAt: number | undefined;
const promptHistory: string[] = [];
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
	startedAt?: number;
	endedAt?: number;
	durEl: HTMLElement;
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
	const durEl = h("span", { class: "tdur" });
	const head = h("div", { class: "thead" }, statusEl, h("span", { class: "tglyph" }, TOOL_GLYPH[name] ?? "•"), h("span", { class: "tname" }, name), summary, badges, durEl);
	const body = h("div", { class: "tbody" });
	const el = h("details", { class: `tool tool-${name}` }, h("summary", {}, head), body);
	const card: ToolCard = { id, name, el, statusEl, summary, badges, body, args: {}, status: "pending", subagents: new Map(), durEl };
	el.addEventListener("toggle", () => {
		card.userToggled = true;
	});
	if (EDIT_TOOLS[name] || name === "ask" || !toolCardsCollapsed) el.open = true;
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
		changesByTool.get(card.id)
			? h("button", { class: "mini ghost danger", title: "Restore this file to its content before this edit", onclick: (e: Event) => (e.preventDefault(), post({ type: "revertFile", toolCallId: card.id, path })) }, "Revert")
			: "",
	);
}

function outputBlock(text: string, error = false): HTMLElement {
	const pre = h("pre", { class: `out${error ? " error" : ""}` });
	renderText(pre, text);
	return h("div", { class: "out-wrap" }, pre, copyButton(() => text, "Copy output"));
}

function updateCard(card: ToolCard): void {
	card.statusEl.className = `tstatus ${card.status}`;
	card.durEl.textContent = card.startedAt ? fmtDuration((card.endedAt ?? Date.now()) - card.startedAt) : "";
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
			body.append(h("div", { class: "file-block" }, fileHeader(card, path, diff, line), renderFileDiff(diff, { onLine: n => post({ type: "openFile", path, line: n }), language: languageFor(path) })));
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
					h("span", { class: "sa-desc" }, str(p.description) || str(s.description) || str(p.lastIntent) || str(s.task || p.task).split("\n").find(l => l.trim() && !/^#|complete assignment/i.test(l))?.slice(0, 120) || ""),
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
	if (!card.el.isConnected) sink.append(h("div", { class: "msg assistant" }, card.el));
}

// ---------- messages ----------
const messageEls = new Map<string, HTMLElement>();
let anonSeq = 0;
/** Where addMessage puts new elements: the transcript, or a block above it while loading earlier turns. */
let sink: ParentNode = transcript;
/** Off while rendering earlier turns: their cost and prompts were already counted when they were hidden. */
let accounting = true;

/** Long transcripts render their last turns first; older turns load on demand so attaching stays fast. */
const TAIL_MESSAGES = 160;
let hiddenMessages: unknown[] = [];
const earlierBtn = h("button", { class: "earlier-btn", onclick: () => showEarlier() });

/** Index of the user message that starts the turn containing `from` (so tool calls and results stay together). */
function turnStart(list: unknown[], from: number): number {
	let i = Math.max(0, from);
	while (i > 0 && rec(list[i])?.role !== "user") i--;
	return i;
}

function loadMessages(list: unknown[]): void {
	const start = turnStart(list, list.length - TAIL_MESSAGES);
	hiddenMessages = list.slice(0, start);
	for (const m of hiddenMessages) {
		const r = rec(m);
		const cost = rec(r?.usage)?.cost;
		if (r?.role === "assistant" && typeof cost === "number") totalCost += cost;
		if (r?.role === "user" && r.attribution !== "agent") {
			const text = splitContext(contentText(r.content)).text;
			if (text.trim()) promptHistory.push(text);
		}
	}
	for (const m of list.slice(start)) addMessage(m);
	renderFooter();
	updateEarlier();
}

function updateEarlier(): void {
	if (!hiddenMessages.length) {
		earlierBtn.remove();
		return;
	}
	earlierBtn.textContent = `Show ${hiddenMessages.length} earlier messages`;
	if (!earlierBtn.isConnected) transcript.prepend(earlierBtn);
}

function showEarlier(): void {
	const start = turnStart(hiddenMessages, hiddenMessages.length - TAIL_MESSAGES);
	const chunk = hiddenMessages.slice(start);
	hiddenMessages = hiddenMessages.slice(0, start);
	const box = h("div", { class: "earlier" });
	earlierBtn.after(box);
	const height = transcript.scrollHeight;
	const top = transcript.scrollTop;
	const laterDay = lastDay;
	sink = box;
	accounting = false;
	lastDay = "";
	try {
		for (const m of chunk) addMessage(m);
	} finally {
		sink = transcript;
		accounting = true;
	}
	// The day separator that used to open the transcript is redundant if the loaded turns end on that day.
	const boxDay = lastDay;
	lastDay = laterDay;
	const next = [...transcript.querySelectorAll<HTMLElement>(".day-sep")].find(s => !box.contains(s) && box.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING);
	if (next && next.dataset.day === boxDay) next.remove();
	linkify(box);
	// Keep what the reader was looking at in place.
	transcript.scrollTop = top + (transcript.scrollHeight - height);
	updateEarlier();
	findBar.refresh();
}

/** Last day a separator was inserted for (in the block being rendered). */
let lastDay = "";
function daySeparator(m: Record<string, unknown>): HTMLElement | undefined {
	const ts = messageTime(m.timestamp);
	if (ts === undefined || dayKey(ts) === lastDay) return undefined;
	lastDay = dayKey(ts);
	return h("div", { class: "divider day-sep", "data-day": lastDay, role: "separator" }, dayLabel(ts));
}

function timeTitle(m: Record<string, unknown>): string | undefined {
	const ts = messageTime(m.timestamp);
	return ts === undefined ? undefined : new Date(ts).toLocaleString();
}

function shortTime(m: Record<string, unknown>): string {
	const ts = messageTime(m.timestamp);
	return ts === undefined ? "" : new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function renderUser(m: Record<string, unknown>): HTMLElement {
	const full = contentText(m.content);
	// Context expanded from @mentions is collapsed below what the user typed.
	const planned = full.startsWith(PLAN_PROMPT_PREFIX);
	const { text, context } = splitContext(planned ? full.slice(PLAN_PROMPT_PREFIX.length) : full);
	const el = h("div", { class: `msg user${m.attribution === "agent" ? " agent-authored" : ""}`, title: timeTitle(m) });
	const bubble = h("div", { class: "bubble" });
	// Prompts the planner sends for tasks: the lane's queue task i/n, a free task of the plan, and a follow-up run.
	const queued = /^\[Task (\d+)\/(\d+) from the queue\] /.exec(text);
	const task = queued
		? { head: queued[0], chip: `Queued task ${queued[1]}/${queued[2]}`, trailer: /\n\nWork through this task completely[\s\S]*$/ }
		: text.startsWith("[Task from the plan] ")
			? { head: "[Task from the plan] ", chip: "Planned task", trailer: /\n\nWork through this task completely[\s\S]*$/ }
			: text.startsWith("[Follow-up on your task] ")
				? { head: "[Follow-up on your task] ", chip: "Follow-up", trailer: /\n\nTake this into account, fix whatever it breaks[\s\S]*$/ }
				: undefined;
	if (task) {
		el.classList.add("queued-task");
		renderMarkdownInto(bubble, text.slice(task.head.length).replace(task.trailer, ""));
		bubble.prepend(h("div", { class: "task-chip" }, task.chip));
	} else renderMarkdownInto(bubble, text);
	if (planned) bubble.prepend(h("div", { class: "task-chip", title: "Sent in Plan mode: read-only, file edits refused" }, "Plan mode"));
	if (context) {
		const body = h("div", { class: "md" });
		const kinds = findMentions(text);
		const details = h("details", { class: "ctx" }, h("summary", {}, `Context from VS Code${kinds.length ? `: ${kinds.map(k => `@${k}`).join(" ")}` : ""}`), body);
		details.addEventListener("toggle", () => {
			if (details.open && !body.childElementCount) {
				renderMarkdownInto(body, context);
				linkify(body);
			}
		});
		bubble.append(details);
	}
	const imgs = Array.isArray(m.content) ? m.content.map(b => rec(b)).filter(b => b?.type === "image") : [];
	if (imgs.length) {
		const row = h("div", { class: "user-images" });
		for (const r of imgs) row.append(typeof r?.data === "string" ? h("img", { class: "thumb", src: `data:${str(r.mimeType)};base64,${r.data}` }) : h("span", { class: "thumb ph" }, "image"));
		bubble.append(row);
	}
	const userAuthored = m.attribution !== "agent";
	el.append(
		bubble,
		h(
			"div",
			{ class: "msg-actions" },
			userAuthored ? h("button", { class: "icon-btn", title: "Restore checkpoint: revert the file edits made since this prompt and rewind the conversation to before it (/redo brings them back)", onclick: () => post({ type: "restoreCheckpoint", text: full, turnId: str(m.turnId) || undefined }) }, icon("undo")) : "",
			userAuthored ? h("button", { class: "icon-btn", title: "Edit & resend from here (rewinds the conversation)", onclick: () => post({ type: "rewindTo", text: full, turnId: str(m.turnId) || undefined }) }, icon("edit")) : "",
			copyButton(() => text, "Copy message"),
			shortTime(m) ? h("span", { class: "msg-meta" }, shortTime(m)) : "",
		),
	);
	if (accounting && userAuthored && text.trim()) promptHistory.push(text);
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
	if (!live && text.trim()) {
		const usage = rec(m.usage);
		const cost = typeof usage?.cost === "number" ? `$${usage.cost.toFixed(4)}` : "";
		const tokens = typeof usage?.totalTokens === "number" ? `${Math.round(usage.totalTokens / 100) / 10}k tok` : "";
		const info = [shortTime(m), str(m.model), tokens, cost].filter(Boolean).join(" · ");
		el.append(h("div", { class: "msg-actions" }, copyButton(() => text, "Copy response"), info ? h("span", { class: "msg-meta" }, info) : ""));
	}
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
	if (role === "bashExecution") return bashCard(str(m.command), str(m.output), typeof m.exitCode === "number" ? m.exitCode : undefined, !!m.cancelled);
	if (role === "commandOutput") return commandOutputEl(str(m.text));
	if (role === "notice") return noticeEl(str(m.message), (str(m.level) as "info" | "warning" | "error") || "info", !!m.markdown);
	if (role === "sideQuestion") {
		onBtwRecord(rec(m.record) ?? {});
		return null;
	}
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
			const sep = daySeparator(m);
			if (sep) sink.append(sep);
			sink.append(el);
		}
	} else if (role === "assistant") {
		if (!el) {
			el = h("div", { class: "msg assistant" });
			messageEls.set(key, el);
			sink.append(el);
		}
		const title = timeTitle(m);
		if (title) el.title = title;
		renderAssistantInto(el, m, live);
		const cost = rec(m.usage)?.cost;
		if (!live && accounting && typeof cost === "number") {
			totalCost += cost;
			renderFooter();
		}
	} else if (!el) {
		const other = renderOther(m);
		if (other) {
			messageEls.set(key, other);
			sink.append(other);
		}
	}
	updateEmpty();
	queueScroll();
}

function noticeEl(text: string, level: "info" | "warning" | "error" = "info", markdown = false): HTMLElement {
	const el = h("div", { class: `notice ${level}` });
	if (markdown) {
		el.classList.add("md");
		renderMarkdownInto(el, text);
	} else renderText(el, text);
	linkify(el);
	return el;
}

function commandOutputEl(text: string): HTMLElement {
	const pre = h("pre", { class: "command-output" });
	renderText(pre, text);
	linkify(pre);
	return pre;
}

function appendNotice(text: string, level: "info" | "warning" | "error" = "info", markdown = false): void {
	transcript.append(noticeEl(text, level, markdown));
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
		sink.append(el);
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
	const menu = h("div", { class: "menu", role: "menu" });
	for (const it of groups) {
		if (!it) menu.append(h("div", { class: "sep", role: "separator" }));
		else menu.append(h("button", { role: "menuitem", onclick: () => (closeMenus(), it[1]()) }, h("span", {}, it[0]), it[2] ? h("span", { class: "kbd" }, it[2]) : ""));
	}
	document.body.append(menu);
	const r = anchor.getBoundingClientRect();
	menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
	menu.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
	menuEl = menu;
	menuKeys(menu);
	menu.querySelector("button")?.focus();
}

/** Arrow keys / Home / End move focus between a menu's buttons. */
function menuKeys(menu: HTMLElement): void {
	menu.addEventListener("keydown", e => {
		const items = [...menu.querySelectorAll<HTMLButtonElement>(":scope > button, .levels > button, .plist > button, .plist > .prow > button")];
		const at = items.findIndex(b => b === document.activeElement);
		const target = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? (at < 0 ? items.length - 1 : at - 1) : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
		if (target === null || !items.length || (e.target instanceof HTMLInputElement && e.key !== "ArrowDown")) return;
		e.preventDefault();
		items[(target + items.length) % items.length].focus();
	});
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
			["Undo last turn (files + conversation)", cmd("undoTurn"), "/undo"],
			...(redoCount ? [["Redo", cmd("redoTurn"), "/redo"] satisfies MenuItem] : []),
			["New session in this project", cmd("newSession"), "/new"],
			null,
			["Compact context", cmd("compact"), "/compact"],
			["Collapse / expand all tool cards", toggleAllCards, "Alt+T"],
			["Find in conversation", () => findBar.open(), "Ctrl/⌘+F"],
			["Permission mode…", () => showModeMenu(menuBtn), "Shift+Tab"],
			["Continue in omp's terminal UI", cmd("openTui"), "/tui"],
			null,
			["Copy last response", cmd("copyLast"), "/copy"],
			["Session stats", cmd("stats"), "/cost"],
			["Copy as Markdown", cmd("exportMarkdownCopy"), "/export copy"],
			["Save as Markdown…", cmd("exportMarkdownSave"), "/export md"],
			["Rename…", cmd("rename")],
			null,
			["Log in to provider…", cmd("login"), "/login"],
			["Log out…", cmd("logout"), "/logout"],
			["omp settings", cmd("settings"), "/settings"],
			["Help", cmd("help"), "/help"],
			null,
			stopped ? ["Resume session", cmd("resumeSession")] : ["Stop session", cmd("stopSession"), "/exit"],
			...(hermes?.card
				? [null, ["Open Hermes card", cmd("openHermesCard")] satisfies MenuItem, ["Show Hermes card in terminal", cmd("showHermesCard")] satisfies MenuItem]
				: []),
		]),
	);
	const files = meta?.changedFiles ?? 0;
	header.replaceChildren(
		h("span", { class: `dot ${status}`, title: label }),
		h("span", { class: "title", title: meta?.cwd ?? "" }, meta?.title ?? "omp"),
		h("span", { class: "cwd" }, meta ? meta.cwd.replace(home, "~") : ""),
		h("span", { class: "spacer" }),
		hermes
			? hermes.card
				? h("button", { class: "chip-btn hermes-chip", title: `Started by the Hermes kanban lane for card ${hermes.card}${hermes.board ? ` on board ${hermes.board}` : ""}. Click to open the Hermes Kanban.`, onclick: cmd("openHermesCard") }, originLabel(hermes))
				: h("span", { class: "chip hermes-chip", title: "Started from a Hermes chat (switchyard_session_start)" }, "Hermes")
			: "",
		files > 0 ? h("button", { class: "chip-btn", title: "Review every change in a multi-file diff", onclick: cmd("reviewChanges") }, icon("diff"), `${files} file${files === 1 ? "" : "s"} changed`) : "",
		redoCount ? h("button", { class: "chip-btn", title: "Bring back what the last checkpoint restore removed (files + conversation)", onclick: cmd("redoTurn") }, icon("redo"), "Redo") : "",
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
		banner.replaceChildren(h("span", { class: "spinner" }), h("span", {}, "Connecting to the AO daemon…"));
	} else banner.className = "banner hidden";
	input.disabled = stopped;
	starters.classList.toggle("hidden", stopped);
	updateSendState();
	vscode.setState({ ...(rec(vscode.getState()) ?? {}), sessionId: meta?.id });
}

function renderFooter(): void {
	const model = state?.model;
	const modelBtn = h("button", { class: "model-btn", title: "Switch model", "aria-haspopup": "menu" }, model ? model.name || model.id : "model");
	modelBtn.addEventListener("click", () => {
		post({ type: "getModels" });
		showModelPicker(modelBtn);
	});
	const thinkingBtn = state?.thinkingLevel
		? h("button", { class: "model-btn thinking-btn", title: "Thinking level", "aria-haspopup": "menu", "aria-label": `Thinking level: ${state.thinkingLevel}` }, h("span", { class: "dim" }, "thinking "), state.thinkingLevel)
		: null;
	thinkingBtn?.addEventListener("click", () => {
		post({ type: "getModels" });
		showThinkingMenu(thinkingBtn);
	});
	const ctx = state?.contextUsage;
	const pct = ctx ? Math.round(ctx.percent) : null;
	const busy = agentBusy || !!state?.isStreaming;
	const cost = typeof state?.cost === "number" ? state.cost : totalCost;
	footer.replaceChildren(
		modelBtn,
		thinkingBtn ?? "",
		modeButton(),
		pct !== null ? h("span", { class: `pill${pct > 80 ? " warn" : ""}`, title: `${ctx?.tokens?.toLocaleString()} / ${ctx?.contextWindow?.toLocaleString()} tokens` }, h("span", { class: "meter" }, h("span", { style: `width:${Math.min(100, pct)}%` })), `${pct}%`) : "",
		cost > 0 ? h("span", { class: "pill", title: typeof state?.cost === "number" ? "Session cost (AO)" : "Cost of the messages shown" }, `$${cost.toFixed(2)}`) : "",
		usageWindowPill(state?.usageWindows),
		usageLimitPill(rec(state?.usageLimit)),
		...[...statuses.values()].filter(Boolean).map(s => h("span", { class: "pill dim" }, s)),
		h("span", { class: "spacer" }),
		busy
			? h("span", { class: "working" }, h("span", { class: "spinner" }), state?.isCompacting ? "compacting" : "working", h("span", { class: "elapsed" }, turnStartedAt ? fmtDuration(Date.now() - turnStartedAt) : ""))
			: h("span", { class: "dim" }, meta?.status === "stopped" ? "stopped" : "ready"),
	);
	stopBtn.classList.toggle("hidden", !busy);
	announce(meta?.status === "waiting" ? "omp needs your input" : busy ? (state?.isCompacting ? "omp is compacting context" : "omp is working") : meta?.status === "stopped" ? "Session stopped" : "omp is ready");
	sendBtn.title = busy ? "Steer the running agent (Enter)" : "Send (Enter)";
}

/** The most used quota window of the session's provider, once it is 80% used (red from 95%). */
function usageWindowPill(windows: Array<{ window: string; usedPercent: number; resetsAtSec?: number }> | undefined): HTMLElement | "" {
	const top = windows?.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
	if (!top || top.usedPercent < 80) return "";
	const when = (w: { resetsAtSec?: number }) => (w.resetsAtSec ? ` · resets ${new Date(w.resetsAtSec * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "");
	const title = (windows ?? []).map(w => `${w.window}: ${Math.round(w.usedPercent)}% used${when(w)}`).join("\n");
	return h("span", { class: `pill${top.usedPercent >= 95 ? " warn" : ""}`, title: `Provider usage\n${title}` }, `${top.window} ${Math.round(top.usedPercent)}%`);
}

/** A turn AO paused at the account's usage limit: it waits for the reset (and continues then when auto-resume is on). */
function usageLimitPill(limit: Record<string, unknown> | undefined): HTMLElement | "" {
	if (!limit) return "";
	const resets = typeof limit.resetsAtSec === "number" ? ` · resets ${new Date(limit.resetsAtSec * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
	return h("span", { class: "pill warn", title: `Usage limit reached: the turn waits for the limit to reset${limit.autoResume ? " and then continues on its own" : ""}${resets}` }, "usage limit");
}

/** Footer chip with the session's permission mode (hosts that predate modes have none). */
function modeButton(): HTMLElement | "" {
	const mode = meta?.permissionMode;
	if (!mode || meta?.status === "stopped") return "";
	const info = PERMISSION_MODE_INFO[mode];
	const btn = h("button", { class: `model-btn mode-btn mode-${mode}`, title: `Permission mode: ${info.detail}. Click or Shift+Tab to change.`, "aria-haspopup": "menu", "aria-label": `Permission mode: ${info.label}` }, h("span", { class: "dim" }, "mode "), info.label);
	btn.addEventListener("click", () => showModeMenu(btn));
	return btn;
}

function setMode(mode: PermissionMode): void {
	if (meta && mode !== meta.permissionMode) post({ type: "setMode", mode });
}

function showModeMenu(anchor: HTMLElement): void {
	closeMenus();
	const menu = h("div", { class: "menu mode-menu", role: "menu" });
	menu.append(
		h("div", { class: "small dim pad" }, "Permission mode"),
		...PERMISSION_MODES.map(m =>
			h(
				"button",
				{ role: "menuitemradio", "aria-checked": String(meta?.permissionMode === m), class: meta?.permissionMode === m ? "current" : "", onclick: () => (closeMenus(), setMode(m)) },
				h("span", { class: "mode-label" }, PERMISSION_MODE_INFO[m].label),
				h("span", { class: "mode-detail" }, PERMISSION_MODE_INFO[m].detail),
			),
		),
	);
	const r = anchor.getBoundingClientRect();
	if (r.top < window.innerHeight / 2) {
		menu.style.top = `${r.bottom + 4}px`;
		menu.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
	} else {
		menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
		menu.style.left = `${r.left}px`;
	}
	document.body.append(menu);
	menuEl = menu;
	menuKeys(menu);
	(menu.querySelector<HTMLElement>("button.current") ?? menu.querySelector("button"))?.focus();
}

function updateSendState(): void {
	const stopped = meta?.status === "stopped";
	sendBtn.disabled = stopped || (!input.value.trim() && tray.count === 0);
	attachBtn.disabled = stopped;
}

/** Background task queue strip: what's running, what's next, run/pause. */
function renderTaskBar(queue: TaskQueue | null): void {
	const tasks = queue?.tasks ?? [];
	const open = tasks.filter(t => t.status === "pending" || t.status === "running");
	if (!queue || !tasks.length) {
		taskBar.classList.add("hidden");
		return;
	}
	const running = tasks.find(t => t.status === "running");
	const next = tasks.find(t => t.status === "pending");
	const done = tasks.filter(t => t.status === "done").length;
	const failed = tasks.filter(t => t.status === "failed").length;
	taskBar.classList.remove("hidden");
	taskBar.replaceChildren(
		h("span", { class: "tb-icon" }, running ? h("span", { class: "spinner" }) : "☰"),
		h(
			"span",
			{ class: "tb-text", title: tasks.map(t => `${t.status.padEnd(8)} ${t.title}`).join("\n") },
			running ? h("b", {}, running.title) : next ? `Next: ${next.title}` : "Queue finished",
			h("span", { class: "dim" }, ` · ${done}/${tasks.length} done${open.length ? ` · ${open.length} open` : ""}${failed ? ` · ${failed} failed` : ""}`),
		),
		h("span", { class: "spacer" }),
		open.length
			? queue.autoRun
				? h("button", { class: "mini ghost", title: "Stop feeding tasks after the current one", onclick: () => post({ type: "queueOp", ops: [{ op: "autoRun", value: false }] }) }, "Pause")
				: h("button", { class: "mini", title: "Run queued tasks one after another in the background", onclick: () => post({ type: "queueOp", ops: [{ op: "autoRun", value: true }] }) }, "Run queue")
			: "",
		h("button", { class: "mini ghost", title: "Open the Tasks view", onclick: () => post({ type: "focusTasks" }) }, "Tasks"),
	);
}

function queueComposer(): void {
	const text = input.value.trim();
	if (!text || meta?.status === "stopped") return;
	post({ type: "prompt", text: `/queue ${text}` });
	input.value = "";
	saveDraft();
	autosize();
}

function renderQueue(steering: string[], followUp: string[]): void {
	const chips = [...steering.map(t => ({ t, q: "steering" as const })), ...followUp.map(t => ({ t, q: "followUp" as const }))];
	queueBox.classList.toggle("hidden", chips.length === 0);
	queueBox.replaceChildren(
		...chips.map(c =>
			h(
				"span",
				{ class: "qchip", title: c.q === "steering" ? "Injected into the running turn" : "Runs after this turn. If you interrupt (Esc), AO drops it and the chat sends it again." },
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
/** `provider/id` of starred models: listed first in the picker. */
let starredModels = new Set<string>();
function showModelPicker(anchor: HTMLElement): void {
	closeMenus();
	const menu: HTMLElement & { refill?: () => void } = h("div", { class: "menu picker", role: "menu" });
	const filter = h("input", { class: "dinput", type: "text", placeholder: "Filter models…", "aria-label": "Filter models" });
	const list = h("div", { class: "plist" });
	const levels = h("div", { class: "levels" });
	const fill = () => {
		const q = filter.value.toLowerCase();
		const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
		const shown = modelsCache.filter(m => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(q));
		list.replaceChildren(
			...[...shown.filter(m => starredModels.has(key(m))), ...shown.filter(m => !starredModels.has(key(m)))].slice(0, 300).map(m => {
				const starred = starredModels.has(key(m));
				return h(
					"div",
					{ class: "prow" },
					h(
						"button",
						{ class: `pick${state?.model?.id === m.id && state?.model?.provider === m.provider ? " current" : ""}`, onclick: () => (closeMenus(), post({ type: "setModel", provider: m.provider, id: m.id })) },
						h("span", {}, m.name ?? m.id),
						h("span", { class: "kbd" }, m.provider),
					),
					h(
						"button",
						{ class: `star${starred ? " on" : ""}`, title: starred ? "Unstar" : "Star: keep at the top of this list", "aria-label": `${starred ? "Unstar" : "Star"} ${m.name ?? m.id}`, "aria-pressed": String(starred), onclick: () => post({ type: "starModel", provider: m.provider, id: m.id }) },
						starred ? "★" : "☆",
					),
				);
			}),
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
	menuKeys(menu);
	fill();
	filter.focus();
}

/** Thinking level only (footer pill); levels arrive with the model list. */
function showThinkingMenu(anchor: HTMLElement): void {
	closeMenus();
	const menu: HTMLElement & { refill?: () => void } = h("div", { class: "menu", role: "menu" });
	const fill = () => {
		const focused = menu.contains(document.activeElement);
		menu.replaceChildren(
			h("div", { class: "small dim pad" }, "Thinking level"),
			...levelsCache.map(l => h("button", { role: "menuitemradio", "aria-checked": String(state?.thinkingLevel === l), class: state?.thinkingLevel === l ? "current" : "", onclick: () => (closeMenus(), post({ type: "setThinking", level: l })) }, l)),
		);
		if (!levelsCache.length) menu.append(h("div", { class: "dim small pad" }, "Loading…"));
		if (!focused) (menu.querySelector<HTMLElement>("button.current") ?? menu.querySelector("button"))?.focus();
	};
	const r = anchor.getBoundingClientRect();
	menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
	menu.style.left = `${r.left}px`;
	document.body.append(menu);
	menuEl = menu;
	menu.refill = fill;
	menuKeys(menu);
	fill();
}

// ---------- composer ----------
let popupKind: "slash" | "file" | null = null;
let popupItems: Array<{ label: string; detail?: string; insert: string; badge?: string }> = [];
let popupIndex = 0;
let fileReq = 0;
let fileTimer: number | undefined;
/** Context mentions matching the pending `@` query; shown first, files follow when they arrive. */
let mentionItems: typeof popupItems = [];

function hidePopup(): void {
	popup.classList.add("hidden");
	input.setAttribute("aria-expanded", "false");
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
	input.setAttribute("aria-expanded", "true");
	popup.replaceChildren(
		...items.map((it, i) =>
			h(
				"div",
				{ class: `pitem${i === popupIndex ? " active" : ""}`, role: "option", "aria-selected": String(i === popupIndex), onmousedown: (e: Event) => (e.preventDefault(), acceptPopup(i)) },
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
	if (popupKind === "slash" && it.insert.startsWith(`/${SNIPPET_PREFIX}`)) {
		// Snippets replace the command with their text (placeholders filled by the extension).
		input.value = after.trimStart();
		input.selectionStart = input.selectionEnd = 0;
		post({ type: "expandSnippet", name: it.insert.slice(SNIPPET_PREFIX.length + 1) });
	} else if (popupKind === "slash") {
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
			.map(c => ({ label: `/${c.name}${c.input?.hint ? ` ${c.input.hint}` : ""}`, detail: c.description, insert: `/${c.name}`, badge: c.name.startsWith(SNIPPET_PREFIX) ? "snippet" : c.local ? "vscode" : undefined }));
		showPopup("slash", items);
		return;
	}
	const at = /(?:^|\s)@([\w./-]*)$/.exec(before);
	if (at) {
		clearTimeout(fileTimer);
		const q = at[1];
		mentionItems = CONTEXT_MENTIONS.filter(c => c.name.startsWith(q.toLowerCase())).map(c => ({ label: `@${c.name}`, detail: c.description, insert: c.name, badge: "context" }));
		if (mentionItems.length) showPopup("file", mentionItems);
		fileTimer = window.setTimeout(() => post({ type: "suggestFiles", reqId: ++fileReq, query: q }), 120);
		return;
	}
	if (popupKind) hidePopup();
}

function autosize(): void {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
	updateSendState();
	renderMentionChips();
}

function send(): void {
	const text = input.value.trim();
	if ((!text && tray.count === 0) || meta?.status === "stopped") return;
	const { images, files } = tray.take();
	post({ type: "prompt", text, images, files });
	promptHistory.push(text);
	historyIndex = -1;
	input.value = "";
	saveDraft();
	autosize();
	hidePopup();
	scrollToBottom(true);
}

let historyIndex = -1;
let draftTimer: number | undefined;
function saveDraft(): void {
	clearTimeout(draftTimer);
	draftTimer = window.setTimeout(() => vscode.setState({ ...(rec(vscode.getState()) ?? {}), sessionId: meta?.id, draft: input.value }), 250);
}

/** ↑/↓ walk previous prompts when the caret is on the first/last line (like a shell). */
function recallHistory(dir: -1 | 1): boolean {
	if (!promptHistory.length) return false;
	const before = input.value.slice(0, input.selectionStart ?? 0);
	const after = input.value.slice(input.selectionEnd ?? 0);
	if (dir === -1 && before.includes("\n")) return false;
	if (dir === 1 && (after.includes("\n") || historyIndex === -1)) return false;
	if (historyIndex === -1 && input.value.trim() && dir === -1 && !promptHistory.includes(input.value)) return false;
	const next = historyIndex === -1 ? promptHistory.length - 1 : historyIndex + dir;
	if (next < 0) return true;
	if (next >= promptHistory.length) {
		historyIndex = -1;
		input.value = "";
	} else {
		historyIndex = next;
		input.value = promptHistory[next];
	}
	autosize();
	input.selectionStart = input.selectionEnd = input.value.length;
	return true;
}

input.addEventListener("input", () => {
	historyIndex = -1;
	saveDraft();
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
	if (e.key === "Tab" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && meta?.permissionMode && meta.status !== "stopped") {
		// Shift+Tab cycles the permission mode (Tab still moves focus on).
		e.preventDefault();
		setMode(PERMISSION_MODES[(PERMISSION_MODES.indexOf(meta.permissionMode) + 1) % PERMISSION_MODES.length]);
		return;
	}
	if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && recallHistory(e.key === "ArrowUp" ? -1 : 1)) {
		e.preventDefault();
		return;
	}
	if (e.key === "Enter" && (e.altKey || ((e.metaKey || e.ctrlKey) && e.shiftKey)) && !e.isComposing) {
		// Alt+Enter / Cmd+Shift+Enter: queue instead of sending now.
		e.preventDefault();
		queueComposer();
	} else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
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
	} else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
		e.preventDefault();
		findBar.open();
	} else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyT") {
		e.preventDefault();
		toggleAllCards();
	}
});

// ---------- events from omp ----------
function resetTranscript(): void {
	transcript.replaceChildren(emptyState);
	hiddenMessages = [];
	messageEls.clear();
	cards.clear();
	sideQuestions.clear();
	totalCost = 0;
	promptHistory.length = 0;
	lastDay = "";
}

// Live clocks: turn elapsed time in the footer and running tool durations.
setInterval(() => {
	const elapsed = footer.querySelector<HTMLElement>(".elapsed");
	if (elapsed && turnStartedAt) elapsed.textContent = fmtDuration(Date.now() - turnStartedAt);
	for (const card of cards.values()) if (card.status === "running" && card.startedAt) card.durEl.textContent = fmtDuration(Date.now() - card.startedAt);
}, 1000);

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
			card.startedAt = Date.now();
			card.endedAt = undefined;
			attachCard(card);
			scheduleCard(card);
			return;
		}
		case "tool_execution_update": {
			const card = cards.get(str(ev.toolCallId));
			if (!card) return;
			card.live = contentText(rec(ev.partialResult)?.content);
			// Async tools (task) keep streaming progress after their result; never un-finish a card.
			if (!card.result) card.status = "running";
			scheduleCard(card);
			return;
		}
		case "tool_execution_end": {
			const card = getCard(str(ev.toolCallId), str(ev.toolName));
			const r = rec(ev.result);
			card.result = { content: r?.content, details: rec(r?.details) };
			card.status = ev.isError ? "error" : "done";
			if (card.startedAt) card.endedAt = Date.now();
			attachCard(card);
			scheduleCard(card);
			return;
		}
		case "btw_record":
			onBtwRecord(rec(ev.record) ?? {});
			return;
		case "btw_delta":
			onBtwDelta(str(ev.recordId), str(ev.delta));
			return;
		case "agent_start":
			agentBusy = true;
			turnStartedAt ??= Date.now();
			renderFooter();
			return;
		case "session_settled":
			agentBusy = false;
			turnStartedAt = undefined;
			renderFooter();
			return;
		case "prompt_result": {
			if (ev.sessionSettled) {
				agentBusy = false;
				turnStartedAt = undefined;
			}
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
			appendNotice(str(ev.message), (str(ev.level) as "info" | "warning" | "error") || "info", ev.markdown === true);
			return;
		case "command_output":
			transcript.append(commandOutputEl(str(ev.text)));
			updateEmpty();
			queueScroll();
			return;
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

unlockAudioOnGesture();
window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
	const msg = event.data;
	switch (msg.type) {
		case "sound":
			playSound(msg.variant, msg.volume);
			return;
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
			loadMessages(msg.messages);
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
			turnStartedAt = agentBusy ? (turnStartedAt ?? Date.now()) : undefined;
			renderDialogs();
			renderHeader();
			renderFooter();
			renderTodos();
			renderQueue(state?.queuedMessages?.steering ?? [], state?.queuedMessages?.followUp ?? []);
			renderTaskBar(msg.queue);
			linkify(transcript);
			findBar.refresh();
			updateEmpty();
			requestAnimationFrame(() => scrollToBottom(true));
			if (meta.status !== "stopped") input.focus();
			{
				const draft = str(rec(vscode.getState())?.draft);
				if (draft && !input.value) {
					input.value = draft;
					autosize();
				}
			}
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
			if (Object.keys(msg.diffs).length) diffsByTool.set(msg.change.toolCallId, msg.diffs);
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
			loadMessages(msg.messages);
			linkify(transcript);
			findBar.refresh();
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
			showPopup("file", [...mentionItems, ...msg.files.map(f => ({ label: f, insert: f }))]);
			return;
		case "models":
			modelsCache = msg.models;
			levelsCache = msg.levels;
			starredModels = new Set(msg.starred);
			menuEl?.refill?.();
			return;
		case "commands":
			commands = msg.commands;
			return;
		case "chatConfig":
			toolCardsCollapsed = msg.toolCardsCollapsed;
			// Apply to cards the user has not opened or closed themselves.
			for (const card of cards.values()) if (!card.userToggled && !EDIT_TOOLS[card.name] && card.name !== "ask") card.el.open = !toolCardsCollapsed;
			return;
		case "checkpoints":
			redoCount = msg.redo;
			renderHeader();
			return;
		case "origin":
			hermes = msg.hermes;
			renderHeader();
			return;
		case "clearComposerIf":
			if (input.value.trim() === msg.text.trim()) {
				input.value = "";
				autosize();
				saveDraft();
				updateSendState();
			}
			return;
		case "queue":
			renderTaskBar(msg.queue);
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
