import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { installOmpExtensions, removeLegacyOmpExtensions } from "../../src/shared/omp-extension-install";

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

test("the pre-rename omp-sessions package is removed so its modules don't load twice; a folder of that name we didn't write stays", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ext-legacy-"));
	const extensions = path.join(root, "agent", "extensions");
	const legacy = path.join(extensions, "omp-sessions");
	fs.mkdirSync(legacy, { recursive: true });
	try {
		fs.writeFileSync(path.join(legacy, "package.json"), JSON.stringify({ name: "someone-else" }));
		assert.equal(removeLegacyOmpExtensions(path.join(extensions, "switchyard")), false);
		assert.ok(fs.existsSync(legacy));
		fs.writeFileSync(path.join(legacy, "package.json"), JSON.stringify({ name: "omp-sessions", private: true, omp: { extensions: ["./todos.js"] } }));
		assert.equal(removeLegacyOmpExtensions(path.join(extensions, "switchyard")), true);
		assert.ok(!fs.existsSync(legacy));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the bridge's pre-rename folder is removed; its current switchyard-bridge extension and other folders stay", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ext-bridge-"));
	const extensions = path.join(root, "agent", "extensions");
	try {
		const bridge = path.join(extensions, "omp-vscode-bridge");
		const current = path.join(extensions, "switchyard-bridge");
		const other = path.join(extensions, "mine");
		const code = "// bridge\npi.registerTool({ name: `mcp__${n}_x`, mcpServerName: n });\n";
		for (const d of [bridge, current, other]) fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(bridge, "index.js"), code);
		fs.writeFileSync(path.join(current, "index.js"), code);
		fs.writeFileSync(path.join(other, "index.js"), "export default () => {}; // someone's own\n");
		assert.equal(removeLegacyOmpExtensions(path.join(extensions, "switchyard")), true);
		assert.ok(!fs.existsSync(bridge));
		assert.ok(fs.existsSync(current), "the bridge's own current extension is not ours to remove");
		assert.ok(fs.existsSync(other), "an extension that is not the bridge stays");
		assert.equal(removeLegacyOmpExtensions(path.join(extensions, "switchyard")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
