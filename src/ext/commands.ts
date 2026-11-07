// Session actions the omp TUI offers but omp's RPC command table does not expose as slash
// commands. They are implemented here on top of the RPC protocol and surface both as
// `/commands` in the composer and as items in the chat menu.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PERMISSION_MODE_INFO, permissionModeOf } from "../shared/permissions";
import type { OmpFrame, SessionMeta } from "../shared/protocol";
import type { PanelCommand, SlashCommand, SlimState, ToWebview } from "../shared/webview";
import type { HostClient } from "./client";
import { listOmpHistory } from "./sessions";
import { pickPermissionMode } from "./permissions";
import { sessionPermissionMode, setSessionPermissionMode } from "../shared/launch";

export interface CommandContext {
	readonly client: HostClient | undefined;
	readonly meta: SessionMeta | undefined;
	readonly state: SlimState | null;
	post(msg: ToWebview): void;
	insertText(text: string): void;
	/** Show a notice after the next transcript replacement (fork/new/switch reset the view). */
	postAfterReset(msg: ToWebview): void;
}

function rec(v: unknown): Record<string, unknown> | undefined {
	// JSON objects from omp responses; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function list(v: unknown): Record<string, unknown>[] {
	return Array.isArray(v) ? v.map(x => rec(x) ?? {}) : [];
}

/** Slash commands handled by the extension (merged into the composer's completion list). */
export const LOCAL_COMMANDS: SlashCommand[] = [
	{ name: "new", description: "Start a fresh conversation in this session", local: true },
	{ name: "clear", description: "Same as /new", local: true },
	{ name: "resume", description: "Switch this session to an earlier omp transcript of this folder", local: true },
	{ name: "tree", description: "Rewind to an earlier user message (branch from there)", local: true },
	{ name: "branch", description: "Same as /tree", local: true },
	{ name: "undo", description: "Undo the last turn: revert its file edits and rewind the conversation", local: true },
	{ name: "redo", description: "Bring back what the last undo / checkpoint restore removed", local: true },
	{ name: "voice", description: "Voice mode: talk with omp (omp's realtime voice)", local: true },
	{ name: "tui", description: "Continue this session in omp's terminal UI; it returns to the background when you exit", local: true },
	{ name: "fork", description: "Copy this conversation into a new transcript and continue there", local: true },
	{ name: "goal", description: "Goal mode: /goal <objective> | pause | resume | drop | status", input: { hint: "<objective|pause|resume|drop|status>" }, local: true },
	{ name: "btw", description: "Ask a side question without interrupting the agent", input: { hint: "<question>" }, local: true },
	{ name: "login", description: "Log in to a model provider", input: { hint: "[provider]" }, local: true },
	{ name: "logout", description: "Remove a stored provider credential", local: true },
	{ name: "agents", description: "Subagents: watch, steer, cancel", local: true },
	{ name: "hub", description: "Same as /agents", local: true },
	{ name: "queue", description: "Add a task to this session's background queue (Title :: sub; sub)", input: { hint: "<task>" }, local: true },
	{ name: "tasks", description: "Show the task queue", local: true },
	{ name: "changes", description: "Review every file this session changed (multi-file diff)", local: true },
	{ name: "diff", description: "Same as /changes", local: true },
	{ name: "copy", description: "Copy the last assistant response", local: true },
	{ name: "cost", description: "Tokens, cost and message counts for this session", local: true },
	{ name: "export", description: "Export the conversation: copy or save as Markdown, or HTML", input: { hint: "[md|copy|html]" }, local: true },
	{ name: "settings", description: "Open omp's config.yml", local: true },
	{ name: "mode", description: "Permission mode: ask | edits | plan | auto (Shift+Tab cycles)", input: { hint: "[ask|edits|plan|auto]" }, local: true },
	{ name: "plan", description: "Switch to Plan mode: read-only, file edits are refused", local: true },
	{ name: "help", description: "Commands and keyboard shortcuts", local: true },
	{ name: "hotkeys", description: "Same as /help", local: true },
	{ name: "exit", description: "Stop this session (transcript is kept)", local: true },
	{ name: "quit", description: "Same as /exit", local: true },
];

const SLASH_TO_PANEL: Record<string, PanelCommand> = {
	new: "newInPlace",
	clear: "newInPlace",
	resume: "resumeTranscript",
	tree: "rewind",
	branch: "rewind",
	fork: "fork",
	login: "login",
	logout: "logout",
	agents: "agents",
	hub: "agents",
	changes: "reviewChanges",
	diff: "reviewChanges",
	copy: "copyLast",
	cost: "stats",
	settings: "settings",
	help: "help",
	hotkeys: "help",
	exit: "stopSession",
	undo: "undoTurn",
	redo: "redoTurn",
	voice: "voiceStart",
	tui: "openTui",
};

function fail(ctx: CommandContext, res: OmpFrame): boolean {
	if (res.success) return false;
	ctx.post({ type: "notice", level: "error", text: String(res.error ?? `${String(res.command)} failed`) });
	return true;
}

function need(ctx: CommandContext): HostClient | undefined {
	if (!ctx.client?.connected) ctx.post({ type: "notice", level: "warning", text: "Session is not running. Resume it first." });
	return ctx.client?.connected ? ctx.client : undefined;
}

/**
 * Handles composer input the extension owns: `/local-command …` and `!shell command`.
 * Returns false when the text should go to omp as a normal prompt.
 */
export async function handleComposerInput(text: string, ctx: CommandContext, runPanel: (name: PanelCommand) => Promise<void>): Promise<boolean> {
	if (text.startsWith("!")) {
		const command = text.replace(/^!!?/, "").trim();
		const client = need(ctx);
		if (!command || !client) return true;
		const res = await client.rpc({ type: "bash", command }, 60 * 60_000);
		if (fail(ctx, res)) return true;
		const data = rec(res.data) ?? {};
		ctx.post({ type: "bashResult", command, output: String(data.output ?? ""), exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined, cancelled: !!data.cancelled });
		return true;
	}
	const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!m) return false;
	const name = m[1];
	const args = (m[2] ?? "").trim();
	if (name === "goal") {
		await goal(ctx, args);
		return true;
	}
	if (name === "btw") {
		await btw(ctx, args);
		return true;
	}
	if (name === "login") {
		await login(ctx, args);
		return true;
	}
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
	if (arg === "html") return "export";
	if (arg) return null;
	const items: Array<vscode.QuickPickItem & { cmd: PanelCommand }> = [
		{ label: "$(copy) Copy as Markdown", cmd: "exportMarkdownCopy" },
		{ label: "$(save) Save as Markdown…", cmd: "exportMarkdownSave" },
		{ label: "$(globe) Export HTML (omp)", cmd: "export" },
	];
	const pick = await vscode.window.showQuickPick(items, { placeHolder: "Export this conversation" });
	return pick?.cmd;
}

async function goal(ctx: CommandContext, args: string): Promise<void> {
	const client = need(ctx);
	if (!client) return;
	const op = args.toLowerCase();
	if (op === "pause" || op === "resume" || op === "drop" || op === "status" || op === "get") {
		const res = await client.rpc({ type: "goal", op: op === "status" ? "get" : op });
		if (fail(ctx, res)) return;
		const g = rec(rec(res.data)?.goal);
		ctx.post({ type: "notice", level: "info", text: g ? `Goal (${String(g.status ?? "active")}): ${String(g.objective ?? "")}` : "No goal." });
		return;
	}
	let objective = args;
	if (!objective) {
		const current = rec(rec((await client.rpc({ type: "goal", op: "get" })).data)?.goal);
		if (current) {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: "$(debug-pause) Pause goal", op: "pause" },
					{ label: "$(debug-start) Resume goal", op: "resume" },
					{ label: "$(trash) Drop goal", op: "drop" },
				],
				{ placeHolder: `Goal: ${String(current.objective ?? "")}` },
			);
			if (pick) await goal(ctx, pick.op);
			return;
		}
		objective = (await vscode.window.showInputBox({ prompt: "Goal objective — omp keeps working until it is achieved", ignoreFocusOut: true })) ?? "";
		if (!objective.trim()) return;
	}
	const res = await client.rpc({ type: "goal", op: "create", objective });
	if (!fail(ctx, res)) ctx.post({ type: "notice", level: "info", text: `Goal set: ${objective}` });
}

async function permissionMode(ctx: CommandContext, arg: string): Promise<void> {
	const meta = ctx.meta;
	if (!meta) return;
	const current = sessionPermissionMode(meta);
	const mode = arg ? permissionModeOf(arg.toLowerCase()) : await pickPermissionMode(current, `Permission mode · ${meta.title}`);
	if (mode === undefined && arg) {
		ctx.post({ type: "notice", level: "warning", text: `Unknown mode "${arg}": use ask, edits, plan or auto.` });
		return;
	}
	if (!mode || mode === current) return;
	if (!(await setSessionPermissionMode(meta, mode))) ctx.post({ type: "notice", level: "warning", text: "This session runs an older host without permission modes. Restart it to switch modes live." });
	else if (meta.status === "stopped") ctx.post({ type: "notice", level: "info", text: `Resumes in ${PERMISSION_MODE_INFO[mode].label} mode.` });
}

async function btw(ctx: CommandContext, args: string): Promise<void> {
	const client = need(ctx);
	if (!client) return;
	const question = args || (await vscode.window.showInputBox({ prompt: "Side question (answered without interrupting the agent)" })) || "";
	if (!question.trim()) return;
	fail(ctx, await client.rpc({ type: "btw", question }, 10 * 60_000));
}

async function login(ctx: CommandContext, providerArg: string): Promise<void> {
	const client = need(ctx);
	if (!client) return;
	let providerId = providerArg;
	if (!providerId) {
		const res = await client.rpc({ type: "get_login_providers" });
		if (fail(ctx, res)) return;
		const pick = await vscode.window.showQuickPick(
			list(rec(res.data)?.providers)
				.filter(p => p.available !== false)
				.map(p => ({ label: String(p.name ?? p.id), description: p.authenticated ? "$(pass-filled) logged in" : "", id: String(p.id) })),
			{ placeHolder: "Log in to which provider?" },
		);
		if (!pick) return;
		providerId = pick.id;
	}
	ctx.post({ type: "notice", level: "info", text: `Logging in to ${providerId}… follow the browser / prompts.` });
	const res = await client.rpc({ type: "login", providerId }, 15 * 60_000);
	if (!fail(ctx, res)) ctx.post({ type: "notice", level: "info", text: `Logged in to ${providerId}.` });
}

/** Menu/command actions that need RPC round-trips or VS Code UI. */
export async function runSessionAction(name: PanelCommand, ctx: CommandContext): Promise<boolean> {
	switch (name) {
		case "newInPlace": {
			const c = need(ctx);
			if (c) fail(ctx, await c.rpc({ type: "new_session" }));
			return true;
		}
		case "resumeTranscript": {
			const c = need(ctx);
			const cwd = ctx.meta?.cwd;
			if (!c || !cwd) return true;
			const history = listOmpHistory(cwd).filter(h => h.file !== ctx.meta?.ompSessionFile);
			if (!history.length) {
				ctx.post({ type: "notice", level: "info", text: "No other omp transcripts for this folder." });
				return true;
			}
			const pick = await vscode.window.showQuickPick(
				history.slice(0, 200).map(h => ({ label: h.title, description: new Date(h.mtime).toLocaleString(), file: h.file })),
				{ placeHolder: "Switch this session to which transcript?" },
			);
			if (pick) fail(ctx, await c.rpc({ type: "switch_session", sessionPath: pick.file }));
			return true;
		}
		case "rewind": {
			const c = need(ctx);
			if (!c) return true;
			const res = await c.rpc({ type: "get_branch_messages" });
			if (fail(ctx, res)) return true;
			const msgs = list(rec(res.data)?.messages);
			if (!msgs.length) {
				ctx.post({ type: "notice", level: "info", text: "Nothing to rewind to yet." });
				return true;
			}
			const pick = await vscode.window.showQuickPick(
				msgs
					.map((x, i) => ({ label: String(x.text ?? "").split("\n")[0].slice(0, 120) || "(empty)", description: `#${i + 1}`, entryId: String(x.entryId), text: String(x.text ?? "") }))
					.reverse(),
				{ placeHolder: "Rewind to before which message? (its text returns to the composer)" },
			);
			if (!pick) return true;
			const br = await c.rpc({ type: "branch", entryId: pick.entryId });
			if (fail(ctx, br)) return true;
			const data = rec(br.data) ?? {};
			if (!data.cancelled) ctx.insertText(String(data.text ?? pick.text));
			return true;
		}
		case "fork": {
			const c = need(ctx);
			if (!c) return true;
			const res = await c.rpc({ type: "fork" });
			if (!fail(ctx, res)) ctx.postAfterReset({ type: "notice", level: "info", text: rec(res.data)?.cancelled ? "Fork cancelled." : "Forked: continuing in a copy of this conversation." });
			return true;
		}
		case "export": {
			const c = need(ctx);
			if (!c) return true;
			const res = await c.rpc({ type: "export_html" }, 120_000);
			if (fail(ctx, res)) return true;
			const file = String(rec(res.data)?.path ?? "");
			ctx.post({ type: "notice", level: "info", markdown: true, text: `Exported to \`${file}\`` });
			return true;
		}
		case "stats": {
			const c = need(ctx);
			if (!c) return true;
			const res = await c.rpc({ type: "get_session_stats" });
			if (fail(ctx, res)) return true;
			const s = rec(res.data) ?? {};
			const t = rec(s.tokens) ?? {};
			const ctxu = rec(s.contextUsage);
			const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString() : "–");
			ctx.post({
				type: "notice",
				level: "info",
				markdown: true,
				text: [
					"| | |",
					"|---|---|",
					`| Cost | $${typeof s.cost === "number" ? s.cost.toFixed(4) : "–"} |`,
					`| Tokens in / out | ${n(t.input)} / ${n(t.output)} |`,
					`| Cache read / write | ${n(t.cacheRead)} / ${n(t.cacheWrite)} |`,
					`| Messages (user / assistant) | ${n(s.userMessages)} / ${n(s.assistantMessages)} |`,
					`| Tool calls | ${n(s.toolCalls)} |`,
					ctxu ? `| Context | ${n(ctxu.tokens)} / ${n(ctxu.contextWindow)} (${Math.round(Number(ctxu.percent))}%) |` : "",
					s.sessionFile ? `| Transcript | \`${String(s.sessionFile)}\` |` : "",
				]
					.filter(Boolean)
					.join("\n"),
			});
			return true;
		}
		case "copyLast": {
			const c = need(ctx);
			if (!c) return true;
			const res = await c.rpc({ type: "get_last_assistant_text" });
			if (fail(ctx, res)) return true;
			const text = rec(res.data)?.text;
			if (typeof text === "string" && text) {
				await vscode.env.clipboard.writeText(text);
				void vscode.window.setStatusBarMessage("$(copy) Copied omp's last response", 2500);
			}
			return true;
		}
		case "toggleFast": {
			const c = need(ctx);
			if (!c) return true;
			const res = await c.rpc({ type: "set_fast_mode", enabled: !ctx.state?.fastModeEnabled });
			if (!fail(ctx, res)) ctx.post({ type: "notice", level: "info", text: `Fast mode ${rec(res.data)?.enabled ? "on" : "off"}.` });
			return true;
		}
		case "toggleAutoCompact": {
			const c = need(ctx);
			if (!c) return true;
			const enabled = !(ctx.state?.autoCompactionEnabled ?? true);
			if (!fail(ctx, await c.rpc({ type: "set_auto_compaction", enabled }))) ctx.post({ type: "notice", level: "info", text: `Auto-compaction ${enabled ? "on" : "off"}.` });
			return true;
		}
		case "goal":
			await goal(ctx, "");
			return true;
		case "login":
			await login(ctx, "");
			return true;
		case "logout": {
			const c = need(ctx);
			if (!c) return true;
			const pr = await c.rpc({ type: "get_login_providers" });
			if (fail(ctx, pr)) return true;
			const provider = await vscode.window.showQuickPick(
				list(rec(pr.data)?.providers)
					.filter(p => p.authenticated)
					.map(p => ({ label: String(p.name ?? p.id), id: String(p.id) })),
				{ placeHolder: "Log out of which provider?" },
			);
			if (!provider) return true;
			const acc = await c.rpc({ type: "get_logout_accounts", providerId: provider.id });
			if (fail(ctx, acc)) return true;
			const account = await vscode.window.showQuickPick(
				list(rec(acc.data)?.accounts).map(a => ({ label: String(a.label ?? a.credentialId), description: `${String(a.detail ?? "")}${a.active ? " · in use" : ""}`, id: Number(a.credentialId) })),
				{ placeHolder: "Remove which credential?" },
			);
			if (!account) return true;
			const res = await c.rpc({ type: "logout", providerId: provider.id, credentialId: account.id });
			if (!fail(ctx, res)) ctx.post({ type: "notice", level: "info", text: `Removed ${account.label}.` });
			return true;
		}
		case "agents":
			await agents(ctx);
			return true;
		case "settings": {
			const file = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), "config.yml");
			if (!fs.existsSync(file)) fs.writeFileSync(file, "");
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

async function agents(ctx: CommandContext): Promise<void> {
	const c = need(ctx);
	if (!c) return;
	const res = await c.rpc({ type: "get_subagents" });
	if (fail(ctx, res)) return;
	const subs = list(rec(res.data)?.subagents);
	if (!subs.length) {
		ctx.post({ type: "notice", level: "info", text: "No subagents in this session." });
		return;
	}
	const pick = await vscode.window.showQuickPick(
		subs.map(s => {
			const p = rec(s.progress) ?? {};
			return {
				label: `${s.status === "running" ? "$(loading~spin)" : s.status === "completed" ? "$(pass-filled)" : "$(circle-outline)"} ${String(s.agent)} #${String(s.index)}`,
				description: String(s.description ?? s.task ?? "").slice(0, 120),
				detail: [p.lastIntent, p.currentTool ? `tool: ${String(p.currentTool)}` : "", typeof p.toolCount === "number" ? `${p.toolCount} tools` : ""].filter(Boolean).join(" · "),
				sub: s,
			};
		}),
		{ placeHolder: "Subagents", matchOnDescription: true },
	);
	if (!pick) return;
	const id = String(pick.sub.id);
	const action = await vscode.window.showQuickPick(
		[
			{ label: "$(output) View transcript", a: "view" },
			...(pick.sub.status === "running" ? [{ label: "$(comment) Steer…", a: "steer" }, { label: "$(debug-stop) Cancel", a: "cancel" }] : []),
		],
		{ placeHolder: `${String(pick.sub.agent)}: ${String(pick.sub.description ?? "")}` },
	);
	if (!action) return;
	if (action.a === "view") {
		const r = await c.rpc({ type: "get_subagent_messages", subagentId: id });
		if (fail(ctx, r)) return;
		const md = list(rec(r.data)?.messages)
			.map(m => {
				const content = Array.isArray(m.content) ? m.content.map(b => rec(b) ?? {}) : [];
				const text = content
					.map(b => (b.type === "text" ? String(b.text) : b.type === "toolCall" ? `\`${String(b.name)}\` ${JSON.stringify(b.arguments).slice(0, 300)}` : ""))
					.filter(Boolean)
					.join("\n\n");
				return text ? `### ${String(m.role)}\n\n${text}` : "";
			})
			.filter(Boolean)
			.join("\n\n---\n\n");
		const doc = await vscode.workspace.openTextDocument({ content: md || "(empty)", language: "markdown" });
		await vscode.window.showTextDocument(doc, { preview: true });
	} else if (action.a === "steer") {
		const message = await vscode.window.showInputBox({ prompt: `Message to ${String(pick.sub.agent)}` });
		if (message) fail(ctx, await c.rpc({ type: "steer_subagent", subagentId: id, message }));
	} else {
		fail(ctx, await c.rpc({ type: "cancel_subagent", subagentId: id }));
	}
}

function helpText(): string {
	const rows = LOCAL_COMMANDS.filter(c => !c.description?.startsWith("Same as")).map(c => `| \`/${c.name}${c.input?.hint ? ` ${c.input.hint}` : ""}\` | ${c.description ?? ""} |`);
	return [
		"**Composer**",
		"",
		"| Input | Effect |",
		"|---|---|",
		"| `Enter` / `Shift+Enter` | send / newline |",
		"| `Esc` | interrupt the agent |",
		"| `Shift+Tab` | cycle the permission mode: Ask → Edits → Plan → Auto |",
		"| `/` | omp + extension commands |",
		"| `@path` | file completion |",
		"| `@selection` `@file` `@problems` `@git` `@terminal` | attach editor selection, active file, diagnostics, uncommitted diff or terminal output when sending |",
		"| `/p:<name>` | insert a prompt snippet (`omp.chat.snippets`, `.omp/prompts/*.md`; `{{selection}}`, `{{file}}` filled in) |",
		"| `!command` | run a shell command in the session (output goes to context) |",
		"| paste / drop image, 📎 | attach images |",
		"",
		"**Extension commands** (omp's own commands like `/model`, `/compact`, `/context`, `/usage`, `/todo`, `/share`, `/handoff` also work)",
		"",
		"| Command | |",
		"|---|---|",
		...rows,
		"",
		"**Keyboard** — `Cmd+Alt+O` focus chat · `Cmd+Alt+K` send selection · `Ctrl/Cmd+F` find in conversation · `Alt+T` collapse/expand tool cards",
	].join("\n");
}
