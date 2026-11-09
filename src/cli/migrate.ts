// `switchyard migrate`: imports an omp Sessions install (~/.omp/vscode) into Switchyard (~/.switchyard).
// Dry run by default; `--apply` writes. See src/migrate/migrate.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import { migrate } from "../migrate/migrate";
import { PlannerClient, ensurePlanner } from "../planner/client";
import { type Args, flag } from "./args";

export const MIGRATE_HELP = `  migrate [--apply] [--json]
                                  bring omp Sessions' organization (groups, board lanes), defaults and
                                  scheduler settings into Switchyard; dry run unless --apply (backs up
                                  ~/.omp/vscode first, never writes or deletes there; safe to repeat). Old
                                  sessions are not migrated: it lists each with its \`omp --resume\` line
                                  and its unfinished queued tasks`;

export async function cmdMigrate(args: Args): Promise<number> {
	const apply = flag(args, "apply");
	const json = flag(args, "json");
	const say = (line: string) => {
		if (!json) process.stdout.write(`${line}\n`);
	};
	// The planner script ships next to this CLI (out/planner.js).
	const plannerScript = path.join(__dirname, "planner.js");
	const planner = (await PlannerClient.connect()) ?? (apply && fs.existsSync(plannerScript) ? await ensurePlanner(plannerScript) : undefined);
	if (!planner && apply) say("Planner not running: the scheduler settings wait for a later run.");
	try {
		const report = await migrate({ apply, ...(planner && { planner }), log: say });
		if (json) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
		return 0;
	} finally {
		planner?.close();
	}
}
