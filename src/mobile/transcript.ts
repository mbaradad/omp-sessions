// Session transcript for the phone: user/assistant text as markdown, tool calls as compact rows
// (edits with file and +n −m), the streaming message updated in place, and omp's dialogs as
// answerable cards. Mirrors what the VS Code chat shows, in less space.
import { parseOmpDiff } from "../shared/diff";
import { PLAN_PROMPT_PREFIX, approvalTool } from "../shared/permissions";
import type { UiRequest } from "../shared/protocol";
import { append, basename, h, isRecord, str } from "./dom";
import { renderMarkdown } from "./markdown";

const TOOL_GLYPH: Record<string, string> = {
	read: "▤",
	write: "✎",
	edit: "✎",
	ast_edit: "✎",
	notebook: "▤",
	bash: "❯",
	grep: "⌕",
	glob: "⌕",
	find: "⌕",
	task: "⧉",
	web_search: "◍",
	browser: "◍",
	todo: "☑",
	ask: "?",
	lsp: "λ",
	eval: "λ",
};

type ToolStatus = "pending" | "running" | "done" | "error";

interface ToolEntry {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: ToolStatus;
	output: string;
	details: Record<string, unknown>;
	row: HTMLDetailsElement;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isRecord)
		.filter(b => b.type === "text")
		.map(b => str(b.text))
		.join("\n");
}

function editPaths(args: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const k of ["path", "file", "file_path"]) if (typeof args[k] === "string") out.push(str(args[k]));
	const input = str(args.input) || str(args.patch);
	for (const m of input.matchAll(/^\[([^\]\n#]+)#[0-9A-Za-z]{2,8}\]/gm)) out.push(m[1].trim());
	for (const m of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
	return [...new Set(out)];
}

/** Lines added/removed by an edit-like tool call, from omp's diff rows or the written content. */
function editStats(t: ToolEntry): { added: number; removed: number } | undefined {
	const d = t.details;
	const diffs = Array.isArray(d.perFileResults) ? d.perFileResults.filter(isRecord).map(f => str(f.diff)) : [str(d.diff)];
	let added = 0;
	let removed = 0;
	for (const diff of diffs.filter(Boolean)) {
		const parsed = parseOmpDiff(diff);
		added += parsed.added;
		removed += parsed.removed;
	}
	if (added || removed) return { added, removed };
	if (t.name === "write" && typeof t.args.content === "string") return { added: t.args.content.replace(/\n$/, "").split("\n").length, removed: 0 };
	return undefined;
}

function toolSummary(t: ToolEntry): string {
	const a = t.args;
	switch (t.name) {
		case "write":
		case "edit":
		case "ast_edit":
		case "notebook":
			return editPaths(a).map(basename).join(", ");
		case "bash":
			return str(a.command).split("\n")[0];
		case "read":
			return str(a.path) || str(a.file_path);
		case "grep":
			return `${str(a.pattern)}${a.path ? ` in ${str(a.path)}` : ""}`;
		case "task": {
			const n = Array.isArray(a.tasks) ? a.tasks.length : 0;
			return n ? `${n} subagent${n === 1 ? "" : "s"}` : str(a.agent);
		}
		default: {
			const first = Object.entries(a).find(([k, v]) => k !== "i" && typeof v === "string" && v.length < 200);
			return first ? str(first[1]) : "";
		}
	}
}

/** The transcript of one session; `scroller` is the element that scrolls. */
export class Transcript {
	readonly el = h("div", { class: "transcript" });
	private readonly tools = new Map<string, ToolEntry>();
	private live: { id: string; el: HTMLElement } | undefined;

	constructor(private readonly scroller: HTMLElement) {}

	private nearBottom(): boolean {
		const s = this.scroller;
		return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
	}

	/** Runs `change`, keeping the view pinned to the bottom when it was there. */
	private keepBottom(change: () => void): void {
		const pinned = this.nearBottom();
		change();
		if (pinned) this.scrollToEnd();
	}

	scrollToEnd(): void {
		this.scroller.scrollTop = this.scroller.scrollHeight;
	}

	reset(messages: readonly unknown[], omitted: number): void {
		this.tools.clear();
		this.live = undefined;
		this.el.replaceChildren();
		if (omitted > 0) this.el.append(h("div", { class: "omitted" }, `${omitted} earlier message${omitted === 1 ? "" : "s"} not shown`));
		for (const m of messages) this.el.append(...this.render(m));
		if (!messages.length) this.el.append(h("div", { class: "empty" }, "No messages yet."));
		this.scrollToEnd();
	}

	/** Streaming message (assistant text so far); replaced in place on every update. */
	setLive(id: string, message: unknown): void {
		this.keepBottom(() => {
			const el = h("div", { class: "live" }, ...this.render(message, true));
			if (this.live?.id === id) this.live.el.replaceWith(el);
			else {
				this.live?.el.remove();
				this.el.querySelector(":scope > .empty")?.remove();
				this.el.append(el);
			}
			this.live = { id, el };
		});
	}

	commit(id: string, message: unknown): void {
		this.keepBottom(() => {
			const nodes = this.render(message);
			if (this.live?.id === id) {
				this.live.el.replaceWith(...nodes);
				this.live = undefined;
			} else {
				this.el.querySelector(":scope > .empty")?.remove();
				this.el.append(...nodes);
			}
		});
	}

	add(message: unknown): void {
		this.keepBottom(() => this.el.append(...this.render(message)));
	}

	toolStart(id: string, name: string, args: unknown): void {
		const t = this.tool(id, name);
		if (isRecord(args)) t.args = args;
		t.status = "running";
		this.paint(t);
	}

	toolUpdate(id: string, partial: unknown): void {
		const t = this.tools.get(id);
		if (!t || !isRecord(partial)) return;
		t.output = contentText(partial.content);
		this.paint(t);
	}

	toolEnd(id: string, name: string, result: unknown, isError: boolean): void {
		const t = this.tool(id, name);
		if (isRecord(result)) {
			t.output = contentText(result.content);
			if (isRecord(result.details)) t.details = result.details;
		}
		t.status = isError ? "error" : "done";
		this.paint(t);
	}

	private tool(id: string, name: string): ToolEntry {
		const existing = this.tools.get(id);
		if (existing) return existing;
		const row = h("details", { class: "tool" });
		const t: ToolEntry = { id, name, args: {}, status: "pending", output: "", details: {}, row };
		this.tools.set(id, t);
		return t;
	}

	private paint(t: ToolEntry): void {
		const stats = editStats(t);
		const summary = toolSummary(t);
		t.row.className = `tool ${t.status}`;
		const open = t.row.open;
		t.row.replaceChildren(
			h(
				"summary",
				{},
				h("span", { class: "tdot" }),
				h("span", { class: "tglyph" }, TOOL_GLYPH[t.name] ?? "•"),
				h("span", { class: "tname" }, t.name),
				h("span", { class: "tsum" }, summary),
				stats ? h("span", { class: "stats" }, h("span", { class: "add" }, `+${stats.added}`), " ", h("span", { class: "del" }, `−${stats.removed}`)) : null,
			),
			t.output ? h("pre", { class: "out" }, t.output) : h("div", { class: "out dim" }, t.status === "running" ? "running…" : "no output"),
		);
		t.row.open = open;
	}

	private render(message: unknown, live = false): Node[] {
		if (!isRecord(message)) return [];
		switch (message.role) {
			case "user": {
				const text = contentText(message.content).replace(PLAN_PROMPT_PREFIX, "");
				const images = Array.isArray(message.content) ? message.content.filter(b => isRecord(b) && b.type === "image").length : 0;
				return [h("div", { class: "msg user" }, h("div", { class: "bubble md" }, renderMarkdown(text)), images ? h("div", { class: "dim small" }, `${images} image${images === 1 ? "" : "s"}`) : null)];
			}
			case "assistant": {
				const out: Node[] = [];
				const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
				for (const b of blocks) {
					if (b.type === "text" && str(b.text).trim()) out.push(h("div", { class: "msg assistant md" }, renderMarkdown(str(b.text))));
					else if (b.type === "thinking" && str(b.thinking).trim()) out.push(h("details", { class: "thinking" }, h("summary", {}, live ? "Thinking…" : "Thought"), h("div", { class: "md" }, renderMarkdown(str(b.thinking)))));
					else if (b.type === "toolCall" && typeof b.id === "string") {
						const t = this.tool(b.id, str(b.name));
						if (isRecord(b.arguments)) t.args = b.arguments;
						this.paint(t);
						out.push(t.row);
					}
				}
				if (!live && (message.stopReason === "error" || message.stopReason === "aborted")) out.push(h("div", { class: "note error" }, str(message.errorMessage) || (message.stopReason === "aborted" ? "Aborted" : "The model request failed")));
				if (live && !out.length) out.push(h("div", { class: "msg assistant typing" }, h("span"), h("span"), h("span")));
				return out;
			}
			case "toolResult": {
				if (typeof message.toolCallId === "string") this.toolEnd(message.toolCallId, str(message.toolName), message, message.isError === true);
				return [];
			}
			case "commandOutput":
				return [h("pre", { class: "out cmd" }, str(message.text))];
			case "notice":
				return [h("div", { class: `note ${str(message.level) || "info"}` }, str(message.message))];
			default: {
				const text = str(message.text) || str(message.message) || str(message.summary);
				return text ? [h("div", { class: "note" }, text)] : [];
			}
		}
	}
}

/** A card answering one omp dialog; `respond` gets the `ui_response` fields (without id). */
export function dialogCard(req: UiRequest, respond: (answer: Record<string, unknown>) => void): HTMLElement {
	const box = h("div", { class: "dialog" });
	const dismiss = h("button", { class: "ghost", onclick: () => respond({ cancelled: true }) }, "Dismiss");
	const tool = approvalTool(req);
	switch (req.method) {
		case "select": {
			const options = Array.isArray(req.options) ? req.options.map(String) : [];
			const [first, ...rest] = str(req.title).split("\n");
			append(box, [
				tool ? h("div", { class: "dkind" }, "Approval") : null,
				h("div", { class: "dtitle" }, tool ? `Allow ${tool}?` : first),
				rest.length ? h("pre", { class: "ddetail" }, rest.join("\n")) : null,
				h(
					"div",
					{ class: "options" },
					...options.map(o => h("button", { class: /^approve/i.test(o) ? (o === "Approve" || o === "Approve Once" ? "primary" : "") : /^deny|^reject/i.test(o) ? "danger" : "", onclick: () => respond({ value: o }) }, o)),
				),
				h("div", { class: "dactions" }, dismiss),
			]);
			break;
		}
		case "confirm":
			append(box, [
				h("div", { class: "dtitle" }, str(req.title)),
				req.message ? h("div", { class: "dmsg" }, str(req.message)) : null,
				h("div", { class: "options row" }, h("button", { class: "primary", onclick: () => respond({ confirmed: true }) }, "Yes"), h("button", { onclick: () => respond({ confirmed: false }) }, "No")),
			]);
			break;
		case "input":
		case "editor": {
			const field = req.method === "editor" ? h("textarea", { rows: 6 }) : h("input", { type: "text", placeholder: str(req.placeholder) || undefined });
			field.value = str(req.prefill);
			box.append(h("div", { class: "dtitle" }, str(req.title)), field, h("div", { class: "dactions" }, dismiss, h("button", { class: "primary", onclick: () => respond({ value: field.value }) }, "Submit")));
			break;
		}
		case "ask": {
			const questions = Array.isArray(req.questions) ? req.questions.filter(isRecord) : [];
			const answers = questions.map(() => ({ selected: new Set<string>(), custom: "" }));
			const submit = () =>
				respond({
					answers: questions.map((q, i) => ({ id: str(q.id), selectedOptions: [...answers[i].selected], ...(answers[i].custom.trim() ? { customInput: answers[i].custom.trim() } : {}) })),
				});
			questions.forEach((q, qi) => {
				const multi = q.multi === true;
				const buttons: HTMLButtonElement[] = [];
				const opts = Array.isArray(q.options) ? q.options.filter(isRecord) : [];
				const list = h("div", { class: "options" });
				for (const o of opts) {
					const label = str(o.label);
					const btn = h(
						"button",
						{
							onclick: () => {
								const set = answers[qi].selected;
								if (multi) {
									if (set.has(label)) set.delete(label);
									else set.add(label);
								} else {
									set.clear();
									set.add(label);
								}
								for (const b of buttons) b.classList.toggle("selected", set.has(b.dataset.label ?? ""));
								if (!multi && questions.length === 1) submit();
							},
						},
						h("span", {}, label),
						o.description ? h("span", { class: "odesc" }, str(o.description)) : null,
					);
					btn.dataset.label = label;
					buttons.push(btn);
					list.append(btn);
				}
				const other = h("input", { type: "text", placeholder: "Other…", oninput: () => (answers[qi].custom = other.value) });
				box.append(h("div", { class: "question" }, h("div", { class: "dtitle" }, str(q.question)), list, other));
			});
			box.append(h("div", { class: "dactions" }, dismiss, h("button", { class: "primary", onclick: submit }, "Submit")));
			break;
		}
		default:
			box.append(h("div", { class: "dtitle" }, req.method), h("div", { class: "dactions" }, dismiss));
	}
	return box;
}
