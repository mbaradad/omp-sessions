// Session actions the chat offers beside omp's own slash commands (which AO lists as the session's
// skills and runs when sent as a message). They surface both as `/commands` in the composer and as
// items in the chat menu, and run on AO's API or in VS Code.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AoClient } from "../ao/client";
import { type PermissionMode, PERMISSION_MODE_INFO, permissionModeOf } from "../shared/permissions";
import type { SessionMeta } from "../shared/protocol";
import type { PanelCommand, SlashCommand, ToWebview } from "../shared/webview";
import type { ChatFeed } from "./chat-feed";
import { pickPermissionMode } from "./permissions";
import { configuredOmpPaths } from "./sessions";

export interface CommandContext {
	readonly sessionId: string;
	readonly meta: SessionMeta | undefined;
	readonly feed: ChatFeed;
	/** The session's permission mode, when known. */
	readonly mode: PermissionMode | undefined;
	ao(): Promise<AoClient>;
	post(msg: ToWebview): void;
	insertText(text: string): void;
	setMode(mode: PermissionMode): void;
	/** Runs `!command` in the session folder; `keep` adds its output to the next prompt's context. */
	runShell(command: string, keep: boolean): Promise<void>;
}

/** Slash commands handled by the extension (merged into the composer's completion list). */
export const LOCAL_COMMANDS: SlashCommand[] = [
	{ name: "new", description: "Start a new session in this project", local: true },
	{ name: "clear", description: "Same as /new", local: true },
	{ name: "undo", description: "Undo the last turn: revert its file edits and rewind the conversation", local: true },
	{ name: "redo", description: "Bring back what the last undo / checkpoint restore removed", local: true },
	{ name: "login", description: "Log in to a model provider (in omp's terminal UI)", local: true },
	{ name: "logout", description: "Remove a stored provider credential (in omp's terminal UI)", local: true },
	{ name: "queue", description: "Add a task to this session's background queue (Title :: sub; sub)", input: { hint: "<task>" }, local: true },
	{ name: "tasks", description: "Show the task queue", local: true },
	{ name: "changes", description: "Review every file this session changed (multi-file diff)", local: true },
	{ name: "diff", description: "Same as /changes", local: true },
	{ name: "copy", description: "Copy the last assistant response", local: true },
	{ name: "cost", description: "Tokens, cost and context use of this session", local: true },
	{ name: "export", description: "Export the conversation: copy or save as Markdown", input: { hint: "[md|copy]" }, local: true },
	{ name: "settings", description: "Open omp's config.yml", local: true },
	{ name: "mode", description: "Permission mode: ask | edits | plan | auto (Shift+Tab cycles)", input: { hint: "[ask|edits|plan|auto]" }, local: true },
	{ name: "plan", description: "Switch to Plan mode: read-only, file edits are refused", local: true },
	{ name: "help", description: "Commands and keyboard shortcuts", local: true },
	{ name: "hotkeys", description: "Same as /help", local: true },
	{ name: "exit", description: "Stop this session (transcript is kept)", local: true },
	{ name: "quit", description: "Same as /exit", local: true },
];

const SLASH_TO_PANEL: Record<string, PanelCommand> = {
	new: "newSession",
	clear: "newSession",
	login: "login",
	logout: "logout",
	changes: "reviewChanges",
	diff: "reviewChanges",
	copy: "copyLast",
	cost: "stats",
	settings: "settings",
	help: "help",
	hotkeys: "help",
	exit: "stopSession",
	quit: "stopSession",
	undo: "undoTurn",
	redo: "redoTurn",
};

/**
 * Handles composer input the extension owns: `/local-command …` and `!shell command`.
 * Returns false when the text should go to omp as a normal prompt.
 */
export async function handleComposerInput(text: string, ctx: CommandContext, runPanel: (name: PanelCommand) => Promise<void>): Promise<boolean> {
	if (text.startsWith("!")) {
		const command = text.replace(/^!!?/, "").trim();
		if (command) await ctx.runShell(command, !text.startsWith("!!"));
		return true;
	}
	const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!m) return false;
	const name = m[1];
	const args = (m[2] ?? "").trim();
	if (name === "mode" || name === "plan") {
		await permissionMode(ctx, name === "plan" ? "plan" : args);
		return true;
	}
	if (name === "export") {
		const choice = await exportChoice(args);
		if (choice === null) return false;
		if (choice) await runPanel(choice);
		return true;
	}
	const panel = SLASH_TO_PANEL[name];
	if (!panel) return false;
	await runPanel(panel);
	return true;
}

/**
 * `/export` target: a panel command, undefined when the quick pick was cancelled, or null for
 * arguments omp handles itself (e.g. `/export <file>`).
 */
async function exportChoice(args: string): Promise<PanelCommand | undefined | null> {
	const arg = args.toLowerCase();
	if (arg === "md" || arg === "markdown" || arg === "save") return "exportMarkdownSave";
	if (arg === "copy" || arg === "clipboard") return "exportMarkdownCopy";
	if (arg) return null;
	const items: Array<vscode.QuickPickItem & { cmd: PanelCommand }> = [
		{ label: "$(copy) Copy as Markdown", cmd: "exportMarkdownCopy" },
		{ label: "$(save) Save as Markdown…", cmd: "exportMarkdownSave" },
	];
	const pick = await vscode.window.showQuickPick(items, { placeHolder: "Export this conversation" });
	return pick?.cmd;
}

async function permissionMode(ctx: CommandContext, arg: string): Promise<void> {
	const meta = ctx.meta;
	if (!meta) return;
	const mode = arg ? permissionModeOf(arg.toLowerCase()) : await pickPermissionMode(ctx.mode ?? "ask", `Permission mode · ${meta.title}`);
	if (mode === undefined && arg) {
		ctx.post({ type: "notice", level: "warning", text: `Unknown mode "${arg}": use ask, edits, plan or auto.` });
		return;
	}
	if (mode && mode !== ctx.mode) ctx.setMode(mode);
}

/** Menu/command actions that need AO round-trips or VS Code UI. */
export async function runSessionAction(name: PanelCommand, ctx: CommandContext): Promise<boolean> {
	switch (name) {
		case "stats": {
			const ao = await ctx.ao();
			const usage = (await ao.getConversation(ctx.sessionId, { limit: 1 })).usage;
			if (!usage) {
				ctx.post({ type: "notice", level: "info", text: "AO has no usage for this session yet." });
				return true;
			}
			const n = (v: number | undefined) => (typeof v === "number" ? v.toLocaleString() : "–");
			ctx.post({
				type: "notice",
				level: "info",
				markdown: true,
				text: [
					"| | |",
					"|---|---|",
					`| Cost | ${typeof usage.cost === "number" ? `${usage.currency && usage.currency !== "USD" ? `${usage.currency} ` : "$"}${usage.cost.toFixed(4)}` : "–"} |`,
					`| Tokens in / out (last turn) | ${n(usage.inputTokens)} / ${n(usage.outputTokens)} |`,
					`| Cached tokens | ${n(usage.cachedTokens)} |`,
					usage.contextWindow ? `| Context | ${n(usage.contextUsed)} / ${n(usage.contextWindow)} (${Math.round(((usage.contextUsed ?? 0) / usage.contextWindow) * 100)}%) |` : "",
				]
					.filter(Boolean)
					.join("\n"),
			});
			return true;
		}
		case "copyLast": {
			const text = ctx.feed.lastReply();
			if (text) {
				await vscode.env.clipboard.writeText(text);
				void vscode.window.setStatusBarMessage("$(copy) Copied omp's last response", 2500);
			} else ctx.post({ type: "notice", level: "info", text: "No response to copy yet." });
			return true;
		}
		case "login":
		case "logout": {
			// omp's provider logins are TUI-only: `omp acp` has no login method.
			const terminal = vscode.window.createTerminal({ name: `omp ${name}`, cwd: ctx.meta?.cwd });
			terminal.show();
			terminal.sendText("omp");
			ctx.post({ type: "notice", level: "info", markdown: true, text: `Type \`/${name}\` in the omp terminal that just opened, then exit it (\`Ctrl+D\`). New prompts in this chat use the new credentials.` });
			return true;
		}
		case "settings": {
			const file = path.join(configuredOmpPaths().agentDir, "config.yml");
			if (!fs.existsSync(file)) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, "");
			}
			await vscode.window.showTextDocument(vscode.Uri.file(file));
			return true;
		}
		case "help":
			ctx.post({ type: "notice", level: "info", markdown: true, text: helpText() });
			return true;
		default:
			return false;
	}
}

function helpText(): string {
	const rows = LOCAL_COMMANDS.filter(c => !c.description?.startsWith("Same as")).map(c => `| \`/${c.name}${c.input?.hint ? ` ${c.input.hint}` : ""}\` | ${c.description ?? ""} |`);
	const modes = Object.values(PERMISSION_MODE_INFO)
		.map(i => i.label)
		.join(" → ");
	return [
		"**Composer**",
		"",
		"| Input | Effect |",
		"|---|---|",
		"| `Enter` / `Shift+Enter` | send / newline |",
		"| `Enter` while omp works | steer the running turn, or queue after it (`omp.sendWhileBusy`) |",
		"| `Alt+Enter` | add to the session's task queue |",
		"| `Esc` | interrupt the agent |",
		`| \`Shift+Tab\` | cycle the permission mode: ${modes} |`,
		"| `/` | omp + extension commands |",
		"| `@path` | file completion |",
		"| `@selection` `@file` `@problems` `@git` `@terminal` | attach editor selection, active file, diagnostics, uncommitted diff or terminal output when sending |",
		"| `/p:<name>` | insert a prompt snippet (`omp.chat.snippets`, `.omp/prompts/*.md`; `{{selection}}`, `{{file}}` filled in) |",
		"| `!command` / `!!command` | run a shell command in the session folder (`!`: its output goes into the next prompt's context) |",
		"| paste / drop image, 📎 | attach images and files |",
		"",
		"**Extension commands** (omp's own commands like `/model`, `/compact`, `/context`, `/usage`, `/todo` also work)",
		"",
		"| Command | |",
		"|---|---|",
		...rows,
		"",
		"**Keyboard** — `Cmd+Alt+O` focus chat · `Cmd+Alt+K` send selection · `Ctrl/Cmd+F` find in conversation · `Alt+T` collapse/expand tool cards",
	].join("\n");
}
