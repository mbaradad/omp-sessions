// Crash-safe persistence of the plan: one JSON file replaced atomically (temp file, fsync, rename,
// fsync of the folder), so a crash or power loss leaves either the old or the new plan, never a torn
// one. Every write happens before the AO call it guards (see TaskRun). Node-only.
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyState, normalizeState } from "./engine";
import type { PlanState } from "./types";

export function loadPlan(file: string): PlanState {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") return emptyState();
		throw err;
	}
	try {
		return normalizeState(JSON.parse(text));
	} catch (err) {
		// Never silently start over on top of a plan we can't read: keep it aside and say so.
		const aside = `${file}.corrupt-${Date.now()}`;
		fs.copyFileSync(file, aside);
		throw new Error(`plan file ${file} is not valid JSON (${String(err)}); a copy is at ${aside}`);
	}
}

export function savePlan(file: string, state: PlanState): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	const fd = fs.openSync(tmp, "w", 0o600);
	try {
		fs.writeSync(fd, JSON.stringify(state));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, file);
	if (process.platform !== "win32") {
		const dfd = fs.openSync(dir, "r");
		try {
			fs.fsyncSync(dfd);
		} finally {
			fs.closeSync(dfd);
		}
	}
}
