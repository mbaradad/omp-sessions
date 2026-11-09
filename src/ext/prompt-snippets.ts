// Prompt snippets from `switchyard.chat.snippets` and `<session folder>/.omp/prompts/*.md`, offered in
// the composer as `/p:<name>`.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SlashCommand } from "../shared/webview";
import { type PromptSnippet, SNIPPET_PREFIX, mergeSnippets, parseSnippetFile, snippetsFromSettings } from "../shared/snippets";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 64 * 1024;

export function promptsDir(cwd: string): string {
	return path.join(cwd, ".omp", "prompts");
}

function workspaceSnippets(cwd: string | undefined): PromptSnippet[] {
	if (!cwd) return [];
	const dir = promptsDir(cwd);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith(".md"));
	} catch {
		return [];
	}
	const out: PromptSnippet[] = [];
	for (const name of names.slice(0, MAX_FILES)) {
		try {
			const file = path.join(dir, name);
			if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
			const s = parseSnippetFile(name, fs.readFileSync(file, "utf8"));
			if (s) out.push(s);
		} catch {
			/* unreadable file */
		}
	}
	return out;
}

export function loadSnippets(cwd: string | undefined): PromptSnippet[] {
	return mergeSnippets(snippetsFromSettings(vscode.workspace.getConfiguration("switchyard.chat").get("snippets")), workspaceSnippets(cwd));
}

export function snippetCommands(snippets: PromptSnippet[]): SlashCommand[] {
	return snippets.map(s => ({ name: `${SNIPPET_PREFIX}${s.name}`, description: `${s.source === "workspace" ? "Prompt file" : "Snippet"}${s.description ? `: ${s.description}` : ""}`, local: true }));
}
