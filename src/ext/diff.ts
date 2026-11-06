import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { EMPTY_BLOB, type FileChange, blobPath } from "../shared/protocol";

export const SNAPSHOT_SCHEME = "omp-snapshot";

/** Read-only documents for file snapshots captured by the session host, or in-memory text. */
export class SnapshotProvider implements vscode.TextDocumentContentProvider {
	private readonly memory = new Map<string, string>();
	private memSeq = 0;

	provideTextDocumentContent(uri: vscode.Uri): string {
		const q = new URLSearchParams(uri.query);
		const mem = q.get("m");
		if (mem) return this.memory.get(mem) ?? "";
		const session = q.get("s");
		const hash = q.get("h");
		if (!session || !hash || hash === EMPTY_BLOB || hash === "absent") return "";
		try {
			return fs.readFileSync(blobPath(session, hash), "utf8");
		} catch {
			return "(snapshot unavailable)";
		}
	}

	blobUri(file: string, session: string, hash: string | null, label: string): vscode.Uri {
		return vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: file, query: new URLSearchParams({ s: session, h: hash ?? "absent", l: label }).toString() });
	}

	textUri(file: string, text: string, label: string): vscode.Uri {
		const key = String(++this.memSeq);
		this.memory.set(key, text);
		return vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: file, query: new URLSearchParams({ m: key, l: label }).toString() });
	}
}

/** Editor column for files/diffs: never the chat panel's own column, so the chat stays visible. */
export function targetColumn(chatColumn?: vscode.ViewColumn): vscode.ViewColumn {
	if (chatColumn === undefined) return vscode.ViewColumn.Active;
	return chatColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
}

/** Diff of one tool call's effect on one file. */
export async function openToolDiff(provider: SnapshotProvider, session: string, change: FileChange, file: string, chatColumn?: vscode.ViewColumn): Promise<void> {
	const entry = change.files.find(f => f.path === file) ?? change.files[0];
	if (!entry) return;
	const left = provider.blobUri(entry.path, session, entry.before, "before");
	const right = provider.blobUri(entry.path, session, entry.after, "after");
	const verb = entry.op === "create" ? "created" : entry.op === "delete" ? "deleted" : change.toolName;
	await vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(entry.path)} (omp ${verb})`, { preview: true, viewColumn: targetColumn(chatColumn) });
}

/** Diff from the file's content before the session first touched it to the live file. */
export async function openSessionDiff(provider: SnapshotProvider, session: string, changes: FileChange[], file: string, chatColumn?: vscode.ViewColumn): Promise<void> {
	const first = changes.flatMap(c => c.files).find(f => f.path === file);
	if (!first) return;
	const left = provider.blobUri(file, session, first.before, "session start");
	const right = fs.existsSync(file) ? vscode.Uri.file(file) : provider.blobUri(file, session, null, "deleted");
	await vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(file)} (omp session changes)`, { preview: true, viewColumn: targetColumn(chatColumn) });
}

export async function openTextDiff(provider: SnapshotProvider, file: string, oldText: string, newText: string, title: string, chatColumn?: vscode.ViewColumn): Promise<void> {
	const left = provider.textUri(file, oldText, "before");
	const right = provider.textUri(file, newText, "after");
	await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true, viewColumn: targetColumn(chatColumn) });
}

export async function openFile(file: string, line?: number, column?: number, chatColumn?: vscode.ViewColumn): Promise<void> {
	const uri = vscode.Uri.file(file);
	let stat: vscode.FileStat;
	try {
		stat = await vscode.workspace.fs.stat(uri);
	} catch {
		void vscode.window.showWarningMessage(`File not found: ${file}`);
		return;
	}
	if (stat.type & vscode.FileType.Directory) {
		await vscode.commands.executeCommand("revealInExplorer", uri);
		return;
	}
	const pos = line ? new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1)) : undefined;
	await vscode.window.showTextDocument(uri, {
		preview: true,
		viewColumn: targetColumn(chatColumn),
		selection: pos ? new vscode.Range(pos, pos) : undefined,
	});
}
