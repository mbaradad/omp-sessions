import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
	acquireInstallLock,
	bundleNewer,
	changedFiles,
	compareVersions,
	configPluginStatus,
	configValue,
	dispatcherConfigured,
	enablePlugin,
	findHermes,
	findOmpSessions,
	gatewayPath,
	hermesCommand,
	hermesHome,
	hermesLookup,
	hermesRoot,
	installPlugin,
	listProfiles,
	parseLaneStatus,
	pluginReport,
	pluginState,
	pluginTarget,
	pluginVersion,
	reportLine,
	resolveTargets,
	runningDashboardUrl,
	staleCopies,
	uninstallPlugin,
	updateLines,
	updatePlugin,
} from "../../src/shared/hermes-plugin";

const temps: string[] = [];
after(() => {
	for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hermes-plugin-"));
	temps.push(dir);
	return dir;
}

/** A plugin folder like out/hermes-plugin/omp-sessions. */
function bundle(root: string, version: string): string {
	const dir = path.join(root, "bundle", "omp-sessions");
	fs.mkdirSync(path.join(dir, "skills", "omp-sessions"), { recursive: true });
	fs.writeFileSync(path.join(dir, "plugin.yaml"), `name: omp-sessions\nversion: ${version}\n`);
	fs.writeFileSync(path.join(dir, "__init__.py"), `VERSION = "${version}"\n`);
	fs.writeFileSync(path.join(dir, "skills", "omp-sessions", "SKILL.md"), "---\nname: omp-sessions\n---\n");
	return dir;
}

test("hermes home and plugin folder follow HERMES_HOME; a profile home's root is two levels up", () => {
	assert.equal(hermesHome({}, "/home/u"), path.join("/home/u", ".hermes"));
	assert.equal(hermesHome({ HERMES_HOME: "/tmp/h" }, "/home/u"), "/tmp/h");
	assert.equal(hermesRoot({ HERMES_HOME: "/tmp/h" }, "/home/u"), "/tmp/h");
	assert.equal(hermesRoot({ HERMES_HOME: "/tmp/h/profiles/work" }, "/home/u"), "/tmp/h");
	assert.equal(pluginTarget("/tmp/h"), path.join("/tmp/h", "plugins", "omp-sessions"));
});

test("hermes home and root follow Hermes's rules: Windows default, data-dir suffix, ~, a HERMES_HOME inside the default home", () => {
	assert.equal(hermesHome({ LOCALAPPDATA: "/c/Users/u/AppData/Local" }, "/c/Users/u", "win32"), path.join("/c/Users/u/AppData/Local", "hermes"));
	assert.equal(hermesHome({}, "/c/Users/u", "win32"), path.join("/c/Users/u", "AppData", "Local", "hermes"));
	assert.equal(hermesRoot({ LOCALAPPDATA: "/la" }, "/c/Users/u", "win32"), path.join("/la", "hermes"));
	assert.equal(hermesHome({ HERMES_DATA_DIR_SUFFIX: "-dev" }, "/home/u"), path.join("/home/u", ".hermes-dev"));
	assert.equal(hermesHome({ HERMES_HOME: "~/hh" }, "/home/u"), path.join("/home/u", "hh"));
	assert.equal(hermesHome({ HERMES_HOME: "  " }, "/home/u"), path.join("/home/u", ".hermes"), "blank HERMES_HOME is unset");
	assert.equal(hermesRoot({ HERMES_HOME: "/home/u/.hermes/profiles/work" }, "/home/u"), path.join("/home/u", ".hermes"));
	assert.equal(hermesRoot({ HERMES_HOME: "/home/u/.hermes/sandbox" }, "/home/u"), path.join("/home/u", ".hermes"), "inside the default home: the default root");
	assert.equal(hermesRoot({ HERMES_HOME: "/srv/hermes" }, "/home/u"), "/srv/hermes", "a custom root");
	assert.deepEqual(resolveTargets({}, { HERMES_HOME: "/srv/hermes" }, "/home/u"), [{ label: "default", home: "/srv/hermes", profile: "default" }]);
	assert.equal(hermesLookup({ LOCALAPPDATA: "/la" }, "/c/Users/u", "win32"), `PATH, ${path.join("/la", "hermes", "bin")}`);
	assert.equal(hermesLookup({}, "/home/u", "linux"), "PATH, ~/.local/bin");
});

/** A fake ~/.hermes: real profiles (identity files), a bare folder, a deleted profile, a bad name. */
function profileTree(): { home: string; root: string } {
	const home = temp();
	const root = path.join(home, ".hermes");
	const mk = (name: string, file?: string) => {
		fs.mkdirSync(path.join(root, "profiles", name), { recursive: true });
		if (file) fs.writeFileSync(path.join(root, "profiles", name, file), "");
	};
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "config.yaml"), "");
	mk("lightscale", "config.yaml");
	mk("zynq-proto", "SOUL.md");
	mk("logs-only");
	mk("gone", "config.yaml");
	fs.mkdirSync(path.join(root, "profiles", ".deleted", "gone"), { recursive: true });
	mk("Bad Name", "config.yaml");
	return { home, root };
}

test("profiles: identity files make a profile; bare, deleted and badly named folders don't", () => {
	const { root } = profileTree();
	assert.deepEqual(listProfiles(root), ["lightscale", "zynq-proto"]);
	assert.deepEqual(listProfiles(path.join(root, "nope")), []);
});

test("targets: no flag is the default home; --profile and --all-profiles resolve real profiles only", () => {
	const { home, root } = profileTree();
	assert.deepEqual(resolveTargets({}, {}, home), [{ label: "default", home: root, profile: "default" }]);
	assert.deepEqual(resolveTargets({}, { HERMES_HOME: path.join(root, "profiles", "lightscale") }, home), [{ label: "lightscale", home: path.join(root, "profiles", "lightscale"), profile: "lightscale" }]);
	assert.deepEqual(resolveTargets({ profiles: ["lightscale"] }, {}, home), [{ label: "lightscale", home: path.join(root, "profiles", "lightscale"), profile: "lightscale" }]);
	assert.deepEqual(
		resolveTargets({ all: true }, {}, home).map(t => [t.label, t.profile, path.relative(root, t.home)]),
		[
			["default", "default", ""],
			["lightscale", "lightscale", path.join("profiles", "lightscale")],
			["zynq-proto", "zynq-proto", path.join("profiles", "zynq-proto")],
		],
	);
	assert.deepEqual(
		resolveTargets({ all: true, profiles: ["lightscale", "default"] }, {}, home).map(t => t.label),
		["default", "lightscale", "zynq-proto"],
		"no duplicates",
	);
	// From inside a profile, --profile still resolves against the shared root.
	assert.equal(resolveTargets({ profiles: ["zynq-proto"] }, { HERMES_HOME: path.join(root, "profiles", "lightscale") }, home)[0].home, path.join(root, "profiles", "zynq-proto"));
	for (const bad of ["logs-only", "gone", "Bad Name", "missing"]) assert.throws(() => resolveTargets({ profiles: [bad] }, {}, home), /no Hermes profile/, bad);
});

test("dispatcherConfigured: only an explicit kanban.dispatch_in_gateway: true", () => {
	const dir = temp();
	const cfg = (text: string) => {
		fs.writeFileSync(path.join(dir, "config.yaml"), text);
		return dispatcherConfigured(dir);
	};
	assert.equal(dispatcherConfigured(path.join(dir, "missing")), false);
	assert.equal(cfg("kanban:\n  dispatch_interval_seconds: 60\n  dispatch_in_gateway: true\nmodel: x\n"), true);
	assert.equal(cfg("kanban:\n  dispatch_in_gateway: false\n"), false);
	assert.equal(cfg("other:\n  dispatch_in_gateway: true\nkanban:\n  x: 1\n"), false);
	assert.equal(cfg("model: x\n"), false);
});

test("install copies the plugin, reports unchanged/updated, and never replaces a folder it didn't write unless forced", () => {
	const root = temp();
	const target = pluginTarget(path.join(root, "hermes"));
	const v1 = bundle(root, "1");
	assert.deepEqual(pluginState(v1, target), { installed: false, managed: false, current: false });
	assert.equal(installPlugin(v1, target), "installed");
	assert.deepEqual(pluginState(v1, target), { installed: true, managed: true, current: true });
	assert.ok(fs.existsSync(path.join(target, "skills", "omp-sessions", "SKILL.md")));
	// Python caches inside the installed copy don't make it stale.
	fs.mkdirSync(path.join(target, "__pycache__"));
	fs.writeFileSync(path.join(target, "__pycache__", "x.pyc"), "");
	assert.equal(installPlugin(v1, target), "unchanged");

	const v2 = bundle(path.join(root, "next"), "2");
	assert.equal(pluginState(v2, target).current, false);
	assert.equal(installPlugin(v2, target), "updated");
	assert.equal(fs.readFileSync(path.join(target, "__init__.py"), "utf8"), 'VERSION = "2"\n');
	assert.deepEqual(fs.readdirSync(path.dirname(target)), ["omp-sessions"], "no temp folders left behind");

	assert.equal(uninstallPlugin(target), true);
	assert.equal(fs.existsSync(target), false);

	fs.mkdirSync(target, { recursive: true });
	fs.writeFileSync(path.join(target, "plugin.yaml"), "name: omp-sessions\n# someone else's\n");
	assert.equal(installPlugin(v2, target), "skipped");
	assert.equal(uninstallPlugin(target), false, "not ours: left alone");
	assert.ok(fs.existsSync(path.join(target, "plugin.yaml")));
	assert.equal(installPlugin(v2, target, { force: true }), "updated");
	assert.deepEqual(pluginState(v2, target), { installed: true, managed: true, current: true });
});

test("install refuses a missing bundle", () => {
	const root = temp();
	assert.throws(() => installPlugin(path.join(root, "nope"), pluginTarget(root)), /bundled Hermes plugin is missing/);
});

const HERMES_CONFIG = `# Hermes config
model:
  default: x   # comment
plugins:
  # Deadline for each Git clone
  clone_timeout_seconds: 300
  enabled:
    - account-pool
    - "omp-sessions"
  disabled: []
  entries:
    omp-sessions:
      allow_gateway_injection: true
      settings:
        omp_sessions: '~/bin/omp-sessions'
        lane:
          boards:
            lightscale:
              folder: /home/me/src/lightscale
          enabled: true
    other:
      allow_gateway_injection: false
kanban:
  dispatch_in_gateway: true
url: http://localhost:9119/x # with a colon
`;

test("configValue reads scalars, lists and nested keys of the block YAML Hermes writes", () => {
	assert.equal(configValue(HERMES_CONFIG, ["model", "default"]), "x");
	assert.deepEqual(configValue(HERMES_CONFIG, ["plugins", "enabled"]), ["account-pool", "omp-sessions"]);
	assert.deepEqual(configValue(HERMES_CONFIG, ["plugins", "disabled"]), []);
	assert.equal(configValue(HERMES_CONFIG, ["plugins", "entries", "omp-sessions", "allow_gateway_injection"]), "true");
	assert.equal(configValue(HERMES_CONFIG, ["plugins", "entries", "other", "allow_gateway_injection"]), "false");
	assert.equal(configValue(HERMES_CONFIG, ["plugins", "entries", "omp-sessions", "settings", "lane", "enabled"]), "true");
	assert.equal(configValue(HERMES_CONFIG, ["plugins", "entries", "omp-sessions", "settings", "omp_sessions"]), "~/bin/omp-sessions");
	assert.equal(configValue(HERMES_CONFIG, ["url"]), "http://localhost:9119/x");
	assert.equal(configValue(HERMES_CONFIG, ["plugins", "entries"]), undefined, "a mapping");
	assert.equal(configValue(HERMES_CONFIG, ["plugins", "entries", "missing", "x"]), undefined);
	assert.equal(configValue(HERMES_CONFIG, ["lane", "enabled"]), undefined, "only at the right depth");
	// Indentless lists (PyYAML's default dump) and a disable winning over the allow-list.
	const dumped = "plugins:\n  enabled:\n  - omp-sessions\n  disabled:\n  - omp-sessions\n  - x\nother: 1\n";
	assert.deepEqual(configValue(dumped, ["plugins", "disabled"]), ["omp-sessions", "x"]);
	assert.equal(configPluginStatus(dumped), "disabled");
	assert.equal(configPluginStatus(HERMES_CONFIG), "enabled");
	assert.equal(configPluginStatus("plugins:\n  enabled: [a, b]\n"), "not enabled");
});

test("pluginReport reads status, lane, notifications and omp_sessions from the profile's config.yaml", () => {
	const root = temp();
	const v1 = bundle(root, "1");
	const home = path.join(root, "hermes");
	const t = { label: "default", home, profile: "default" };
	assert.deepEqual(pluginReport(v1, t), { label: "default", home, target: pluginTarget(home), state: { installed: false, managed: false, current: false } });
	installPlugin(v1, pluginTarget(home));
	fs.writeFileSync(path.join(home, "config.yaml"), HERMES_CONFIG);
	const r = pluginReport(v1, t);
	assert.deepEqual([r.status, r.lane, r.injection, r.ompSessions], ["enabled", true, true, "~/bin/omp-sessions"]);
	fs.writeFileSync(path.join(home, "config.yaml"), "plugins:\n  enabled: []\n");
	const off = pluginReport(v1, t);
	assert.deepEqual([off.status, off.lane, off.injection], ["not enabled", undefined, undefined]);
});

test("a copy 0.5.0 and earlier installed (the old marker file) stays ours: updated, uninstalled, re-marked", () => {
	const root = temp();
	const v1 = stamp(bundle(root, "1.0.0"), 1000);
	const v2 = stamp(bundle(path.join(root, "next"), "1.2.0"), 1000);
	const t = { label: "default", home: path.join(root, "hermes"), profile: "default" };
	const dir = pluginTarget(t.home);
	fs.cpSync(v1, dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".managed-by-omp-vs"), "Installed by omp-vs (omp-vs hermes install); replaced on update.\nversion: 1.0.0\nstamp: 1000000\n");
	assert.deepEqual(pluginState(v1, dir), { installed: true, managed: true, current: true });
	assert.deepEqual(staleCopies(v2, [t]).map(x => x.label), ["default"]);
	assert.equal(installPlugin(v2, dir, { onlyIfNewer: true }), "updated");
	assert.equal(fs.existsSync(path.join(dir, ".managed-by-omp-vs")), false);
	assert.equal(fs.existsSync(path.join(dir, ".managed-by-omp-sessions")), true);
	fs.renameSync(path.join(dir, ".managed-by-omp-sessions"), path.join(dir, ".managed-by-omp-vs"));
	assert.equal(uninstallPlugin(dir), true);
	assert.equal(fs.existsSync(dir), false);
});

/** Sets every file's mtime under `dir` (the build stamp). */
function stamp(dir: string, seconds: number): string {
	for (const f of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (f.isFile()) fs.utimesSync(path.join(f.parentPath, f.name), seconds, seconds);
	return dir;
}

test("staleCopies: managed copies the bundle is newer than (version, then build stamp); never a downgrade", () => {
	const root = temp();
	const v1 = stamp(bundle(root, "1.0.0"), 1000);
	const v2 = stamp(bundle(path.join(root, "next"), "1.2.0"), 1000);
	const t = (label: string) => ({ label, home: path.join(root, label), profile: label });
	installPlugin(v1, pluginTarget(t("old").home));
	installPlugin(v2, pluginTarget(t("current").home));
	fs.mkdirSync(pluginTarget(t("git").home), { recursive: true });
	fs.writeFileSync(path.join(pluginTarget(t("git").home), "plugin.yaml"), "name: omp-sessions\nversion: 0\n");
	assert.deepEqual(staleCopies(v2, [t("old"), t("current"), t("git"), t("none")]).map(x => x.label), ["old"]);
	assert.deepEqual(changedFiles(v2, pluginTarget(t("old").home)), ["__init__.py", "plugin.yaml"]);
	assert.equal(pluginVersion(v2), "1.2.0");

	// An older extension (v1 bundle) leaves the newer copy alone, and says why.
	assert.deepEqual(staleCopies(v1, [t("current")]), []);
	assert.equal(pluginReport(v1, t("current")).ahead, true);
	assert.equal(installPlugin(v1, pluginTarget(t("current").home), { onlyIfNewer: true }), "unchanged", "no downgrade inside the lock either");
	assert.equal(pluginVersion(pluginTarget(t("current").home)), "1.2.0");

	// Same version, different files: only a later build replaces it.
	const sameOlder = stamp(bundle(path.join(root, "same-older"), "1.2.0"), 500);
	fs.appendFileSync(path.join(sameOlder, "__init__.py"), "# older build\n");
	stamp(sameOlder, 500);
	const sameNewer = stamp(bundle(path.join(root, "same-newer"), "1.2.0"), 2000);
	fs.appendFileSync(path.join(sameNewer, "__init__.py"), "# newer build\n");
	stamp(sameNewer, 2000);
	assert.equal(bundleNewer(sameOlder, pluginTarget(t("current").home)), false);
	assert.equal(bundleNewer(sameNewer, pluginTarget(t("current").home)), true);
	assert.equal(installPlugin(sameNewer, pluginTarget(t("current").home), { onlyIfNewer: true }), "updated");
	assert.equal(bundleNewer(sameOlder, pluginTarget(t("current").home)), false, "the marker now records the newer build");
	assert.equal(bundleNewer(v2, pluginTarget(t("current").home)), false);
	// A manual install may still replace it with whatever this omp-sessions bundles.
	assert.equal(installPlugin(v1, pluginTarget(t("current").home)), "updated");
});

test("compareVersions orders dotted versions numerically", () => {
	assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
	assert.equal(compareVersions("0.6.0", "0.6"), 0);
	assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
});

test("install lock: a live holder makes installs busy; a dead or old lock is taken over", { skip: process.platform === "win32" }, () => {
	const root = temp();
	const v1 = bundle(root, "1");
	const target = pluginTarget(path.join(root, "hermes"));
	const plugins = path.dirname(target);
	const lockFile = path.join(plugins, ".omp-sessions.install.lock");
	const release = acquireInstallLock(plugins);
	assert.ok(release);
	assert.equal(acquireInstallLock(plugins), undefined, "held by this live process");
	assert.equal(installPlugin(v1, target), "busy");
	assert.equal(fs.existsSync(target), false, "nothing touched while busy");
	release();
	assert.equal(fs.existsSync(lockFile), false);

	// A crashed holder (dead pid) and an old lock (pid reused, past the limit) are stale.
	fs.writeFileSync(lockFile, `999999999 ${Date.now()} x\n`);
	assert.equal(installPlugin(v1, target), "installed");
	assert.equal(fs.existsSync(lockFile), false);
	fs.writeFileSync(lockFile, `${process.pid} ${Date.now() - 11 * 60_000} x\n`);
	const late = acquireInstallLock(plugins);
	assert.ok(late, "older than 10 minutes");
	late();

	const u = updatePlugin(v1, { label: "w", home: path.join(root, "hermes"), profile: "w" }, undefined);
	assert.equal(u.outcome, "unchanged");
	fs.writeFileSync(lockFile, `${process.pid} ${Date.now()} other-window\n`);
	const busy = updatePlugin(bundle(path.join(root, "v2"), "2"), { label: "w", home: path.join(root, "hermes"), profile: "w" }, "/nonexistent/hermes");
	assert.deepEqual([busy.outcome, busy.reload, busy.enable], ["busy", undefined, undefined]);
	assert.deepEqual(updateLines("w", busy), ["w: skipped, another window or omp-sessions is installing the plugin there right now"]);
});

test("install sweeps staging left by crashed runs and restores the old copy when the swap fails", { skip: process.platform === "win32" }, () => {
	const root = temp();
	const v1 = bundle(root, "1");
	const v2 = bundle(path.join(root, "next"), "2");
	const target = pluginTarget(path.join(root, "hermes"));
	const plugins = path.dirname(target);
	installPlugin(v1, target);
	for (const name of ["__omp-sessions-999999999-tmp__", "__omp-sessions-999999998-old__", "omp-sessions.999999997.tmp", `omp-sessions.${process.pid}.old`]) {
		fs.mkdirSync(path.join(plugins, name));
		fs.writeFileSync(path.join(plugins, name, "plugin.yaml"), "name: omp-sessions\n");
	}
	fs.mkdirSync(path.join(plugins, "other-plugin"));
	assert.equal(installPlugin(v2, target), "updated");
	assert.deepEqual(fs.readdirSync(plugins).sort(), ["omp-sessions", "other-plugin"]);

	// The new copy can't be read: the copy fails, the installed v2 stays, no staging remains.
	const broken = bundle(path.join(root, "broken"), "3");
	fs.chmodSync(path.join(broken, "__init__.py"), 0);
	if (process.getuid?.() !== 0) {
		assert.throws(() => installPlugin(broken, target));
		assert.equal(pluginVersion(target), "2");
		assert.deepEqual(fs.readdirSync(plugins).sort(), ["omp-sessions", "other-plugin"]);
	}
	fs.chmodSync(path.join(broken, "__init__.py"), 0o644);
});

test("reload retries enable once and reports a plugin left disabled", { skip: process.platform === "win32" }, () => {
	const root = temp();
	const log = path.join(root, "calls.log");
	const failures = path.join(root, "enable-failures");
	const fake = path.join(root, "hermes");
	// `plugins enable` fails as many times as the counter file says.
	fs.writeFileSync(
		fake,
		`#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in *"plugins enable"*) n=$(cat "${failures}" 2>/dev/null || echo 0); if [ "$n" -gt 0 ]; then echo $((n-1)) > "${failures}"; echo "enable timed out" >&2; exit 1; fi ;; esac\necho "ok $3"\n`,
		{ mode: 0o755 },
	);
	const home = path.join(root, "work");
	const t = { label: "work", home, profile: "work" };
	updatePlugin(bundle(root, "1"), t, undefined);
	fs.writeFileSync(path.join(home, "config.yaml"), "plugins:\n  enabled:\n    - omp-sessions\n");
	const calls = () => fs.readFileSync(log, "utf8").trim().split("\n");

	fs.writeFileSync(failures, "1");
	const once = updatePlugin(bundle(path.join(root, "v2"), "2"), t, fake, { enable: false });
	assert.deepEqual([once.reload?.ok, once.leftDisabled], [true, undefined]);
	assert.deepEqual(calls(), ["-p work plugins disable omp-sessions", "-p work plugins enable omp-sessions", "-p work plugins enable omp-sessions"]);
	fs.rmSync(log);

	fs.writeFileSync(failures, "2");
	const twice = updatePlugin(bundle(path.join(root, "v3"), "3"), t, fake, { enable: false });
	assert.deepEqual([twice.reload?.ok, twice.leftDisabled], [false, true]);
	assert.equal(calls().length, 3);
	assert.match(updateLines("work", twice)[1], /^work: the plugin was left DISABLED in profile work \(enabling it again failed twice\): run hermes -p work plugins enable omp-sessions/);
});

test("updatePlugin reloads an enabled copy in the running gateway (disable → enable), enables others", { skip: process.platform === "win32" }, () => {
	const root = temp();
	const log = path.join(root, "calls.log");
	const fake = path.join(root, "hermes");
	fs.writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\necho "ok $3"\n`, { mode: 0o755 });
	const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
	const v1 = bundle(root, "1");
	const v2 = bundle(path.join(root, "next"), "2");
	fs.mkdirSync(path.join(v2, "dashboard"));
	fs.writeFileSync(path.join(v2, "dashboard", "plugin_api.py"), "# v2\n");
	const home = path.join(root, "work");
	const t = { label: "work", home, profile: "work" };

	const fresh = updatePlugin(v1, t, fake);
	assert.deepEqual([fresh.outcome, fresh.needsReload, fresh.enable?.ok, fresh.reload], ["installed", false, true, undefined]);
	assert.deepEqual(calls(), ["-p work plugins enable omp-sessions", "-p work config set plugins.entries.omp-sessions.allow_gateway_injection true"]);
	fs.rmSync(log);

	fs.writeFileSync(path.join(home, "config.yaml"), "plugins:\n  enabled:\n    - omp-sessions\n");
	const u = updatePlugin(v2, t, fake, { enable: false });
	assert.deepEqual([u.outcome, u.needsReload, u.reload?.ok, u.enable, u.dashboardChanged], ["updated", true, true, undefined, true]);
	assert.deepEqual(calls(), ["-p work plugins disable omp-sessions", "-p work plugins enable omp-sessions"]);
	assert.deepEqual(updateLines("work", u), ["work: updated, reloaded in the running gateway", "work: the dashboard's omp Sessions page backend changed; it loads when the dashboard restarts"]);
	fs.rmSync(log);

	// Only files outside dashboard/ changed: no dashboard note. Without hermes, only the files change.
	const v3 = bundle(path.join(root, "v3"), "3");
	fs.cpSync(path.join(v2, "dashboard"), path.join(v3, "dashboard"), { recursive: true });
	const files = updatePlugin(v3, t, undefined);
	assert.deepEqual([files.outcome, files.needsReload, files.reload, files.dashboardChanged], ["updated", true, undefined, false]);
	assert.equal(updatePlugin(v3, t, fake, { enable: false }).outcome, "unchanged");
	assert.deepEqual(calls(), [], "hermes ran for nothing");
});

test("findHermes looks on PATH, then ~/.local/bin; hermes always runs with -p", { skip: process.platform === "win32" }, () => {
	const root = temp();
	const home = path.join(root, "home");
	const bin = path.join(home, ".local", "bin");
	fs.mkdirSync(bin, { recursive: true });
	assert.equal(findHermes({ PATH: path.join(root, "empty") }, home), undefined);
	const log = path.join(root, "calls.log");
	const fake = path.join(bin, "hermes");
	fs.writeFileSync(fake, `#!/bin/sh\necho "$HERMES_HOME $*" >> "${log}"\necho "ok $3"\n`, { mode: 0o755 });
	assert.equal(findHermes({ PATH: path.join(root, "empty") }, home), fake);
	const env = { ...process.env, HERMES_HOME: "/tmp/h" };
	const res = enablePlugin(fake, { label: "default", home: "/tmp/h", profile: "default" }, env);
	assert.equal(res.ok, true);
	assert.equal(res.output, "ok plugins\nok config");
	assert.equal(enablePlugin(fake, { label: "work", home: "/tmp/h/profiles/work", profile: "work" }, env).ok, true);
	assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
		"/tmp/h -p default plugins enable omp-sessions",
		"/tmp/h -p default config set plugins.entries.omp-sessions.allow_gateway_injection true",
		"/tmp/h -p work plugins enable omp-sessions",
		"/tmp/h -p work config set plugins.entries.omp-sessions.allow_gateway_injection true",
	]);
});

test("findOmpSessions follows the plugin's order: setting, the gateway's PATH, ~/.local/bin", { skip: process.platform === "win32" }, () => {
	const root = temp();
	const home = path.join(root, "home");
	const exe = (p: string) => {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
		return p;
	};
	assert.equal(findOmpSessions(undefined, undefined, home), undefined);
	const local = exe(path.join(home, ".local", "bin", "omp-sessions"));
	assert.deepEqual(findOmpSessions(undefined, undefined, home), { path: local, via: "install" });
	const onPath = exe(path.join(root, "bin", "omp-sessions"));
	assert.deepEqual(findOmpSessions(undefined, path.join(root, "bin"), home), { path: onPath, via: "PATH" });
	const set = exe(path.join(home, "tools", "omp-sessions"));
	assert.deepEqual(findOmpSessions("~/tools/omp-sessions", path.join(root, "bin"), home), { path: set, via: "setting" });
	assert.deepEqual(findOmpSessions(path.join(root, "missing"), undefined, home), { path: local, via: "install" }, "a bad setting falls through");
});

test("Windows: findHermes finds the installer's %LOCALAPPDATA%\\hermes\\bin, a .cmd runs through a shell, findOmpSessions finds the extension's launcher", { skip: process.platform === "win32" }, () => {
	const root = temp();
	const la = path.join(root, "AppData", "Local");
	const env = { LOCALAPPDATA: la, PATH: path.join(root, "empty") };
	assert.equal(findHermes(env, root, "win32"), undefined);
	const hermes = path.join(la, "hermes", "bin", "hermes.cmd");
	fs.mkdirSync(path.dirname(hermes), { recursive: true });
	fs.writeFileSync(hermes, "@echo off\r\n");
	assert.equal(findHermes(env, root, "win32"), hermes);
	assert.deepEqual(hermesCommand(hermes, ["-p", "default"], "win32"), { file: `"${hermes}"`, args: ["-p", "default"], shell: true });
	assert.deepEqual(hermesCommand("C:\\h\\hermes.exe", ["-p", "default"], "win32"), { file: "C:\\h\\hermes.exe", args: ["-p", "default"], shell: false });
	assert.deepEqual(hermesCommand("/x/hermes.cmd", [], "linux").shell, false);
	const bin = path.join(root, "bin");
	const shim = path.join(la, "omp-sessions", "omp-sessions.cmd");
	fs.mkdirSync(path.dirname(shim), { recursive: true });
	fs.writeFileSync(shim, "@echo off\r\n", { mode: 0o755 });
	assert.deepEqual(findOmpSessions(undefined, bin, root, env, "win32"), { path: shim, via: "install" });
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "omp-sessions.cmd"), "@echo off\r\n", { mode: 0o755 });
	assert.deepEqual(findOmpSessions(undefined, `${path.join(root, "empty")};${bin}`, root, env, "win32"), { path: path.join(bin, "omp-sessions.cmd"), via: "PATH" });
});

test("runningDashboardUrl: the live dashboard in Hermes's spawn ledger, at localhost for a wildcard bind", () => {
	const root = temp();
	assert.equal(runningDashboardUrl(root), undefined, "no ledger");
	const ledger = (entries: unknown) => fs.writeFileSync(path.join(root, "spawn-ledger.json"), JSON.stringify(entries));
	const alive = (pid: number) => pid !== 1;
	ledger([
		{ pid: 1, purpose: "dashboard", host: "127.0.0.1", port: 9200 },
		{ pid: 2, purpose: "browser-harness-daemon", host: "", port: null },
		{ pid: 3, purpose: "dashboard", host: "0.0.0.0", port: 9300 },
	]);
	assert.equal(runningDashboardUrl(root, alive), "http://localhost:9300", "the dead one is skipped");
	ledger([{ pid: 3, purpose: "dashboard", host: "100.64.1.2", port: 9119 }]);
	assert.equal(runningDashboardUrl(root, alive), "http://100.64.1.2:9119");
	ledger([{ pid: 3, purpose: "dashboard", host: "fd7a::5", port: 9119 }]);
	assert.equal(runningDashboardUrl(root, alive), "http://[fd7a::5]:9119");
	ledger([{ pid: 1, purpose: "dashboard", host: "", port: 9119 }]);
	assert.equal(runningDashboardUrl(root, alive), undefined);
	fs.writeFileSync(path.join(root, "spawn-ledger.json"), "{corrupt");
	assert.equal(runningDashboardUrl(root, alive), undefined);
	ledger([{ pid: process.pid, purpose: "dashboard", host: "::", port: 9400 }]);
	assert.equal(runningDashboardUrl(root), "http://localhost:9400", "the default liveness check");
});

test("gatewayPath reads the PATH of the process in gateway.pid", { skip: process.platform !== "linux" }, () => {
	const home = temp();
	assert.equal(gatewayPath(home), undefined);
	fs.writeFileSync(path.join(home, "gateway.pid"), JSON.stringify({ pid: process.pid, kind: "hermes-gateway" }));
	assert.equal(gatewayPath(home), process.env.PATH);
});

test("parseLaneStatus: the dispatcher heartbeat, notes and last notification of `hermes omp status --json`", () => {
	const json = JSON.stringify({ profile: "default", omp_sessions: "/x/omp-sessions", dispatcher: { at: 100, pid: 7, profile: "default", lane_on: true, board: "lightscale" }, dispatcher_notes: ["n1", 3], last_notification: { at: 90, ok: false, session: "abc" } });
	assert.deepEqual(parseLaneStatus(`warning: x\n${json}`), {
		profile: "default",
		ompSessions: "/x/omp-sessions",
		dispatcher: { at: 100, pid: 7, profile: "default", laneOn: true, board: "lightscale" },
		dispatcherNotes: ["n1"],
		lastNotification: { at: 90, ok: false, session: "abc" },
	});
	assert.deepEqual(parseLaneStatus(JSON.stringify({ dispatcher: null, last_notification: null })), { dispatcherNotes: [], dispatcher: null, lastNotification: null });
	assert.deepEqual(parseLaneStatus(JSON.stringify({ omp_sessions: null })), { dispatcherNotes: [], ompSessions: null }, "an older plugin: no dispatcher key");
	assert.equal(parseLaneStatus("not json"), undefined);
});

test("report line per profile", () => {
	const state = { installed: true, managed: true, current: false };
	assert.equal(reportLine({ label: "work", home: "/h", target: "/h/plugins/omp-sessions", state, status: "enabled", lane: true }), "work: outdated, run install to update, enabled · lane on (/h/plugins/omp-sessions)");
	assert.equal(reportLine({ label: "w", home: "/h", target: "/t", state, status: "enabled", lane: false, injection: false }), "w: outdated, run install to update, enabled · lane off · notifications not allowed (allow_gateway_injection) (/t)");
	assert.equal(reportLine({ label: "default", home: "/h", target: "/t", state: { installed: false, managed: false, current: false } }), "default: not installed (/t)");
});

