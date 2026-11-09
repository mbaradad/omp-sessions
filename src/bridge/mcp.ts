// `out/mcp.js`: stdio MCP server exposing this machine's VS Code windows' language features to any
// MCP client. omp sessions get the same tools from the omp extension (src/omp-extension/bridge.ts), because
// `omp acp` (how Agent Orchestrator runs omp) ignores on-disk MCP config. It always answers
// initialize / tools/list; tools/call is forwarded to the VS Code window that has the cwd open, or
// fails with a clear "not connected" message.
import * as readline from "node:readline";
import { isRecord, MCP_INSTRUCTIONS, TOOL_DEFS } from "../shared/bridge";
import { BridgeCaller } from "./call";

const caller = new BridgeCaller(process.env.SWITCHYARD_BRIDGE_CWD || process.cwd());

function send(msg: unknown): void {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function callTool(params: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	const p = isRecord(params) ? params : {};
	const r = await caller.call(p.name, p.arguments);
	return { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) };
}

async function handle(msg: unknown): Promise<void> {
	if (!isRecord(msg) || typeof msg.method !== "string") return;
	const id = msg.id;
	if (id === undefined || id === null) return; // notification
	const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
	switch (msg.method) {
		case "initialize": {
			const requested = isRecord(msg.params) && typeof msg.params.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18";
			reply({ protocolVersion: requested, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "switchyard-vscode", version: "1" }, instructions: MCP_INSTRUCTIONS });
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
	caller.close();
	process.exit(0);
});
