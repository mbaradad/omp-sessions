import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceServesHome, serviceUnitText } from "../../src/shared/server-client";

const env = (home?: string): string[] => ["ELECTRON_RUN_AS_NODE=1", ...(home ? [`OMP_VSCODE_HOME=${home}`] : []), "PATH=/usr/bin"];

for (const kind of ["systemd", "launchd"] as const) {
	test(`an installed ${kind} service is started only for the state folder it serves`, () => {
		const defaultUnit = serviceUnitText(kind, "/usr/bin/node", "/x/server.js", env());
		const tempUnit = serviceUnitText(kind, "/usr/bin/node", "/x/server.js", env("/tmp/omp a&b"));
		assert.ok(serviceServesHome(defaultUnit, kind, undefined), "default folder, default unit");
		assert.ok(!serviceServesHome(defaultUnit, kind, "/tmp/omp a&b"), "a temp folder (tests) must not start the user's service");
		assert.ok(serviceServesHome(tempUnit, kind, "/tmp/omp a&b"));
		assert.ok(!serviceServesHome(tempUnit, kind, undefined), "the default folder must not start a temp-folder service");
		assert.ok(!serviceServesHome(tempUnit, kind, "/tmp/omp a"), "no prefix matches");
	});
}
