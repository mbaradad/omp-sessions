import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileChange, HostToClient, SessionMeta } from "../shared/protocol";
import { sessionDir } from "../shared/protocol";
import type { FromWebview, SlashCommand, SlimState, ToWebview } from "../shared/webview";
import { HostClient } from "./client";
import { type SnapshotProvider, openFile, openSessionDiff, openTextDiff, openToolDiff } from "./diff";
import type { SessionManager } from "./sessions";
import { slimFrame, slimMessage, slimRunningTool } from "./slim";

export const VIEW_TYPE = "omp.chat";

function rec(v: unknown): Record<string, unknown> | undefined {
	// JSON objects from omp frames; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Messages recorded in an omp session file (used to show stopped sessions). */
function readTranscript(file: string | undefined): unknown[] {
	if (!file) return [];
	let raw = "";
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		if (!line.includes('"type":"message"')) continue;
		try {
			const entry = rec(JSON.parse(line));
			if (entry?.type === "message" && entry.message) out.push(entry.message);
		} catch {
			/* torn line */
		}
	}
	return out;
}

export class ChatPanel implements vscode.Disposable {
	private client: HostClient | undefined;
	private clientSubs: vscode.Disposable[] = [];
	private readonly subs: vscode.Disposable[] = [];
	private webviewReady = false;
	private snapshot: Extract<HostToClient, { t: "snapshot" }> | undefined;
	private state: SlimState | null = null;
	private changes: FileChange[] = [];
	/** Full edit details (with oldText/newText) by toolCallId, for diffs of history the host did not snapshot. */
	private readonly editTexts = new Map<string, Array<{ path: string; oldText: string; newText: string }>>();
	private outbox: ToWebview[] = [];
	private flushTimer: NodeJS.Timeout | undefined;
	private disposed = false;
	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	readonly onDidDispose = this.disposeEmitter.event;

	constructor(
		readonly sessionId: string,
		readonly panel: vscode.WebviewPanel,
		private readonly sessions: SessionManager,
		private readonly snapshots: SnapshotProvider,
		private readonly extensionUri: vscode.Uri,
	) {
		panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out"), vscode.Uri.joinPath(extensionUri, "media")] };
		panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "omp-color.svg");
		panel.webview.html = this.html();
		this.subs.push(
			panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onWebviewMessage(m)),
			panel.onDidDispose(() => this.dispose()),
			sessions.onDidChange(() => this.onSessionsChanged()),
		);
		this.updateTitle();
		this.lastStatus = this.meta?.status;
		this.attach();
	}

	get meta(): SessionMeta | undefined {
		return this.sessions.get(this.sessionId);
	}

	get isVisible(): boolean {
		return this.panel.visible;
	}

	reveal(): void {
		this.panel.reveal(undefined, false);
	}

	post(msg: ToWebview): void {
		if (!this.webviewReady) return;
		const coalesce = (a: ToWebview, b: ToWebview) =>
			a.type === "event" &&
			b.type === "event" &&
			a.ev.type === b.ev.type &&
			((a.ev.type === "message_update" && a.ev.messageId === b.ev.messageId) || (a.ev.type === "tool_execution_update" && a.ev.toolCallId === b.ev.toolCallId));
		const last = this.outbox[this.outbox.length - 1];
		if (last && coalesce(last, msg)) this.outbox[this.outbox.length - 1] = msg;
		else this.outbox.push(msg);
		this.flushTimer ??= setTimeout(() => this.flush(), 40);
	}

	private flush(): void {
		this.flushTimer = undefined;
		const batch = this.outbox;
		this.outbox = [];
		for (const m of batch) void this.panel.webview.postMessage(m);
	}

	/** (Re)connect to the session host if it is running; otherwise show the recorded transcript. */
	attach(): void {
		for (const d of this.clientSubs) d.dispose();
		this.clientSubs = [];
		this.client?.dispose();
		this.client = undefined;
		this.snapshot = undefined;
		const meta = this.meta;
		if (!meta) return;
		if (meta.status === "stopped") {
			this.sendInit();
			return;
		}
		const client = new HostClient(meta.socket, `vscode:${vscode.env.machineId.slice(0, 8)}`, () => this.meta?.status !== "stopped" && !this.disposed);
		this.client = client;
		this.clientSubs.push(
			client.onMessage(m => this.onHostMessage(m)),
			client.onConnection(connected => this.post({ type: "connection", connected })),
		);
	}

	private lastStatus: SessionMeta["status"] | undefined;
	private onSessionsChanged(): void {
		const meta = this.meta;
		if (!meta) return;
		this.updateTitle();
		if (this.lastStatus === "stopped" && meta.status !== "stopped") this.attach();
		else if (meta.status === "stopped" && this.lastStatus !== "stopped" && this.lastStatus !== undefined) {
			this.post({ type: "meta", meta });
		}
		this.lastStatus = meta.status;
	}

	private updateTitle(): void {
		const meta = this.meta;
		if (!meta) return;
		const mark = meta.status === "working" ? "● " : meta.status === "waiting" ? "◆ " : "";
		this.panel.title = `${mark}${meta.title}`;
	}

	private indexEdits(messages: unknown[]): void {
		for (const m of messages) {
			const r = rec(m);
			if (r?.role !== "toolResult" || typeof r.toolCallId !== "string") continue;
			const d = rec(r.details);
			if (!d) continue;
			const files: Array<{ path: string; oldText: string; newText: string }> = [];
			const add = (x: Record<string, unknown> | undefined) => {
				if (x && typeof x.path === "string" && typeof x.oldText === "string" && typeof x.newText === "string") files.push({ path: x.path, oldText: x.oldText, newText: x.newText });
			};
			add(d);
			if (Array.isArray(d.perFileResults)) for (const f of d.perFileResults) add(rec(f));
			if (files.length) this.editTexts.set(r.toolCallId, files);
		}
	}

	private onHostMessage(m: HostToClient): void {
		switch (m.t) {
			case "snapshot":
				this.snapshot = m;
				this.state = (m.state as SlimState) ?? null;
				this.changes = [...m.changes];
				this.indexEdits(m.messages);
				this.sendInit();
				return;
			case "event": {
				if (m.ev.type === "message_end") this.indexEdits([m.ev.message]);
				const ev = slimFrame(m.ev);
				if (ev) this.post({ type: "event", ev });
				if (m.ev.type === "available_commands_update" && this.snapshot) {
					this.snapshot.commands = (m.ev.commands as unknown[]) ?? [];
				}
				return;
			}
			case "state":
				this.state = (m.state as SlimState) ?? null;
				this.post({ type: "state", state: this.state });
				return;
			case "meta":
				this.post({ type: "meta", meta: m.meta });
				return;
			case "change":
				this.changes.push(m.change);
				this.post({ type: "change", change: m.change });
				return;
			case "ui_resolved":
				this.post({ type: "uiResolved", id: m.id });
				return;
			case "reset":
				this.state = (m.state as SlimState) ?? null;
				this.indexEdits(m.messages);
				this.post({ type: "reset", messages: m.messages.map(x => slimMessage(x)), state: this.state });
				return;
			case "response":
				return;
		}
	}

	private sendInit(): void {
		if (!this.webviewReady) return;
		const meta = this.meta;
		if (!meta) return;
		const snap = this.snapshot;
		let messages: unknown[];
		if (snap) messages = snap.messages;
		else {
			messages = readTranscript(meta.ompSessionFile);
			this.changes = this.sessions.changes(this.sessionId);
			this.indexEdits(messages);
		}
		this.outbox = [];
		this.post({
			type: "init",
			meta: snap?.meta ?? meta,
			messages: messages.map(x => slimMessage(x)),
			inflight: snap?.inflight ? { messageId: snap.inflight.messageId, message: slimMessage(snap.inflight.message, true) } : null,
			runningTools: (snap?.runningTools ?? []).map(slimRunningTool),
			pendingUi: snap?.pendingUi ?? [],
			state: this.state,
			commands: (snap?.commands ?? []) as SlashCommand[],
			changes: this.changes,
			connected: !!this.client?.connected,
			home: os.homedir(),
		});
	}

	insertText(text: string): void {
		this.post({ type: "insertText", text });
	}

	focusComposer(): void {
		this.post({ type: "focusComposer" });
	}

	private resolveCandidate(candidate: string): string | undefined {
		const cwd = this.meta?.cwd ?? os.homedir();
		const expanded = candidate.startsWith("~/") ? path.join(os.homedir(), candidate.slice(2)) : candidate;
		const abs = path.resolve(cwd, expanded);
		return fs.existsSync(abs) ? abs : undefined;
	}

	private async onWebviewMessage(m: FromWebview): Promise<void> {
		const client = this.client;
		switch (m.type) {
			case "ready":
				this.webviewReady = true;
				this.sendInit();
				return;
			case "prompt": {
				if (!client) {
					this.post({ type: "error", message: "Session is not running. Resume it first." });
					return;
				}
				const busy = !!this.state?.isStreaming;
				const behavior = vscode.workspace.getConfiguration("omp").get<string>("sendWhileBusy") ?? "steer";
				const res = await client.rpc({ type: "prompt", message: m.text, ...(busy ? { streamingBehavior: behavior } : {}) });
				if (!res.success) this.post({ type: "error", message: String(res.error ?? "prompt failed") });
				return;
			}
			case "abort":
				await client?.rpc({ type: "abort" });
				return;
			case "uiResponse":
				client?.write({ t: "ui_response", res: m.res });
				return;
			case "openFile": {
				const abs = this.resolveCandidate(m.path) ?? path.resolve(this.meta?.cwd ?? "", m.path);
				await openFile(abs, m.line, m.column, this.panel.viewColumn);
				return;
			}
			case "openDiff":
				await this.openDiff(m.toolCallId, m.path);
				return;
			case "resolvePaths": {
				const resolved: Record<string, string> = {};
				for (const c of m.candidates.slice(0, 500)) {
					const abs = this.resolveCandidate(c);
					if (abs) resolved[c] = abs;
				}
				this.post({ type: "pathsResolved", reqId: m.reqId, resolved });
				return;
			}
			case "suggestFiles": {
				const cwd = this.meta?.cwd;
				if (!cwd) return;
				const q = m.query.replace(/[[\]{}*?!]/g, "");
				const found = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(cwd), `**/*${q}*`), "**/{node_modules,.git,dist,out,build,__pycache__,.venv}/**", 40);
				const files = found.map(u => path.relative(cwd, u.fsPath)).sort((a, b) => a.length - b.length);
				this.post({ type: "fileSuggestions", reqId: m.reqId, files });
				return;
			}
			case "getModels": {
				if (!client) return;
				const [models, levels] = await Promise.all([client.rpc({ type: "get_available_models" }), client.rpc({ type: "get_available_thinking_levels" })]);
				const list = Array.isArray(rec(models.data)?.models) ? (rec(models.data)?.models as unknown[]) : [];
				const lv = rec(levels.data)?.levels;
				this.post({
					type: "models",
					models: list.map(x => rec(x) ?? {}).map(x => ({ provider: String(x.provider), id: String(x.id), name: typeof x.name === "string" ? x.name : undefined })),
					levels: Array.isArray(lv) ? lv.map(String) : [],
				});
				return;
			}
			case "setModel": {
				const res = await client?.rpc({ type: "set_model", provider: m.provider, modelId: m.id });
				if (res && !res.success) this.post({ type: "error", message: String(res.error) });
				return;
			}
			case "setThinking": {
				const res = await client?.rpc({ type: "set_thinking_level", level: m.level });
				if (res && !res.success) this.post({ type: "error", message: String(res.error) });
				return;
			}
			case "removeQueued":
				await client?.rpc({ type: "remove_queued_message", message: m.text, queue: m.queue });
				return;
			case "openUrl":
				await vscode.env.openExternal(vscode.Uri.parse(m.url));
				return;
			case "command":
				await this.runCommand(m.name);
				return;
		}
	}

	private async runCommand(name: string): Promise<void> {
		const meta = this.meta;
		switch (name) {
			case "compact": {
				const res = await this.client?.rpc({ type: "compact" }, 15 * 60_000);
				if (res && !res.success) this.post({ type: "error", message: String(res.error) });
				return;
			}
			case "newSession":
				await vscode.commands.executeCommand("omp.newSession", meta?.cwd);
				return;
			case "stopSession":
				await vscode.commands.executeCommand("omp.stopSession", this.sessionId);
				return;
			case "resumeSession":
				await vscode.commands.executeCommand("omp.resumeSession", this.sessionId);
				return;
			case "rename":
				await vscode.commands.executeCommand("omp.renameSession", this.sessionId);
				return;
			case "sessionChanges":
				await vscode.commands.executeCommand("omp.showChanges", this.sessionId);
				return;
			case "openLog":
				await vscode.window.showTextDocument(vscode.Uri.file(path.join(sessionDir(this.sessionId), "host.log")));
				return;
		}
	}

	private async openDiff(toolCallId: string, file?: string): Promise<void> {
		const change = this.changes.find(c => c.toolCallId === toolCallId);
		if (change) {
			const target = file ? this.resolveCandidate(file) ?? file : undefined;
			const entry = change.files.find(f => f.path === target) ?? change.files.find(f => file && f.path.endsWith(file)) ?? change.files[0];
			await openToolDiff(this.snapshots, this.sessionId, change, entry.path, this.panel.viewColumn);
			return;
		}
		const texts = this.editTexts.get(toolCallId);
		const t = texts?.find(x => !file || x.path === file || x.path.endsWith(file)) ?? texts?.[0];
		if (t) {
			await openTextDiff(this.snapshots, t.path, t.oldText, t.newText, `${path.basename(t.path)} (omp edit)`, this.panel.viewColumn);
			return;
		}
		if (file) {
			const abs = this.resolveCandidate(file);
			if (abs) await openFile(abs, undefined, undefined, this.panel.viewColumn);
		}
	}

	private html(): string {
		const webview = this.panel.webview;
		const nonce = crypto.randomBytes(16).toString("base64");
		const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "webview.js"));
		const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "webview.css"));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>omp</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.flushTimer);
		for (const d of this.clientSubs) d.dispose();
		for (const d of this.subs) d.dispose();
		this.client?.dispose();
		this.panel.dispose();
		this.disposeEmitter.fire();
		this.disposeEmitter.dispose();
	}
}
