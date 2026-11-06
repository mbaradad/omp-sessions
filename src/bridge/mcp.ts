// `out/mcp.js`: stdio MCP server that omp starts for each session (see bridgeOmpArgs). It always
// answers initialize / tools/list so omp starts normally; tools/call is forwarded to the VS Code
// window that has the session cwd open, or fails with a clear "not connected" message.
import * as readline from "node:readline";
import { isRecord, isToolName, MCP_INSTRUCTIONS, pickWindows, readRegistry, TOOL_DEFS, type ToolArgs, validateArgs } from "../shared/bridge";
import { pidAlive } from "../shared/launch";
import { BridgeConnection } from "./client";
import { formatResult } from "./format";

const cwd = process.env.OMP_VSCODE_BRIDGE_CWD || process.cwd();
const NOT_CONNECTED = `VS Code is not connected: no VS Code window with the omp extension (and \`omp.vscodeTools\` enabled) is open on this machine. Use omp's built-in tools (read, grep, find, lsp…) instead.`;

let conn: BridgeConnection | undefined;
let connMatched = false;

function send(msg: unknown): void {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** Reuses the current window connection unless a better-matching window is available. */
async function connection(): Promise<{ conn: BridgeConnection; matched: boolean } | undefined> {
	const choices = pickWindows(readRegistry(), cwd).filter(c => pidAlive(c.entry.pid));
	if (conn && !conn.closed && (connMatched || !choices.some(c => c.matched && c.entry.pid !== conn?.entry.pid))) return { conn, matched: connMatched };
	conn?.close();
	conn = undefined;
	for (const c of choices) {
		try {
			conn = await BridgeConnection.open(c.entry);
			connMatched = c.matched;
			return { conn, matched: c.matched };
		} catch (err) {
			process.stderr.write(`bridge: window ${c.entry.pid} unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}
	return undefined;
}

async function callTool(params: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });
	const p = isRecord(params) ? params : {};
	const name = isToolName(p.name) ? p.name : undefined;
	let args: ToolArgs;
	if (!name) {
		return text(`Unknown tool: ${p.name === undefined ? "(none)" : String(p.name)}`, true);
	}
	try {
		args = validateArgs(name, p.arguments, cwd);
	} catch (err) {
		return text(`Invalid arguments: ${err instanceof Error ? err.message : String(err)}`, true);
	}
	const c = await connection();
	if (!c) return text(NOT_CONNECTED, true);
	try {
		const result = await c.conn.call(name, args, cwd);
		const note = c.matched ? undefined : `(Note: no VS Code window has ${cwd} open; answering from window "${c.conn.entry.name}", so workspace-wide results may belong to another project.)`;
		return text(formatResult(result, cwd, note));
	} catch (err) {
		return text(`VS Code: ${err instanceof Error ? err.message : String(err)}`, true);
	}
}

async function handle(msg: unknown): Promise<void> {
	if (!isRecord(msg) || typeof msg.method !== "string") return;
	const id = msg.id;
	if (id === undefined || id === null) return; // notification
	const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
	switch (msg.method) {
		case "initialize": {
			const requested = isRecord(msg.params) && typeof msg.params.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18";
			reply({ protocolVersion: requested, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "omp-vscode", version: "1" }, instructions: MCP_INSTRUCTIONS });
			return;
		}
		case "ping":
			reply({});
			return;
		case "tools/list":
			reply({ tools: TOOL_DEFS });
			return;
		case "tools/call":
			reply(await callTool(msg.params));
			return;
		default:
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
	}
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on("line", line => {
	if (!line.trim()) return;
	let msg: unknown;
	try {
		msg = JSON.parse(line);
	} catch {
		send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		return;
	}
	for (const m of Array.isArray(msg) ? msg : [msg]) {
		handle(m).catch(err => process.stderr.write(`bridge: ${String(err)}\n`));
	}
});
rl.on("close", () => {
	conn?.close();
	process.exit(0);
});
