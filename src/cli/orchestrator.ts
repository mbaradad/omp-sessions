// `switchyard orchestrator`: the project's AO orchestrator from the terminal (src/ao/orchestrator.ts): give it a
// high-level task, see it and its workers, replace it, configure it. Its chat is a session like any other:
// `switchyard show|tail|attach|send|answer <its id>` work on it.
import * as fs from "node:fs";
import * as path from "node:path";
import type { AoProject } from "../ao/client";
import { readSwitchyardConfig } from "../ao/config";
import {
	ORCHESTRATOR_PERMISSIONS,
	type OrchestratorConfig,
	type OrchestratorConfigPatch,
	type OrchestratorInfo,
	type OrchestratorPermissions,
	type OrchestratorWorker,
	NoProjectError,
	ensureOrchestrator,
	listOrchestrators,
	orchestratorConfig,
	orchestratorOf,
	resolveProject,
	restartOrchestrator,
	setOrchestratorConfig,
	submitTask,
} from "../ao/orchestrator";
import { prSummaryLine } from "../shared/pr-review";
import { type Args, UsageError, flag, value } from "./args";
import { ao } from "./sessions";
import { ago, c, oneLine, pad, readStdin, truncate } from "./term";

/** What the dispatcher lends this command: `wait` lives with the other session commands. */
export interface OrchestratorDeps {
	waitFor(id: string, timeoutMs: number | undefined, json: boolean, turnId?: string): Promise<number>;
}

const VERBS = ["status", "submit", "start", "restart", "stop", "config", "ls"] as const;
type Verb = (typeof VERBS)[number];

const STATE_COLOR: Record<string, (s: string) => string> = { working: c.yellow, starting: c.dim, needs_input: c.magenta, idle: c.green, interrupted: c.red, stopped: c.dim, queued: c.blue, scheduled: c.blue };
const colorState = (state: string) => (STATE_COLOR[state] ?? c.dim)(state.replace("_", " "));

function isVerb(word: string | undefined): word is Verb {
	return !!word && (VERBS as readonly string[]).includes(word);
}

function permissionsFlag(args: Args): OrchestratorPermissions | undefined {
	const v = value(args, "permissions");
	if (v === undefined) return undefined;
	if (!ORCHESTRATOR_PERMISSIONS.includes(v as OrchestratorPermissions)) throw new UsageError(`--permissions is one of ${ORCHESTRATOR_PERMISSIONS.join(", ")}`);
	return v as OrchestratorPermissions;
}

/** `none` clears a setting; text, `@file` and `-` (stdin) for the rules. */
async function textSetting(raw: string, what: string): Promise<string | null> {
	if (raw === "none") return null;
	if (raw === "-") return (await readStdin()) || null;
	if (raw.startsWith("@")) {
		const file = path.resolve(raw.slice(1));
		if (!fs.existsSync(file)) throw new UsageError(`${what}: no such file ${file}`);
		return fs.readFileSync(file, "utf8").trim() || null;
	}
	return raw;
}

function onOff(raw: string, what: string): boolean | null {
	if (raw === "none") return null;
	if (/^(on|yes|true)$/i.test(raw)) return true;
	if (/^(off|no|false)$/i.test(raw)) return false;
	throw new UsageError(`${what} is on, off or none`);
}

/** Flags of `orchestrator config` and `restart --harness …` as a patch; empty when none was given. */
async function patchFrom(args: Args): Promise<OrchestratorConfigPatch> {
	const patch: OrchestratorConfigPatch = {};
	const plain = (flagName: string, key: "harness" | "model" | "effort" | "workerHarness" | "workerModel") => {
		const v = value(args, flagName);
		if (v !== undefined) patch[key] = v === "none" ? null : v;
	};
	plain("harness", "harness");
	plain("model", "model");
	plain("effort", "effort");
	plain("worker-harness", "workerHarness");
	plain("worker-model", "workerModel");
	const permissions = value(args, "permissions");
	if (permissions !== undefined) patch.permissions = permissions === "none" ? null : permissionsFlag(args);
	const rules = value(args, "rules");
	if (rules !== undefined) patch.rules = await textSetting(rules, "--rules");
	const rulesFile = value(args, "rules-file");
	if (rulesFile !== undefined) patch.rulesFile = rulesFile === "none" ? null : rulesFile;
	const review = value(args, "review");
	if (review !== undefined) patch.workersRequestReview = onOff(review, "--review");
	const autoReview = value(args, "auto-review");
	if (autoReview !== undefined) patch.autoReview = onOff(autoReview, "--auto-review");
	return patch;
}

// ---------- text output ----------

function configLines(config: OrchestratorConfig): string[] {
	const rows: Array<[string, string | undefined]> = [
		["harness", config.harness],
		["model", config.model],
		["effort", config.effort],
		["permissions", config.permissions],
		["rules", config.rules ? truncate(oneLine(config.rules), 100) : undefined],
		["rules file", config.rulesFile],
		["workers", [config.workerHarness, config.workerModel].filter(Boolean).join(" · ") || undefined],
		["workers request review", config.workersRequestReview === undefined ? undefined : config.workersRequestReview ? "on" : "off"],
		["auto review", config.autoReview === undefined ? undefined : config.autoReview ? "on" : "off"],
	];
	const set = rows.filter((r): r is [string, string] => r[1] !== undefined);
	return set.length ? set.map(([k, v]) => `  ${c.dim(pad(k, 24))} ${v}`) : [c.dim("  nothing set: AO's defaults apply")];
}

function workerLine(w: OrchestratorWorker): string {
	const pr = w.prs.find(p => p.state === "open" || p.state === "draft") ?? w.prs[0];
	const prText = pr ? `  ${prSummaryLine(pr)}` : "";
	return `    ${pad(w.id, 14)} ${pad(colorState(w.state), 12)} ${truncate(w.title, 44)}${w.harness && w.harness !== "omp" ? c.dim(` · ${w.harness}`) : ""}${w.branch ? c.dim(`  ${w.branch}`) : ""}${prText}`;
}

function printOrchestrator(o: OrchestratorInfo): void {
	const harness = o.harness ? c.dim(` · ${o.harness}${o.model ? ` ${o.model}` : ""}`) : "";
	process.stdout.write(`${c.bold("orchestrator")} ${o.id}  ${c.bold(o.projectName)}${harness}  ${colorState(o.state)}${o.active ? "" : c.dim(" (stopped)")}  ${c.dim(`${ago(o.updatedAt)} ago`)}\n`);
	if (o.question) process.stdout.write(`${c.magenta(`? ${o.question.title}`)}${o.question.message ? `\n${o.question.message}` : ""}\n  ${c.dim(`switchyard answer ${o.id} <choice>`)}\n`);
	if (o.reply) process.stdout.write(`${c.dim("last: ")}${truncate(oneLine(o.reply), 160)}\n`);
	const n = o.counts;
	const bits = [n.working && `${n.working} working`, n.needsInput && `${n.needsInput} need${n.needsInput === 1 ? "s" : ""} input`, n.idle && `${n.idle} idle`, n.stopped && `${n.stopped} stopped`, n.openPrs && `${n.openPrs} open PR${n.openPrs === 1 ? "" : "s"}`].filter(Boolean);
	process.stdout.write(`workers ${n.workers}${bits.length ? c.dim(`: ${bits.join(" · ")}`) : ""}\n`);
	for (const w of o.workers.slice(0, 15)) process.stdout.write(`${workerLine(w)}\n`);
	if (o.workers.length > 15) process.stdout.write(c.dim(`    … ${o.workers.length - 15} more (switchyard ls --project ${o.projectId})\n`));
}

// ---------- the command ----------

export async function cmdOrchestrator(args: Args, deps: OrchestratorDeps): Promise<number> {
	const verb: Verb = isVerb(args._[0]) ? (args._.shift() as Verb) : "status";
	const json = flag(args, "json");
	const client = await ao();
	// `submit` takes free text: its project is --project or this folder. The others may name it first.
	const named = value(args, "project") ?? (verb === "submit" ? undefined : args._.shift());
	const needsProject = verb !== "ls" && !(verb === "status" && flag(args, "all"));
	let project: AoProject | undefined;
	if (needsProject) {
		try {
			project = await resolveProject(client, named, process.cwd(), { create: verb === "submit" || verb === "start" || verb === "restart" });
		} catch (err) {
			// Reading a repository AO doesn't know yet is not a failure: it has no orchestrator.
			if (verb !== "status" || !(err instanceof NoProjectError)) throw err;
			if (json) process.stdout.write(`${JSON.stringify({ project: null, orchestrator: null, note: err.message }, null, 2)}\n`);
			else process.stdout.write(`${c.dim(`${err.message}: no orchestrator yet (switchyard orchestrator submit "<task>" starts one)`)}\n`);
			return 0;
		}
	}

	if (!project || verb === "ls") {
		const all = await listOrchestrators(client, { includeStopped: flag(args, "all") });
		if (json) process.stdout.write(`${JSON.stringify({ orchestrators: all }, null, 2)}\n`);
		else if (!all.length) process.stdout.write(c.dim("no orchestrator is running (switchyard orchestrator submit \"<task>\" starts the one of this project)\n"));
		else for (const [i, o] of all.entries()) (i && process.stdout.write("\n"), printOrchestrator(o));
		return 0;
	}

	const defaultHarness = readSwitchyardConfig().harness;
	switch (verb) {
		case "status": {
			const o = await orchestratorOf(client, project);
			if (json) process.stdout.write(`${JSON.stringify({ project: { id: project.id, name: project.name, path: project.path }, orchestrator: o ?? null }, null, 2)}\n`);
			else if (o) printOrchestrator(o);
			else process.stdout.write(c.dim(`${project.name} has no orchestrator yet: switchyard orchestrator submit "<task>" --project ${project.id}\n`));
			return 0;
		}
		case "submit": {
			let text = args._.join(" ");
			if (text === "-" || (!text && !process.stdin.isTTY)) text = await readStdin();
			if (!text.trim()) throw new UsageError('what should the orchestrator do? switchyard orchestrator submit "<task>" [--project p] (or - for stdin)');
			const permissions = permissionsFlag(args);
			const sent = await submitTask(client, project, text, { steer: flag(args, "steer"), ...(value(args, "harness") && { harness: value(args, "harness") }), ...(permissions && { permissions }), ...(defaultHarness && { defaultHarness }) });
			if (flag(args, "wait")) return deps.waitFor(sent.orchestrator, undefined, json, sent.turnId);
			if (json) process.stdout.write(`${JSON.stringify({ ...sent, project: project.name }, null, 2)}\n`);
			else {
				const what = sent.started ? "started the orchestrator and gave it the task" : sent.revived ? "restarted the orchestrator and gave it the task" : sent.mode === "steer" ? "steered the orchestrator" : "gave the orchestrator the task";
				process.stdout.write(`${c.green("sent")} ${what}: ${sent.orchestrator} (${project.name}${sent.harness ? `, ${sent.harness}` : ""})\n${c.dim(`  watch: switchyard orchestrator status --project ${project.id} · switchyard tail ${sent.orchestrator} -f · answer: switchyard answer ${sent.orchestrator} <choice>`)}\n`);
			}
			return 0;
		}
		case "start": {
			const permissions = permissionsFlag(args);
			const harness = value(args, "harness");
			const started = await ensureOrchestrator(client, project, { ...(harness && { harness }), ...(permissions && { permissions }), ...(defaultHarness && { defaultHarness }) });
			if (json) process.stdout.write(`${JSON.stringify({ ...started, projectId: project.id }, null, 2)}\n`);
			else process.stdout.write(`${started.started ? c.green("started") : started.revived ? c.green("resumed") : "already running"} orchestrator ${started.id} (${project.name}${started.harness ? `, ${started.harness}` : ""})\n`);
			return 0;
		}
		case "restart": {
			const patch = await patchFrom(args);
			if (Object.keys(patch).length) await setOrchestratorConfig(client, project.id, patch);
			const permissions = permissionsFlag(args);
			const fresh = await restartOrchestrator(client, project, { ...(permissions && { permissions }), ...(defaultHarness && { defaultHarness }) });
			if (json) process.stdout.write(`${JSON.stringify({ ...fresh, projectId: project.id }, null, 2)}\n`);
			else process.stdout.write(`${c.green("replaced")} the orchestrator of ${project.name} with ${fresh.id}${fresh.harness ? ` (${fresh.harness})` : ""}; the old one was told to stop\n`);
			return 0;
		}
		case "stop": {
			const o = await orchestratorOf(client, project);
			if (!o?.active) {
				if (json) process.stdout.write(`${JSON.stringify({ projectId: project.id, stopped: false })}\n`);
				else process.stdout.write(c.dim(`${project.name} has no running orchestrator\n`));
				return 1;
			}
			await client.exitAgent(o.id);
			if (json) process.stdout.write(`${JSON.stringify({ id: o.id, projectId: project.id, stopped: true })}\n`);
			else process.stdout.write(`${c.green("stopped")} orchestrator ${o.id} (its transcript stays; switchyard orchestrator start resumes it)\n`);
			return 0;
		}
		case "config": {
			const patch = await patchFrom(args);
			const result = Object.keys(patch).length ? await setOrchestratorConfig(client, project.id, patch) : await orchestratorConfig(client, project.id);
			if (json) process.stdout.write(`${JSON.stringify({ projectId: project.id, config: result }, null, 2)}\n`);
			else {
				process.stdout.write(`${c.bold(project.name)} orchestrator settings${Object.keys(patch).length ? c.green(" (saved)") : ""}\n${configLines(result).join("\n")}\n`);
				if (Object.keys(patch).length) process.stdout.write(c.dim("a running orchestrator keeps what it started with: switchyard orchestrator restart applies the change\n"));
			}
			return 0;
		}
	}
}
