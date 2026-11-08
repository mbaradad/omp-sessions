// The one-time move from the `omp-vs` command (0.5.0 and earlier) to `omp-sessions`: old launcher
// and service paths, rewriting their text, moving a launcher we installed (never someone else's) and
// replacing the systemd service (systemctl faked through the exec seam).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { LAUNCHER_MARK, launcherPath, launcherText } from "../../src/shared/cli-launcher";
import { legacyLauncherPath, legacyServicePaths, migrateLegacyLauncher, migrateLegacyService, renamedLauncherText, renamedServiceText } from "../../src/shared/rename-migration";
import { LAUNCHD_LABEL, SERVICE_DESCRIPTION, serviceUnitPaths, serviceUnitText } from "../../src/shared/server-client";

const temps: string[] = [];
after(() => {
	for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rename-"));
	temps.push(dir);
	return dir;
}

/** The launcher 0.5.0 wrote (shimText then). */
const OLD_SH = `#!/bin/sh\n# omp-vs: ${LAUNCHER_MARK}\nELECTRON_RUN_AS_NODE=1 exec '/opt/code/code' '/home/u/.omp/vscode/runtime/cli.js' "$@"\n`;
const OLD_CMD = `@echo off\r\nrem omp-vs: ${LAUNCHER_MARK}\r\n"C:\\node.exe" "C:\\rt\\cli.js" %*\r\n`;

test("old and new paths: ~/.local/bin, %LOCALAPPDATA% folders, systemd unit, launchd plist", () => {
	assert.equal(legacyLauncherPath("linux", "/home/u", {}), path.join("/home/u", ".local", "bin", "omp-vs"));
	assert.equal(launcherPath("linux", "/home/u", {}), path.join("/home/u", ".local", "bin", "omp-sessions"));
	assert.equal(legacyLauncherPath("win32", "/u", { LOCALAPPDATA: "/la" }), path.join("/la", "omp-vs", "omp-vs.cmd"));
	assert.equal(launcherPath("win32", "/u", { LOCALAPPDATA: "/la" }), path.join("/la", "omp-sessions", "omp-sessions.cmd"));
	assert.equal(launcherPath("win32", "/u", {}), path.join("/u", "AppData", "Local", "omp-sessions", "omp-sessions.cmd"));
	assert.deepEqual(legacyServicePaths("/home/u"), {
		systemd: path.join("/home/u", ".config", "systemd", "user", "omp-vs.service"),
		launchd: path.join("/home/u", "Library", "LaunchAgents", "dev.omp.vs-server.plist"),
	});
	assert.deepEqual(serviceUnitPaths("/home/u"), {
		systemd: path.join("/home/u", ".config", "systemd", "user", "omp-sessions.service"),
		launchd: path.join("/home/u", "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
	});
});

test("renamed launcher text equals what the new version writes for the same node and cli.js", () => {
	const node = { path: "/opt/code/code", electron: true };
	assert.equal(renamedLauncherText(OLD_SH), launcherText(node, "/home/u/.omp/vscode/runtime/cli.js", "linux", {}));
	assert.equal(renamedLauncherText(OLD_CMD), launcherText({ path: "C:\\node.exe", electron: false }, "C:\\rt\\cli.js", "win32", {}));
	assert.equal(renamedLauncherText("#!/bin/sh\nexec mine\n"), "#!/bin/sh\nexec mine\n");
});

test("renamed service text keeps node, script and environment; new description / label", () => {
	const env = ["ELECTRON_RUN_AS_NODE=1", "OMP_VSCODE_HOME=/data", "PATH=/usr/bin"];
	const systemdOld = serviceUnitText("systemd", "/usr/bin/node", "/rt/server.js", env).replace(SERVICE_DESCRIPTION, "omp-vs server (omp Sessions: queued session launcher)");
	assert.equal(renamedServiceText("systemd", systemdOld), serviceUnitText("systemd", "/usr/bin/node", "/rt/server.js", env));
	const launchdOld = serviceUnitText("launchd", "/usr/bin/node", "/rt/server.js", env).replace(`<string>${LAUNCHD_LABEL}</string>`, "<string>dev.omp.vs-server</string>");
	assert.notEqual(launchdOld, serviceUnitText("launchd", "/usr/bin/node", "/rt/server.js", env));
	assert.equal(renamedServiceText("launchd", launchdOld), serviceUnitText("launchd", "/usr/bin/node", "/rt/server.js", env));
});

test("launcher migration: ours moves, the old one goes; idempotent; others' files are never touched", () => {
	const home = temp();
	assert.equal(migrateLegacyLauncher("linux", home, {}), undefined, "nothing old");
	const from = legacyLauncherPath("linux", home, {});
	const to = launcherPath("linux", home, {});
	fs.mkdirSync(path.dirname(from), { recursive: true });
	fs.writeFileSync(from, "#!/bin/sh\nexec something-else\n", { mode: 0o755 });
	assert.equal(migrateLegacyLauncher("linux", home, {}), undefined);
	assert.equal(fs.existsSync(from), true, "not our launcher: left alone");
	assert.equal(fs.existsSync(to), false);

	fs.writeFileSync(from, OLD_SH, { mode: 0o755 });
	assert.deepEqual(migrateLegacyLauncher("linux", home, {}), { from, to });
	assert.equal(fs.existsSync(from), false);
	assert.equal(fs.readFileSync(to, "utf8"), renamedLauncherText(OLD_SH));
	assert.equal(fs.statSync(to).mode & 0o111, 0o111, "executable");
	assert.equal(migrateLegacyLauncher("linux", home, {}), undefined, "second run: nothing to do");

	// Someone else's omp-sessions at the new path: keep both as they are.
	fs.writeFileSync(from, OLD_SH, { mode: 0o755 });
	fs.writeFileSync(to, "#!/bin/sh\nexec theirs\n", { mode: 0o755 });
	assert.equal(migrateLegacyLauncher("linux", home, {}), undefined);
	assert.equal(fs.readFileSync(to, "utf8"), "#!/bin/sh\nexec theirs\n");
	assert.equal(fs.existsSync(from), true);
});

test("launcher migration on Windows removes the old folder once empty", () => {
	const home = temp();
	const env = { LOCALAPPDATA: path.join(home, "la") };
	const from = legacyLauncherPath("win32", home, env);
	fs.mkdirSync(path.dirname(from), { recursive: true });
	fs.writeFileSync(from, OLD_CMD);
	const moved = migrateLegacyLauncher("win32", home, env);
	assert.equal(moved?.to, launcherPath("win32", home, env));
	assert.equal(fs.existsSync(path.dirname(from)), false);
	assert.equal(fs.readFileSync(launcherPath("win32", home, env), "utf8"), renamedLauncherText(OLD_CMD));
});

test("service migration (systemd): stop + remove the old unit, install + start the new one; idempotent", { skip: process.platform === "win32" }, async () => {
	const home = temp();
	const saved = process.env.OMP_VSCODE_HOME;
	process.env.OMP_VSCODE_HOME = path.join(home, "state");
	try {
		const calls: string[] = [];
		const exec = (cmd: string, argv: string[]) => (calls.push(`${cmd} ${argv.join(" ")}`), true);
		assert.equal(await migrateLegacyService("linux", home, exec), undefined, "nothing old");
		assert.equal(await migrateLegacyService("win32", home, exec), undefined, "no services on Windows");
		const old = legacyServicePaths(home).systemd;
		const oldText = serviceUnitText("systemd", "/usr/bin/node", "/rt/server.js", ["PATH=/usr/bin"]).replace(SERVICE_DESCRIPTION, "omp-vs server");
		fs.mkdirSync(path.dirname(old), { recursive: true });
		fs.writeFileSync(old, oldText);
		const r = await migrateLegacyService("linux", home, exec);
		assert.deepEqual(r, { from: old, to: serviceUnitPaths(home).systemd, started: true });
		assert.equal(fs.existsSync(old), false);
		assert.equal(fs.readFileSync(serviceUnitPaths(home).systemd, "utf8"), renamedServiceText("systemd", oldText));
		assert.deepEqual(calls, [
			"systemctl --user disable --now omp-vs.service",
			"systemctl --user daemon-reload",
			"systemctl --user daemon-reload",
			"systemctl --user enable --now omp-sessions.service",
		]);
		assert.equal(fs.existsSync(path.join(home, "state", "rename-migration.lock")), false, "lock released");
		assert.equal(await migrateLegacyService("linux", home, exec), undefined, "second run: nothing to do");
		assert.equal(calls.length, 4);
	} finally {
		if (saved === undefined) delete process.env.OMP_VSCODE_HOME;
		else process.env.OMP_VSCODE_HOME = saved;
	}
});
