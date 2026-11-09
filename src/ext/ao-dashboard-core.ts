// Pure helpers for the AO Dashboard panel (no `vscode` import, so unit tests can load them): the webview
// page that frames AO's own UI, served by the planner (src/ao/dashboard.ts), at the URL VS Code forwards.

/**
 * The iframe's src: the forwarded dashboard URL with its path ending in `/` (AO's UI uses relative URLs and
 * hash routes, so it must load as a folder). Throws on anything but an http(s) URL.
 */
export function frameUrl(external: string): URL {
	const url = new URL(external);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`not an http(s) URL: ${external}`);
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	url.hash = "";
	return url;
}

function escapeAttr(s: string): string {
	return s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
}

/**
 * The panel page: a thin toolbar (Reload, Open in Browser) over a borderless full-size iframe. The CSP lets the
 * page frame only the dashboard's origin and run only its own nonce'd script and style.
 */
export function dashboardHtml(external: string, nonce: string): string {
	const url = frameUrl(external);
	const src = escapeAttr(url.toString());
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeAttr(url.origin)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
.bar { display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.bar .url { flex: 1; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { padding: 2px 10px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; cursor: pointer; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
iframe { flex: 1; width: 100%; border: 0; background: var(--vscode-editor-background); }
</style></head><body>
<div class="bar"><span class="url">${src}</span><button id="reload">Reload</button><button id="open">Open in Browser</button></div>
<iframe id="frame" src="${src}" allow="clipboard-read; clipboard-write" title="AO Dashboard"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const frame = document.getElementById("frame");
// Setting src again reloads the frame, back at the board (the frame is cross-origin: no location.reload()).
document.getElementById("reload").addEventListener("click", () => { frame.src = ${JSON.stringify(url.toString()).replace(/</g, "\\u003c")}; });
document.getElementById("open").addEventListener("click", () => vscode.postMessage({ type: "open" }));
</script>
</body></html>`;
}
