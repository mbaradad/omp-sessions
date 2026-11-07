// DOM and value helpers of the phone app (no framework; text always goes in as text nodes).

type Attrs = Record<string, string | boolean | number | undefined | EventListener>;
export type Child = Node | string | false | null | undefined;

/** Creates an element: `on…` attributes become listeners, `false`/undefined attributes are skipped. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === false) continue;
		if (typeof v === "function") el.addEventListener(k.slice(2), v);
		else if (v === true) el.setAttribute(k, "");
		else el.setAttribute(k, String(v));
	}
	append(el, children);
	return el;
}

export function append(el: Node, children: readonly Child[]): void {
	for (const c of children) if (c !== false && c !== null && c !== undefined) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
}

/** The app's one JSON-object guard (API and host messages). */
export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

export function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function basename(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

export function ago(ms: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return "now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const hrs = Math.round(m / 60);
	if (hrs < 48) return `${hrs}h`;
	return `${Math.round(hrs / 24)}d`;
}

export function money(cost: number | undefined): string {
	if (!cost) return "";
	return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}
