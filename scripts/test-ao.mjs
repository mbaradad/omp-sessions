// `npm run test:ao`: the live src/ao contract test, always under an isolated HOME (CONTRACT.md,
// "Isolated HOME"): nothing it or a started daemon writes can reach the user's real global state.
// The shared dev daemon is found through the real run file (read-only); set AO_RUN_FILE/AO_PORT to
// aim at another daemon, e.g. test-infra's fixture (its `clientEnv`).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const realHome = os.userInfo().homedir;
const root = "/tmp/ao-smoke-foundation";
const home = path.join(root, "home");
for (const dir of [".config", ".local/share", ".local/state"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
const env = {
	...process.env,
	HOME: home,
	XDG_CONFIG_HOME: path.join(home, ".config"),
	XDG_DATA_HOME: path.join(home, ".local/share"),
	XDG_STATE_HOME: path.join(home, ".local/state"),
	OMP_VSCODE_HOME: path.join(home, "omp-vscode"),
	SWITCHYARD_HOME: path.join(home, "switchyard"),
};
if (!env.AO_RUN_FILE && !env.AO_PORT) env.AO_RUN_FILE = path.join(realHome, ".ao", "running.json");
const result = spawnSync(process.execPath, ["test/run.mjs", "ao", ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(result.status ?? 1);
