// Remote access from VS Code: *Connect Phone…* turns on the omp-vs server's HTTP API + phone app
// (asking Tailscale / local network / this computer), makes sure the server runs and shows the
// pairing QR code; *Disable Remote Access* and *Rotate Remote Access Token* manage it afterwards.
// The server does the serving (src/server/remote.ts); this module only edits remote.json.
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { type RemoteBind, type RemoteStatus, lanAddress, newRemoteToken, pairingUrl, readRemoteConfig, tailscaleAddress, updateRemoteConfig } from "../shared/remote";
import { qrSvg } from "../shared/remote-qr";
import { ServerClient } from "../shared/server-client";
import type { OmpApi } from "./api";
import type { ServerControl } from "./server";

type BindItem = vscode.QuickPickItem & { bind: RemoteBind };

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

/** Applies remote.json in the running server; undefined when no server runs. */
async function applyInServer(): Promise<RemoteStatus | undefined> {
	const client = await ServerClient.connect();
	if (!client) return undefined;
	try {
		return await client.request("remote", {}, 10_000);
	} finally {
		client.close();
	}
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
}

function pairingHtml(webview: vscode.Webview, status: RemoteStatus, url: string): string {
	const nonce = crypto.randomBytes(16).toString("base64");
	const warning =
		status.bind === "lan"
			? `<p class="warn">Local network mode is plain HTTP: anyone on the same Wi-Fi can see the traffic, including this pairing code. Use it only on a network you trust; Tailscale encrypts the connection.</p>`
			: status.bind === "localhost"
				? `<p class="warn">Bound to 127.0.0.1: only this computer (or your own tunnel / reverse proxy) can reach it.</p>`
				: "";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; max-width: 560px; margin: 0 auto; }
h1 { font-size: 1.4em; margin: 0 0 4px; }
.dim { color: var(--vscode-descriptionForeground); }
.qr { width: min(320px, 80vw); margin: 20px 0; padding: 0; border-radius: 12px; overflow: hidden; }
.qr svg { display: block; width: 100%; height: auto; }
.url { display: flex; gap: 8px; }
.url input { flex: 1; min-width: 0; padding: 6px 8px; font-family: var(--vscode-editor-font-family); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
button { padding: 6px 14px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; cursor: pointer; }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.warn { padding: 8px 12px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); }
.actions { display: flex; gap: 8px; margin-top: 24px; }
ol { padding-left: 1.2em; }
</style></head><body>
<h1>Connect Phone</h1>
<div class="dim">Listening on ${escapeHtml(status.url ?? "")} (${escapeHtml(status.bind)})</div>
<div class="qr">${qrSvg(url)}</div>
<ol>
<li>Scan the code with your phone's camera${status.bind === "tailscale" ? " (Tailscale must be on there too)" : ""}.</li>
<li>Opening the link pairs that browser: it keeps a cookie, the address bar keeps no token.</li>
<li>Add it to the home screen to use it like an app.</li>
</ol>
<div class="url"><input id="url" readonly value="${escapeHtml(url)}"><button id="copy">Copy</button></div>
<p class="dim">Anyone with this link can see and control your omp sessions. Rotate the token to unpair every phone.</p>
${warning}
<div class="actions"><button class="secondary" id="rotate">Rotate Token</button><button class="secondary" id="disable">Turn Off Remote Access</button></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const id of ["copy", "rotate", "disable"]) document.getElementById(id).addEventListener("click", () => vscode.postMessage({ type: id }));
document.getElementById("url").addEventListener("focus", e => e.target.select());
</script>
</body></html>`;
}

export function registerRemote(api: OmpApi, server: ServerControl): void {
	const { context } = api;
	let panel: vscode.WebviewPanel | undefined;
	/** The pairing link the panel shows. */
	let shownUrl = "";

	const showPanel = (status: RemoteStatus) => {
		if (!status.url) return;
		const url = pairingUrl(status.url, readRemoteConfig().token);
		shownUrl = url;
		if (!panel) {
			const created = vscode.window.createWebviewPanel("omp.remote", "Connect Phone", vscode.ViewColumn.Active, { enableScripts: true });
			created.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "omp-color.svg");
			created.onDidDispose(() => {
				if (panel === created) panel = undefined;
			});
			created.webview.onDidReceiveMessage(async (msg: unknown) => {
				if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
				if (msg.type === "copy") {
					await vscode.env.clipboard.writeText(shownUrl);
					void vscode.window.showInformationMessage("Copied the pairing link. Treat it like a password.");
				} else if (msg.type === "rotate") await vscode.commands.executeCommand("omp.remote.rotateToken");
				else if (msg.type === "disable") await vscode.commands.executeCommand("omp.remote.disable");
			});
			panel = created;
		}
		panel.webview.html = pairingHtml(panel.webview, status, url);
		panel.reveal();
	};

	/** Asks where to listen; explains Tailscale and the plain-HTTP risk of the local network. */
	const pickBind = async (): Promise<RemoteBind | undefined> => {
		const ts = tailscaleAddress();
		const lan = lanAddress();
		const current = readRemoteConfig().bind;
		const items: BindItem[] = [
			{ label: "$(lock) Tailscale", description: ts ? `${ts} · recommended` : "not running on this machine", detail: "Encrypted, reachable wherever your phone has internet. Free for personal use.", bind: "tailscale" },
			{ label: "$(broadcast) Local network (Wi-Fi)", description: lan ?? "", detail: "Plain HTTP: others on the same Wi-Fi could read the traffic and the pairing code.", bind: "lan" },
			{ label: "$(device-desktop) This computer only", description: "127.0.0.1", detail: "Try it in a browser here, or put your own tunnel / reverse proxy in front.", bind: "localhost" },
		];
		const qp = vscode.window.createQuickPick<BindItem>();
		qp.title = "Connect Phone: how should your phone reach this machine?";
		qp.items = items;
		qp.activeItems = items.filter(i => i.bind === (ts ? "tailscale" : current));
		const { promise, resolve } = Promise.withResolvers<RemoteBind | undefined>();
		qp.onDidAccept(() => {
			resolve(qp.selectedItems[0]?.bind);
			qp.hide();
		});
		qp.onDidHide(() => {
			resolve(undefined);
			qp.dispose();
		});
		qp.show();
		let bind = await promise;
		if (bind === "tailscale" && !ts) {
			const pick = await vscode.window.showWarningMessage(
				"Tailscale isn't running on this machine.",
				{
					modal: true,
					detail:
						"Tailscale is free for personal use and encrypts the connection between your phone and this computer, wherever you are. Install it here and on your phone, sign in to the same account, then run Connect Phone again.\n\nOr use the local network instead: plain HTTP, visible to others on that Wi-Fi.",
				},
				"Get Tailscale",
				"Use Local Network…",
			);
			if (pick === "Get Tailscale") void vscode.env.openExternal(vscode.Uri.parse(TAILSCALE_DOWNLOAD));
			if (pick !== "Use Local Network…") return undefined;
			bind = "lan";
		}
		if (bind === "lan") {
			const ok = await vscode.window.showWarningMessage(
				"Use the local network without encryption?",
				{
					modal: true,
					detail:
						"The phone app talks plain HTTP. Anyone on the same Wi-Fi can see your sessions' traffic, including the pairing token, and could control your sessions with it. Use this only on a network you trust (not public Wi-Fi); Tailscale encrypts the connection.",
				},
				"Use Local Network",
			);
			if (ok !== "Use Local Network") return undefined;
		}
		return bind;
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("omp.remote.connectPhone", async () => {
			const bind = await pickBind();
			if (!bind) return;
			try {
				updateRemoteConfig({ enabled: true, bind });
				await server.ensureRunning();
				const status = await applyInServer();
				if (!status) throw new Error("the omp-vs server is not reachable");
				if (!status.url) throw new Error(status.error ?? "remote access is not listening");
				showPanel(status);
			} catch (err) {
				const pick = await vscode.window.showErrorMessage(`Could not turn on remote access: ${err instanceof Error ? err.message : String(err)}`, "Show Server Log");
				if (pick) void vscode.commands.executeCommand("omp.server.showLog");
			}
		}),
		vscode.commands.registerCommand("omp.remote.disable", async () => {
			updateRemoteConfig({ enabled: false });
			await applyInServer().catch(() => undefined);
			panel?.dispose();
			void vscode.window.showInformationMessage("Remote access is off. Paired phones stay paired until you rotate the token.");
		}),
		vscode.commands.registerCommand("omp.remote.rotateToken", async () => {
			const cfg = updateRemoteConfig({ token: newRemoteToken() });
			const status = await applyInServer().catch(() => undefined);
			if (panel && status?.url) showPanel(status);
			const pick = await vscode.window.showInformationMessage("New remote access token: every paired phone has to pair again.", ...(cfg.enabled && status?.url && !panel ? ["Show QR Code"] : []));
			if (pick && status) showPanel(status);
		}),
	);
}
