import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { installOmpExtensions } from "../../src/shared/omp-extension-install";

test("installs the shipped modules as one omp package, refreshes them, and drops ones no longer shipped", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ext-install-"));
	const src = path.join(root, "out");
	const dst = path.join(root, "agent", "extensions", "omp-sessions");
	fs.mkdirSync(src);
	fs.writeFileSync(path.join(src, "todos.js"), "export default () => {};\n");
	fs.writeFileSync(path.join(src, "todos.js.map"), "{}");
	try {
		assert.equal(installOmpExtensions(src, dst), true);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dst, "package.json"), "utf8")).omp, { extensions: ["./todos.js"] });
		assert.deepEqual(fs.readdirSync(dst).sort(), ["package.json", "todos.js"]);
		assert.equal(installOmpExtensions(src, dst), false, "nothing to do the second time");

		fs.writeFileSync(path.join(src, "todos.js"), "export default () => { /* v2 */ };\n");
		fs.writeFileSync(path.join(dst, "old.js"), "export default () => {};\n");
		assert.equal(installOmpExtensions(src, dst), true);
		assert.match(fs.readFileSync(path.join(dst, "todos.js"), "utf8"), /v2/);
		assert.deepEqual(fs.readdirSync(dst).sort(), ["package.json", "todos.js"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
