// `out/switchyard-bridge.js`: omp extension that gives every omp session the VS Code bridge tools
// (the same TOOL_DEFS `out/mcp.js` serves). Agent Orchestrator runs omp as `omp acp`, and ACP
// sessions ignore on-disk MCP config (their MCP servers come from the ACP client), so the tools
// are registered natively instead. The VS Code extension copies this file to
// `<omp agent dir>/extensions/switchyard-bridge/index.js` while `omp.vscodeTools` is on.
// Names stay `mcp__vscode_<tool>`, what omp called them when they came from the MCP server.
import * as fs from "node:fs";
import { bridgeDisabledFlag, MCP_SERVER_NAME, TOOL_DEFS } from "../shared/bridge";
import { BridgeCaller } from "./call";

/** The slice of omp's ExtensionAPI this extension uses. */
interface OmpExtensionApi {
	registerTool(def: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		approval?: "read" | "write" | "exec";
		mcpServerName?: string;
		mcpToolName?: string;
		mcpReadOnlyHint?: boolean;
		execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string } | undefined): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
	}): void;
	logger?: { warn(msg: string, ...rest: unknown[]): void };
}

export default function ompVscodeBridge(pi: OmpExtensionApi): void {
	if (fs.existsSync(bridgeDisabledFlag())) return;
	const callers = new Map<string, BridgeCaller>();
	const warn = (msg: string) => pi.logger?.warn(msg);
	for (const def of TOOL_DEFS) {
		pi.registerTool({
			name: `mcp__${MCP_SERVER_NAME}_${def.name}`,
			label: `VS Code: ${def.name.replace(/_/g, " ")}`,
			description: def.description,
			parameters: def.inputSchema,
			approval: "read",
			mcpServerName: MCP_SERVER_NAME,
			mcpToolName: def.name,
			mcpReadOnlyHint: true,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const cwd = ctx?.cwd || process.cwd();
				let caller = callers.get(cwd);
				if (!caller) {
					caller = new BridgeCaller(cwd, warn);
					callers.set(cwd, caller);
				}
				const r = await caller.call(def.name, params);
				// omp marks a tool result as failed when execute throws.
				if (r.isError) throw new Error(r.text);
				return { content: [{ type: "text", text: r.text }] };
			},
		});
	}
}
