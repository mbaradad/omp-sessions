// What a session could load — skills, MCP servers, effective omp settings — for the Session
// Settings pickers. omp's own CLI is authoritative (`omp skill list --json`, `omp config list
// --json`); MCP servers (no omp CLI) and a missing/failing omp fall back to reading the
// well-known config locations directly. Node-only.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ompPaths } from "./omp-paths";
import { spawnTarget } from "./win-spawn";

export interface SkillInfo {
	name: string;
	description: string;
	/** omp provider tag (`agents:user`, `omp:project`, …) or the scanned folder kind. */
	source: string;
	file?: string;
}

export interface McpServerInfo {
	name: string;
	/** Short origin label, e.g. `omp user`, `.mcp.json`, `Claude`. */
	source: string;
	file: string;
	/** Off before this session's own toggles (user `disabledServers` or `enabled: false`). */
	disabledByConfig?: boolean;
}

export interface Capabilities {
	skills: SkillInfo[];
	mcp: McpServerInfo[];
	/** Effective omp settings for the folder (`omp config list --json` values). */
	config: Map<string, unknown>;
	/** False when omp could not be run (skills come from the folder scan, config is empty). */
	ompOk: boolean;
}

function rec(v: unknown): Record<string, unknown> | undefined {
	// Parsed JSON objects; arrays/primitives excluded.
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** `omp skill list --json` → skills (hidden ones dropped); undefined when the output is not that shape. */
export function parseSkillList(stdout: string): SkillInfo[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const skills = rec(parsed)?.skills;
	if (!Array.isArray(skills)) return undefined;
	const out: SkillInfo[] = [];
	for (const s of skills) {
		const r = rec(s);
		if (!r || typeof r.name !== "string" || r.hide === true) continue;
		out.push({ name: r.name, description: typeof r.description === "string" ? r.description : "", source: typeof r.source === "string" ? r.source : "", file: typeof r.filePath === "string" ? r.filePath : undefined });
	}
	return out;
}

/** `name` / `description` from a SKILL.md YAML front matter (plain, quoted and folded scalars). */
export function parseFrontmatter(text: string): { name?: string; description?: string; hide?: boolean } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) return {};
	const lines = m[1].split(/\r?\n/);
	const out: { name?: string; description?: string; hide?: boolean } = {};
	for (let i = 0; i < lines.length; i++) {
		const kv = /^(name|description|hide):\s*(.*)$/.exec(lines[i]);
		if (!kv) continue;
		let value = kv[2].trim();
		if (value === "" || /^[>|][+-]?$/.test(value)) {
			const block: string[] = [];
			while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]) && lines[i + 1] !== "") block.push(lines[++i].trim());
			value = block.join(" ");
		} else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (kv[1] === "hide") out.hide = value === "true";
		else out[kv[1] === "name" ? "name" : "description"] = value;
	}
	return out;
}

/** Folder scan used when omp cannot list skills: the default-enabled omp skill locations. */
export function scanSkills(cwd: string, home = os.homedir()): SkillInfo[] {
	const roots = [
		{ dir: path.join(cwd, ".omp", "skills"), source: "omp:project" },
		{ dir: path.join(cwd, ".agents", "skills"), source: "agents:project" },
		{ dir: path.join(cwd, ".claude", "skills"), source: "claude:project" },
		{ dir: path.join(ompPaths({ home }).agentDir, "skills"), source: "omp:user" },
		{ dir: path.join(home, ".agents", "skills"), source: "agents:user" },
	];
	const seen = new Set<string>();
	const out: SkillInfo[] = [];
	for (const { dir, source } of roots) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!e.isDirectory() && !e.isSymbolicLink()) continue;
			const file = path.join(dir, e.name, "SKILL.md");
			let text: string;
			try {
				text = fs.readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const fm = parseFrontmatter(text);
			const name = fm.name || e.name;
			if (fm.hide || seen.has(name)) continue;
			seen.add(name);
			out.push({ name, description: fm.description ?? "", source, file });
		}
	}
	return out;
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * MCP servers configured for `cwd`: omp's user/project `mcp.json`, standalone `.mcp.json`, Claude,
 * Cursor and VS Code configs, plus `extraFiles` (e.g. the session's VS Code bridge). First wins.
 */
export function scanMcpServers(cwd: string, home = os.homedir(), extraFiles: Array<{ file: string; source: string }> = []): McpServerInfo[] {
	const agentDir = ompPaths({ home }).agentDir;
	const userOmp = path.join(agentDir, "mcp.json");
	const userConfig = rec(readJson(userOmp));
	const disabled = new Set(Array.isArray(userConfig?.disabledServers) ? userConfig.disabledServers.filter((x): x is string => typeof x === "string") : []);
	const forced = new Set(Array.isArray(userConfig?.enabledServers) ? userConfig.enabledServers.filter((x): x is string => typeof x === "string") : []);
	const sources: Array<{ file: string; source: string; pick: (json: Record<string, unknown>) => unknown }> = [
		...[".omp/mcp.json", ".omp/.mcp.json"].map(f => ({ file: path.join(cwd, f), source: "omp project", pick: (j: Record<string, unknown>) => j.mcpServers })),
		{ file: userOmp, source: "omp user", pick: j => j.mcpServers },
		{ file: path.join(agentDir, ".mcp.json"), source: "omp user", pick: j => j.mcpServers },
		...["mcp.json", ".mcp.json"].map(f => ({ file: path.join(cwd, f), source: f, pick: (j: Record<string, unknown>) => j.mcpServers })),
		...[".claude/.mcp.json", ".claude/mcp.json"].map(f => ({ file: path.join(cwd, f), source: "Claude project", pick: (j: Record<string, unknown>) => j.mcpServers })),
		{ file: path.join(home, ".claude.json"), source: "Claude", pick: j => ({ ...rec(j.mcpServers), ...rec(rec(rec(j.projects)?.[cwd])?.mcpServers) }) },
		{ file: path.join(home, ".claude", "mcp.json"), source: "Claude", pick: j => j.mcpServers },
		{ file: path.join(cwd, ".cursor", "mcp.json"), source: "Cursor project", pick: j => j.mcpServers },
		{ file: path.join(home, ".cursor", "mcp.json"), source: "Cursor", pick: j => j.mcpServers },
		{ file: path.join(cwd, ".vscode", "mcp.json"), source: ".vscode/mcp.json", pick: j => rec(j.mcp)?.servers ?? j.servers },
		...extraFiles.map(x => ({ ...x, pick: (j: Record<string, unknown>) => j.mcpServers })),
	];
	const out = new Map<string, McpServerInfo>();
	for (const s of sources) {
		const json = rec(readJson(s.file));
		const servers = json ? rec(s.pick(json)) : undefined;
		if (!servers) continue;
		for (const [name, config] of Object.entries(servers)) {
			if (out.has(name)) continue;
			const off = disabled.has(name) || (rec(config)?.enabled === false && !forced.has(name));
			out.set(name, { name, source: s.source, file: s.file, disabledByConfig: off || undefined });
		}
	}
	return [...out.values()];
}

/** `omp config list --json` → key → effective value (keys without a value are left out). */
export function parseConfigList(stdout: string): Map<string, unknown> {
	const out = new Map<string, unknown>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return out;
	}
	for (const [key, entry] of Object.entries(rec(parsed) ?? {})) {
		const r = rec(entry);
		if (r && "value" in r) out.set(key, r.value);
	}
	return out;
}

/** Runs omp and resolves its stdout (undefined on failure/timeout). */
export function runOmp(omp: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	// `.cmd` shims on Windows go through cmd.exe with quoted arguments (the folder is user-chosen).
	const target = spawnTarget(omp, args);
	execFile(
		target.file,
		target.args,
		{ cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: target.windowsVerbatimArguments },
		(err, stdout) => resolve(err ? undefined : stdout),
	);
	return promise;
}

/** Everything the Session Settings pickers list for a session in `cwd` (`sessionDir` adds its bridge MCP server). */
export async function discoverCapabilities(omp: string | undefined, cwd: string, sessionDir?: string): Promise<Capabilities> {
	const folder = fs.existsSync(cwd) ? cwd : os.homedir();
	const [skillsOut, configOut] = omp ? await Promise.all([runOmp(omp, ["skill", "list", folder, "--json"], folder), runOmp(omp, ["config", "list", "--json"], folder)]) : [undefined, undefined];
	const listed = skillsOut === undefined ? undefined : parseSkillList(skillsOut);
	const extra = sessionDir ? [{ file: path.join(sessionDir, "vscode-bridge", ".mcp.json"), source: "VS Code bridge" }] : [];
	return {
		skills: listed ?? scanSkills(cwd),
		mcp: scanMcpServers(cwd, os.homedir(), extra),
		config: configOut === undefined ? new Map() : parseConfigList(configOut),
		ompOk: listed !== undefined,
	};
}
