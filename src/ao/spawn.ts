// How a Switchyard session starts (MAPPING.md D11, GAPS.md G7/G15/G34/G36). One helper, called by the
// CLI, the VS Code extension, Hermes and the planner, so they cannot drift apart:
//   1. reject a model that exists nowhere (the catalog), before any session is created;
//   2. POST /sessions with AO's `bypass-permissions` (the omp extension's gate is then the only one),
//      no prompt, no model (AO refuses `effort` for omp, and a model it does not know leaves a
//      terminated session behind);
//   3. check `model` against the session's own config options;
//   4. with extra omp arguments, write `omp-args` and restart the agent (they are read at launch);
//   5. PATCH model, then thinking (checked after the model: the levels depend on it);
//   6. set the permission mode: the file the gate reads, and omp's `plan` option. After the restart,
//      which resets omp's live options;
//   7. send the prompt, with a `clientMessageId` (idempotent).
// Re-running it with the same `clientRequestId` and `clientMessageId` after a crash is safe: AO returns
// the same session for the request id and reports the message as a duplicate. A failure before the
// prompt is sent removes the session it created, so a typo leaves nothing behind.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AoClient, AoConfigOptions, AoProject, AoSendResponse, AoSessionView } from "./client";
import { sessionStateFile, switchyardHome } from "./native";
import type { AoPermissionMode } from "./report";

/** The permission modes; the gate in the omp extension reads one of these from the mode file. */
export type AoSessionMode = AoPermissionMode;

export interface SpawnSwitchyardOptions {
	/** A folder: the AO project of its git root (D2), registered on first use. Outside git: a standalone session. */
	dir?: string;
	/** An AO project id; wins over `dir`. */
	projectId?: string;
	displayName?: string;
	/** The git branch AO checks out for the session (an existing local branch not checked out elsewhere, else a new one from the default branch). Project sessions only. */
	branch?: string;
	/** An omp model id (`provider/model`), checked against the session's own choices. */
	model?: string;
	/** omp's thinking level (`off`, `low`, `medium`, `high`, …), checked against its choices. */
	thinking?: string;
	/** The permission mode, written to the mode file before the prompt. Default `auto` (the gate lets everything through). */
	mode?: AoSessionMode;
	/**
	 * Extra `omp acp` arguments for this session (G34), read by the Switchyard `omp` shim, which must be first on
	 * the daemon's PATH. Written as plain words when every argument is one word, else as a JSON array of strings
	 * (the shim reads either; the array needs `node` or `bun` on the daemon's PATH, a word list does not).
	 */
	ompArgs?: readonly string[];
	/** The first message. Without one the session is left ready and waiting. */
	prompt?: string;
	/**
	 * Sets the session's permission mode: writes the mode file and, for `plan`, omp's own plan option
	 * (checkpoints' `setSessionMode`; MAPPING D11 says the mode file is never written by hand). Called after
	 * the agent restart and the model and thinking options, before the prompt. Default: this module does the
	 * same for a session that has no turns yet (the file, and the plan option).
	 */
	setMode?: (sessionId: string, mode: AoSessionMode) => Promise<unknown>;
	/** Makes the prompt idempotent (retry the helper with the same one). Generated when absent and a prompt is given. */
	clientMessageId?: string;
	/** Makes the spawn idempotent. Generated when absent. */
	clientRequestId?: string;
	/** Switchyard's state folder; default `$SWITCHYARD_HOME` or `~/.switchyard`. */
	home?: string;
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

/** Starts a Switchyard session (see the file header). Rejects before creating anything for an unknown model. */
export async function spawnSwitchyardSession(client: AoClient, options: SpawnSwitchyardOptions = {}): Promise<SpawnedSwitchyardSession> {
	const home = options.home ?? switchyardHome();
	const mode = options.mode ?? "auto";
	const ompArgs = options.ompArgs ?? [];
	if (ompArgs.includes("")) throw new Error("an omp argument is empty");

	// 1. A model no catalog knows would leave a terminated session behind; refuse it before any session exists.
	if (options.model) {
		const catalog = await client.agentModels("omp").catch(() => undefined);
		if (catalog && !catalog.models.some(m => m.id === options.model)) throw new Error(`Unknown omp model "${options.model}" (not in AO's model catalog)`);
	}
	const project = options.projectId ? undefined : options.dir ? await client.projectForFolder(options.dir) : undefined;
	const projectId = options.projectId ?? project?.id;
	const clientRequestId = options.clientRequestId ?? randomUUID();
	const clientMessageId = options.prompt ? (options.clientMessageId ?? randomUUID()) : undefined;

	// 2. The session: bypass (the extension's gate decides), no prompt, no model.
	const spawned = await client.spawnSession({
		harness: "omp",
		mode: "chat",
		kind: "worker",
		approvalMode: "bypass-permissions",
		clientRequestId,
		...(projectId && { projectId }),
		...(options.displayName && { displayName: options.displayName }),
		...(projectId && options.branch && { branch: options.branch }),
	});
	const id = spawned.session.id;
	try {
		// 3. What the session's own options accept.
		let configOptions = await client.configOptions(id);
		if (options.model) {
			const models = choicesOf(configOptions, "model");
			if (models && !models.includes(options.model)) throw new Error(`Unknown omp model "${options.model}"; this session offers: ${models.join(", ")}`);
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
		if (options.model && current("model") !== options.model) {
			await client.setConfigOption(id, "model", { value: options.model });
			configOptions = await client.configOptions(id);
		}
		if (options.thinking) {
			const levels = choicesOf(configOptions, "thinking");
			if (levels && !levels.includes(options.thinking)) throw new Error(`Unknown thinking level "${options.thinking}"${options.model ? ` for ${options.model}` : ""}; omp offers: ${levels.join(", ")}`);
			if (current("thinking") !== options.thinking) await client.setConfigOption(id, "thinking", { value: options.thinking });
		}

		// 6. The permission mode, last for the same reason (omp's `plan` option is one of the live ones).
		// The caller's setMode writes the mode file and handles plan (MAPPING D11: never write the file
		// by hand); without one this does both itself, which is all a session with no turns needs.
		if (options.setMode) await options.setMode(id, mode);
		else {
			writeFileAtomic(sessionStateFile(id, "mode", home), `${mode}\n`);
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

	// 7. The prompt last, so the gate, the model and the arguments are all in place for the first turn.
	const sent = options.prompt ? await client.sendMessage(id, { text: options.prompt, clientMessageId }) : undefined;
	return { session: spawned.session, ...(project && { project }), ...(sent && { sent }), clientRequestId, ...(clientMessageId && { clientMessageId }) };
}
