// `switchyard migrate`: imports an omp Sessions install (~/.omp/vscode) into Switchyard on AO.
// Dry run by default; `--apply` writes. See src/migrate/migrate.ts.
import { AoClient } from "../ao/client";
import { migrate } from "../migrate/migrate";
import { type Args, flag, value } from "./args";

export const MIGRATE_HELP = `  migrate [--apply] [--only <id,…>] [--model <provider/id>] [--json]
                                  bring omp Sessions sessions (with their omp history) and organization
                                  into AO; dry run unless --apply (backs up ~/.omp/vscode first, never
                                  deletes; safe to repeat); --model: continue them on another model`;

export async function cmdMigrate(args: Args): Promise<number> {
	const apply = flag(args, "apply");
	const json = flag(args, "json");
	const only = value(args, "only")
		?.split(",")
		.map(s => s.trim())
		.filter(Boolean);
	const model = value(args, "model");
	let client: AoClient | undefined;
	try {
		client = await AoClient.connect({ start: apply });
	} catch (err) {
		if (apply) throw err;
		if (!json) process.stdout.write("AO daemon not running: the dry run cannot tell which AO projects exist yet.\n");
	}
	const report = await migrate({ apply, client, ...(only?.length && { only }), ...(model && { model }), ...(!json && { log: (line: string) => process.stdout.write(`${line}\n`) }) });
	if (json) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
	return report.sessions.some(s => s.kind === "failed") ? 1 : 0;
}
