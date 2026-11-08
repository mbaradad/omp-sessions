// "Open in VS Code" from the Hermes page or `omp-sessions vscode` (src/shared/vscode-open.ts): this window
// records itself as the one last used on this machine, takes pending open requests when it gains focus
// (the request's link focused or opened it), and handles vscode://mbaradad.omp-sessions/open?session=<id>.
import * as fs from "node:fs";
import * as vscode from "vscode";
import { stateRoot } from "../shared/protocol";
import { OPEN_REQUEST_FILE, clearOpenRequest, recordWindow, takeOpenRequest } from "../shared/vscode-open";
import type { OmpApi } from "./api";

/**
 * Remote authority of this window (`ssh-remote+ws`); "" for a local window; undefined when unknown. A remote
 * extension host sees its folders as file: URIs, but asExternalUri turns a workspace URI into a link that
 * opens it from the client, carrying the remote URI: `vscode:workspace?vscode-remote%3A%2F%2Fssh-remote%252Bws%2F`
 * (VS Code 1.10x), or `vscode://vscode-remote/ssh-remote+ws/`.
 */
async function windowAuthority(): Promise<string | undefined> {
	if (!vscode.env.remoteName) return "";
	try {
		const link = await vscode.env.asExternalUri(vscode.Uri.file("/"));
		const remote = link.query.startsWith("vscode-remote:")
			? vscode.Uri.parse(link.query)
			: link.authority === "vscode-remote"
				? vscode.Uri.parse(`vscode-remote://${link.path.slice(1)}`)
				: undefined;
		return remote?.authority || undefined;
	} catch {
		return undefined;
	}
}

export function registerVscodeOpen(api: OmpApi): void {
	const open = (id: string) => api.openPanel(id)?.focusComposer();
	const authority = windowAuthority();
	const focused = async () => {
		const known = await authority;
		if (known !== undefined) {
			try {
				recordWindow(known, vscode.env.uriScheme);
			} catch {
				/* read-only state folder: links fall back to the URI handler */
			}
		}
		const id = takeOpenRequest(s => !!api.sessions.get(s));
		if (id) open(id);
	};
	if (vscode.window.state.focused) void focused();
	api.context.subscriptions.push(
		vscode.window.onDidChangeWindowState(s => {
			if (s.focused) void focused();
		}),
		vscode.window.registerUriHandler({
			handleUri(uri) {
				if (uri.path !== "/open") return;
				const query = new URLSearchParams(uri.query).get("session")?.trim() ?? "";
				const all = api.sessions.all();
				const prefixed = query.length >= 4 ? all.filter(m => m.id.startsWith(query)) : [];
				const meta = all.find(m => m.id === query) ?? (prefixed.length === 1 ? prefixed[0] : undefined);
				if (!meta) {
					const here = vscode.env.remoteName ? "the machine this window is connected to" : "this computer";
					void vscode.window.showWarningMessage(`No omp session ${query || "(none given)"} on ${here}: it runs on another machine. Open it from a VS Code window connected there.`);
					return;
				}
				clearOpenRequest(meta.id);
				open(meta.id);
			},
		}),
	);
	// A request made while this window already has focus (a browser beside it on this machine).
	try {
		const watcher = fs.watch(stateRoot(), (_e, name) => {
			if (vscode.window.state.focused && (name === null || String(name) === OPEN_REQUEST_FILE)) void focused();
		});
		watcher.on("error", () => watcher.close());
		api.context.subscriptions.push({ dispose: () => watcher.close() });
	} catch {
		/* focus changes still take requests */
	}
}
