// DOM helpers of the Switchyard webviews that are built without a framework (the Sessions Board and the
// Overview): element builder, the 16×16 line icons and a button that posts an action.

export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...children: Child[]): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
	return e;
}

const ICONS: Record<string, string> = {
	chat: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
	stop: '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/>',
	play: '<path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor"/>',
	pause: '<path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
	rerun: '<path d="M13 8a5 5 0 11-1.6-3.7M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
	archive: '<path d="M2 3.5h12v3H2zM3 6.5v6h10v-6M6.5 9h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
	unarchive: '<path d="M2 3.5h12v3H2zM3 6.5v6h10v-6M8 12V8.5M6.5 10 8 8.5 9.5 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
	palette: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6.3" r="1" fill="currentColor"/><circle cx="9.8" cy="6.3" r="1" fill="currentColor"/><circle cx="6.5" cy="10" r="1" fill="currentColor"/>',
	more: '<circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/>',
	chevron: '<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
	plus: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
	minus: '<path d="M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
	pin: '<path d="M6 2.5h4l-.5 4 2 2v1h-7v-1l2-2zM8 9.5V14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
	bell: '<path d="M4 11V7a4 4 0 018 0v4l1 1H3zM6.5 13.5a1.5 1.5 0 003 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
	check: '<path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
	circle: '<circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
	clock: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
	link: '<path d="M7 9a2.5 2.5 0 003.5 0l2.5-2.5a2.5 2.5 0 00-3.5-3.5L8.8 3.7M9 7a2.5 2.5 0 00-3.5 0L3 9.5A2.5 2.5 0 006.5 13l.7-.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
	run: '<path d="M3.5 3.5l6 4.5-6 4.5zM11 3.5v9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>',
	retry: '<path d="M12.5 8a4.5 4.5 0 11-1.3-3.2M12.5 2.5v2.8H9.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
	expand: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
	folder: '<path d="M1.5 4h4.5l1.5 1.5h7v7h-13z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
	alert: '<path d="M8 2.2l6.2 11H1.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".9" fill="currentColor"/>',
	question: '<circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.2 6.3a1.9 1.9 0 113 1.5c-.7.5-1.2.8-1.2 1.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.2" r=".9" fill="currentColor"/>',
	pr: '<circle cx="4.5" cy="3.8" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="4.5" cy="12.2" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="11.5" cy="12.2" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 5.3v5.4M11.5 10.7V6.5a2 2 0 00-2-2H8M9.3 3l-1.6 1.5L9.3 6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
	orchestrator: '<circle cx="8" cy="4" r="1.8" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="3.8" cy="12" r="1.8" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="12.2" cy="12" r="1.8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M7.2 5.7L4.6 10.3M8.8 5.7l2.6 4.6" stroke="currentColor" stroke-width="1.2"/>',
	diff: '<path d="M3 2.5h6l3 3v8H3z M9 2.5v3h3 M5.5 8.5h4M5.5 11h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
	gear: '<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6L5 5M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
	hermes: '<path d="M2.5 13.5L8 2.5l5.5 11M4.7 9.5h6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
	"p-urgent": '<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor"/><path d="M8 4.5v4.3" stroke="var(--vscode-editor-background)" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.4" r="1.05" fill="var(--vscode-editor-background)"/>',
	"p-high": '<rect x="2" y="9" width="3" height="5" rx=".8" fill="currentColor"/><rect x="6.5" y="6" width="3" height="8" rx=".8" fill="currentColor"/><rect x="11" y="2.5" width="3" height="11.5" rx=".8" fill="currentColor"/>',
	"p-normal": '<rect x="2" y="9" width="3" height="5" rx=".8" fill="currentColor"/><rect x="6.5" y="6" width="3" height="8" rx=".8" fill="currentColor"/><rect x="11" y="2.5" width="3" height="11.5" rx=".8" fill="currentColor" opacity=".25"/>',
	"p-low": '<rect x="2" y="9" width="3" height="5" rx=".8" fill="currentColor"/><rect x="6.5" y="6" width="3" height="8" rx=".8" fill="currentColor" opacity=".25"/><rect x="11" y="2.5" width="3" height="11.5" rx=".8" fill="currentColor" opacity=".25"/>',
};

export function icon(name: string, cls = ""): HTMLElement {
	const span = el("span", `ic ${cls}`.trim());
	span.setAttribute("aria-hidden", "true");
	span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16">${ICONS[name] ?? ""}</svg>`;
	return span;
}

export function button(cls: string, title: string, content: Child[], run: (ev: MouseEvent) => void): HTMLButtonElement {
	const b = el("button", cls, ...content);
	b.type = "button";
	b.title = title;
	b.setAttribute("aria-label", title);
	b.addEventListener("click", ev => {
		ev.stopPropagation();
		run(ev);
	});
	return b;
}
