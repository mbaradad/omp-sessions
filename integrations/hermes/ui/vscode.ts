// Open in VS Code: a session's chat, a session's project folder, or a folder the page shows. The
// backend records the request on omp's machine and returns the link; the host opens it (the
// dashboard as a vscode:// link, Desktop through the redirect page).
import type { Host, VscodeLink } from "./api";
import { ago } from "./util";

/** Asks the backend at `path` for the link, opens it, and says where it opens. */
export async function openInVscode(host: Host, path: string, body: Record<string, unknown> = {}): Promise<string> {
	const link = await host.request<VscodeLink>(path, { method: "POST", body });
	await host.openVscode(link);
	const what = link.folder ? link.folder : "the session";
	if (link.authority) return `Opening ${what} in the VS Code window connected to ${link.authority.replace(/^ssh-remote\+/, "")}${link.windowAt ? ` (used ${ago(link.windowAt)})` : ""}.`;
	if (link.authority === "") return `Opening ${what} in VS Code on omp's machine.`;
	return link.folder
		? `Opening ${what} in VS Code here (no VS Code window has used Switchyard on omp's machine yet).`
		: "No VS Code window has used Switchyard on omp's machine yet: the link opens VS Code here, which needs the Switchyard extension.";
}
