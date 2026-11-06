// Transcript find bar (Ctrl/Cmd+F): highlights matches in the rendered conversation, counts
// matches in earlier messages that are not rendered yet, and offers to load them.
import { h } from "./dom";

/** Highlighting stops here; the count still says how many were found. */
const MAX_MARKS = 5000;

/** Whether the search is case-sensitive: only when the query has an uppercase letter ("smart case"). */
export function caseSensitive(query: string): boolean {
	return query !== query.toLowerCase();
}

/** Non-overlapping [start, end) ranges of `query` in `text` (smart case). */
export function findRanges(text: string, query: string): Array<[number, number]> {
	if (!query) return [];
	const sensitive = caseSensitive(query);
	const hay = sensitive ? text : text.toLowerCase();
	const needle = sensitive ? query : query.toLowerCase();
	const out: Array<[number, number]> = [];
	for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
	return out;
}

function rec(v: unknown): Record<string, unknown> | undefined {
	// Transcript messages are plain JSON objects; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Searchable text of a transcript message that is not rendered (approximates what it shows). */
export function messageSearchText(message: unknown): string {
	const m = rec(message);
	if (!m) return "";
	const parts: string[] = [];
	const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
	for (const raw of content) {
		const b = rec(raw);
		if (!b) continue;
		if (typeof b.text === "string") parts.push(b.text);
		if (typeof b.thinking === "string") parts.push(b.thinking);
		if (b.type === "toolCall") parts.push(String(b.name ?? ""), JSON.stringify(b.arguments ?? {}));
	}
	for (const k of ["command", "output", "message", "summary", "errorMessage"]) if (typeof m[k] === "string") parts.push(m[k]);
	return parts.join("\n");
}

/** Matches of `query` across messages that are not rendered. */
export function countMatches(messages: unknown[], query: string): number {
	let n = 0;
	for (const m of messages) n += findRanges(messageSearchText(m), query).length;
	return n;
}

export interface FindHooks {
	/** Matches in earlier messages that are not rendered. */
	hiddenMatches(query: string): number;
	/** Render every earlier message. */
	loadAll(): void;
	/** Bar closed (focus goes back to the composer). */
	onClose(): void;
}

export class FindBar {
	readonly el: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly status: HTMLElement;
	private readonly loadBtn: HTMLButtonElement;
	private marks: HTMLElement[] = [];
	private current = -1;
	/** Matches found in rendered text (may exceed the highlighted `marks`). */
	private total = 0;
	private timer: number | undefined;

	constructor(
		private readonly root: HTMLElement,
		private readonly hooks: FindHooks,
	) {
		this.input = h("input", { class: "find-input", type: "text", placeholder: "Find in conversation", "aria-label": "Find in conversation", spellcheck: "false" });
		this.status = h("span", { class: "find-status", "aria-live": "polite" });
		this.loadBtn = h("button", { class: "mini ghost hidden", title: "Render earlier messages so their matches can be shown", onclick: () => this.loadAll() }, "Load all");
		const prev = h("button", { class: "icon-btn", title: "Previous match (Shift+Enter)", "aria-label": "Previous match", onclick: () => this.step(-1) }, "↑");
		const next = h("button", { class: "icon-btn", title: "Next match (Enter)", "aria-label": "Next match", onclick: () => this.step(1) }, "↓");
		const close = h("button", { class: "icon-btn", title: "Close (Escape)", "aria-label": "Close find", onclick: () => this.close() }, "×");
		this.el = h("div", { class: "find-bar hidden", role: "search" }, this.input, this.status, this.loadBtn, prev, next, close);
		this.input.addEventListener("input", () => {
			clearTimeout(this.timer);
			this.timer = window.setTimeout(() => this.search(false), 120);
		});
		this.input.addEventListener("keydown", e => {
			if (e.key === "Enter" || e.key === "F3") {
				e.preventDefault();
				this.step(e.shiftKey ? -1 : 1);
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.close();
			}
		});
	}

	get isOpen(): boolean {
		return !this.el.classList.contains("hidden");
	}

	open(): void {
		this.el.classList.remove("hidden");
		const selected = window.getSelection()?.toString().trim();
		if (selected && !selected.includes("\n") && selected.length < 200) this.input.value = selected;
		this.input.focus();
		this.input.select();
		this.search(false);
	}

	close(): void {
		clearTimeout(this.timer);
		this.clear();
		this.status.textContent = "";
		this.el.classList.add("hidden");
		this.hooks.onClose();
	}

	/** Re-run the search after the transcript changed (keeps the current position when possible). */
	refresh(): void {
		if (this.isOpen) this.search(true);
	}

	private loadAll(): void {
		this.hooks.loadAll();
		this.search(true);
		this.input.focus();
	}

	private step(dir: 1 | -1): void {
		// Streaming re-renders can drop highlighted nodes; search again before moving.
		if (!this.marks.length || this.marks.some(m => !m.isConnected)) this.search(true);
		if (!this.marks.length) return;
		this.select((this.current + dir + this.marks.length) % this.marks.length);
	}

	private clear(): void {
		const parents = new Set<Node>();
		for (const m of this.marks) {
			const parent = m.parentNode;
			if (!parent) continue;
			parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
			parents.add(parent);
		}
		for (const p of parents) p.normalize();
		this.marks = [];
		this.current = -1;
	}

	private search(keepPosition: boolean): void {
		const previous = this.current;
		this.clear();
		const query = this.input.value;
		const hidden = query ? this.hooks.hiddenMatches(query) : 0;
		this.loadBtn.classList.toggle("hidden", hidden === 0);
		this.loadBtn.textContent = `Load ${hidden} in earlier messages`;
		if (!query) {
			this.status.textContent = "";
			return;
		}
		const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT, {
			acceptNode: n => (n.parentElement?.closest(".find-bar, script, style, .hidden") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
		});
		const nodes: Text[] = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n instanceof Text) nodes.push(n);
		this.total = 0;
		for (const node of nodes) {
			const ranges = findRanges(node.data, query);
			this.total += ranges.length;
			if (!ranges.length || this.marks.length >= MAX_MARKS) continue;
			const created: HTMLElement[] = [];
			// Wrap from the end so earlier offsets stay valid.
			for (let i = ranges.length - 1; i >= 0; i--) {
				const [start, end] = ranges[i];
				const hit = node.splitText(start);
				hit.splitText(end - start);
				const mark = h("mark", { class: "find-hit" }, hit.data);
				hit.replaceWith(mark);
				created.unshift(mark);
			}
			this.marks.push(...created);
		}
		if (!this.marks.length) {
			this.status.textContent = hidden ? "No matches shown" : "No matches";
			this.status.classList.toggle("none", !hidden);
			return;
		}
		this.status.classList.remove("none");
		this.select(keepPosition && previous >= 0 ? Math.min(previous, this.marks.length - 1) : this.firstBelowTop());
	}

	/** First match at or below the top of the viewport, so a new search starts where the reader is. */
	private firstBelowTop(): number {
		const top = this.root.getBoundingClientRect().top;
		const i = this.marks.findIndex(m => m.getBoundingClientRect().bottom >= top);
		return i < 0 ? this.marks.length - 1 : i;
	}

	private select(index: number): void {
		this.marks[this.current]?.classList.remove("current");
		this.current = index;
		const mark = this.marks[index];
		mark.classList.add("current");
		for (let p = mark.parentElement; p && p !== this.root; p = p.parentElement) if (p instanceof HTMLDetailsElement && !p.open) p.open = true;
		mark.scrollIntoView({ block: "center" });
		const capped = this.total > this.marks.length ? ` (${this.total} found, first ${this.marks.length} shown)` : "";
		this.status.textContent = `${index + 1}/${this.marks.length}${capped}`;
	}
}
