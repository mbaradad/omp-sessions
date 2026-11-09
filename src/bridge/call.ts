// One VS Code bridge tool call, shared by the stdio MCP server (`out/mcp.js`) and the omp
// extension (`out/switchyard-bridge.js`): picks the VS Code window that has `cwd` open, validates the
// arguments, forwards the call over that window's socket and formats the result as text.
import { isToolName, pickWindows, readRegistry, type ToolArgs, validateArgs } from "../shared/bridge";
import { pidAlive } from "../shared/launch";
import { BridgeConnection } from "./client";
import { formatResult } from "./format";

export const NOT_CONNECTED = `VS Code is not connected: no VS Code window with the omp extension (and \`omp.vscodeTools\` enabled) is open on this machine. Use omp's built-in tools (read, grep, find, lsp…) instead.`;

export interface CallOutcome {
	text: string;
	isError: boolean;
}

export class BridgeCaller {
	private conn: BridgeConnection | undefined;
	private connMatched = false;

	constructor(
		readonly cwd: string,
		private readonly warn: (msg: string) => void = msg => process.stderr.write(`${msg}\n`),
	) {}

	/** Reuses the current window connection unless a better-matching window is available. */
	private async connection(): Promise<{ conn: BridgeConnection; matched: boolean } | undefined> {
		const choices = pickWindows(readRegistry(), this.cwd).filter(c => pidAlive(c.entry.pid));
		const current = this.conn;
		if (current && !current.closed && (this.connMatched || !choices.some(c => c.matched && c.entry.pid !== current.entry.pid))) return { conn: current, matched: this.connMatched };
		current?.close();
		this.conn = undefined;
		for (const c of choices) {
			try {
				this.conn = await BridgeConnection.open(c.entry);
				this.connMatched = c.matched;
				return { conn: this.conn, matched: c.matched };
			} catch (err) {
				this.warn(`bridge: window ${c.entry.pid} unreachable: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return undefined;
	}

	async call(name: unknown, rawArgs: unknown): Promise<CallOutcome> {
		if (!isToolName(name)) return { text: `Unknown tool: ${name === undefined ? "(none)" : String(name)}`, isError: true };
		let args: ToolArgs;
		try {
			args = validateArgs(name, rawArgs, this.cwd);
		} catch (err) {
			return { text: `Invalid arguments: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
		const c = await this.connection();
		if (!c) return { text: NOT_CONNECTED, isError: true };
		try {
			const result = await c.conn.call(name, args, this.cwd);
			const note = c.matched ? undefined : `(Note: no VS Code window has ${this.cwd} open; answering from window "${c.conn.entry.name}", so workspace-wide results may belong to another project.)`;
			return { text: formatResult(result, this.cwd, note), isError: false };
		} catch (err) {
			return { text: `VS Code: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
	}

	close(): void {
		this.conn?.close();
		this.conn = undefined;
	}
}
