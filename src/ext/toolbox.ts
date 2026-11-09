// omp's CLI without a terminal: a Command Center over every omp command, terminal-backed
// interactive commands (login, update, plugins, …) and captured-output reports (usage, stats, models).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { prepareResume } from "../shared/omp-paths";
import type { SessionMeta } from "../shared/protocol";
import type { OmpApi } from "./api";
import { plain } from "./plain";
import { OmpMissingError, projectRoot, resolveOmpPath } from "./sessions";
import {
	type CommandCenterEntry,
	type CommandGroup,
	type ModelInfo,
	commandCenterEntries,
	commandLine,
	exportedPath,
	modelDetail,
	parseModels,
	pushRecent,
	shellKind,
	slugify,
	stripAnsi,
	withModel,
} from "./toolbox-core";

const OUTPUT_SCHEME = "omp-output";
const RECENT_KEY = "omp.commandCenter.recent";
const DOCS_URL = "https://omp.sh";
const GROUP_ICON: Record<CommandGroup, string> = {
	Sessions: "hubot",
	Chat: "comment",
	Tasks: "checklist",
	"Review & git": "git-compare",
	"omp account & tools": "account",
	Help: "question",
};

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

const MAX_OUTPUT = 32 * 1024 * 1024;

/** Runs omp to completion (no TTY, colors off) and collects its output. */
function runOmp(args: string[], cwd: string, timeoutMs: number, token?: vscode.CancellationToken): Promise<RunResult> {
	const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
	const omp = resolveOmpPath();
	if (!omp) {
		reject(new OmpMissingError());
		return promise;
	}
	// npm/bun shims on Windows are .cmd files, which need a shell; quote for cmd ourselves then.
	const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(omp);
	const child = spawn(viaShell ? commandLine(omp, args, "cmd") : omp, viaShell ? [] : args, {
		cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		windowsHide: true,
		shell: viaShell,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (d: string) => {
		if (stdout.length < MAX_OUTPUT) stdout += d;
	});
	child.stderr.on("data", (d: string) => {
		if (stderr.length < MAX_OUTPUT) stderr += d;
	});
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	const cancel = token?.onCancellationRequested(() => child.kill());
	child.on("error", err => {
		clearTimeout(timer);
		cancel?.dispose();
		reject(err);
	});
	child.on("close", code => {
		clearTimeout(timer);
		cancel?.dispose();
		resolve({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), timedOut });
	});
	return promise;
}

/** Doctor's "omp is not installed" notification (install / set path / learn more). */
const showOmpMissing = () => vscode.commands.executeCommand("omp.showOmpMissing");

/** Folder for workspace-level commands: the active editor's folder, else the first one, else home. */
function workspaceCwd(): string {
	const active = vscode.window.activeTextEditor?.document.uri;
	const folder = active?.scheme === "file" ? vscode.workspace.getWorkspaceFolder(active) : undefined;
	return (folder ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === "file"))?.uri.fsPath ?? os.homedir();
}

export function registerToolbox(api: OmpApi): void {
	const { context } = api;
	const reg = (name: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));

	// ---------- read-only output documents ----------
	const outputs = new Map<string, string>();
	const outputChanged = new vscode.EventEmitter<vscode.Uri>();
	context.subscriptions.push(
		outputChanged,
		vscode.workspace.registerTextDocumentContentProvider(OUTPUT_SCHEME, { onDidChange: outputChanged.event, provideTextDocumentContent: uri => outputs.get(uri.path) ?? "" }),
	);
	async function showOutput(name: string, text: string): Promise<void> {
		const uri = vscode.Uri.from({ scheme: OUTPUT_SCHEME, path: `/${name}` });
		outputs.set(uri.path, text);
		outputChanged.fire(uri);
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });
	}

	/** Runs omp with a progress notification; returns stdout, or undefined after reporting the failure. */
	async function capture(label: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<string | undefined> {
		let result: RunResult;
		try {
			result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running omp ${label}…`, cancellable: true }, (_p, token) =>
				runOmp(args, cwd, timeoutMs, token),
			);
		} catch (err) {
			if (err instanceof OmpMissingError) await showOmpMissing();
			else void vscode.window.showErrorMessage(plain(`Could not run omp ${label}: ${err instanceof Error ? err.message : String(err)}`));
			return undefined;
		}
		if (result.timedOut) {
			void vscode.window.showErrorMessage(`omp ${label} did not finish within ${Math.round(timeoutMs / 1000)} s.`);
			return undefined;
		}
		if (result.code === null) return undefined; // cancelled
		if (result.code !== 0) {
			const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n");
			const last = output.split(/\r?\n/).filter(l => l.trim()).pop() ?? "no output";
			const action = await vscode.window.showErrorMessage(plain(`omp ${label} failed (exit code ${result.code}): ${last}`), "Show Output");
			if (action) await showOutput(`omp ${label} (failed).txt`, output || "(no output)");
			return undefined;
		}
		return result.stdout;
	}

	async function showCaptured(label: string, args: string[], cwd = workspaceCwd(), timeoutMs?: number): Promise<void> {
		const out = await capture(label, args, cwd, timeoutMs);
		if (out !== undefined) await showOutput(`omp ${label}.txt`, out.trim() || "(no output)");
	}

	// ---------- terminals ----------
	/** Opens a terminal named `omp <label>` in `cwd` and types the omp command into its shell. */
	function runInTerminal(label: string, args: string[], cwd: string): vscode.Terminal | undefined {
		const omp = resolveOmpPath();
		if (!omp) {
			void showOmpMissing();
			return undefined;
		}
		const terminal = vscode.window.createTerminal({ name: `omp ${label}`, cwd: fs.existsSync(cwd) ? cwd : os.homedir(), iconPath: new vscode.ThemeIcon("hubot") });
		terminal.show();
		terminal.sendText(commandLine(omp, args, shellKind(vscode.env.shell, process.platform)));
		return terminal;
	}

	/**
	 * omp's own terminal UI on a transcript, in an editor-area terminal beside the chat. The terminal
	 * process is omp itself, so the terminal closes when omp exits (Windows: a shell runs the shim).
	 */
	function openTui(title: string, sessionFile: string, cwd: string): vscode.Terminal | undefined {
		const omp = resolveOmpPath();
		if (!omp) {
			void showOmpMissing();
			return undefined;
		}
		const args = ["--resume", sessionFile];
		const viaShell = process.platform === "win32";
		const terminal = vscode.window.createTerminal({
			name: `omp · ${title}`,
			cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
			iconPath: new vscode.ThemeIcon("hubot"),
			location: { viewColumn: vscode.ViewColumn.Beside },
			...(viaShell ? {} : { shellPath: omp, shellArgs: args }),
		});
		if (viaShell) terminal.sendText(commandLine(omp, args, shellKind(vscode.env.shell, process.platform)));
		terminal.show();
		return terminal;
	}

	function onTerminalClosed(terminal: vscode.Terminal, fn: () => void): void {
		const sub = vscode.window.onDidCloseTerminal(t => {
			if (t !== terminal) return;
			sub.dispose();
			fn();
		});
		context.subscriptions.push(sub);
	}

	/** Folder from an SCM title-menu argument (`rootUri`) or the usual folder pick. */
	async function folderFrom(arg: unknown): Promise<string | undefined> {
		if (arg && typeof arg === "object" && "rootUri" in arg && arg.rootUri instanceof vscode.Uri) return arg.rootUri.fsPath;
		return api.pickFolder(arg);
	}

	/** A session that has an omp transcript on disk, from a command argument or a pick. */
	async function transcriptSession(arg: unknown, placeHolder: string): Promise<(SessionMeta & { ompSessionFile: string }) | undefined> {
		let id = api.idFrom(arg);
		if (!id) {
			if (!api.sessions.all().some(m => m.ompSessionFile)) {
				void vscode.window.showInformationMessage("No omp session has a transcript yet.");
				return undefined;
			}
			id = await api.pickSession(placeHolder, m => !!m.ompSessionFile);
		}
		const meta = id ? api.sessions.get(id) : undefined;
		if (!meta) return undefined;
		const file = meta.ompSessionFile;
		if (!file) {
			void vscode.window.showInformationMessage(plain(`"${meta.title}" has no omp transcript yet. Send it a message first.`));
			return undefined;
		}
		// `omp gc` may have archived it (.jsonl.gz, which omp can't open): put it back first.
		const target = prepareResume(file);
		if (target.kind === "missing") {
			void vscode.window.showErrorMessage(plain(`The omp transcript of "${meta.title}" is missing: ${file} (${target.reason})`));
			return undefined;
		}
		if (target.kind === "restored") void vscode.window.showInformationMessage(plain(`Restored the omp transcript of "${meta.title}" from omp's archive.`));
		return { ...meta, ompSessionFile: target.file };
	}

	// ---------- command center ----------
	reg("omp.commandCenter", async () => {
		type Item = vscode.QuickPickItem & { command?: string };
		const entries = commandCenterEntries(context.extension.packageJSON, process.platform);
		const byId = new Map(entries.map(e => [e.command, e]));
		const toItem = (e: CommandCenterEntry): Item => ({ label: `$(${e.icon ?? GROUP_ICON[e.group]}) ${e.title}`, description: e.keybinding, command: e.command });
		const recent = (context.globalState.get<string[]>(RECENT_KEY) ?? []).filter(id => byId.has(id));
		const items: Item[] = [];
		const recentEntries = recent.flatMap(id => byId.get(id) ?? []);
		if (recentEntries.length) items.push({ label: "Recently Used", kind: vscode.QuickPickItemKind.Separator }, ...recentEntries.map(toItem));
		let group: CommandGroup | undefined;
		for (const e of entries) {
			if (e.group !== group) {
				group = e.group;
				items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
			}
			items.push(toItem(e));
		}
		const pick = await vscode.window.showQuickPick(items, { placeHolder: "omp: search every omp command", matchOnDescription: true });
		if (!pick?.command) return;
		await context.globalState.update(RECENT_KEY, pushRecent(recent, pick.command));
		await vscode.commands.executeCommand(pick.command);
	});

	// ---------- omp account & tools ----------
	reg("omp.login", () => runInTerminal("login", ["login"], workspaceCwd()));
	reg("omp.update", () => runInTerminal("update", ["update"], workspaceCwd()));
	reg("omp.setup", () => runInTerminal("setup", ["setup"], workspaceCwd()));

	type Action = vscode.QuickPickItem & { run: () => unknown };
	const pickAction = async (placeHolder: string, actions: Action[]) => (await vscode.window.showQuickPick(actions, { placeHolder }))?.run();
	const ask = async (prompt: string, placeHolder: string) => (await vscode.window.showInputBox({ prompt, placeHolder, ignoreFocusOut: true }))?.trim() || undefined;

	reg("omp.plugins", () => {
		const cwd = workspaceCwd();
		return pickAction("omp plugins", [
			{ label: "$(list-unordered) List Installed Plugins", run: () => showCaptured("plugin list", ["plugin", "list"], cwd) },
			{
				label: "$(cloud-download) Install Plugin…",
				run: async () => {
					const pkg = await ask("Plugin to install", "npm package, git URL or local path");
					if (pkg) runInTerminal("plugin install", ["plugin", "install", pkg], cwd);
				},
			},
			{
				label: "$(trash) Uninstall Plugin…",
				run: async () => {
					const name = await ask("Plugin to uninstall", "plugin name (see List Installed Plugins)");
					if (name) runInTerminal("plugin uninstall", ["plugin", "uninstall", name], cwd);
				},
			},
			{ label: "$(sync) Upgrade Plugins", run: () => runInTerminal("plugin upgrade", ["plugin", "upgrade"], cwd) },
			{ label: "$(pulse) Check Plugins (Doctor)", run: () => runInTerminal("plugin doctor", ["plugin", "doctor"], cwd) },
		]);
	});

	reg("omp.skills", () => {
		const cwd = workspaceCwd();
		const scope = async (verb: string) =>
			(
				await vscode.window.showQuickPick(
					[
						{ label: "This Project", description: path.basename(cwd), args: [] },
						{ label: "All Projects", description: "user-global skills.json", args: ["--global"] },
					],
					{ placeHolder: `${verb} for…` },
				)
			)?.args;
		return pickAction("omp skills", [
			{ label: "$(list-unordered) List Skills", run: () => showCaptured("skill list", ["skill", "list"], cwd) },
			{
				label: "$(search) Search Skills…",
				run: async () => {
					const query = await ask("Search the skills registry (skills.omp.sh)", "e.g. pdf");
					if (query) await showCaptured("skill search", ["skill", "search", query], cwd);
				},
			},
			{
				label: "$(cloud-download) Install Skill…",
				run: async () => {
					const spec = await ask("Skill to install", "@scope/name[@version]");
					const where = spec && (await scope("Install"));
					if (spec && where) runInTerminal("skill install", ["skill", "install", ...where, spec], cwd);
				},
			},
			{
				label: "$(sync) Update Skills",
				run: async () => {
					const where = await scope("Update");
					if (where) runInTerminal("skill update", ["skill", "update", ...where], cwd);
				},
			},
			{
				label: "$(trash) Uninstall Skill…",
				run: async () => {
					const name = await ask("Skill to uninstall", "@scope/name");
					const where = name && (await scope("Uninstall"));
					if (name && where) runInTerminal("skill uninstall", ["skill", "uninstall", ...where, name], cwd);
				},
			},
		]);
	});

	reg("omp.usage", () => showCaptured("usage", ["usage"]));

	reg("omp.stats", async () => {
		const cwd = workspaceCwd();
		const out = await capture("stats", ["stats", "--summary"], cwd);
		if (out === undefined) return;
		await showOutput("omp stats.txt", out.trim() || "(no output)");
		const action = await vscode.window.showInformationMessage("omp can also serve an interactive statistics dashboard.", "Open Dashboard");
		if (action) runInTerminal("stats", ["stats"], cwd);
	});

	reg("omp.models", async () => {
		const out = await capture("models", ["models", "--json"], workspaceCwd());
		if (out === undefined) return;
		let models: ModelInfo[];
		try {
			models = parseModels(out);
		} catch (err) {
			void vscode.window.showErrorMessage(plain(`Could not read omp's model list: ${err instanceof Error ? err.message : String(err)}`));
			return;
		}
		if (models.length === 0) {
			const action = await vscode.window.showInformationMessage("omp has no models available. Log in to a provider first.", "Log In");
			if (action) await vscode.commands.executeCommand("omp.login");
			return;
		}
		type ModelItem = vscode.QuickPickItem & { selector?: string };
		const items: ModelItem[] = [];
		let provider: string | undefined;
		for (const m of models) {
			if (m.provider !== provider) {
				provider = m.provider;
				items.push({ label: provider, kind: vscode.QuickPickItemKind.Separator });
			}
			items.push({ label: m.name, description: m.selector, detail: modelDetail(m) || undefined, selector: m.selector });
		}
		const pick = await vscode.window.showQuickPick(items, { placeHolder: `${models.length} models — pick one to start a session with it or copy its id`, matchOnDescription: true, matchOnDetail: true });
		const selector = pick?.selector;
		if (!selector) return;
		await pickAction(selector, [
			{
				label: "$(add) New Session with This Model",
				run: async () => {
					const cwd = await api.pickFolder();
					if (cwd) await api.launchAndOpen({ cwd, ompArgs: withModel(vscode.workspace.getConfiguration("omp").get<string[]>("extraArgs") ?? [], selector) });
				},
			},
			{
				label: "$(copy) Copy Model Id",
				description: selector,
				run: async () => {
					await vscode.env.clipboard.writeText(selector);
					void vscode.window.setStatusBarMessage(`Copied ${selector}`, 3000);
				},
			},
		]);
	});

	// ---------- review & git ----------
	reg("omp.cleanse", async (arg?: unknown) => {
		const cwd = await folderFrom(arg);
		if (!cwd) return;
		const request = await vscode.window.showInputBox({
			prompt: "What should omp detect and fix? Leave empty to choose from the checkers it discovers.",
			placeHolder: 'e.g. "ts errors"',
			ignoreFocusOut: true,
		});
		if (request === undefined) return;
		runInTerminal("cleanse", ["cleanse", ...(request.trim() ? [request.trim()] : [])], cwd);
	});

	reg("omp.commitInTerminal", async (arg?: unknown) => {
		const cwd = await folderFrom(arg);
		if (!cwd) return;
		if (!projectRoot(cwd).isRepo) {
			void vscode.window.showWarningMessage(plain(`${cwd} is not inside a git repository.`));
			return;
		}
		const mode = await vscode.window.showQuickPick(
			[
				{ label: "$(git-commit) Commit", description: "write the message and update changelogs", args: [] },
				{ label: "$(repo-push) Commit and Push", args: ["--push"] },
				{ label: "$(eye) Dry Run", description: "preview without committing", args: ["--dry-run"] },
			],
			{ placeHolder: `omp commit in ${path.basename(cwd)}` },
		);
		if (mode) runInTerminal("commit", ["commit", ...mode.args], cwd);
	});

	reg("omp.gitUi", async (arg?: unknown) => {
		const cwd = await folderFrom(arg);
		if (!cwd) return;
		if (!projectRoot(cwd).isRepo) {
			void vscode.window.showWarningMessage(plain(`${cwd} is not inside a git repository.`));
			return;
		}
		runInTerminal("git", ["git"], cwd);
	});

	// ---------- sessions ----------
	reg("omp.exportHtml", async (arg?: unknown) => {
		const meta = await transcriptSession(arg, "Export which session as HTML?");
		if (!meta) return;
		const dir = path.join(context.globalStorageUri.fsPath, "exports");
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, `${slugify(meta.title)}-${meta.id}.html`);
		const out = await capture("--export", ["--export", meta.ompSessionFile, target], dir, 120_000);
		if (out === undefined) return;
		const file = exportedPath(out, dir) ?? target;
		if (!fs.existsSync(file)) {
			void vscode.window.showErrorMessage(plain(`omp did not write the HTML export (${out.trim() || "no output"}).`));
			return;
		}
		const local = vscode.env.remoteName === undefined;
		const action = await vscode.window.showInformationMessage(
			plain(`Exported "${meta.title}" to HTML.`),
			...(local ? ["Open in Browser", "Reveal in File Explorer"] : []),
			"Save Copy As…",
			"Copy Path",
		);
		const uri = vscode.Uri.file(file);
		if (action === "Open in Browser") await vscode.env.openExternal(uri);
		else if (action === "Reveal in File Explorer") await vscode.commands.executeCommand("revealFileInOS", uri);
		else if (action === "Copy Path") await vscode.env.clipboard.writeText(file);
		else if (action === "Save Copy As…") {
			// On a remote, the save dialog's "Show Local" saves onto this computer.
			const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(meta.cwd, path.basename(file))), filters: { HTML: ["html"] } });
			if (dest) await vscode.workspace.fs.writeFile(dest, await vscode.workspace.fs.readFile(uri));
		}
	});

	reg("omp.share", async (arg?: unknown) => {
		const meta = await transcriptSession(arg, "Share which session?");
		if (!meta) return;
		const how = await vscode.window.showQuickPick(
			[
				{ label: "$(link) Encrypted Share Link", description: "omp share server", args: [] },
				{ label: "$(github) Secret GitHub Gist", args: ["--gist"] },
			],
			{ placeHolder: `Share "${meta.title}": uploads its transcript` },
		);
		if (how) runInTerminal("share", ["share", meta.ompSessionFile, ...how.args], meta.cwd);
	});

	reg("omp.continueInTerminal", async (arg?: unknown) => {
		const meta = await transcriptSession(arg, "Continue which session in omp's terminal UI?");
		if (!meta) return;
		if (meta.status === "working" || meta.status === "waiting") {
			const ok = await vscode.window.showWarningMessage(
				`Move "${meta.title}" to omp's terminal UI?`,
				{ modal: true, detail: `omp is ${meta.status === "working" ? "working; its current turn is interrupted" : "waiting for your answer, which you then give in the terminal"}. The session comes back to the background when you exit omp in the terminal.` },
				"Continue in Terminal",
			);
			if (ok !== "Continue in Terminal") return;
		}
		if (meta.status !== "stopped") {
			try {
				await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: plain(`Moving "${meta.title}" to the terminal…`) }, () => api.sessions.stop(meta.id));
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`"${meta.title}" did not stop (${err instanceof Error ? err.message : String(err)}); not opening it in a terminal to avoid two omp processes on one transcript.`));
				return;
			}
		}
		const terminal = openTui(meta.title, meta.ompSessionFile, meta.cwd);
		if (!terminal) return;
		onTerminalClosed(terminal, () => {
			// omp exited (or the terminal was closed): the session goes back to the background.
			if (api.sessions.get(meta.id)?.status !== "stopped") return;
			void vscode.commands.executeCommand("omp.resumeSession", meta.id);
			void vscode.window.showInformationMessage(plain(`"${meta.title}" is back in the background.`));
		});
	});

	const importFrom = (source: "claude" | "codex", name: string) => () => {
		const cwd = workspaceCwd();
		const terminal = runInTerminal(`import ${source}`, [`--from-${source}`], cwd);
		if (!terminal) return;
		void vscode.window.showInformationMessage(`Pick a ${name} session in the terminal; omp imports it and continues it there.`);
	};
	reg("omp.importClaude", importFrom("claude", "Claude Code"));
	reg("omp.importCodex", importFrom("codex", "Codex"));

	// ---------- help ----------
	reg("omp.openDocs", () => vscode.env.openExternal(vscode.Uri.parse(DOCS_URL)));
	reg("omp.keyboardShortcuts", () => vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "omp."));
	reg("omp.openConfig", async () => {
		let dir = path.join(os.homedir(), ".omp", "agent");
		try {
			const res = await runOmp(["config", "path"], os.homedir(), 15_000);
			const printed = res.code === 0 ? res.stdout.trim().split(/\r?\n/).pop()?.trim() : undefined;
			if (printed && path.isAbsolute(printed)) dir = printed;
		} catch {
			/* omp missing: fall back to the default location */
		}
		const file = path.join(dir, "config.yml");
		if (fs.existsSync(file)) {
			await vscode.window.showTextDocument(vscode.Uri.file(file));
			return;
		}
		const action = await vscode.window.showInformationMessage(plain(`omp has no config file yet (${file}); it uses its defaults.`), "Show Settings in Terminal", "Open Documentation");
		if (action === "Show Settings in Terminal") runInTerminal("config", ["config"], workspaceCwd());
		else if (action === "Open Documentation") await vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
	});
}
