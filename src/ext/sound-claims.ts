// Cross-window dedupe of session sounds (vscode-free, unit-tested): every VS Code window on the machine sees the
// same session transition, and only the first to claim it plays the cue.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Claims older than this are removed by the next claim. */
const CLAIM_TTL_MS = 60_000;

/** Per-user folder of claim files (in the temp folder: claims are only worth something for a minute). */
export function soundClaimsDir(): string {
	let user = "user";
	try {
		user = os.userInfo().username.replace(/[^\w.-]/g, "_") || user;
	} catch {
		/* no passwd entry */
	}
	return path.join(os.tmpdir(), `switchyard-sound-claims-${user}`);
}

/**
 * Claims the cue `key` (session, alert kind and the session's `updatedAt`, so all windows derive the same key):
 * true for exactly one caller, false if another window already claimed it. A claims folder that cannot be
 * written does not silence the cue.
 */
export function claimSound(dir: string, key: string, now = Date.now()): boolean {
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		return true;
	}
	try {
		for (const f of fs.readdirSync(dir)) {
			const file = path.join(dir, f);
			try {
				if (now - fs.statSync(file).mtimeMs > CLAIM_TTL_MS) fs.rmSync(file, { force: true });
			} catch {
				/* removed by another window */
			}
		}
	} catch {
		/* unreadable: claim anyway */
	}
	try {
		fs.writeFileSync(path.join(dir, key.replace(/[^\w.-]/g, "_")), "", { flag: "wx" });
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "EEXIST";
	}
}
