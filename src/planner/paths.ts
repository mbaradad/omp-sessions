// Where the planner keeps its state and listens. `<stateRoot>/planner/` (stateRoot: $OMP_VSCODE_HOME or
// ~/.omp/vscode): plan.json, planner.pid, planner.log, planner.sock (or, on Windows, planner.pipe
// naming a random named pipe). Node-only.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function stateRoot(): string {
	return process.env.OMP_VSCODE_HOME || path.join(os.homedir(), ".omp", "vscode");
}

export function plannerDir(): string {
	return path.join(stateRoot(), "planner");
}

export const planPath = (): string => path.join(plannerDir(), "plan.json");
export const pidPath = (): string => path.join(plannerDir(), "planner.pid");
export const logPath = (): string => path.join(plannerDir(), "planner.log");
const pipeFile = (): string => path.join(plannerDir(), "planner.pipe");

const PIPE = /^\\\\\.\\pipe\\omp-planner-[0-9a-f]{32}$/;

/**
 * `<tmp>/ompv-<uid>`: where the socket goes when its normal path exceeds sun_path (~104 bytes). It must
 * be a real folder owned by this user with no group/other access (else another user could swap sockets).
 */
function privateSocketDir(): string {
	const dir = path.join(os.tmpdir(), `ompv-${process.getuid?.() ?? "u"}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = fs.lstatSync(dir);
	const uid = process.getuid?.();
	if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) throw new Error(`unsafe socket folder ${dir}: remove it, or set OMP_VSCODE_HOME or TMPDIR to a shorter path`);
	return dir;
}

/** Where the planner listens: a fixed Unix socket, or a fresh random pipe on Windows (recorded once listening). */
export function listenPath(): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\omp-planner-${crypto.randomBytes(16).toString("hex")}`;
	const preferred = path.join(plannerDir(), "planner.sock");
	if (Buffer.byteLength(preferred) < 100) return preferred;
	const tag = crypto.createHash("sha256").update(stateRoot()).digest("hex").slice(0, 16);
	return path.join(privateSocketDir(), `planner-${tag}.sock`);
}

/** Where clients find the planner (undefined: Windows with no recorded pipe, so none runs). */
export function socketPath(): string | undefined {
	if (process.platform !== "win32") return listenPath();
	try {
		const name = fs.readFileSync(pipeFile(), "utf8").trim();
		return PIPE.test(name) ? name : undefined;
	} catch {
		return undefined;
	}
}

/** Windows: records the pipe this planner listens on. */
export function recordPipe(name: string): void {
	const tmp = `${pipeFile()}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, name, { mode: 0o600 });
	fs.renameSync(tmp, pipeFile());
}

export function forgetPipe(name: string): void {
	if (socketPath() === name) fs.rmSync(pipeFile(), { force: true });
}
