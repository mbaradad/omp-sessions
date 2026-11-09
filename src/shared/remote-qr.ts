// QR codes of the pairing URL: Unicode half blocks for `switchyard remote qr`, SVG for the VS Code
// "Connect Phone" view. Encoding by qrcode-generator (MIT), bundled into out/ by esbuild.
import qrcode from "qrcode-generator";

/** Dark modules of `text`'s QR code (error correction M), rows of columns, without quiet zone. */
export function qrMatrix(text: string): boolean[][] {
	const qr = qrcode(0, "M");
	qr.addData(text, "Byte");
	qr.make();
	const n = qr.getModuleCount();
	return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/**
 * Two module rows per text line with ▀ ▄ █. `color`: black on white via ANSI colors, readable on
 * any terminal theme; without it dark modules print as spaces and light ones as blocks (the
 * usual light-on-dark terminal shows a normal code).
 */
export function qrHalfBlocks(text: string, color: boolean, margin = 2): string {
	const m = qrMatrix(text);
	const size = m.length + margin * 2;
	const dark = (r: number, c: number) => m[r - margin]?.[c - margin] === true;
	const lines: string[] = [];
	for (let r = 0; r < size; r += 2) {
		let line = "";
		for (let c = 0; c < size; c++) {
			const top = dark(r, c);
			const bottom = r + 1 < size && dark(r + 1, c);
			// Colored: glyphs draw dark modules (black on white). Plain: glyphs draw light ones.
			const [t, b] = color ? [top, bottom] : [!top, r + 1 < size ? !bottom : false];
			line += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
		}
		lines.push(color ? `\x1b[30;47m${line}\x1b[0m` : line);
	}
	return `${lines.join("\n")}\n`;
}

/** Standalone SVG (black on white, quiet zone included) that scales to its container. */
export function qrSvg(text: string, margin = 4): string {
	const m = qrMatrix(text);
	const size = m.length + margin * 2;
	let d = "";
	m.forEach((row, r) =>
		row.forEach((on, c) => {
			if (on) d += `M${c + margin} ${r + margin}h1v1h-1z`;
		}),
	);
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
