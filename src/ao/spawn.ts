// How a Switchyard session starts (MAPPING.md D11, GAPS.md G7/G15/G34/G36). One helper, called by the
// CLI, the VS Code extension, Hermes and the planner, so they cannot drift apart:
//   0. resolve the harness (harness.ts: explicit, Switchyard's default, the project's worker harness, AO's
//      default) and refuse one AO can't chat with;
//   1. reject a model that exists nowhere (the harness's catalog), before any session is created;
//   2. POST /sessions. omp: AO's `bypass-permissions` (the omp extension's gate is then the only one), no
//      prompt, no model (AO refuses `effort` for omp, and a model it does not know leaves a terminated session
//      behind). Any other harness: the mode as AO's own `approvalMode` (approvalModeFor: ask → default,
//      edits → accept-edits, auto → bypass-permissions), model and thinking (`effort`) in the request;
//      a mode AO says the harness can't run is refused when asked for, and a default mode gives way to the
//      nearest one it can (Kimi runs only in `default`); steps 3–6 are omp's only;
//   3. check `model` against the session's own config options;
//   4. with extra omp arguments, write `omp-args` and restart the agent (they are read at launch);
//   5. PATCH model, then thinking (checked after the model: the levels depend on it);
//   6. set the permission mode: the file the gate reads, and omp's `plan` option. After the restart,
//      which resets omp's live options;
//   7. send the prompt, with a `clientMessageId` (idempotent).
// Plan mode and extra omp arguments are omp's only: asked of another harness they are refused up front (a default
// mode `plan` starts another harness in `ask`).
// Re-running it with the same `clientRequestId` and `clientMessageId` after a crash is safe: AO returns
// the same session for the request id and reports the message as a duplicate. A failure before the
// prompt is sent removes the session it created, so a typo leaves nothing behind.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AoClient, AoConfigOptions, AoProject, AoSendResponse, AoSessionView, AoSpawnRequest } from "./client";
import { refuseRealStateInTests, sessionStateFile, switchyardHome } from "./native";
import { writeMode } from "../shared/session-mode";
import { gateStatus } from "./gate";
import { readSwitchyardConfig, switchyardConfigPath } from "./config";
import { type HarnessSource, isOmpHarness, resolveSessionHarness } from "./harness";
import { type AoPermissionMode, approvalModeFor, permissionModeOf } from "./report";
import type { OmpPathOptions } from "../shared/omp-paths";

/** The permission modes; the gate in the omp extension reads one of these from the mode file. */
export type AoSessionMode = AoPermissionMode;

export interface SpawnSwitchyardOptions {
	/** A folder: the AO project of its git root (D2), registered on first use. Outside git: a standalone session. */
	dir?: string;
	/** An AO project id; wins over `dir`. */
	projectId?: string;
	displayName?: string;
	/** The branch the session's worktree is created on (AO default: `ao/<slug>/root`). Needs a project (`dir` in a git repo, or `projectId`). */
	branch?: string;
	/** The AO harness asked for (claude-code, codex, omp, …): first in the resolution order (harness.ts). */
	harness?: string;
	/** Switchyard's default harness (second in the order); default config.json's `harness`. `null`: none. */
	defaultHarness?: string | null;
	/** A model id (omp: `provider/model`), checked against the harness's catalog and, for omp, the session's own choices. */
	model?: string;
	/** The model of an omp session that names none (config.json's `model`, the default); never applied to another harness. `null`: none. */
	defaultModel?: string | null;
	/** omp's thinking level (`off`, `low`, `medium`, `high`, …), checked against its choices; another harness's reasoning effort (AO's `effort`). */
	thinking?: string;
	/** The permission mode asked for. omp: written to the mode file before the prompt; any mode but `auto` needs the permission gate installed, without it the spawn is refused (`switchyard omp-extension install`). Another harness: AO's approvalMode (approvalModeFor), refused when AO says the harness can't run it; `plan` is omp's only. */
	mode?: AoSessionMode;
	/** The mode when none is asked for: default config.json's `mode`, else `auto`. `null`: `auto`. A harness that can't run it gets AO's nearest mode instead of a refusal. */
	defaultMode?: AoSessionMode | null;
	/** Where to look for the gate (omp's agent folder): default the machine's own. For tests that install a stand-in gate in a temp folder. */
	gate?: { omp?: OmpPathOptions };
	/**
	 * Extra `omp acp` arguments for this session (G34), read by the Switchyard `omp` shim, which must be first on
	 * the daemon's PATH. Written as plain words when every argument is one word, else as a JSON array of strings
	 * (the shim reads either; the array needs `node` or `bun` on the daemon's PATH, a word list does not). omp only.
	 */
	ompArgs?: readonly string[];
	/** The first message. Without one the session is left ready and waiting. */
	prompt?: string;
	/**
	 * Sets an omp session's permission mode: writes the mode file and, for `plan`, omp's own plan option
	 * (checkpoints' `setSessionMode`; MAPPING D11 says the mode file is never written by hand). Called after
	 * the agent restart and the model and thinking options, before the prompt. Default: this module does the
	 * same for a session that has no turns yet (the file, and the plan option). Not called for other harnesses.
	 */
	setMode?: (sessionId: string, mode: AoSessionMode) => Promise<unknown>;
	/** Makes the prompt idempotent (retry the helper with the same one). Generated when absent and a prompt is given. */
	clientMessageId?: string;
	/** Makes the spawn idempotent. Generated when absent. */
	clientRequestId?: string;
	/** Switchyard's state folder; default `$SWITCHYARD_HOME` or `~/.switchyard`. */
	home?: string;
	/** How long to wait for AO's model catalog to settle (a fresh daemon answers empty while it refreshes) before skipping the pre-check. Default 5 s. */
	catalogWaitMs?: number;
	/** How long to wait for the agent after a restart. Default 90 s. */
	readyTimeoutMs?: number;
}

export interface SpawnedSwitchyardSession {
	session: AoSessionView;
	/** The AO project it runs in; absent for a standalone session (the folder was outside git, or none was given). */
	project?: AoProject;
	/** AO's answer to the prompt: its turn, queued or running. */
	sent?: AoSendResponse;
	clientRequestId: string;
	clientMessageId?: string;
	/** The permission mode it starts in (for another harness: what AO's approval mode stands for). */
	mode: AoSessionMode;
	/** The harness it runs, where that choice came from, and why (harness.ts). */
	harness: string;
	harnessSource: HarnessSource;
	harnessReason: string;
}

/** The choices of a config option, or undefined when the agent has no such option. */
function choicesOf(options: AoConfigOptions, id: string): string[] | undefined {
	const option = options.options.find(o => o.id === id);
	return option ? (option.choices ?? []).map(c => c.value) : undefined;
}

/** The `omp-args` file: plain words when no argument has whitespace (no JSON runtime needed), else a JSON array of strings. */
export function ompArgsFile(args: readonly string[]): string {
	return args.some(a => /\s/.test(a)) ? `${JSON.stringify(args)}\n` : `${args.join(" ")}\n`;
}

function writeFileAtomic(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}

/**
 * AO's model catalog of a harness once it can be trusted. A daemon that has just started answers with no models and
 * `refreshState: "refreshing"` for a second or two (omp lists its models in the background): that is not "the model
 * does not exist", so an empty or still-refreshing answer that lacks the model is asked again, for up to `waitMs`.
 * A catalog that has the model, or that has settled without it, is returned. undefined: it never settled or could
 * not be read: the caller skips the pre-check, and the session's own config options (step 3, omp) or AO's own
 * check (other harnesses) still reject a bad model.
 */
async function settledCatalog(client: AoClient, harness: string, model: string, waitMs: number): Promise<Awaited<ReturnType<AoClient["agentModels"]>> | undefined> {
	const deadline = Date.now() + waitMs;
	const pause = Math.min(250, Math.ceil(waitMs / 4));
	for (;;) {
		const catalog = await client.agentModels(harness).catch(() => undefined);
		if (!catalog || catalog.models.some(m => m.id === model)) return catalog;
		const settling = catalog.models.length === 0 || catalog.refreshState === "refreshing" || catalog.refreshState === "queued";
		if (!settling) return catalog;
		if (Date.now() >= deadline) return undefined;
		await sleep(pause);
	}
}

/** Thrown for what only omp sessions have (plan mode, extra omp arguments, /undo): says so, with the harness. */
export function ompOnly(feature: string, harness: string): Error {
	return new Error(`${feature} is omp-only (Switchyard's omp extension); this session runs ${harness}`);
}

/** Starts a Switchyard session (see the file header). Rejects before creating anything for an unknown harness or model. */
export async function spawnSwitchyardSession(client: AoClient, options: SpawnSwitchyardOptions = {}): Promise<SpawnedSwitchyardSession> {
	const home = options.home ?? switchyardHome();
	refuseRealStateInTests(home);
	const ompArgs = options.ompArgs ?? [];
	if (ompArgs.includes("")) throw new Error("an omp argument is empty");
	const config = options.defaultHarness === undefined || options.defaultModel === undefined || (options.mode === undefined && options.defaultMode === undefined) ? readSwitchyardConfig(switchyardConfigPath(home)) : {};
	let mode: AoSessionMode = options.mode ?? (options.defaultMode === undefined ? config.mode : options.defaultMode) ?? "auto";

	// 0. The harness: explicit, Switchyard's default, the project's worker harness, AO's default. The project counts only
	// when nothing earlier chose; a folder's project is looked up without registering it (a new one has no worker harness).
	const defaultHarness = options.defaultHarness === undefined ? config.harness : (options.defaultHarness ?? undefined);
	const chosen = Boolean(options.harness?.trim() || defaultHarness?.trim());
	const knownProject = options.projectId ?? (!chosen && options.dir ? (await client.projectForFolder(options.dir, { create: false }))?.id : undefined);
	const choice = await resolveSessionHarness(client, { ...(options.harness && { explicit: options.harness }), ...(defaultHarness && { config: defaultHarness }), ...(knownProject && { projectId: knownProject }) });
	const harness = choice.harness;
	const omp = isOmpHarness(harness);
	const model = options.model ?? (omp ? (options.defaultModel === undefined ? config.model : (options.defaultModel ?? undefined)) : undefined);
	let approvalMode: NonNullable<AoSpawnRequest["approvalMode"]> = "bypass-permissions";
	if (!omp) {
		if (ompArgs.length > 0) throw ompOnly(`Extra omp arguments (${ompArgs.join(" ")})`, harness);
		if (mode === "plan" && options.mode) throw ompOnly('Permission mode "plan"', harness);
		if (mode === "plan") mode = "ask";
		approvalMode = approvalModeFor(mode);
		// Not every harness runs in every AO mode (Kimi: only `default`). A mode asked for is refused; a default gives way to the nearest one.
		const modes = await client.chatPermissionModes(harness).catch(() => undefined);
		if (modes?.length && !modes.includes(approvalMode)) {
			const named = modes.map(m => `${permissionModeOf({ approvalMode: m as typeof approvalMode }, false, harness) ?? m} (AO ${m})`).join(", ");
			if (options.mode) throw new Error(`Permission mode "${mode}" (AO ${approvalMode}) is not available for ${harness}; AO runs it in: ${named}`);
			// strictest first: auto takes the least strict one left, the others the strictest.
			approvalMode = (mode === "auto" ? modes[modes.length - 1] : modes[0]) as typeof approvalMode;
			mode = permissionModeOf({ approvalMode }, false, harness) ?? mode;
		}
	}
	// Fail closed (G46): omp is launched in AO's bypass-permissions and only the gate enforces ask/edits/plan,
	// so a mode file nobody reads would run everything unrestricted while reporting the mode. Refuse before anything exists.
	if (omp && mode !== "auto") {
		const status = gateStatus(options.gate);
		if (!status.gate) throw new Error(`Permission mode "${mode}" needs the Switchyard permission gate, which is not installed (looked in ${status.extensionDir}). Run \`switchyard omp-extension install\`; without the gate a session can only start in mode "auto".`);
	}

	// 1. A model no catalog knows would leave a terminated session behind; refuse it before any session exists.
	// A harness whose catalog takes custom models (AO's `allowCustom`) is left to AO.
	if (model) {
		const catalog = await settledCatalog(client, harness, model, options.catalogWaitMs ?? 5_000);
		if (catalog && !(catalog.allowCustom && !omp) && !catalog.models.some(m => m.id === model)) throw new Error(`Unknown ${harness} model "${model}" (not in AO's model catalog)`);
	}
	const project = options.projectId ? undefined : options.dir ? await client.projectForFolder(options.dir) : undefined;
	const projectId = options.projectId ?? project?.id;
	const clientRequestId = options.clientRequestId ?? randomUUID();
	const clientMessageId = options.prompt ? (options.clientMessageId ?? randomUUID()) : undefined;

	// 2. The session. omp: bypass (the extension's gate decides), no prompt, no model. Others: AO's own approval mode, model and effort.
	const spawned = await client.spawnSession({
		harness: harness as AoSpawnRequest["harness"],
		mode: "chat",
		kind: "worker",
		approvalMode,
		clientRequestId,
		...(projectId && { projectId }),
		...(options.displayName && { displayName: options.displayName }),
		...(options.branch && { branch: options.branch }),
		...(!omp && model && { model }),
		...(!omp && options.thinking && { effort: options.thinking }),
	});
	const id = spawned.session.id;
	if (omp) {
		try {
			// 3. What the session's own options accept.
			let configOptions = await client.configOptions(id);
			if (model) {
				const models = choicesOf(configOptions, "model");
				if (models && !models.includes(model)) throw new Error(`Unknown omp model "${model}"; this session offers: ${models.join(", ")}`);
			}

			// 4. Extra arguments are read when omp launches: write them, restart omp on the same transcript.
			if (ompArgs.length > 0) {
				writeFileAtomic(sessionStateFile(id, "omp-args", home), ompArgsFile(ompArgs));
				await client.exitAgent(id);
				await client.resumeAgent(id);
				const deadline = Date.now() + (options.readyTimeoutMs ?? 90_000);
				while ((await client.getConversation(id).catch(() => undefined))?.controller !== "ready") {
					if (Date.now() > deadline) throw new Error(`The agent of ${id} did not come back after restarting with ${ompArgs.join(" ")}`);
					await new Promise(resolve => setTimeout(resolve, 500));
				}
				configOptions = await client.configOptions(id);
			}

			// 5. Model and thinking are omp's own options, live before the first message, and a restart resets
			// them: so after it. The thinking levels a model offers depend on the model (haiku 3 has no `low`),
			// so the model goes first and the choices are read again before `thinking` is checked.
			const current = (key: string) => configOptions.options.find(o => o.id === key)?.currentValue;
			if (model && current("model") !== model) {
				await client.setConfigOption(id, "model", { value: model });
				configOptions = await client.configOptions(id);
			}
			if (options.thinking) {
				const levels = choicesOf(configOptions, "thinking");
				if (levels && !levels.includes(options.thinking)) throw new Error(`Unknown thinking level "${options.thinking}"${model ? ` for ${model}` : ""}; omp offers: ${levels.join(", ")}`);
				if (current("thinking") !== options.thinking) await client.setConfigOption(id, "thinking", { value: options.thinking });
			}

			// 6. The permission mode, last for the same reason (omp's `plan` option is one of the live ones).
			// A caller's setMode (e.g. setSessionMode, which also declines gate questions left open) takes
			// over; without one this writes the mode file and handles plan, which is all a session with no
			// turns needs.
			if (options.setMode) await options.setMode(id, mode);
			else {
				writeMode(id, mode, home);
				if (mode === "plan" && current("mode") !== "plan") await client.setConfigOption(id, "mode", { value: "plan" });
			}
		} catch (error) {
			// Nothing was sent. Remove a session this call made; one that already has turns (a retry after a
			// crash found the session of an earlier, successful call) is not ours to delete.
			const fresh = (await client.getConversation(id).catch(() => undefined))?.turns.length === 0;
			if (fresh) {
				await client.killSession(id).catch(() => undefined);
				await client.deleteSession(id).catch(() => undefined);
				fs.rmSync(path.dirname(sessionStateFile(id, "mode", home)), { recursive: true, force: true });
			}
			throw error;
		}
	}

	// 7. The prompt last, so the gate, the model and the arguments are all in place for the first turn.
	const sent = options.prompt ? await client.sendMessage(id, { text: options.prompt, clientMessageId }) : undefined;
	return { session: spawned.session, ...(project && { project }), ...(sent && { sent }), clientRequestId, ...(clientMessageId && { clientMessageId }), mode, harness, harnessSource: choice.source, harnessReason: choice.reason };
}
