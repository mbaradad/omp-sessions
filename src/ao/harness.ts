// Which agent harness a Switchyard session runs (claude-code, codex, omp, …): AO's own configuration decides.
// The candidates are AO's chat harnesses (`GET /settings` `chatHarnesses`: the ones that run in Chat mode, the
// only mode Switchyard drives), with the readiness of AO's agent catalog (`GET /agents`). Resolution order:
//   1. an explicit choice (`--harness`, a task or lane option, the Hermes `harness` parameter or board setting);
//   2. Switchyard's default (`config.json` `harness`, which VS Code's `switchyard.defaultHarness` mirrors);
//   3. the AO project's worker harness (project config `worker.agent`, as AO's own `ao spawn` resolves it);
//   4. AO's authorized chat harnesses: the only one; with several, `omp` when it is authorized, else the one with
//      the most sessions (`usageCount`). With none authorized, the same rule over the installed ones.
// A choice from 1–3 must be one of AO's chat harnesses: anything else is refused with the list.
import type { AoClient, AoSchemas } from "./client";

/** The harness Switchyard's own extras (the permission gate, /undo checkpoints, the todo mirror, the shim) are built for. */
export const OMP_HARNESS = "omp";

/** A session's harness is omp: AO's sessions from before harnesses were recorded are omp too. */
export function isOmpHarness(harness: string | undefined | null): boolean {
	return (harness || OMP_HARNESS) === OMP_HARNESS;
}

export type AoAuthStatus = NonNullable<AoSchemas["AgentInfo"]["authStatus"]>;

/** One of AO's chat harnesses, with what AO's agent catalog says about it. */
export interface AoHarnessInfo {
	id: string;
	label: string;
	/** AO's auth probe; `authorized` is advisory (AO: spawn is the authoritative check). */
	authStatus: AoAuthStatus;
	/** The binary resolved in AO's latest catalog probe. */
	installed: boolean;
	/** Retained AO sessions attributed to it. */
	usageCount: number;
	lastUsedAt?: string;
}

/** Where the resolved harness came from (the resolution order above). */
export type HarnessSource = "explicit" | "config" | "project" | "only" | "omp" | "usage";

export interface HarnessChoice {
	harness: string;
	source: HarnessSource;
	/** One line for people: why this harness. */
	reason: string;
}

export interface ResolveHarnessInput {
	explicit?: string;
	/** Switchyard's default (config.json `harness`). */
	config?: string;
	/** The AO project's `worker.agent`. */
	project?: string;
	/** AO's chat harnesses (availableHarnesses). */
	harnesses: readonly AoHarnessInfo[];
}

/** A harness Switchyard can't start: unknown to AO, not a chat harness, or none to choose from. */
export class HarnessError extends Error {}

/** AO's chat harnesses, in AO's order, with their readiness from the agent catalog. */
export async function availableHarnesses(client: AoClient): Promise<AoHarnessInfo[]> {
	const [settings, agents] = await Promise.all([client.settings(), client.agents()]);
	const info = new Map(agents.supported.map(a => [a.id, a]));
	const installed = new Set(agents.installed.map(a => a.id));
	const authorized = new Set(agents.authorized.map(a => a.id));
	return settings.chatHarnesses.map(id => {
		const a = info.get(id);
		const authStatus: AoAuthStatus = a?.authStatus ?? (authorized.has(id) ? "authorized" : "unknown");
		return { id, label: a?.label ?? id, authStatus, installed: installed.has(id), usageCount: a?.usageCount ?? 0, ...(a?.lastUsedAt && { lastUsedAt: a.lastUsedAt }) };
	});
}

function listText(harnesses: readonly AoHarnessInfo[]): string {
	return harnesses.length ? harnesses.map(h => `${h.id}${h.authStatus === "authorized" ? "" : ` (${h.authStatus})`}`).join(", ") : "none";
}

/** Step 4 alone: AO's default among its chat harnesses, or undefined when none is authorized or installed. */
export function defaultHarness(harnesses: readonly AoHarnessInfo[]): HarnessChoice | undefined {
	const authorized = harnesses.filter(h => h.authStatus === "authorized");
	const pool = authorized.length ? authorized : harnesses.filter(h => h.installed);
	const what = authorized.length ? "authorized" : "installed (none is authorized)";
	if (pool.length === 0) return undefined;
	if (pool.length === 1) return { harness: pool[0].id, source: "only", reason: `the only chat harness AO reports ${what}` };
	if (pool.some(h => h.id === OMP_HARNESS)) return { harness: OMP_HARNESS, source: "omp", reason: `omp: the default when several chat harnesses are ${what} (${pool.map(h => h.id).join(", ")})` };
	// Most used first; then the most recently used; then AO's order (a stable sort keeps it).
	const best = [...pool].sort((a, b) => b.usageCount - a.usageCount || (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))[0];
	return { harness: best.id, source: "usage", reason: `the most used of the ${what} chat harnesses (${best.usageCount} session${best.usageCount === 1 ? "" : "s"}; ${pool.map(h => h.id).join(", ")})` };
}

/** The resolution order (file header), as a pure function. Throws HarnessError. */
export function resolveHarness(input: ResolveHarnessInput): HarnessChoice {
	const steps: Array<[HarnessSource, string | undefined, string]> = [
		["explicit", input.explicit, "asked for"],
		["config", input.config, "Switchyard's default (switchyard config set harness)"],
		["project", input.project, "the AO project's worker harness (worker.agent)"],
	];
	for (const [source, raw, why] of steps) {
		const id = raw?.trim();
		if (!id) continue;
		if (!input.harnesses.some(h => h.id === id)) {
			const where = source === "config" ? " (Switchyard's default: switchyard config set harness <id>|none)" : source === "project" ? " (the AO project's worker.agent)" : "";
			throw new HarnessError(`"${id}"${where} is not one of AO's chat harnesses; available: ${listText(input.harnesses)}`);
		}
		return { harness: id, source, reason: why };
	}
	const fallback = defaultHarness(input.harnesses);
	if (!fallback) throw new HarnessError(`AO reports no authorized or installed chat harness: log in to one (AO's agent settings) or pass one explicitly; AO's chat harnesses: ${listText(input.harnesses)}`);
	return fallback;
}

/** The AO project's worker harness (`config.worker.agent`), undefined when unset or unreadable. */
export async function projectWorkerHarness(client: AoClient, projectId: string): Promise<string | undefined> {
	const project = await client.getProject(projectId).catch(() => undefined);
	const config = project && "config" in project ? project.config : undefined;
	return config?.worker?.agent?.trim() || undefined;
}

/** resolveHarness against the running daemon: reads its chat harnesses and, with a project, the project's worker harness. */
export async function resolveSessionHarness(client: AoClient, input: { explicit?: string; config?: string; projectId?: string }): Promise<HarnessChoice & { harnesses: AoHarnessInfo[] }> {
	const harnesses = await availableHarnesses(client);
	// The project only matters when nothing earlier in the order chose.
	const project = !input.explicit?.trim() && !input.config?.trim() && input.projectId ? await projectWorkerHarness(client, input.projectId) : undefined;
	return { ...resolveHarness({ explicit: input.explicit, config: input.config, project, harnesses }), harnesses };
}
