// Entry point loaded by VS Code's extension host via --extensionTestsPath.
import * as path from "node:path";
import Mocha from "mocha";

export async function run(): Promise<void> {
	const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60_000, bail: true });
	mocha.addFile(path.join(__dirname, "session.test.js"));
	const { promise, resolve } = Promise.withResolvers<number>();
	mocha.run(resolve);
	const failures = await promise;
	if (failures > 0) throw new Error(`${failures} desktop e2e test(s) failed`);
}
