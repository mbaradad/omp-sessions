// Minimal SGR renderer for command output (colors, 256-color, bold/dim/italic/underline).
const BASE = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

function color256(n: number): string {
	if (n < 8) return `var(--vscode-terminal-ansi${cap(BASE[n])})`;
	if (n < 16) return `var(--vscode-terminal-ansiBright${cap(BASE[n - 8])})`;
	if (n < 232) {
		const i = n - 16;
		const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
		return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
	}
	const g = 8 + (n - 232) * 10;
	return `rgb(${g},${g},${g})`;
}

function cap(s: string): string {
	return s[0].toUpperCase() + s.slice(1);
}

interface Style {
	fg?: string;
	bg?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
}

function apply(style: Style, codes: number[]): Style {
	const s = { ...style };
	for (let i = 0; i < codes.length; i++) {
		const c = codes[i];
		if (c === 0) Object.assign(s, { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false });
		else if (c === 1) s.bold = true;
		else if (c === 2) s.dim = true;
		else if (c === 3) s.italic = true;
		else if (c === 4) s.underline = true;
		else if (c === 22) s.bold = s.dim = false;
		else if (c === 23) s.italic = false;
		else if (c === 24) s.underline = false;
		else if (c >= 30 && c <= 37) s.fg = color256(c - 30);
		else if (c >= 90 && c <= 97) s.fg = color256(c - 90 + 8);
		else if (c === 39) s.fg = undefined;
		else if (c >= 40 && c <= 47) s.bg = color256(c - 40);
		else if (c >= 100 && c <= 107) s.bg = color256(c - 100 + 8);
		else if (c === 49) s.bg = undefined;
		else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
			const col = color256(codes[i + 2] ?? 0);
			if (c === 38) s.fg = col;
			else s.bg = col;
			i += 2;
		} else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
			const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
			if (c === 38) s.fg = col;
			else s.bg = col;
			i += 4;
		}
	}
	return s;
}

export function hasAnsi(text: string): boolean {
	return text.includes("\x1b[");
}

/** Renders text with ANSI SGR codes into `target`; other escape sequences are dropped. */
export function renderAnsi(text: string, target: HTMLElement): void {
	let style: Style = {};
	let last = 0;
	const re = /\x1b\[([\d;]*)([A-Za-z])/g;
	const flush = (chunk: string) => {
		if (!chunk) return;
		if (!style.fg && !style.bg && !style.bold && !style.dim && !style.italic && !style.underline) {
			target.append(chunk);
			return;
		}
		const span = document.createElement("span");
		span.textContent = chunk;
		if (style.fg) span.style.color = style.fg;
		if (style.bg) span.style.background = style.bg;
		if (style.bold) span.style.fontWeight = "600";
		if (style.dim) span.style.opacity = "0.65";
		if (style.italic) span.style.fontStyle = "italic";
		if (style.underline) span.style.textDecoration = "underline";
		target.append(span);
	};
	for (let m = re.exec(text); m; m = re.exec(text)) {
		flush(text.slice(last, m.index));
		last = m.index + m[0].length;
		if (m[2] === "m") style = apply(style, (m[1] || "0").split(";").map(Number));
	}
	flush(text.slice(last).replace(/\x1b\][^\x07]*\x07/g, ""));
}
