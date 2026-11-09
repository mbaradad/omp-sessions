// `switchyard migrate`: imports an omp Sessions install (~/.omp/vscode) into Switchyard on AO.
// Dry run by default; `--apply` writes. See src/migrate/migrate.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import { AoClient } from "../ao/client";
import { migrate } from "../migrate/migrate";
import { PlannerClient, ensurePlanner } from "../planner/client";
import { type Args, flag, value } from "./args";

export const MIGRATE_HELP = `  migrate [--apply] [--only <id,…>] [--model <provider/id>] [--json]
                                  bring omp Sessions sessions (with their omp history), organization and
                                  task queues into AO and the planner; dry run unless --apply (backs up
                                  ~/.omp/vscode first, never deletes; safe to repeat); --model: continue
                                  the sessions on another model`;

export async function cmdMigrate(args: Args): Promise<number> {
	const apply = flag(args, "apply");
	const json = flag(args, "json");
	const only = value(args, "only")
		?.split(",")
		.map(s => s.trim())
		.filter(Boolean);
	const model = value(args, "model");
	const say = (line: string) => {
		if (!json) process.stdout.write(`${line}\n`);
	};
	let client: AoClient | undefined;
	try {
		client = await AoClient.connect({ start: apply });
	} catch (err) {
		if (apply) throw err;
		say("AO daemon not running: the dry run cannot tell which AO projects exist yet.");
	}
	// The planner script ships next to this CLI (out/planner.js).
	const plannerScript = path.join(__dirname, "planner.js");
	const planner = (await PlannerClient.connect()) ?? (apply && fs.existsSync(plannerScript) ? await ensurePlanner(plannerScript) : undefined);
	if (!planner && apply) say("Planner not running: task queues and scheduler.json wait for a later run.");
	try {
		const report = await migrate({ apply, client, ...(planner && { planner }), ...(only?.length && { only }), ...(model && { model }), log: say });
		if (json) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
		return report.sessions.some(s => s.kind === "failed") ? 1 : 0;
	} finally {
		planner?.close();
	}
}
