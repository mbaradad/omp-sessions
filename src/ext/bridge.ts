// VS Code side of the omp bridge: serves this window's language features (read-only) to the
// per-session MCP server (`out/mcp.js`, see src/shared/bridge.ts), resolves chat symbol links, and
// implements `omp.bridgeStatus`.
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import { cleanHover, formatResult, relPath } from "../bridge/format";
import {
	BRIDGE_VERSION,
	type BCall,
	type BDiag,
	type BLoc,
	type BridgeEntry,
	type BSignature,
	type BSym,
	bridgeDisabledFlag,
	bridgeRoot,
	bridgeSocketPath,
	ensureBridgeRoot,
	isInside,
	isRecord,
	isToolName,
	LIMITS,
	readRegistry,
	splitSymbol,
	TOOL_NAMES,
	type ToolArgs,
	type ToolName,
	type ToolResult,
	validateArgs,
} from "../shared/bridge";
import { pidAlive } from "../shared/launch";
import { ompExtensionDir } from "../shared/omp-extension-install";
import type { OmpApi } from "./api";
import { openFile } from "./diff";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

function enabled(): boolean {
	return vscode.workspace.getConfiguration("omp").get<boolean>("vscodeTools") ?? true;
}

// ---------- conversions ----------

function kindName(kind: vscode.SymbolKind): string {
	return (vscode.SymbolKind[kind] ?? "symbol").toLowerCase();
}

/** Lines of files, from open documents or disk, memoized for one tool call. */
class LineReader {
	private readonly cache = new Map<string, string[] | null>();
	line(uri: vscode.Uri, line: number): string | undefined {
		const key = uri.toString();
		let lines = this.cache.get(key);
		if (lines === undefined) {
			lines = null;
			const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
			if (doc) lines = doc.getText().split(/\r?\n/);
			else if (uri.scheme === "file" && this.cache.size < 200) {
				try {
					if (fs.statSync(uri.fsPath).size <= 4 * 1024 * 1024) lines = fs.readFileSync(uri.fsPath, "utf8").split(/\r?\n/);
				} catch {
					lines = null;
				}
			}
			this.cache.set(key, lines);
		}
		const text = lines?.[line]?.trim();
		return text ? (text.length > LIMITS.previewChars ? `${text.slice(0, LIMITS.previewChars - 1)}…` : text) : undefined;
	}
}

function uriPath(uri: vscode.Uri): string {
	return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

function toLoc(uri: vscode.Uri, range: vscode.Range | vscode.Position, lines?: LineReader): BLoc {
	const start = range instanceof vscode.Position ? range : range.start;
	const loc: BLoc = { path: uriPath(uri), line: start.line + 1, col: start.character + 1 };
	if (range instanceof vscode.Range && !range.isEmpty) {
		loc.endLine = range.end.line + 1;
		loc.endCol = range.end.character + 1;
	}
	const text = lines?.line(uri, start.line);
	if (text) loc.text = text;
	return loc;
}

function asLocation(l: vscode.Location | vscode.LocationLink): vscode.Location {
	return l instanceof vscode.Location ? l : new vscode.Location(l.targetUri, l.targetSelectionRange ?? l.targetRange);
}

function markdownOf(c: vscode.MarkdownString | vscode.MarkedString): string {
	if (typeof c === "string") return c;
	if (c instanceof vscode.MarkdownString) return c.value;
	return `\`\`\`${c.language}\n${c.value}\n\`\`\``;
}

function docText(d: string | vscode.MarkdownString | undefined): string | undefined {
	if (d === undefined) return undefined;
	return typeof d === "string" ? d : d.value;
}

function wordRegex(name: string): RegExp {
	return new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "g");
}

/** Strips signature/qualifier decorations some servers put into symbol names (`bar()`, `Foo.bar`). */
function baseName(name: string): string {
	return splitSymbol(name).name;
}

// ---------- documents and targets ----------

async function openDoc(file: string): Promise<vscode.TextDocument> {
	const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === "file" && d.uri.fsPath === file);
	if (open) return open;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		throw new Error(`file not found: ${file}`);
	}
	if (!stat.isFile()) throw new Error(`not a file: ${file}`);
	if (stat.size > MAX_FILE_BYTES) throw new Error(`file too large for language features: ${file}`);
	return vscode.workspace.openTextDocument(vscode.Uri.file(file));
}

function flattenDocSymbols(items: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): Array<{ name: string; container?: string; pos: vscode.Position }> {
	const out: Array<{ name: string; container?: string; pos: vscode.Position }> = [];
	const visit = (s: vscode.DocumentSymbol | vscode.SymbolInformation, container?: string) => {
		if (s instanceof vscode.SymbolInformation) {
			out.push({ name: baseName(s.name), container: s.containerName || container, pos: s.location.range.start });
			return;
		}
		out.push({ name: baseName(s.name), container, pos: s.selectionRange.start });
		for (const c of s.children ?? []) visit(c, s.name);
	};
	for (const s of items) visit(s);
	return out;
}

async function docSymbols(doc: vscode.TextDocument): Promise<Array<vscode.DocumentSymbol | vscode.SymbolInformation>> {
	return (await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>("vscode.executeDocumentSymbolProvider", doc.uri)) ?? [];
}

/** Position of `name` in `doc`: a declared symbol (qualifier-aware) first, else its first word occurrence. */
async function findInDoc(doc: vscode.TextDocument, symbol: string): Promise<vscode.Position | undefined> {
	const { name, qualifier } = splitSymbol(symbol);
	const decls = flattenDocSymbols(await docSymbols(doc)).filter(s => s.name === name);
	const best = decls.find(s => qualifier && s.container && baseName(s.container) === baseName(qualifier)) ?? decls[0];
	if (best) return best.pos;
	const m = wordRegex(name).exec(doc.getText());
	return m ? doc.positionAt(m.index) : undefined;
}

interface Ranked {
	info: vscode.SymbolInformation;
	score: number;
}

/** Workspace symbols named like `symbol`, best first (exact name, qualifier match, inside cwd). */
async function findWorkspaceSymbols(symbol: string, cwd: string | undefined): Promise<Ranked[]> {
	const { name, qualifier } = splitSymbol(symbol);
	if (!name) return [];
	const infos = (await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>("vscode.executeWorkspaceSymbolProvider", name)) ?? [];
	const ranked: Ranked[] = [];
	for (const info of infos) {
		const base = baseName(info.name);
		if (base.toLowerCase() !== name.toLowerCase()) continue;
		let score = base === name ? 100 : 60;
		if (qualifier && info.containerName && baseName(info.containerName) === baseName(qualifier)) score += 50;
		else if (qualifier && info.name.includes(qualifier)) score += 30;
		const file = info.location.uri.fsPath;
		if (cwd && info.location.uri.scheme === "file" && isInside(cwd, file)) score += 30;
		if (!/[\\/](node_modules|\.venv|site-packages|vendor|dist|out|build)[\\/]/.test(file)) score += 10;
		if ([vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Enum, vscode.SymbolKind.Struct].includes(info.kind)) score += 5;
		ranked.push({ info, score });
	}
	return ranked.sort((a, b) => b.score - a.score);
}

/** Opens a workspace symbol's file and finds the name inside its range (servers often give the whole declaration). */
async function locateSymbol(info: vscode.SymbolInformation): Promise<{ doc: vscode.TextDocument; pos: vscode.Position }> {
	const doc = await vscode.workspace.openTextDocument(info.location.uri);
	const range = info.location.range;
	const from = doc.offsetAt(range.start);
	const re = wordRegex(baseName(info.name));
	re.lastIndex = from;
	const m = re.exec(doc.getText());
	const pos = m && m.index <= doc.offsetAt(range.end) ? doc.positionAt(m.index) : range.start;
	return { doc, pos };
}

async function resolveTarget(a: ToolArgs, cwd: string): Promise<{ doc: vscode.TextDocument; pos: vscode.Position }> {
	if (a.path) {
		const doc = await openDoc(a.path);
		if (a.line) {
			const lineIdx = Math.min(a.line - 1, doc.lineCount - 1);
			const text = doc.lineAt(lineIdx).text;
			if (a.column) return { doc, pos: new vscode.Position(lineIdx, Math.min(a.column - 1, text.length)) };
			if (a.symbol) {
				const m = wordRegex(splitSymbol(a.symbol).name).exec(text);
				if (!m) throw new Error(`\`${a.symbol}\` does not occur on line ${a.line} of ${a.path}: ${text.trim().slice(0, 200)}`);
				return { doc, pos: new vscode.Position(lineIdx, m.index) };
			}
			return { doc, pos: new vscode.Position(lineIdx, doc.lineAt(lineIdx).firstNonWhitespaceCharacterIndex) };
		}
		if (a.symbol) {
			const pos = await findInDoc(doc, a.symbol);
			if (!pos) throw new Error(`\`${a.symbol}\` not found in ${a.path}`);
			return { doc, pos };
		}
		throw new Error("pass `line` or `symbol` together with `path`");
	}
	if (a.symbol) {
		const [best] = await findWorkspaceSymbols(a.symbol, cwd);
		if (best) return locateSymbol(best.info);
		throw new Error(`no workspace symbol named \`${a.symbol}\`; pass \`path\` of a file that uses it (library symbols are not indexed workspace-wide)`);
	}
	throw new Error("pass `symbol`, or `path` and `line`");
}

function toSym(name: string, kind: vscode.SymbolKind, uri: vscode.Uri, range: vscode.Range, container?: string, detail?: string): BSym {
	const s: BSym = { name, kind: kindName(kind), loc: toLoc(uri, range) };
	if (container) s.container = container;
	if (detail) s.detail = detail;
	return s;
}

async function waitForDiagnostics(uri: vscode.Uri, ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	const sub = vscode.languages.onDidChangeDiagnostics(e => {
		if (e.uris.some(u => u.toString() === uri.toString())) resolve();
	});
	await promise;
	clearTimeout(timer);
	sub.dispose();
}

const SEVERITY: Record<vscode.DiagnosticSeverity, BDiag["severity"]> = {
	[vscode.DiagnosticSeverity.Error]: "error",
	[vscode.DiagnosticSeverity.Warning]: "warning",
	[vscode.DiagnosticSeverity.Information]: "info",
	[vscode.DiagnosticSeverity.Hint]: "hint",
};
const SEVERITY_RANK: Record<BDiag["severity"], number> = { error: 0, warning: 1, info: 2, hint: 3 };

async function hoverAt(doc: vscode.TextDocument, pos: vscode.Position): Promise<string[]> {
	const hovers = (await vscode.commands.executeCommand<vscode.Hover[] | undefined>("vscode.executeHoverProvider", doc.uri, pos)) ?? [];
	return hovers.flatMap(h => h.contents.map(markdownOf)).filter(s => s.trim());
}

function signaturesOf(help: vscode.SignatureHelp | undefined): BSignature[] {
	return (help?.signatures ?? []).slice(0, 8).map(s => ({
		label: s.label,
		doc: docText(s.documentation),
		params: (s.parameters ?? []).map(p => ({ label: typeof p.label === "string" ? p.label : s.label.slice(p.label[0], p.label[1]), doc: docText(p.documentation) })),
	}));
}

// ---------- tools ----------

/** Runs one read-only tool in this window. `args` must come from `validateArgs`. */
export async function runTool(tool: ToolName, a: ToolArgs, cwd: string): Promise<ToolResult> {
	const limit = a.limit ?? LIMITS.defaultResults;
	switch (tool) {
		case "workspace_symbols": {
			const query = a.query ?? "";
			const infos = (await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>("vscode.executeWorkspaceSymbolProvider", query)) ?? [];
			const q = query.toLowerCase();
			const rank = (i: vscode.SymbolInformation) => {
				const n = baseName(i.name).toLowerCase();
				return (n === q ? 0 : n.startsWith(q) ? 1 : 2) + (i.location.uri.scheme === "file" && isInside(cwd, i.location.uri.fsPath) ? 0 : 3);
			};
			const sorted = [...infos].sort((x, y) => rank(x) - rank(y));
			return { kind: "symbols", query, total: sorted.length, symbols: sorted.slice(0, limit).map(i => toSym(i.name, i.kind, i.location.uri, i.location.range, i.containerName)) };
		}
		case "document_symbols": {
			const doc = await openDoc(a.path ?? "");
			const items = await docSymbols(doc);
			const maxDepth = a.depth ?? 3;
			let count = 0;
			let total = 0;
			const conv = (s: vscode.DocumentSymbol | vscode.SymbolInformation, depth: number): BSym | undefined => {
				total++;
				if (count >= LIMITS.outlineEntries) return undefined;
				count++;
				if (s instanceof vscode.SymbolInformation) return toSym(s.name, s.kind, s.location.uri, s.location.range);
				const sym = toSym(s.name, s.kind, doc.uri, s.selectionRange, undefined, s.detail);
				if (depth < maxDepth && s.children?.length) sym.children = s.children.flatMap(c => conv(c, depth + 1) ?? []);
				else if (s.children?.length) total += s.children.length;
				return sym;
			};
			const symbols = items.flatMap(s => conv(s, 1) ?? []);
			return { kind: "outline", path: uriPath(doc.uri), symbols, total };
		}
		case "definition":
		case "type_definition":
		case "implementations":
		case "references": {
			const { doc, pos } = await resolveTarget(a, cwd);
			const command = {
				definition: "vscode.executeDefinitionProvider",
				type_definition: "vscode.executeTypeDefinitionProvider",
				implementations: "vscode.executeImplementationProvider",
				references: "vscode.executeReferenceProvider",
			}[tool];
			const raw = (await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(command, doc.uri, pos)) ?? [];
			const locs = raw.map(asLocation).sort((x, y) => uriPath(x.uri).localeCompare(uriPath(y.uri)) || x.range.start.line - y.range.start.line);
			const lines = new LineReader();
			const what = { definition: "Definition", type_definition: "Type definition", implementations: "Implementations", references: "References" }[tool];
			return { kind: "locations", what, target: toLoc(doc.uri, pos, lines), total: locs.length, locations: locs.slice(0, limit).map(l => toLoc(l.uri, l.range, lines)) };
		}
		case "hover": {
			const { doc, pos } = await resolveTarget(a, cwd);
			return { kind: "hover", target: toLoc(doc.uri, pos, new LineReader()), contents: await hoverAt(doc, pos) };
		}
		case "signature_help": {
			const t = await resolveTarget(a, cwd);
			let pos = t.pos;
			if (a.symbol && !a.column) {
				// From a function name, move inside its call parentheses when they follow on the line.
				const text = t.doc.lineAt(pos.line).text;
				const open = /^[\w$.]*\s*(?:<[^>]*>)?\s*\(/.exec(text.slice(pos.character));
				if (open) pos = pos.translate(0, open[0].length);
			}
			const help = await vscode.commands.executeCommand<vscode.SignatureHelp | undefined>("vscode.executeSignatureHelpProvider", t.doc.uri, pos, "(");
			return { kind: "signature", target: toLoc(t.doc.uri, pos, new LineReader()), signatures: signaturesOf(help), activeSignature: help?.activeSignature ?? 0, activeParameter: help?.activeParameter ?? 0 };
		}
		case "call_hierarchy": {
			const { doc, pos } = await resolveTarget(a, cwd);
			const direction = a.direction ?? "incoming";
			const items = ((await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>("vscode.prepareCallHierarchy", doc.uri, pos)) ?? []).slice(0, 3);
			let total = 0;
			const out: Array<{ sym: BSym; incoming?: BCall[]; outgoing?: BCall[] }> = [];
			for (const item of items) {
				const entry: { sym: BSym; incoming?: BCall[]; outgoing?: BCall[] } = { sym: toSym(item.name, item.kind, item.uri, item.selectionRange, undefined, item.detail) };
				if (direction !== "outgoing") {
					const calls = (await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | undefined>("vscode.provideIncomingCalls", item)) ?? [];
					total += calls.length;
					entry.incoming = calls.slice(0, limit).map(c => ({ sym: toSym(c.from.name, c.from.kind, c.from.uri, c.from.selectionRange, undefined, c.from.detail), at: c.fromRanges.map(r => toLoc(c.from.uri, r)) }));
				}
				if (direction !== "incoming") {
					const calls = (await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[] | undefined>("vscode.provideOutgoingCalls", item)) ?? [];
					total += calls.length;
					entry.outgoing = calls.slice(0, limit).map(c => ({ sym: toSym(c.to.name, c.to.kind, c.to.uri, c.to.selectionRange, undefined, c.to.detail), at: c.fromRanges.map(r => toLoc(item.uri, r)) }));
				}
				out.push(entry);
			}
			return { kind: "calls", target: toLoc(doc.uri, pos), items: out, total };
		}
		case "diagnostics": {
			const min = SEVERITY_RANK[a.severity ?? "warning"];
			let pairs: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
			if (a.path) {
				const wasOpen = vscode.workspace.textDocuments.some(d => d.uri.scheme === "file" && d.uri.fsPath === a.path);
				const doc = await openDoc(a.path);
				// Language servers analyse a file only once it is open; give them a moment.
				if (!wasOpen && vscode.languages.getDiagnostics(doc.uri).length === 0) await waitForDiagnostics(doc.uri, 3000);
				pairs = [[doc.uri, vscode.languages.getDiagnostics(doc.uri)]];
			} else pairs = vscode.languages.getDiagnostics().filter(([u]) => u.scheme === "file" && isInside(cwd, u.fsPath));
			const all: BDiag[] = [];
			for (const [uri, diags] of pairs) {
				for (const d of diags) {
					const severity = SEVERITY[d.severity];
					if (SEVERITY_RANK[severity] > min) continue;
					const item: BDiag = { loc: toLoc(uri, d.range), severity, message: d.message };
					if (d.source) item.source = d.source;
					const code = typeof d.code === "object" ? d.code.value : d.code;
					if (code !== undefined) item.code = String(code);
					all.push(item);
				}
			}
			all.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || x.loc.path.localeCompare(y.loc.path) || x.loc.line - y.loc.line);
			return { kind: "diagnostics", scope: a.path ?? cwd, total: all.length, items: all.slice(0, limit) };
		}
		case "editor_context": {
			const ed = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
			const open = vscode.window.tabGroups.all
				.flatMap(g => g.tabs)
				.flatMap(t => (t.input instanceof vscode.TabInputText && t.input.uri.scheme === "file" ? [{ uri: t.input.uri, dirty: t.isDirty, active: t.isActive && t.group.isActive }] : []))
				.slice(0, 60)
				.map(t => ({ path: t.uri.fsPath, dirty: t.dirty, active: t.active, languageId: vscode.workspace.textDocuments.find(d => d.uri.toString() === t.uri.toString())?.languageId ?? path.extname(t.uri.fsPath).slice(1) }));
			if (!ed) return { kind: "editor", open };
			const doc = ed.document;
			const selected = doc.getText(ed.selection);
			const visible = ed.visibleRanges[0];
			return {
				kind: "editor",
				open,
				active: {
					path: uriPath(doc.uri),
					languageId: doc.languageId,
					dirty: doc.isDirty,
					selections: ed.selections.slice(0, 10).map(s => ({ start: toLoc(doc.uri, s.start), end: toLoc(doc.uri, s.end) })),
					...(selected ? { selectedText: selected.length > LIMITS.selectionChars ? `${selected.slice(0, LIMITS.selectionChars)}\n…` : selected } : {}),
					...(visible ? { visible: { from: visible.start.line + 1, to: visible.end.line + 1 } } : {}),
				},
			};
		}
		case "symbol_docs": {
			const symbol = a.symbol ?? "";
			let target: { doc: vscode.TextDocument; pos: vscode.Position } | undefined;
			let definition: BSym | undefined;
			if (a.path) {
				const doc = await openDoc(a.path);
				const pos = await findInDoc(doc, symbol);
				if (!pos) throw new Error(`\`${symbol}\` not found in ${a.path}`);
				target = { doc, pos };
				const defs = (await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>("vscode.executeDefinitionProvider", doc.uri, pos)) ?? [];
				const def = defs[0] ? asLocation(defs[0]) : undefined;
				if (def) definition = { name: symbol, kind: "definition", loc: toLoc(def.uri, def.range) };
			} else {
				const [best] = await findWorkspaceSymbols(symbol, cwd);
				if (best) {
					target = await locateSymbol(best.info);
					definition = toSym(best.info.name, best.info.kind, best.info.location.uri, new vscode.Range(target.pos, target.pos), best.info.containerName);
				} else {
					// Library symbols are rarely indexed workspace-wide; try a use in an open document.
					const { name } = splitSymbol(symbol);
					for (const doc of vscode.workspace.textDocuments) {
						if (doc.uri.scheme !== "file") continue;
						const m = wordRegex(name).exec(doc.getText());
						if (m) {
							target = { doc, pos: doc.positionAt(m.index) };
							break;
						}
					}
				}
			}
			if (!target) throw new Error(`no symbol named \`${symbol}\` in the workspace or open files; pass \`path\` of a file that uses it`);
			return { kind: "docs", symbol, definition, contents: await hoverAt(target.doc, target.pos) };
		}
	}
}

// ---------- socket server ----------

class BridgeServer implements vscode.Disposable {
	private server: net.Server | undefined;
	private entry: BridgeEntry | undefined;
	private readonly sockets = new Set<net.Socket>();
	private writeTimer: NodeJS.Timeout | undefined;
	lastError: string | undefined;

	get running(): BridgeEntry | undefined {
		return this.server ? this.entry : undefined;
	}

	get clients(): number {
		return this.sockets.size;
	}

	private get entryFile(): string {
		return path.join(bridgeRoot(), `${process.pid}.json`);
	}

	async start(): Promise<void> {
		if (this.server) return;
		this.lastError = undefined;
		try {
			ensureBridgeRoot();
			sweepStale();
			const socket = bridgeSocketPath(process.pid);
			if (process.platform !== "win32") fs.rmSync(socket, { force: true });
			const server = net.createServer(sock => this.accept(sock));
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.once("error", reject);
			server.listen(socket, () => resolve());
			await promise;
			server.on("error", err => console.warn("[omp bridge]", err));
			if (process.platform !== "win32") fs.chmodSync(socket, 0o600);
			this.server = server;
			const now = Date.now();
			this.entry = { version: BRIDGE_VERSION, pid: process.pid, socket, token: crypto.randomBytes(24).toString("hex"), folders: [], name: "", startedAt: now, focusedAt: vscode.window.state.focused ? now : 0 };
			this.writeEntry();
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
			console.warn("[omp bridge] could not start:", err);
			this.stop();
		}
	}

	/** Rewrites the registry file (folders / focus changed); debounced when `soon`. */
	writeEntry(soon = false): void {
		if (soon) {
			clearTimeout(this.writeTimer);
			this.writeTimer = setTimeout(() => this.writeEntry(), 300);
			return;
		}
		const e = this.entry;
		if (!e || !this.server) return;
		e.folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === "file").map(f => f.uri.fsPath);
		e.name = vscode.workspace.name ?? "(no folder)";
		const tmp = `${this.entryFile}.${crypto.randomBytes(4).toString("hex")}.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 });
			fs.renameSync(tmp, this.entryFile);
		} catch (err) {
			console.warn("[omp bridge] registry write failed:", err);
			fs.rmSync(tmp, { force: true });
		}
	}

	focused(): void {
		if (!this.entry) return;
		this.entry.focusedAt = Date.now();
		this.writeEntry(true);
	}

	private accept(sock: net.Socket): void {
		this.sockets.add(sock);
		sock.on("close", () => this.sockets.delete(sock));
		sock.on("error", () => sock.destroy());
		sock.setEncoding("utf8");
		let authed = false;
		let buf = "";
		const reply = (id: unknown, body: { result: unknown } | { error: string }) => {
			if (!sock.destroyed) sock.write(`${JSON.stringify({ id, ...body })}\n`);
		};
		sock.on("data", (d: string) => {
			buf += d;
			if (buf.length > MAX_LINE_BYTES) {
				sock.destroy();
				return;
			}
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				let msg: unknown;
				try {
					msg = JSON.parse(line);
				} catch {
					sock.destroy();
					return;
				}
				if (!isRecord(msg) || typeof msg.id !== "number" || !isRecord(msg.params)) {
					sock.destroy();
					return;
				}
				const { id, method, params } = msg;
				if (!authed) {
					const token = Buffer.from(typeof params.token === "string" ? params.token : "");
					const expected = Buffer.from(this.entry?.token ?? "");
					if (method !== "hello" || token.length !== expected.length || !crypto.timingSafeEqual(token, expected)) {
						sock.destroy();
						return;
					}
					authed = true;
					reply(id, { result: { name: this.entry?.name, folders: this.entry?.folders } });
					continue;
				}
				if (method !== "call" || !isToolName(params.tool) || typeof params.cwd !== "string" || !path.isAbsolute(params.cwd)) {
					reply(id, { error: "bad request" });
					continue;
				}
				const tool = params.tool;
				const cwd = params.cwd;
				let args: ToolArgs;
				try {
					args = validateArgs(tool, params.args, cwd);
				} catch (err) {
					reply(id, { error: err instanceof Error ? err.message : String(err) });
					continue;
				}
				runTool(tool, args, cwd).then(
					result => reply(id, { result }),
					err => reply(id, { error: err instanceof Error ? err.message : String(err) }),
				);
			}
		});
	}

	stop(): void {
		clearTimeout(this.writeTimer);
		for (const s of this.sockets) s.destroy();
		this.sockets.clear();
		this.server?.close();
		const socket = this.entry?.socket;
		if (this.server && socket && process.platform !== "win32") fs.rmSync(socket, { force: true });
		if (this.server) fs.rmSync(this.entryFile, { force: true });
		this.server = undefined;
		this.entry = undefined;
	}

	dispose(): void {
		this.stop();
	}
}

/** Removes registry entries (and their sockets) left behind by crashed windows. */
function sweepStale(): void {
	const dir = bridgeRoot();
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const f of files) {
		const m = /^(\d+)\.json$/.exec(f);
		if (!m || pidAlive(Number(m[1]))) continue;
		const stale = readRegistry(dir).find(e => e.pid === Number(m[1]));
		if (stale && process.platform !== "win32" && stale.socket.endsWith(".sock")) fs.rmSync(stale.socket, { force: true });
		fs.rmSync(path.join(dir, f), { force: true });
	}
}

function syncDisabledFlag(on: boolean): void {
	try {
		if (on) fs.rmSync(bridgeDisabledFlag(), { force: true });
		else {
			ensureBridgeRoot();
			fs.writeFileSync(bridgeDisabledFlag(), "omp.vscodeTools is off\n", { mode: 0o600 });
		}
	} catch (err) {
		console.warn("[omp bridge] could not update the disabled flag:", err);
	}
}

// ---------- chat symbol links ----------

export interface ChatSymbolInfo {
	found: boolean;
	/** Display location, relative to the session cwd. */
	location?: string;
	kind?: string;
	/** Cleaned hover markdown (signature + docs), capped. */
	hover?: string;
}

const symbolCache = new Map<string, { at: number; value: Promise<ChatSymbolInfo> }>();

async function computeSymbolInfo(name: string, cwd: string | undefined): Promise<ChatSymbolInfo> {
	const [best] = await findWorkspaceSymbols(name, cwd);
	if (!best || best.score < 100) return { found: false };
	const { doc, pos } = await locateSymbol(best.info);
	const hover = cleanHover((await hoverAt(doc, pos)).join("\n\n"), 1500);
	const file = uriPath(doc.uri);
	return { found: true, kind: kindName(best.info.kind), location: `${cwd ? relPath(file, cwd) : file}:${pos.line + 1}`, ...(hover ? { hover } : {}) };
}

/** Lazily resolves an inline-code identifier from the chat; cached for two minutes. */
export async function chatSymbolInfo(name: string, cwd: string | undefined): Promise<ChatSymbolInfo> {
	if (name.length > 200) return { found: false };
	const key = `${cwd ?? ""}\0${name}`;
	const hit = symbolCache.get(key);
	if (hit && Date.now() - hit.at < 120_000) return hit.value;
	if (symbolCache.size > 500) symbolCache.clear();
	const value = computeSymbolInfo(name, cwd).catch(() => ({ found: false }));
	symbolCache.set(key, { at: Date.now(), value });
	return value;
}

/** Click on a chat symbol: go to its definition (asks when several match equally well). */
export async function openChatSymbol(name: string, cwd: string | undefined, chatColumn?: vscode.ViewColumn): Promise<void> {
	const ranked = await findWorkspaceSymbols(name, cwd);
	const top = ranked.filter(r => r.score >= 100 && r.score === ranked[0]?.score);
	let pick = top[0];
	if (top.length > 1) {
		const chosen = await vscode.window.showQuickPick(
			top.slice(0, 30).map(r => ({
				label: r.info.name,
				description: r.info.containerName,
				detail: `${cwd && r.info.location.uri.scheme === "file" ? relPath(r.info.location.uri.fsPath, cwd) : uriPath(r.info.location.uri)}:${r.info.location.range.start.line + 1}`,
				r,
			})),
			{ placeHolder: `Go to definition of ${name}` },
		);
		if (!chosen) return;
		pick = chosen.r;
	}
	if (!pick) {
		void vscode.window.setStatusBarMessage(`$(search) No definition found for ${name}`, 3000);
		return;
	}
	const { doc, pos } = await locateSymbol(pick.info);
	if (doc.uri.scheme === "file") await openFile(doc.uri.fsPath, pos.line + 1, pos.character + 1, chatColumn);
	else await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
}

// ---------- status / self-test ----------

let server: BridgeServer | undefined;

function selfTestArgs(tool: ToolName, file: string, target: { name: string; line: number } | undefined): unknown {
	const at = target ? { path: file, line: target.line, symbol: target.name } : undefined;
	switch (tool) {
		case "workspace_symbols":
			return { query: target?.name ?? "a", limit: 5 };
		case "document_symbols":
			return { path: file, depth: 2 };
		case "diagnostics":
			return { path: file, limit: 5 };
		case "editor_context":
			return {};
		case "symbol_docs":
			return { symbol: target?.name ?? "", path: file };
		case "references":
		case "implementations":
		case "call_hierarchy":
			return { ...at, limit: 5 };
		default:
			return at;
	}
}

/** Spawns out/mcp.js like omp does and runs initialize, tools/list and one call through the socket. */
async function mcpRoundTrip(script: string, cwd: string, file: string): Promise<string> {
	const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OMP_VSCODE_BRIDGE_CWD: cwd }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const replies = new Map<number, (v: unknown) => void>();
	let buf = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (d: string) => {
		buf += d;
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			try {
				const msg: unknown = JSON.parse(line);
				if (isRecord(msg) && typeof msg.id === "number") replies.get(msg.id)?.(msg.result ?? msg.error);
			} catch {
				/* not ours */
			}
		}
	});
	const rpc = async (id: number, method: string, params: unknown) => {
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		replies.set(id, resolve);
		const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		try {
			return await promise;
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "omp-bridge-status", version: "1" } });
		const list = await rpc(2, "tools/list", {});
		const count = isRecord(list) && Array.isArray(list.tools) ? list.tools.length : 0;
		const call = await rpc(3, "tools/call", { name: "document_symbols", arguments: { path: file, depth: 1 } });
		const content = isRecord(call) && Array.isArray(call.content) && isRecord(call.content[0]) ? String(call.content[0].text ?? "") : JSON.stringify(call);
		const failed = isRecord(call) && call.isError === true;
		return `${failed ? "✗" : "✓"} MCP server: ${count} tools listed; document_symbols via socket:\n\n\`\`\`\n${content.split("\n").slice(0, 8).join("\n")}\n\`\`\``;
	} finally {
		child.kill();
	}
}

async function bridgeStatus(api: OmpApi): Promise<void> {
	const lines: string[] = ["# omp ↔ VS Code bridge", ""];
	const on = enabled();
	const running = server?.running;
	lines.push(`- Setting \`omp.vscodeTools\`: **${on ? "on" : "off"}**${on ? "" : " (sessions start without the VS Code tools)"}`);
	lines.push(`- This window: ${running ? `serving on \`${running.socket}\` (pid ${running.pid}, ${server?.clients ?? 0} MCP connection(s))` : `not serving${server?.lastError ? ` — ${server.lastError}` : ""}`}`);
	const script = vscode.Uri.joinPath(api.context.extensionUri, "out", "mcp.js").fsPath;
	lines.push(`- MCP server script: \`${script}\`${fs.existsSync(script) ? "" : " **(missing — rebuild the extension)**"}`);
	lines.push(`- omp extension: module \`bridge.js\` of the Switchyard package, installed into omp's agent folder at activation (\`${path.join(ompExtensionDir(), "bridge.js")}\`)${fs.existsSync(path.join(ompExtensionDir(), "bridge.js")) ? "" : " **(missing — reload the window)**"}`);
	lines.push("", "## Connected windows", "");
	const entries = readRegistry();
	if (!entries.length) lines.push("None.");
	for (const e of entries.sort((a, b) => b.focusedAt - a.focusedAt)) {
		const alive = pidAlive(e.pid);
		lines.push(`- **${e.name || "(no folder)"}** — pid ${e.pid}${e.pid === process.pid ? " (this window)" : ""}${alive ? "" : " — stale"}`);
		for (const f of e.folders) lines.push(`  - \`${f}\``);
	}
	const ed = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
	lines.push("", "## Self-test", "");
	if (!ed || ed.document.uri.scheme !== "file") lines.push("Open a source file and run this command again to test each tool on it.");
	else {
		const file = ed.document.uri.fsPath;
		const cwd = vscode.workspace.getWorkspaceFolder(ed.document.uri)?.uri.fsPath ?? path.dirname(file);
		const items = await docSymbols(ed.document);
		const flat = flattenDocSymbols(items);
		const decl = items.flatMap(function walk(s): Array<vscode.DocumentSymbol | vscode.SymbolInformation> {
			return s instanceof vscode.DocumentSymbol ? [s, ...s.children.flatMap(walk)] : [s];
		});
		const preferred = decl.find(s => [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class].includes(s.kind)) ?? decl[0];
		const target = preferred ? { name: baseName(preferred.name), line: (preferred instanceof vscode.DocumentSymbol ? preferred.selectionRange : preferred.location.range).start.line + 1 } : undefined;
		lines.push(`File \`${relPath(file, cwd)}\` (${ed.document.languageId}, ${flat.length} symbols)${target ? `, target \`${target.name}\` on line ${target.line}` : ""}.`, "");
		for (const tool of TOOL_NAMES) {
			const t0 = Date.now();
			try {
				const result = await runTool(tool, validateArgs(tool, selfTestArgs(tool, file, target), cwd), cwd);
				const text = formatResult(result, cwd);
				lines.push(`### ✓ ${tool} (${Date.now() - t0} ms)`, "", "```", ...text.split("\n").slice(0, 8), text.split("\n").length > 8 ? "…" : "", "```", "");
			} catch (err) {
				lines.push(`### ✗ ${tool} (${Date.now() - t0} ms)`, "", `${err instanceof Error ? err.message : String(err)}`, "");
			}
		}
		if (running && fs.existsSync(script)) {
			try {
				lines.push("## End-to-end", "", await mcpRoundTrip(script, cwd, file));
			} catch (err) {
				lines.push("## End-to-end", "", `✗ ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "markdown" });
	await vscode.window.showTextDocument(doc, { preview: true });
}

export function registerBridge(api: OmpApi): void {
	const srv = new BridgeServer();
	server = srv;
	const apply = () => {
		const on = enabled();
		syncDisabledFlag(on);
		if (on) void srv.start();
		else srv.stop();
	};
	apply();
	api.context.subscriptions.push(
		srv,
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("omp.vscodeTools")) apply();
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => srv.writeEntry(true)),
		vscode.window.onDidChangeWindowState(s => {
			if (s.focused) srv.focused();
		}),
		vscode.commands.registerCommand("omp.bridgeStatus", () => bridgeStatus(api)),
	);
}
