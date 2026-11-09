// Remote access from VS Code: *Connect Phone…* pairs AO's mobile app with this machine. AO's daemon
// serves the phone (`/api/v1/mobile/*`: an authenticated listener on the local network, Tailscale TLS,
// and optionally a Cloudflare tunnel); this module turns it on, shows the pairing QR code and manages it.
// *Disable Remote Access* turns the listener off; *Rotate Remote Access Token* mints a new password,
// which unpairs every phone.
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { AoClient } from "../ao/client";
import { ANDROID_APP_URL, IOS_APP_URL, type PairingStatus, pairingLink, pairingPending, reachSummary } from "../ao/mobile";
import { qrSvg } from "../shared/remote-qr";
import type { OmpApi } from "./api";
import { plain } from "./plain";
import type { ServerControl } from "./server";

type Reach = "lan" | "anywhere";
type ReachItem = vscode.QuickPickItem & { reach: Reach };

/** How long Connect Phone waits for the first address (the tunnel can take a minute; LAN is instant). */
const READY_TIMEOUT_MS = 90_000;
const POLL_MS = 2_000;

type MobilePath = "/api/v1/mobile/enable" | "/api/v1/mobile/enable-lan-only" | "/api/v1/mobile/remote-access" | "/api/v1/mobile/regenerate" | "/api/v1/mobile/disable";

async function mobileStatus(ao: AoClient): Promise<PairingStatus> {
	const { data, error, response } = await ao.api.GET("/api/v1/mobile/status");
	if (!response.ok || !data) throw new Error(errorText(error, response));
	return data as PairingStatus;
}

async function mobilePost(ao: AoClient, path: MobilePath): Promise<void> {
	const { error, response } = await ao.api.POST(path);
	if (!response.ok) throw new Error(errorText(error, response));
}

function errorText(error: unknown, response: Response): string {
	const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : undefined;
	return message ?? `AO answered HTTP ${response.status}`;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
}

function pairingHtml(status: PairingStatus, link: string | undefined): string {
	const nonce = crypto.randomBytes(16).toString("base64");
	const lanOnly = !(status.endpoints ?? []).some(e => e.kind === "tunnel");
	const plainLan = lanOnly && !status.securePairing?.active;
	const code = link
		? `<div class="qr">${qrSvg(link)}</div>`
		: `<p class="wait">Preparing the pairing code… the public tunnel can take up to a minute.</p>`;
	const warning = plainLan && link ? `<p class="warn">On the local network the phone talks plain HTTP: others on the same Wi-Fi could read the traffic. Use it only on a network you trust; Tailscale (with TLS) and the tunnel encrypt the connection.</p>` : "";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; max-width: 560px; margin: 0 auto; }
h1 { font-size: 1.4em; margin: 0 0 4px; }
.dim { color: var(--vscode-descriptionForeground); }
.qr { width: min(320px, 80vw); margin: 20px 0; padding: 0; border-radius: 12px; overflow: hidden; }
.qr svg { display: block; width: 100%; height: auto; }
.wait { margin: 20px 0; padding: 40px 12px; text-align: center; border: 1px dashed var(--vscode-panel-border); }
button { padding: 6px 14px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; cursor: pointer; }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.warn { padding: 8px 12px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
ol { padding-left: 1.2em; }
a { color: var(--vscode-textLink-foreground); }
</style></head><body>
<h1>Connect Phone</h1>
<div class="dim" id="reach">Reachable from: ${escapeHtml(reachSummary(status))}</div>
${code}
<ol>
<li>Install the Orchestrator app (<a href="${IOS_APP_URL}">App Store</a> · <a href="${ANDROID_APP_URL}">Google Play</a>).</li>
<li>Scan the code with the phone's camera or in the app${(status.endpoints ?? []).some(e => e.kind === "tailscale") ? " (away from this network, Tailscale must be on there too)" : ""}.</li>
<li>Your sessions show up in the app; the phone keeps the pairing.</li>
</ol>
<p class="dim">The code carries this machine's AO password: anyone with it can see and control your sessions. Rotate it to unpair every phone.</p>
${warning}
<div class="actions">
${link ? `<button id="copy">Copy Pairing Link</button>` : ""}
${lanOnly ? `<button class="secondary" id="anywhere">Allow From Anywhere (Tunnel)</button>` : `<button class="secondary" id="lanOnly">Local Network Only</button>`}
<button class="secondary" id="rotate">Rotate Password</button>
<button class="secondary" id="disable">Turn Off Remote Access</button>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const id of ["copy", "anywhere", "lanOnly", "rotate", "disable"]) document.getElementById(id)?.addEventListener("click", () => vscode.postMessage({ type: id }));
</script>
</body></html>`;
}

export function registerRemote(api: OmpApi, server: ServerControl): void {
	const { context } = api;
	let panel: vscode.WebviewPanel | undefined;
	/** The pairing link the panel shows. */
	let shownLink: string | undefined;
	let poll: NodeJS.Timeout | undefined;

	const stopPolling = () => {
		clearTimeout(poll);
		poll = undefined;
	};

	const render = (status: PairingStatus) => {
		if (!panel) return;
		shownLink = pairingLink(status);
		panel.webview.html = pairingHtml(status, shownLink);
	};

	/** Re-reads the status every 2 s while the code is still coming up (no address yet, or the tunnel starting). */
	const follow = (ao: AoClient, deadline: number) => {
		stopPolling();
		poll = setTimeout(async () => {
			poll = undefined;
			if (!panel) return;
			try {
				const status = await mobileStatus(ao);
				render(status);
				if (pairingPending(status) && Date.now() < deadline) follow(ao, deadline);
				else if (!pairingLink(status)) void vscode.window.showErrorMessage(plain(`AO's phone access has no address to offer: ${status.tunnel?.lastError || status.warning || "check the network, or turn on Tailscale"}.`));
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`Could not read AO's phone access: ${err instanceof Error ? err.message : String(err)}`));
			}
		}, POLL_MS);
	};

	const showPanel = (ao: AoClient, status: PairingStatus) => {
		if (!panel) {
			const created = vscode.window.createWebviewPanel("switchyard.remote", "Connect Phone", vscode.ViewColumn.Active, { enableScripts: true });
			created.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "switchyard-color.svg");
			created.onDidDispose(() => {
				if (panel !== created) return;
				panel = undefined;
				stopPolling();
			});
			created.webview.onDidReceiveMessage(async (msg: unknown) => {
				if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
				if (msg.type === "copy" && shownLink) {
					await vscode.env.clipboard.writeText(shownLink);
					void vscode.window.showInformationMessage("Copied the pairing link. Treat it like a password.");
				} else if (msg.type === "anywhere") await setReach(ao, "anywhere");
				else if (msg.type === "lanOnly") await setReach(ao, "lan");
				else if (msg.type === "rotate") await vscode.commands.executeCommand("switchyard.remote.rotateToken");
				else if (msg.type === "disable") await vscode.commands.executeCommand("switchyard.remote.disable");
			});
			panel = created;
		}
		render(status);
		panel.reveal();
		if (pairingPending(status)) follow(ao, Date.now() + READY_TIMEOUT_MS);
	};

	/** Asks how far the phone should reach; the tunnel publishes this machine's (password-protected) phone API on the internet. */
	const pickReach = async (): Promise<Reach | undefined> => {
		const items: ReachItem[] = [
			{
				label: "$(broadcast) Local network and Tailscale",
				detail: "The phone reaches this machine on the same Wi-Fi, or anywhere over Tailscale (TLS when Tailscale offers certificates). Plain HTTP on the Wi-Fi itself.",
				reach: "lan",
			},
			{
				label: "$(globe) Anywhere",
				detail: "Adds a Cloudflare tunnel (cloudflared): encrypted, reachable from any network. The phone API is on the internet, protected by AO's password.",
				reach: "anywhere",
			},
		];
		const pick = await vscode.window.showQuickPick(items, { title: "Connect Phone: how should your phone reach this machine?", ignoreFocusOut: true });
		if (pick?.reach !== "lan") return pick?.reach;
		const ok = await vscode.window.showWarningMessage(
			"Pair over the local network?",
			{
				modal: true,
				detail: "On the Wi-Fi itself the phone talks plain HTTP: anyone on that network can see your sessions' traffic, and the pairing code too. Use it only on a network you trust; Tailscale and the tunnel encrypt the connection.",
			},
			"Use Local Network",
		);
		return ok ? "lan" : undefined;
	};

	/**
	 * Turns phone access on (or switches it) without minting a new password when it is already on: AO's
	 * `enable` makes a new one, which would unpair the phone the user is setting this up for.
	 */
	const setReach = async (ao: AoClient, reach: Reach) => {
		try {
			const before = await mobileStatus(ao);
			if (reach === "lan") await mobilePost(ao, "/api/v1/mobile/enable-lan-only");
			else await mobilePost(ao, before.enabled ? "/api/v1/mobile/remote-access" : "/api/v1/mobile/enable");
			let status = await mobileStatus(ao);
			// TLS over Tailscale where the tailnet offers certificates: iOS refuses plain HTTP to a 100.x address.
			if (status.tailscaleHost && status.securePairing?.available && !status.securePairing.enabled) {
				const { response } = await ao.api.POST("/api/v1/mobile/secure-pairing", { body: { enabled: true } });
				if (response.ok) status = await mobileStatus(ao);
			}
			showPanel(ao, status);
		} catch (err) {
			void vscode.window.showErrorMessage(plain(`Could not turn on phone access: ${err instanceof Error ? err.message : String(err)}`));
		}
	};

	context.subscriptions.push(
		{ dispose: stopPolling },
		vscode.commands.registerCommand("switchyard.remote.connectPhone", async () => {
			let ao: AoClient;
			let status: PairingStatus;
			try {
				ao = await server.client();
				status = await mobileStatus(ao);
			} catch (err) {
				const pick = await vscode.window.showErrorMessage(plain(`Could not reach the AO daemon: ${err instanceof Error ? err.message : String(err)}`), "Show Log");
				if (pick) void vscode.commands.executeCommand("switchyard.server.showLog");
				return;
			}
			// Already on: show the code it serves (picking again would only matter to switch, which the panel offers).
			if (status.enabled) {
				showPanel(ao, status);
				return;
			}
			const reach = await pickReach();
			if (reach) await setReach(ao, reach);
		}),
		vscode.commands.registerCommand("switchyard.remote.disable", async () => {
			try {
				await mobilePost(await server.client(), "/api/v1/mobile/disable");
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`Could not turn off phone access: ${err instanceof Error ? err.message : String(err)}`));
				return;
			}
			panel?.dispose();
			void vscode.window.showInformationMessage("Phone access is off. Paired phones reconnect when you turn it on again, until you rotate the password.");
		}),
		vscode.commands.registerCommand("switchyard.remote.rotateToken", async () => {
			let ao: AoClient;
			let status: PairingStatus;
			try {
				ao = await server.client();
				if (!(await mobileStatus(ao)).enabled) {
					void vscode.window.showInformationMessage("Phone access is off; Connect Phone turns it on with a new password.");
					return;
				}
				await mobilePost(ao, "/api/v1/mobile/regenerate");
				status = await mobileStatus(ao);
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`Could not rotate the password: ${err instanceof Error ? err.message : String(err)}`));
				return;
			}
			if (panel) showPanel(ao, status);
			const pick = await vscode.window.showInformationMessage("New AO password: every paired phone has to pair again.", ...(panel ? [] : ["Show QR Code"]));
			if (pick) showPanel(ao, status);
		}),
	);
}
