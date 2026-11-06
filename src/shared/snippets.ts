// Prompt snippets: `omp.chat.snippets` (settings) and `.omp/prompts/*.md` (workspace) appear in
// the composer's `/` completion as `/p:<name>`; their text is inserted with `{{selection}}` and
// `{{file}}` expanded by the extension. Pure helpers; file IO lives in src/ext/prompt-snippets.ts.

export interface PromptSnippet {
	/** Completion name (after `p:`), lowercase slug. */
	name: string;
	prompt: string;
	description?: string;
	source: "settings" | "workspace";
}

export const SNIPPET_PREFIX = "p:";

/** `Review PR` → `review-pr`; empty when nothing usable is left. */
export function snippetSlug(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^\w.-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Snippets from the `omp.chat.snippets` setting; malformed entries are skipped. */
export function snippetsFromSettings(value: unknown): PromptSnippet[] {
	if (!Array.isArray(value)) return [];
	const out: PromptSnippet[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const name = "name" in item && typeof item.name === "string" ? snippetSlug(item.name) : "";
		const prompt = "prompt" in item && typeof item.prompt === "string" ? item.prompt : "";
		if (!name || !prompt.trim()) continue;
		const description = "description" in item && typeof item.description === "string" ? item.description : undefined;
		out.push({ name, prompt, description, source: "settings" });
	}
	return out;
}

/**
 * A workspace prompt file. Optional front matter (`--- description: … ---`) is stripped; without
 * a description the first non-empty line (minus heading marks) describes the snippet.
 */
export function parseSnippetFile(fileName: string, content: string): PromptSnippet | undefined {
	const name = snippetSlug(fileName.replace(/\.md$/i, ""));
	let body = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	let description: string | undefined;
	const front = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(body);
	if (front) {
		body = body.slice(front[0].length);
		const d = /^description:[ \t]*(.+)$/m.exec(front[1]);
		if (d) description = d[1].trim().replace(/^(["'])(.*)\1$/, "$2");
	}
	body = body.trim();
	if (!name || !body) return undefined;
	description ??= body
		.split("\n")
		.find(l => l.trim())
		?.replace(/^#+\s*/, "")
		.slice(0, 100);
	return { name, prompt: body, description, source: "workspace" };
}

/** Settings first, workspace files override snippets of the same name; sorted by name. */
export function mergeSnippets(fromSettings: PromptSnippet[], fromWorkspace: PromptSnippet[]): PromptSnippet[] {
	const byName = new Map<string, PromptSnippet>();
	for (const s of [...fromSettings, ...fromWorkspace]) byName.set(s.name, s);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface PlaceholderValues {
	/** Selected text in the active editor. */
	selection?: string;
	/** Active editor's path (relative to the session folder when inside it). */
	file?: string;
}

/**
 * Replaces `{{selection}}` and `{{file}}` (whitespace inside the braces allowed). Missing values
 * become empty and are reported; other `{{…}}` are left alone.
 */
export function expandPlaceholders(template: string, values: PlaceholderValues): { text: string; missing: Array<keyof PlaceholderValues> } {
	const missing: Array<keyof PlaceholderValues> = [];
	const text = template.replace(/\{\{\s*(selection|file)\s*\}\}/g, (_m, key: keyof PlaceholderValues) => {
		const v = values[key];
		if (v === undefined || v === "") {
			if (!missing.includes(key)) missing.push(key);
			return "";
		}
		return v;
	});
	return { text, missing };
}

/** `/p:name rest…` → the snippet and the text after it, when `name` is a known snippet. */
export function matchSnippetCommand(text: string, snippets: PromptSnippet[]): { snippet: PromptSnippet; rest: string } | undefined {
	const m = /^\/p:([\w.-]+)(?:[ \t]+|\n|$)([\s\S]*)$/.exec(text.trim());
	if (!m) return undefined;
	const snippet = snippets.find(s => s.name === m[1].toLowerCase());
	return snippet ? { snippet, rest: m[2].trim() } : undefined;
}
