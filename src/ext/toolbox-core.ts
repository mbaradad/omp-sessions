// Pure helpers for the toolbox (no `vscode` import, so unit tests can load them).
import * as path from "node:path";

// ---------- shell quoting ----------

/** Shell family of a terminal, which decides how command lines are quoted. */
export type ShellKind = "posix" | "fish" | "powershell" | "cmd";

/** Shell family from a shell executable path (e.g. `vscode.env.shell`). */
export function shellKind(shellPath: string | undefined, platform: NodeJS.Platform): ShellKind {
	const name = (shellPath ?? "")
		.split(/[\\/]/)
		.pop()
		?.toLowerCase()
		.replace(/\.exe$/, "");
	if (name === "pwsh" || name === "powershell" || name === "pwsh-preview") return "powershell";
	if (name === "cmd") return "cmd";
	if (name === "fish") return "fish";
	if (name) return "posix";
	// No shell reported: VS Code's default is PowerShell on Windows and a POSIX shell elsewhere.
	return platform === "win32" ? "powershell" : "posix";
}

/** Characters that need no quoting, per shell. */
const SAFE: Record<ShellKind, RegExp> = {
	posix: /^[\w/.,:=@%+-]+$/,
	fish: /^[\w/.,:=@%+-]+$/,
	// `,` builds arrays and `@` splats in PowerShell.
	powershell: /^[\w/.:\\=+-]+$/,
	cmd: /^[\w/.:\\=,+-]+$/,
};

/** Quotes one argument so `kind` passes it to the program verbatim. */
export function quoteArg(arg: string, kind: ShellKind): string {
	if (arg !== "" && SAFE[kind].test(arg)) return arg;
	switch (kind) {
		case "posix":
			return `'${arg.replace(/'/g, "'\\''")}'`;
		case "fish":
			// Inside fish single quotes only `\\` and `\'` are escapes.
			return `'${arg.replace(/[\\']/g, "\\$&")}'`;
		case "powershell":
			// PowerShell also treats typographic single quotes as quote characters.
			return `'${arg.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
		case "cmd":
			// `""` is a literal quote for cmd's quote tracking and for the C runtime's argv parser;
			// trailing backslashes are doubled so they do not escape the closing quote.
			return `"${arg.replace(/"/g, '""').replace(/(\\+)$/, "$1$1")}"`;
	}
}

/** Full command line that runs `exe` with `args` when typed into a `kind` shell. */
export function commandLine(exe: string, args: readonly string[], kind: ShellKind): string {
	const parts = args.map(a => quoteArg(a, kind));
	// PowerShell needs the call operator to run a quoted path.
	const head = kind === "powershell" ? `& ${quoteArg(exe, kind)}` : quoteArg(exe, kind);
	return [head, ...parts].join(" ");
}

// ---------- captured output ----------

/** Removes ANSI escape sequences (colors, cursor moves) from CLI output. */
export function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g, "");
}

/** Output path from `omp --export`'s "Exported to: <path>" line (relative paths resolve against `cwd`). */
export function exportedPath(stdout: string, cwd: string): string | undefined {
	const m = /^Exported to:\s*(.+?)\s*$/m.exec(stripAnsi(stdout));
	return m ? path.resolve(cwd, m[1]) : undefined;
}

/** File-name-safe slug of a session title. */
export function slugify(title: string, max = 60): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/[\s_-]+/g, "-")
		.toLowerCase()
		.slice(0, max)
		.replace(/-+$/, "");
	return slug || "session";
}

// ---------- models ----------

export interface ModelInfo {
	provider: string;
	id: string;
	/** `provider/id`, what `--model` accepts. */
	selector: string;
	name: string;
	contextWindow?: number;
	reasoning?: boolean;
	input?: string[];
	cost?: { input: number; output: number };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Parses `omp models --json`; throws when the output is not that shape. */
export function parseModels(json: string): ModelInfo[] {
	const data: unknown = JSON.parse(json);
	if (!isRecord(data) || !Array.isArray(data.models)) throw new Error("unexpected `omp models --json` output");
	const out: ModelInfo[] = [];
	for (const m of data.models) {
		if (!isRecord(m)) continue;
		const provider = str(m.provider);
		const id = str(m.id);
		if (!provider || !id) continue;
		const cost = isRecord(m.cost) ? { input: num(m.cost.input), output: num(m.cost.output) } : undefined;
		out.push({
			provider,
			id,
			selector: str(m.selector) ?? `${provider}/${id}`,
			name: str(m.name) ?? id,
			contextWindow: num(m.contextWindow),
			reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
			input: Array.isArray(m.input) ? m.input.filter((i): i is string => typeof i === "string") : undefined,
			cost: cost?.input !== undefined && cost.output !== undefined ? { input: cost.input, output: cost.output } : undefined,
		});
	}
	return out;
}

/** One-line summary of a model for quick pick details: context, inputs, price per million tokens. */
export function modelDetail(m: ModelInfo): string {
	const parts: string[] = [];
	if (m.contextWindow) parts.push(`${m.contextWindow >= 1_000_000 ? `${+(m.contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(m.contextWindow / 1000)}K`} context`);
	if (m.input?.includes("image")) parts.push("images");
	if (m.reasoning) parts.push("reasoning");
	if (m.cost && (m.cost.input || m.cost.output)) parts.push(`$${m.cost.input}/$${m.cost.output} per M tokens`);
	return parts.join(" · ");
}

// ---------- command center ----------

export const GROUPS = ["Sessions", "Chat", "Tasks", "Review & git", "omp account & tools", "Help"] as const;
export type CommandGroup = (typeof GROUPS)[number];

const EXPLICIT: Record<string, CommandGroup> = {
	"switchyard.refresh": "Sessions",
	"switchyard.toggleGrouping": "Sessions",
	"switchyard.exportHtml": "Sessions",
	"switchyard.share": "Sessions",
	"switchyard.continueInTerminal": "Sessions",
	"switchyard.setPermissionMode": "Sessions",
	"switchyard.importClaude": "Sessions",
	"switchyard.importCodex": "Sessions",
	"switchyard.remote.connectPhone": "Sessions",
	"switchyard.remote.disable": "Sessions",
	"switchyard.remote.rotateToken": "Sessions",
	"switchyard.openAoDashboard": "Sessions",
	"switchyard.installAoDashboard": "Sessions",
	"switchyard.installAgentSkill": "Sessions",
	"switchyard.hermes.install": "Sessions",
	"switchyard.focus": "Chat",
	"switchyard.fixDiagnostics": "Chat",
	"switchyard.addToChat": "Chat",
	"switchyard.reviewChanges": "Review & git",
	"switchyard.showChanges": "Review & git",
	"switchyard.revertFile": "Review & git",
	"switchyard.cleanse": "Review & git",
	"switchyard.gitUi": "Review & git",
	"switchyard.commitInTerminal": "Review & git",
	"switchyard.setDependencies": "Sessions",
	"switchyard.installOmpIntegration": "Help",
	"switchyard.openConfig": "Help",
	"switchyard.openDocs": "Help",
	"switchyard.keyboardShortcuts": "Help",
};

/** Ordered keyword rules for commands without an explicit group (e.g. ones added later). */
const RULES: Array<[RegExp, CommandGroup]> = [
	[/^omp\.tasks?\.|task|queue/i, "Tasks"],
	[/scm|git|diff|review|revert|changes|commit|worktree|checkpoint/i, "Review & git"],
	[/login|logout|update|setup|plugin|skill|usage|stats|model|account|mcp/i, "omp account & tools"],
	[/doc|help|shortcut|keyboard|walkthrough|doctor|config|report|about/i, "Help"],
	[/chat|send|ask|explain|prompt|selection|focus|mention|attach|composer/i, "Chat"],
];

export function commandGroup(id: string): CommandGroup {
	const explicit = EXPLICIT[id];
	if (explicit) return explicit;
	for (const [re, group] of RULES) if (re.test(id)) return group;
	return "Sessions";
}

export interface CommandCenterEntry {
	command: string;
	title: string;
	group: CommandGroup;
	/** Codicon id without `$()`, if the manifest gives one. */
	icon?: string;
	/** Human-readable default keybinding for this platform. */
	keybinding?: string;
}

/** Commands that make no sense from a list (they need a tree item, a file, or are this list itself). */
const ALWAYS_HIDDEN = new Set(["switchyard.commandCenter", "switchyard.openSessionFileDiff"]);

function prettyKey(key: string, platform: NodeJS.Platform): string {
	const mac: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
	return key
		.split(" ")
		.map(chord =>
			chord
				.split("+")
				.map(k => (platform === "darwin" ? (mac[k] ?? k.toUpperCase()) : k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)))
				.join(platform === "darwin" ? "" : "+"),
		)
		.join(" ");
}

/**
 * Command center entries from the extension manifest (`package.json`): every contributed `switchyard.*`
 * command except the ones hidden from the Command Palette (`"when": "false"`), sorted by group
 * (in `GROUPS` order) and then manifest order.
 */
export function commandCenterEntries(manifest: unknown, platform: NodeJS.Platform): CommandCenterEntry[] {
	const contributes = isRecord(manifest) && isRecord(manifest.contributes) ? manifest.contributes : {};
	const commands = Array.isArray(contributes.commands) ? contributes.commands : [];
	const menus = isRecord(contributes.menus) ? contributes.menus : {};
	const palette = Array.isArray(menus.commandPalette) ? menus.commandPalette : [];
	const hidden = new Set(ALWAYS_HIDDEN);
	for (const p of palette) if (isRecord(p) && p.when === "false" && typeof p.command === "string") hidden.add(p.command);
	const keys = new Map<string, string>();
	for (const k of Array.isArray(contributes.keybindings) ? contributes.keybindings : []) {
		if (!isRecord(k) || typeof k.command !== "string" || keys.has(k.command)) continue;
		const key = str(platform === "darwin" ? k.mac : platform === "win32" ? k.win : platform === "linux" ? k.linux : undefined) ?? str(k.key);
		if (key) keys.set(k.command, prettyKey(key, platform));
	}
	const seen = new Set<string>();
	const entries: CommandCenterEntry[] = [];
	for (const c of commands) {
		if (!isRecord(c)) continue;
		const command = str(c.command);
		const title = str(c.title);
		if (!command || !title || !command.startsWith("switchyard.") || hidden.has(command) || seen.has(command)) continue;
		seen.add(command);
		const icon = typeof c.icon === "string" ? /^\$\(([\w~-]+)\)$/.exec(c.icon)?.[1] : undefined;
		entries.push({ command, title, group: commandGroup(command), icon, keybinding: keys.get(command) });
	}
	return entries.map((e, i) => ({ e, i })).sort((a, b) => GROUPS.indexOf(a.e.group) - GROUPS.indexOf(b.e.group) || a.i - b.i).map(x => x.e);
}

/** Most-recent-first list with `id` moved to the front, capped at `max`. */
export function pushRecent(recent: readonly string[], id: string, max = 5): string[] {
	return [id, ...recent.filter(r => r !== id)].slice(0, max);
}
