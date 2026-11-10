// A project's orchestrator rules as a file you edit and save: `switchyard-orchestrator-rules:/<project>/orchestrator-rules.md`
// reads AO's project setting and writes it back on save (setOrchestratorConfig), so long standing instructions are
// written in an editor, not an input box. AO keeps them; this holds nothing but the last text it saw.
import * as vscode from "vscode";
import type { AoClient } from "../ao/client";
import { orchestratorConfig, setOrchestratorConfig } from "../ao/orchestrator";

export const RULES_SCHEME = "switchyard-orchestrator-rules";

export function rulesUri(projectId: string): vscode.Uri {
	return vscode.Uri.from({ scheme: RULES_SCHEME, path: `/${projectId}/orchestrator-rules.md` });
}

/** The project a rules document belongs to. */
function projectOf(uri: vscode.Uri): string {
	const id = uri.path.split("/")[1];
	if (!id || uri.path !== `/${id}/orchestrator-rules.md`) throw vscode.FileSystemError.FileNotFound(uri);
	return id;
}

export class RulesFileSystem implements vscode.FileSystemProvider {
	private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changes.event;
	/** What each project's rules read last, and when they last differed (the editor compares modification times to spot a changed file). */
	private readonly seen = new Map<string, { text: string; mtime: number }>();

	constructor(
		private readonly client: () => Promise<AoClient>,
		/** A save reached AO. */
		private readonly onSaved: (projectId: string) => void,
	) {}

	private async read(uri: vscode.Uri): Promise<{ text: string; mtime: number }> {
		const id = projectOf(uri);
		const text = (await orchestratorConfig(await this.client(), id).catch((err: unknown) => this.unavailable(err))).rules ?? "";
		const known = this.seen.get(id);
		const now = known?.text === text ? known : { text, mtime: Date.now() };
		this.seen.set(id, now);
		return now;
	}

	private unavailable(err: unknown): never {
		throw vscode.FileSystemError.Unavailable(err instanceof Error ? err.message : String(err));
	}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const { text, mtime } = await this.read(uri);
		return { type: vscode.FileType.File, ctime: 0, mtime, size: Buffer.byteLength(text) };
	}

	readDirectory(): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(uri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		return Buffer.from((await this.read(uri)).text, "utf8");
	}

	/** AO's own refusal is the error the editor shows. */
	async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		const id = projectOf(uri);
		const text = Buffer.from(content).toString("utf8");
		try {
			const saved = await setOrchestratorConfig(await this.client(), id, { rules: text.trim() ? text : null });
			this.seen.set(id, { text: saved.rules ?? "", mtime: Date.now() });
		} catch (err) {
			this.unavailable(err);
		}
		this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
		this.onSaved(id);
	}

	delete(uri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	rename(oldUri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(oldUri);
	}
}
