// Whether the pieces that make a Switchyard session's permission mode (and extra omp flags) mean
// something are installed on this machine. Switchyard starts omp in AO's `bypass-permissions` and the
// gate, an omp extension (`mode.js` in the `switchyard` package of omp's agent folder), enforces
// ask/edits/plan from the session's mode file; without it a session reports `ask` and runs unrestricted.
// The `omp` shim (`<SWITCHYARD_HOME>/bin/omp`) is what puts `omp-args` flags on omp's command line.
// Read-only, Node-only: a client checks this before it offers a mode, or says so in `status`.
import * as fs from "node:fs";
import * as path from "node:path";
import { ompExtensionDir } from "../shared/omp-extension-install";
import type { OmpPathOptions } from "../shared/omp-paths";
import { shimDir, switchyardHome } from "./native";

/** The module of the `switchyard` package that is the permission gate (built from src/omp-extension/mode.ts). */
const GATE_MODULE = "mode.js";
/** First lines of the shim carry this marker (src/shared/omp-extension-install.ts). */
const SHIM_MARKER = "switchyard-omp-shim";

export interface AoGateStatus {
	/** The gate extension is installed: omp loads it in every AO-started omp, so mode file `ask`/`edits`/`plan` is enforced. */
	gate: boolean;
	/** The `omp` shim is installed in `<home>/bin`: `omp-args` flags reach omp (the daemon must also have that folder first on its PATH). */
	shim: boolean;
	/** The package folder checked for the gate. */
	extensionDir: string;
	/** The shim file checked. */
	shimFile: string;
}

export function gateStatus(options: { omp?: OmpPathOptions; home?: string } = {}): AoGateStatus {
	const extensionDir = ompExtensionDir(options.omp);
	const shimFile = path.join(shimDir(options.home ?? switchyardHome()), "omp");
	return { gate: gateInstalled(extensionDir), shim: shimInstalled(shimFile), extensionDir, shimFile };
}

function gateInstalled(extensionDir: string): boolean {
	try {
		const manifest: unknown = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf8"));
		const listed = typeof manifest === "object" && manifest !== null && "omp" in manifest && typeof manifest.omp === "object" && manifest.omp !== null && "extensions" in manifest.omp && Array.isArray(manifest.omp.extensions) && manifest.omp.extensions.includes(`./${GATE_MODULE}`);
		return listed && fs.statSync(path.join(extensionDir, GATE_MODULE)).isFile();
	} catch {
		return false;
	}
}

function shimInstalled(shimFile: string): boolean {
	try {
		return fs.readFileSync(shimFile, "utf8").slice(0, 400).includes(SHIM_MARKER);
	} catch {
		return false;
	}
}
