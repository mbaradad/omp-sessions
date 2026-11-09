// `omp-sessions omp-extension` and the automatic refresh: the bundles that ship next to cli.js are copied into
// omp's agent folder and the Switchyard bin folder, refreshed when they differ, and removed again (G38).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { writeSwitchyardConfig } from "../../src/ao/config";
import { bundlesAt, ensureBundles, extensionReport, installBundles, uninstallBundles } from "../../src/cli/extension";

/** A machine of its own: omp's agent folder and Switchyard's home in a temp dir, and a build that ships two modules and the shim. */
function machine<T>(fn: (m: { shipped: string; agent: string; home: string }) => T): T {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-ext-"));
	const saved = { agent: process.env.PI_CODING_AGENT_DIR, home: process.env.SWITCHYARD_HOME };
	const agent = path.join(root, "agent");
	const home = path.join(root, "switchyard");
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.SWITCHYARD_HOME = home;
	const shipped = path.join(root, "out");
	fs.mkdirSync(path.join(shipped, "omp-extension"), { recursive: true });
	fs.mkdirSync(path.join(shipped, "omp-shim"), { recursive: true });
	fs.writeFileSync(path.join(shipped, "omp-extension", "mode.js"), "// gate 1\n");
	fs.writeFileSync(path.join(shipped, "omp-extension", "checkpoints.js"), "// checkpoints 1\n");
	fs.writeFileSync(path.join(shipped, "omp-shim", "omp"), "#!/bin/sh\n# switchyard-omp-shim 1\n");
	try {
		return fn({ shipped, agent, home });
	} finally {
		for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agent], ["SWITCHYARD_HOME", saved.home]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("install puts the gate and the shim in place; a changed bundle makes the report older and ensureBundles refreshes it once", () =>
	machine(({ shipped, agent, home }) => {
		const bundles = bundlesAt(shipped);
		assert.deepEqual(bundlesAt(path.join(shipped, "nowhere")), {}, "a build that ships nothing");
		const before = extensionReport(undefined, bundles);
		assert.equal(before.installed, false);
		assert.equal(before.shim.installed, false);
		assert.equal(before.shim.inEffect, false, "not installed: not in effect");
		assert.equal(before.shipped, true);

		const result = installBundles(bundles);
		assert.equal(result.extensions, true);
		assert.equal(result.shim, "installed");
		const after = extensionReport(undefined, bundles);
		assert.equal(after.installed, true, "the gate counts only when the package lists mode.js");
		assert.deepEqual(after.modules, ["checkpoints.js", "mode.js"]);
		assert.equal(after.current && after.shim.current && after.shim.installed, true);
		assert.equal(after.shim.inEffect, undefined, "installed, but no daemon to read a PATH from: not claimed either way");
		// A daemon whose PATH starts elsewhere (this test process: its own PATH) does not have the shim first.
		const against = extensionReport(process.pid, bundles).shim;
		assert.deepEqual([against.onDaemonPath, against.inEffect], [false, false]);
		assert.ok(fs.statSync(path.join(home, "bin", "omp")).mode & 0o100, "the shim is executable");
		assert.equal(fs.existsSync(path.join(agent, "extensions", "switchyard", "package.json")), true);

		// The build changes: the installed copy is older until it is refreshed, and a refresh is not a "first install".
		fs.writeFileSync(path.join(shipped, "omp-extension", "mode.js"), "// gate 2\n");
		assert.equal(extensionReport(undefined, bundles).current, false);
		assert.equal(ensureBundles(bundles)?.firstInstall, false, "a refresh is not a first install, so nothing is announced");
		assert.equal(extensionReport(undefined, bundles).current, true);
		assert.equal(fs.readFileSync(path.join(agent, "extensions", "switchyard", "mode.js"), "utf8"), "// gate 2\n");
		assert.equal(ensureBundles(bundles), undefined, "nothing to do the second time");
	}));

test("ensureBundles reports the first install; config omp-extension off stops it; uninstall removes what install wrote and leaves a foreign omp alone", () =>
	machine(({ shipped, home }) => {
		const bundles = bundlesAt(shipped);
		writeSwitchyardConfig({ ompExtension: "off" });
		assert.equal(ensureBundles(bundles), undefined);
		assert.equal(extensionReport(undefined, bundles).installed, false, "off: nothing installed by itself");
		assert.equal(extensionReport(undefined, bundles).auto, "off");

		writeSwitchyardConfig({ ompExtension: undefined });
		// Test and dev runs pin SWITCHYARD_INSTALL_OMP_EXTENSIONS=0: the shared omp agent folder is never written by itself.
		process.env.SWITCHYARD_INSTALL_OMP_EXTENSIONS = "0";
		try {
			assert.equal(ensureBundles(bundles), undefined);
			assert.equal(extensionReport(undefined, bundles).installed, false);
		} finally {
			delete process.env.SWITCHYARD_INSTALL_OMP_EXTENSIONS;
		}
		const first = ensureBundles(bundles);
		assert.equal(first?.firstInstall, true);
		assert.equal(extensionReport(undefined, bundles).installed, true);

		assert.deepEqual(uninstallBundles(), { extensions: true, shim: true });
		assert.equal(extensionReport(undefined, bundles).installed, false);
		assert.deepEqual(uninstallBundles(), { extensions: false, shim: false });

		// A file called omp that isn't the shim is never replaced or removed.
		fs.mkdirSync(path.join(home, "bin"), { recursive: true });
		fs.writeFileSync(path.join(home, "bin", "omp"), "#!/bin/sh\nexec real-omp\n");
		assert.equal(installBundles(bundles).shim, "skipped");
		assert.equal(uninstallBundles().shim, false);
		assert.equal(fs.readFileSync(path.join(home, "bin", "omp"), "utf8"), "#!/bin/sh\nexec real-omp\n");
	}));
