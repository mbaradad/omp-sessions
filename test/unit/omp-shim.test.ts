import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { installOmpShim, ompShimDir, removeOmpShim } from "../../src/shared/omp-extension-install";

const SHIM = path.resolve(process.cwd(), "src/omp-shim/omp");
const posix = process.platform !== "win32";

/** A sandbox: the shim in its own bin dir, a fake `omp` that prints its arguments one per line, an empty Switchyard home. */
function sandbox() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shim-"));
	const bin = path.join(root, "bin");
	const real = path.join(root, "real");
	for (const d of [bin, real, path.join(root, "home")]) fs.mkdirSync(d);
	assert.equal(installOmpShim(SHIM, bin), "installed");
	fs.writeFileSync(path.join(real, "omp"), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
	const home = path.join(root, "home");
	const run = (args: string[], env: Record<string, string> = {}) => {
		const res = spawnSync(path.join(bin, "omp"), args, {
			encoding: "utf8", timeout: 10_000,
			env: { PATH: `${bin}:${real}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, SWITCHYARD_HOME: home, ...env },
		});
		return { args: res.stdout.split("\n").filter(Boolean), status: res.status, stderr: res.stderr };
	};
	return { root, bin, real, home, run };
}

test("not an AO session, or not `omp acp`: plain pass-through", { skip: !posix }, () => {
	const { run, home } = sandbox();
	fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ omp: { extraArgs: ["--profile", "work"] } }));
	assert.deepEqual(run(["acp", "--model", "m"]).args, ["acp", "--model", "m"], "no AO_SESSION_ID");
	assert.deepEqual(run(["--version"], { AO_SESSION_ID: "p-1" }).args, ["--version"], "not acp");
	assert.deepEqual(run(["-p", "hi"], { AO_SESSION_ID: "p-1" }).args, ["-p", "hi"]);
});

test("an AO session's `omp acp` gets machine, project and session flags, in that order", { skip: !posix }, () => {
	const { run, home } = sandbox();
	fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ omp: { extraArgs: ["--profile", "work"] } }));
	fs.mkdirSync(path.join(home, "sessions", "p-1"), { recursive: true });
	fs.writeFileSync(path.join(home, "sessions", "p-1", "omp-args"), "--plan-yolo\n");
	const res = run(["acp", "--approval-mode", "yolo"], { AO_SESSION_ID: "p-1", SWITCHYARD_OMP_ARGS: "--advisor" });
	assert.deepEqual(res.args, ["acp", "--approval-mode", "yolo", "--profile", "work", "--advisor", "--plan-yolo"]);
	assert.deepEqual(run(["acp"], { AO_SESSION_ID: "p-2" }).args, ["acp", "--profile", "work"], "another session has no file");
});

test("values with spaces, quotes and glob characters survive as single arguments (JSON arrays)", { skip: !posix }, () => {
	const { run, home } = sandbox();
	const tricky = ["--append-system-prompt", "it's a \"test\" * $HOME `x`"];
	fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ omp: { extraArgs: tricky } }));
	fs.mkdirSync(path.join(home, "sessions", "p-1"), { recursive: true });
	fs.writeFileSync(path.join(home, "sessions", "p-1", "omp-args"), JSON.stringify(["--note", "two words"]));
	assert.deepEqual(run(["acp"], { AO_SESSION_ID: "p-1", SWITCHYARD_OMP_ARGS: JSON.stringify(["--x", "a b"]) }).args, ["acp", ...tricky, "--x", "a b", "--note", "two words"]);
});

test("any problem means no extra flags, never a failed launch", { skip: !posix }, () => {
	const { run, home } = sandbox();
	fs.writeFileSync(path.join(home, "config.json"), "{ not json");
	assert.deepEqual(run(["acp"], { AO_SESSION_ID: "p-1" }).args, ["acp"], "malformed config");
	fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ omp: { extraArgs: "--profile work" } }));
	assert.deepEqual(run(["acp"], { AO_SESSION_ID: "p-1" }).args, ["acp"], "extraArgs is not an array");
	fs.mkdirSync(path.join(home, "sessions", "p-1"), { recursive: true });
	fs.writeFileSync(path.join(home, "sessions", "p-1", "omp-args"), "[1, 2]");
	assert.deepEqual(run(["acp"], { AO_SESSION_ID: "p-1", SWITCHYARD_OMP_ARGS: "--ok" }).args, ["acp", "--ok"], "bad session file only drops itself");
	assert.deepEqual(run(["acp"], { AO_SESSION_ID: "../etc" }).args, ["acp"], "a session id that is a path is ignored");
});

test("without node or bun only plain-word values apply", { skip: !posix }, () => {
	const s = sandbox();
	const res = spawnSync(path.join(s.bin, "omp"), ["acp"], { encoding: "utf8", timeout: 10_000, env: { PATH: `${s.bin}:${s.real}:/usr/bin:/bin`, HOME: s.root, SWITCHYARD_HOME: s.home, AO_SESSION_ID: "p-1", SWITCHYARD_OMP_ARGS: "--advisor --prewalk" } });
	const hasRuntime = spawnSync("sh", ["-c", "command -v node || command -v bun"], { env: { PATH: "/usr/bin:/bin" } }).stdout.length > 0;
	if (hasRuntime) return; // a runtime on the minimal PATH: the JSON route runs instead, covered above
	assert.deepEqual(res.stdout.split("\n").filter(Boolean), ["acp", "--advisor", "--prewalk"]);
});

test("the real omp is found past the shim's own folder, even when the shim is listed twice", { skip: !posix }, () => {
	const { run, bin, real, root } = sandbox();
	const second = path.join(root, "bin2");
	fs.mkdirSync(second);
	installOmpShim(SHIM, second);
	const res = spawnSync(path.join(bin, "omp"), ["acp"], { encoding: "utf8", timeout: 10_000, env: { PATH: `${bin}:${second}:${real}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, SWITCHYARD_HOME: path.join(root, "home"), AO_SESSION_ID: "p-1", SWITCHYARD_OMP_ARGS: "--advisor" } });
	assert.equal(res.status, 0);
	assert.deepEqual(res.stdout.split("\n").filter(Boolean), ["acp", "--advisor"], "flags applied once");
	assert.equal(run(["x"]).status, 0);
	const nothing = spawnSync(path.join(bin, "omp"), ["acp"], { encoding: "utf8", timeout: 10_000, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root } });
	assert.equal(nothing.status, 127, "no real omp: a clear failure, not a loop");
});

test("the installer never replaces an omp that is not the shim, refreshes its own copy and removes it", { skip: !posix }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shim-inst-"));
	const bin = path.join(root, "bin");
	try {
		assert.equal(installOmpShim(SHIM, bin), "installed");
		assert.equal(fs.statSync(path.join(bin, "omp")).mode & 0o111, 0o111, "executable");
		assert.equal(installOmpShim(SHIM, bin), "unchanged");
		fs.appendFileSync(path.join(bin, "omp"), "# old\n");
		assert.equal(installOmpShim(SHIM, bin), "updated");
		assert.equal(removeOmpShim(bin), true);
		fs.writeFileSync(path.join(bin, "omp"), "#!/bin/sh\necho mine\n");
		assert.equal(installOmpShim(SHIM, bin), "skipped");
		assert.equal(removeOmpShim(bin), false);
		assert.match(fs.readFileSync(path.join(bin, "omp"), "utf8"), /mine/);
		assert.equal(ompShimDir("/x/.switchyard"), path.join("/x/.switchyard", "bin"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
