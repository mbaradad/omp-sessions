// VS Code bridge: lets omp sessions use VS Code's language features.
//   omp ──omp extension (out/omp-bridge.js)──┐
//   MCP client ──stdio MCP (out/mcp.js)──────┴──JSONL socket──> extension (one socket per VS Code window)
// Each window registers itself in `<stateRoot>/bridge/<pid>.json` (0600) next to its socket; the
// caller picks the window whose workspace folders contain the session cwd and authenticates
// with the per-window token from that file. Everything here is node-only and VS Code-free.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ompPaths } from "./omp-paths";
import { stateRoot } from "./protocol";
import { privateSocketDir } from "./server-protocol";

export const BRIDGE_VERSION = 1;
/** MCP server name; omp exposes the tools as `mcp__vscode_<tool>` (the omp extension keeps those names). */
export const MCP_SERVER_NAME = "vscode";

export function bridgeRoot(): string {
	return path.join(stateRoot(), "bridge");
}

/** Present while `omp.vscodeTools` is off: the omp extension then registers no tools. */
export function bridgeDisabledFlag(): string {
	return path.join(bridgeRoot(), "disabled");
}

export function ensureBridgeRoot(): string {
	const dir = bridgeRoot();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
	return dir;
}

/** Unix socket in the bridge dir (short tmp dir if that path is too long), named pipe on Windows. */
export function bridgeSocketPath(pid: number): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\omp-vscode-bridge-${pid}-${crypto.randomBytes(6).toString("hex")}`;
	const preferred = path.join(bridgeRoot(), `${pid}.sock`);
	if (Buffer.byteLength(preferred) < 100) return preferred;
	return path.join(privateSocketDir(), `b${pid}.sock`);
}

/** One VS Code window serving the bridge. */
export interface BridgeEntry {
	version: number;
	pid: number;
	socket: string;
	token: string;
	/** Absolute workspace folder paths of the window. */
	folders: string[];
	/** Window / workspace name, for status output. */
	name: string;
	startedAt: number;
	/** Last time the window had focus (epoch ms); breaks ties between windows. */
	focusedAt: number;
}

/** The bridge's one JSON-object guard (wire frames, tool args, registry files). */
export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseEntry(raw: unknown): BridgeEntry | undefined {
	if (!isRecord(raw)) return undefined;
	const { version, pid, socket, token, folders, name, startedAt, focusedAt } = raw;
	if (version !== BRIDGE_VERSION || typeof pid !== "number" || typeof socket !== "string" || typeof token !== "string") return undefined;
	if (!Array.isArray(folders) || !folders.every(f => typeof f === "string")) return undefined;
	return {
		version,
		pid,
		socket,
		token,
		folders,
		name: typeof name === "string" ? name : "",
		startedAt: typeof startedAt === "number" ? startedAt : 0,
		focusedAt: typeof focusedAt === "number" ? focusedAt : 0,
	};
}

export function readRegistry(dir = bridgeRoot()): BridgeEntry[] {
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f));
	} catch {
		return [];
	}
	const out: BridgeEntry[] = [];
	for (const f of files) {
		try {
			const e = parseEntry(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
			if (e) out.push(e);
		} catch {
			/* half-written or removed meanwhile */
		}
	}
	return out;
}

function norm(p: string): string {
	const r = path.resolve(p);
	return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
}

/** True when `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
	const rel = path.relative(norm(parent), norm(child));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface WindowChoice {
	entry: BridgeEntry;
	/** The window has the session cwd (or a parent of it) open as a workspace folder. */
	matched: boolean;
}

/**
 * Windows to try for a session in `cwd`, best first: windows with a folder containing cwd (deepest
 * folder wins, then most recently focused), then windows with a folder inside cwd, then the rest
 * by focus. Callers skip dead pids / refused connections and fall through to the next.
 */
export function pickWindows(entries: BridgeEntry[], cwd: string): WindowChoice[] {
	const scored = entries.map(entry => {
		let score = 0;
		for (const f of entry.folders) {
			if (isInside(f, cwd)) score = Math.max(score, 2_000_000 + norm(f).length);
			else if (isInside(cwd, f)) score = Math.max(score, 1_000_000);
		}
		return { entry, score };
	});
	scored.sort((a, b) => b.score - a.score || b.entry.focusedAt - a.entry.focusedAt);
	return scored.map(s => ({ entry: s.entry, matched: s.score > 0 }));
}

// ---------- omp side: the omp extension that registers the tools in every omp session ----------

/** Folder of the bridge's omp extension: `<omp agent dir>/extensions/omp-vscode-bridge`. */
export function bridgeExtensionDir(agentDir = ompPaths().agentDir): string {
	return path.join(agentDir, "extensions", "omp-vscode-bridge");
}

/**
 * Installs (or refreshes) the bundled omp extension `out/omp-bridge.js` as `index.js` of
 * {@link bridgeExtensionDir}, so omp sessions, including the `omp acp` ones Agent Orchestrator
 * runs (which ignore on-disk MCP config), get the VS Code tools. Rewrites only on change; true
 * when it wrote. omp loads extensions at startup: running sessions keep what they had.
 */
export function installBridgeExtension(bundle: string, dir = bridgeExtensionDir()): boolean {
	const code = fs.readFileSync(bundle, "utf8");
	const target = path.join(dir, "index.js");
	try {
		if (fs.readFileSync(target, "utf8") === code) return false;
	} catch {
		/* not installed yet */
	}
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(`${target}.tmp`, code);
	fs.renameSync(`${target}.tmp`, target);
	return true;
}

export function removeBridgeExtension(dir = bridgeExtensionDir()): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- wire protocol (MCP server <-> extension), JSONL ----------

export type BridgeRequest = { id: number; method: "hello"; params: { token: string } } | { id: number; method: "call"; params: { tool: ToolName; args: ToolArgs; cwd: string } };

export type BridgeResponse = { id: number; result: unknown } | { id: number; error: string };

export function parseResponse(raw: unknown): BridgeResponse | undefined {
	if (!isRecord(raw) || typeof raw.id !== "number") return undefined;
	if (typeof raw.error === "string") return { id: raw.id, error: raw.error };
	if ("result" in raw) return { id: raw.id, result: raw.result };
	return undefined;
}

// ---------- tools ----------

export const TOOL_NAMES = [
	"workspace_symbols",
	"document_symbols",
	"definition",
	"type_definition",
	"implementations",
	"references",
	"hover",
	"signature_help",
	"call_hierarchy",
	"diagnostics",
	"editor_context",
	"symbol_docs",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(v: unknown): v is ToolName {
	return typeof v === "string" && (TOOL_NAMES as readonly string[]).includes(v);
}

/** Validated tool arguments. Positions are 1-based; paths absolute after `validateArgs`. */
export interface ToolArgs {
	path?: string;
	line?: number;
	column?: number;
	symbol?: string;
	query?: string;
	limit?: number;
	depth?: number;
	direction?: "incoming" | "outgoing" | "both";
	severity?: "error" | "warning" | "info" | "hint";
}

export const LIMITS = { defaultResults: 50, maxResults: 300, outlineEntries: 400, hoverChars: 6000, previewChars: 200, selectionChars: 4000, outputChars: 24_000 } as const;

const TARGET_PROPS = {
	path: { type: "string", description: "File path (relative to the session cwd or absolute)." },
	line: { type: "integer", minimum: 1, description: "1-based line." },
	column: { type: "integer", minimum: 1, description: "1-based column. Optional: pass `symbol` instead and it is located on `line`." },
	symbol: {
		type: "string",
		description: "Identifier to target (`Foo`, `foo.bar`, `Type::method`). Located on `line` if given, else in `path`, else via workspace symbol search.",
	},
};

interface ToolDef {
	name: ToolName;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
}

const target = (description: string, name: ToolName, extra: Record<string, unknown> = {}): ToolDef => ({
	name,
	description: `${description} Target with path+line(+column or symbol), path+symbol, or just symbol.`,
	inputSchema: { type: "object", properties: { ...TARGET_PROPS, ...extra }, additionalProperties: false },
});

const limitProp = { limit: { type: "integer", minimum: 1, maximum: LIMITS.maxResults, description: `Max results (default ${LIMITS.defaultResults}).` } };

export const TOOL_DEFS: ToolDef[] = [
	{
		name: "workspace_symbols",
		description: "Search symbols (classes, functions, methods, variables…) across the workspace by name via VS Code's language servers. Returns kind, name, container and path:line:col.",
		inputSchema: { type: "object", properties: { query: { type: "string", description: "Symbol name or prefix (fuzzy)." }, ...limitProp }, required: ["query"], additionalProperties: false },
	},
	{
		name: "document_symbols",
		description: "Outline of a file: nested symbols with kinds and line numbers.",
		inputSchema: {
			type: "object",
			properties: { path: TARGET_PROPS.path, depth: { type: "integer", minimum: 1, maximum: 10, description: "Nesting depth (default 3)." } },
			required: ["path"],
			additionalProperties: false,
		},
	},
	target("Go to definition of a symbol (works across files and into dependencies).", "definition"),
	target("Go to the type definition of a symbol (the declaration of its type).", "type_definition"),
	target("Find implementations of an interface / abstract member.", "implementations", limitProp),
	target("Find all references to a symbol, with the source line of each.", "references", limitProp),
	target("Hover info for a symbol: its type signature and documentation (JSDoc/docstrings, also for library APIs).", "hover"),
	target("Signature help (parameters and their docs) for a call. Target a position inside the call's parentheses, or a function name.", "signature_help"),
	target("Call hierarchy of a function: who calls it (incoming) and what it calls (outgoing).", "call_hierarchy", {
		direction: { type: "string", enum: ["incoming", "outgoing", "both"], description: "Default incoming." },
		...limitProp,
	}),
	{
		name: "diagnostics",
		description: "Errors/warnings from VS Code's language servers and linters for a file, or for the whole workspace under the session cwd when `path` is omitted.",
		inputSchema: {
			type: "object",
			properties: { path: TARGET_PROPS.path, severity: { type: "string", enum: ["error", "warning", "info", "hint"], description: "Minimum severity (default warning)." }, ...limitProp },
			additionalProperties: false,
		},
	},
	{
		name: "editor_context",
		description: "What the user has open in VS Code: active file, cursor/selection (with selected text) and the open editors.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "symbol_docs",
		description: "Read the documentation for a symbol by name: its definition location, signature and doc comment. For library APIs pass `path` of a file that uses the symbol.",
		inputSchema: { type: "object", properties: { symbol: TARGET_PROPS.symbol, path: TARGET_PROPS.path }, required: ["symbol"], additionalProperties: false },
	},
];

export const MCP_INSTRUCTIONS =
	"Tools backed by the user's running VS Code (any language with an installed extension): semantic navigation (definition, references, implementations, call hierarchy), hover/symbol_docs for API documentation, diagnostics, and the user's open editors/selection. Positions are 1-based. Read-only. If they report that VS Code is not connected, fall back to your built-in tools.";

function int(v: unknown, name: string, min: number, max: number): number | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`\`${name}\` must be an integer between ${min} and ${max}`);
	return v;
}

function str(v: unknown, name: string, max: number): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string") throw new Error(`\`${name}\` must be a string`);
	const t = v.trim();
	if (!t) return undefined;
	if (t.length > max || t.includes("\0")) throw new Error(`\`${name}\` is too long or invalid`);
	return t;
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T | undefined {
	if (v === undefined || v === null) return undefined;
	const hit = allowed.find(a => a === v);
	if (!hit) throw new Error(`\`${name}\` must be one of ${allowed.join(", ")}`);
	return hit;
}

/**
 * Validates raw tool arguments (from the model or from the socket) and resolves `path` against
 * `cwd`. Throws an Error with a model-readable message on bad input.
 */
export function validateArgs(tool: ToolName, raw: unknown, cwd: string): ToolArgs {
	const r = raw === undefined || raw === null ? {} : raw;
	if (!isRecord(r)) throw new Error("arguments must be an object");
	const p = str(r.path, "path", 4096);
	const args: ToolArgs = {
		path: p ? path.resolve(cwd, p.replace(/^~(?=$|[\\/])/, os.homedir())) : undefined,
		line: int(r.line, "line", 1, 10_000_000),
		column: int(r.column, "column", 1, 100_000),
		symbol: str(r.symbol, "symbol", 300),
		query: str(r.query, "query", 300),
		limit: int(r.limit, "limit", 1, LIMITS.maxResults),
		depth: int(r.depth, "depth", 1, 10),
		direction: oneOf(r.direction, "direction", ["incoming", "outgoing", "both"] as const),
		severity: oneOf(r.severity, "severity", ["error", "warning", "info", "hint"] as const),
	};
	for (const k of Object.keys(args) as Array<keyof ToolArgs>) if (args[k] === undefined) delete args[k];
	if (tool === "workspace_symbols" && !args.query) throw new Error("`query` is required");
	if (tool === "document_symbols" && !args.path) throw new Error("`path` is required");
	if (tool === "symbol_docs" && !args.symbol) throw new Error("`symbol` is required");
	const needsTarget = !["workspace_symbols", "document_symbols", "diagnostics", "editor_context", "symbol_docs"].includes(tool);
	if (needsTarget && !args.symbol && !(args.path && args.line)) throw new Error("pass `symbol`, or `path` and `line` (with `column` or `symbol`)");
	return args;
}

/** `foo.bar()`, `Type::method`, `a->b`, `Foo#bar`, `Foo<T>` → { name: "bar", qualifier: "foo" }. */
export function splitSymbol(symbol: string): { name: string; qualifier?: string } {
	const clean = symbol
		.trim()
		.replace(/\(.*\)$/, "")
		.replace(/<[^<>]*>/g, "")
		.replace(/[!?]+$/, "");
	const parts = clean.split(/::|->|[.#\\]/).filter(Boolean);
	const name = parts.pop() ?? clean;
	return { name, qualifier: parts.length ? parts.join(".") : undefined };
}

// ---------- tool results (extension → MCP server); 1-based positions, absolute paths ----------

export interface BLoc {
	path: string;
	line: number;
	col: number;
	endLine?: number;
	endCol?: number;
	/** Source text of `line` (trimmed, capped). */
	text?: string;
}

export interface BSym {
	name: string;
	kind: string;
	detail?: string;
	container?: string;
	loc: BLoc;
	children?: BSym[];
}

export interface BDiag {
	loc: BLoc;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	source?: string;
	code?: string;
}

export interface BSignature {
	label: string;
	doc?: string;
	params: Array<{ label: string; doc?: string }>;
}

export interface BCall {
	sym: BSym;
	/** Call sites. */
	at: BLoc[];
}

export interface BEditor {
	path: string;
	languageId: string;
	dirty: boolean;
	active?: boolean;
}

export type ToolResult =
	| { kind: "locations"; what: string; target?: BLoc; locations: BLoc[]; total: number }
	| { kind: "symbols"; query: string; symbols: BSym[]; total: number }
	| { kind: "outline"; path: string; symbols: BSym[]; total: number }
	| { kind: "hover"; target: BLoc; contents: string[] }
	| { kind: "signature"; target: BLoc; signatures: BSignature[]; activeSignature: number; activeParameter: number }
	| { kind: "calls"; target: BLoc; items: Array<{ sym: BSym; incoming?: BCall[]; outgoing?: BCall[] }>; total: number }
	| { kind: "diagnostics"; scope: string; items: BDiag[]; total: number }
	| {
			kind: "editor";
			active?: BEditor & { selections: Array<{ start: BLoc; end: BLoc }>; selectedText?: string; visible?: { from: number; to: number } };
			open: BEditor[];
	  }
	| { kind: "docs"; symbol: string; definition?: BSym; contents: string[]; signatures?: BSignature[] };
