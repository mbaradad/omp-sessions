// First-run offer for `migrate` (MAPPING D9, Q2): a person who used omp Sessions has settings under
// ~/.omp/vscode (groups, board lanes, defaults); `migrate` copies them to ~/.switchyard. Offered once while
// ~/.omp/vscode exists and migrate has never written (`<switchyard home>/migration.json` is its marker).
// The dry run changes nothing; the offer only opens it in a terminal.
import * as fs from "node:fs";
import * as path from "node:path";

/** What omp Sessions leaves in ~/.omp/vscode that `migrate` reads (the folder alone proves nothing: the extension's own runtime copy lives there too). */
const OLD_DATA = ["organize.json", "launcher.json", "scheduler.json", "sessions"];

/** Whether the old state holds data and `migrate` has not written anything yet. */
export function migrationPending(oldRoot: string, switchyardHome: string, exists: (p: string) => boolean = fs.existsSync): boolean {
	return OLD_DATA.some(f => exists(path.join(oldRoot, f))) && !exists(path.join(switchyardHome, "migration.json"));
}
