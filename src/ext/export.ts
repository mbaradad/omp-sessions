// Chat "Copy as Markdown" / "Save as Markdown…" (also `/export md|copy`).
import * as path from "node:path";
import * as vscode from "vscode";
import { conversationMarkdown } from "../shared/export-md";
import type { SessionMeta } from "../shared/protocol";
import type { ToWebview } from "../shared/webview";

export async function exportMarkdown(mode: "copy" | "save", messages: unknown[], meta: SessionMeta | undefined, post: (msg: ToWebview) => void): Promise<void> {
	if (!messages.length) {
		post({ type: "notice", level: "info", text: "Nothing to export yet." });
		return;
	}
	const title = meta?.title || "omp conversation";
	const markdown = conversationMarkdown(messages, { title, cwd: meta?.cwd, exportedAt: new Date(), formatTime: ms => new Date(ms).toLocaleString() });
	if (mode === "copy") {
		await vscode.env.clipboard.writeText(markdown);
		void vscode.window.setStatusBarMessage("$(copy) Copied the conversation as Markdown", 2500);
		return;
	}
	const slug = title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "omp-conversation";
	const target = await vscode.window.showSaveDialog({
		defaultUri: meta?.cwd ? vscode.Uri.file(path.join(meta.cwd, `${slug}.md`)) : undefined,
		filters: { Markdown: ["md"] },
		saveLabel: "Save conversation",
	});
	if (!target) return;
	await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, "utf8"));
	post({ type: "notice", level: "info", markdown: true, text: `Saved the conversation to \`${target.fsPath}\`` });
	const open = await vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`, "Open");
	if (open) await vscode.window.showTextDocument(target, { preview: true });
}
