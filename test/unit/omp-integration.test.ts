import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ensureOmpIntegration } from "../../src/shared/omp-extension-install";

const posix = process.platform !== "win32";
const SHIM = path.resolve(process.cwd(), "src/omp-shim/omp");

/** A built `out/` (two modules and the shim) plus empty target folders, all in a temp dir. */
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-integration-"));
	const bundleRoot = path.join(root, "out");
	fs.mkdirSync(path.join(bundleRoot, "omp-extension"), { recursive: true });
	fs.mkdirSync(path.join(bundleRoot, "omp-shim"), { recursive: true });
	fs.writeFileSync(path.join(bundleRoot, "omp-extension", "checkpoints.js"), "export default () => {};\n");
	fs.writeFileSync(path.join(bundleRoot, "omp-extension", "mode.js"), "export default () => {};\n");
	fs.copyFileSync(SHIM, path.join(bundleRoot, "omp-shim", "omp"));
	const extensionDir = path.join(root, "agent", "extensions", "switchyard");
	const shimDir = path.join(root, "switchyard", "bin");
	return { root, bundleRoot, extensionDir, shimDir, opts: { bundleRoot, extensionDir, shimDir, env: {} as NodeJS.ProcessEnv } };
}

test("installs the gate package and the shim, then reports up to date; a changed module is refreshed", { skip: !posix }, () => {
	const s = setup();
	try {
		const first = ensureOmpIntegration(s.opts);
		assert.deepEqual([first.installed, first.upToDate, first.error], [["gate", "shim"], false, undefined]);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.extensionDir, "package.json"), "utf8")).omp.extensions, ["./checkpoints.js", "./mode.js"]);
		assert.ok(fs.existsSync(path.join(s.shimDir, "omp")));
		const again = ensureOmpIntegration(s.opts);
		assert.deepEqual([again.installed, again.upToDate, again.error], [[], true, undefined]);
		fs.writeFileSync(path.join(s.bundleRoot, "omp-extension", "mode.js"), "export default () => { /* v2 */ };\n");
		assert.deepEqual(ensureOmpIntegration(s.opts).installed, ["gate"]);
	} finally {
		fs.rmSync(s.root, { recursive: true, force: true });
	}
});

test("a development host installs nothing unless SWITCHYARD_INSTALL_OMP_EXTENSIONS=1; =0 stops even a product", { skip: !posix }, () => {
	const s = setup();
	try {
		const dev = ensureOmpIntegration({ ...s.opts, production: false });
		assert.deepEqual([dev.installed, dev.upToDate, dev.error], [[], false, undefined]);
		assert.match(dev.skipped ?? "", /SWITCHYARD_INSTALL_OMP_EXTENSIONS=1/);
		assert.ok(!fs.existsSync(s.extensionDir) && !fs.existsSync(s.shimDir), "nothing was written");
		assert.deepEqual(ensureOmpIntegration({ ...s.opts, production: false, env: { SWITCHYARD_INSTALL_OMP_EXTENSIONS: "1" } }).installed, ["gate", "shim"]);
		fs.rmSync(path.join(s.root, "agent"), { recursive: true });
		assert.ok(ensureOmpIntegration({ ...s.opts, production: true, env: { SWITCHYARD_INSTALL_OMP_EXTENSIONS: "0" } }).skipped, "=0 forbids it for a product too");
	} finally {
		fs.rmSync(s.root, { recursive: true, force: true });
	}
});

test("a folder that is not writable is reported with its code, never thrown; the other half still installs", { skip: !posix || process.getuid?.() === 0 }, () => {
	const s = setup();
	try {
		const locked = path.join(s.root, "locked");
		fs.mkdirSync(locked);
		fs.chmodSync(locked, 0o555);
		const res = ensureOmpIntegration({ ...s.opts, extensionDir: path.join(locked, "extensions", "switchyard") });
		assert.equal(res.code, "EACCES");
		assert.match(res.error ?? "", /could not install the omp extensions .*EACCES/);
		assert.deepEqual(res.installed, ["shim"], "the shim went in");
		assert.equal(res.upToDate, false);
		const shimLocked = ensureOmpIntegration({ ...s.opts, shimDir: path.join(locked, "bin") });
		assert.equal(shimLocked.code, "EACCES");
		assert.match(shimLocked.error ?? "", /omp shim/);
		fs.chmodSync(locked, 0o755);
	} finally {
		fs.rmSync(s.root, { recursive: true, force: true });
	}
});

test("a missing build and an omp that is not the shim are reported, not thrown", { skip: !posix }, () => {
	const s = setup();
	try {
		const none = ensureOmpIntegration({ ...s.opts, bundleRoot: path.join(s.root, "nowhere") });
		assert.deepEqual(none.installed, []);
		assert.match(none.error ?? "", /ENOENT/);
		fs.mkdirSync(s.shimDir, { recursive: true });
		fs.writeFileSync(path.join(s.shimDir, "omp"), "#!/bin/sh\necho mine\n");
		const foreign = ensureOmpIntegration(s.opts);
		assert.deepEqual(foreign.installed, ["gate"]);
		assert.match(foreign.error ?? "", /not Switchyard's/);
		assert.match(fs.readFileSync(path.join(s.shimDir, "omp"), "utf8"), /mine/);
	} finally {
		fs.rmSync(s.root, { recursive: true, force: true });
	}
});
