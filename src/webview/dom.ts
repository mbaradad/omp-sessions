import type { FromWebview } from "../shared/webview";

interface VsCodeApi {
	postMessage(msg: FromWebview): void;
	setState(state: unknown): void;
	getState(): unknown;
}
declare function acquireVsCodeApi(): VsCodeApi;
export const vscode = acquireVsCodeApi();
export const post = (msg: FromWebview): void => vscode.postMessage(msg);

type Child = Node | string | null | undefined | false;
export type Attrs = Record<string, string | boolean | undefined | ((ev: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === false) continue;
		if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
		else if (k === "class") el.className = String(v);
		else if (v === true) el.setAttribute(k, "");
		else el.setAttribute(k, v);
	}
	for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
	// Icon-only buttons: screen readers announce the tooltip.
	if (tag === "button" && typeof attrs.title === "string" && !attrs["aria-label"] && !el.textContent?.trim()) el.setAttribute("aria-label", attrs.title);
	return el;
}

export function rec(v: unknown): Record<string, unknown> | undefined {
	// Plain JSON objects from the extension; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => ESCAPES[c] ?? c);
}

/** Inline SVG icons (codicon-like), sized by CSS. */
const ICONS: Record<string, string> = {
	copy: '<path d="M4 4h7v9H4z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 2h7v9" fill="none" stroke="currentColor" stroke-width="1.3"/>',
	check: '<path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
	diff: '<path d="M5 2v8M1 6h8M8 13h7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
	file: '<path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.3"/>',
	clip: '<path d="M11 7.5l-4.6 4.6a2.6 2.6 0 01-3.7-3.7L8 3.1a1.7 1.7 0 012.5 2.5L5.4 10.7a.8.8 0 01-1.2-1.2L8.5 5.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
	send: '<path d="M2 8l12-5.5L9.5 14 8 9z" fill="currentColor"/>',
	stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/>',
	more: '<circle cx="3" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="13" cy="8" r="1.4" fill="currentColor"/>',
	x: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
	link: '<path d="M7 9a3 3 0 004.2 0l2.3-2.3a3 3 0 00-4.2-4.2L8.6 3.2M9 7a3 3 0 00-4.2 0L2.5 9.3a3 3 0 004.2 4.2l.7-.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
	edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
	fork: '<circle cx="4" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 5.1v1.4c0 1.4 1 2.2 2.4 2.6L8 9.5v1.4M12 5.1v1.4c0 1.4-1 2.2-2.4 2.6L8 9.5" fill="none" stroke="currentColor" stroke-width="1.3"/>',
	chevron: '<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
	undo: '<path d="M5.5 3L2.5 6l3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 6h6.5a3.5 3.5 0 010 7H6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
	redo: '<path d="M10.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 6H6.5a3.5 3.5 0 000 7H10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
	mic: '<rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 7.5a5 5 0 0010 0M8 12.5v2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
	terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 6l2.5 2L4 10M8 10.5h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
};
export function icon(name: string, cls = ""): HTMLElement {
	const span = h("span", { class: `ic ${cls}`.trim(), "aria-hidden": "true" });
	span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16">${ICONS[name] ?? ""}</svg>`;
	return span;
}

/** Copy via the extension (webview clipboard access is not reliable remotely). */
export function copyButton(getText: () => string, title = "Copy"): HTMLButtonElement {
	const btn = h("button", { class: "icon-btn", title }, icon("copy"));
	btn.addEventListener("click", e => {
		e.preventDefault();
		e.stopPropagation();
		post({ type: "copy", text: getText() });
		btn.replaceChildren(icon("check"));
		setTimeout(() => btn.replaceChildren(icon("copy")), 1200);
	});
	return btn;
}
