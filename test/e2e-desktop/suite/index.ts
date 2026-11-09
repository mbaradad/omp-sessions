// Entry point of the AO views suite (test/e2e-desktop/run.mjs), loaded by VS Code's extension host.
import * as path from "node:path";
import Mocha from "mocha";

export async function run(): Promise<void> {
	// Real omp turns take seconds to a minute each.
	const mocha = new Mocha({ ui: "bdd", color: true, timeout: 240_000, bail: true });
	mocha.addFile(path.join(__dirname, "desktop.test.js"));
	const { promise, resolve } = Promise.withResolvers<number>();
	mocha.run(resolve);
	const failures = await promise;
	if (failures > 0) throw new Error(`${failures} views e2e test(s) failed`);
}
