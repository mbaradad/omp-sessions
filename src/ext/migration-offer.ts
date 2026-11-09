// First-run offer for `migrate` (MAPPING D9, Q2): a person who used omp Sessions has settings under
// ~/.omp/vscode (groups, board lanes, defaults); `migrate` copies them to ~/.switchyard. Offered once while
// ~/.omp/vscode holds data and migrate has not finished (`completedAt` in `<switchyard home>/migration.json`).
// The dry run changes nothing; the offer only opens it in a terminal.
import * as fs from "node:fs";
import * as path from "node:path";

/** What omp Sessions leaves in ~/.omp/vscode that `migrate` reads (the folder alone proves nothing: the extension's own runtime copy lives there too). */
const OLD_DATA = ["organize.json", "launcher.json", "scheduler.json", "sessions"];

/** `migrate --apply` writes `completedAt` into migration.json when nothing is left to do (never in a dry run, never while the scheduler waits for the planner). */
function migrationDone(file: string, read: (p: string) => string): boolean {
	try {
		const marker: unknown = JSON.parse(read(file));
		return typeof marker === "object" && marker !== null && "completedAt" in marker && typeof marker.completedAt === "string";
	} catch {
		return false;
	}
}

/** Whether the old state holds data and `migrate` has not finished. */
export function migrationPending(
	oldRoot: string,
	switchyardHome: string,
	exists: (p: string) => boolean = fs.existsSync,
	read: (p: string) => string = p => fs.readFileSync(p, "utf8"),
): boolean {
	return OLD_DATA.some(f => exists(path.join(oldRoot, f))) && !migrationDone(path.join(switchyardHome, "migration.json"), read);
}
