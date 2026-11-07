import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	dispatcherConfigured,
	enablePlugin,
	findHermes,
	hermesHome,
	hermesRoot,
	installPlugin,
	laneEnabled,
	listProfiles,
	parsePluginStatus,
	pluginState,
	pluginTarget,
	reportLine,
	resolveTargets,
	uninstallPlugin,
} from "../../src/shared/hermes-plugin";

function temp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omp-hermes-plugin-"));
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
	assert.deepEqual(resolveTargets({}, {}, home), [{ label: "default", home: root }]);
	assert.deepEqual(resolveTargets({}, { HERMES_HOME: path.join(root, "profiles", "lightscale") }, home), [{ label: "lightscale", home: path.join(root, "profiles", "lightscale") }]);
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
	assert.equal(installPlugin(v2, target, true), "updated");
	assert.deepEqual(pluginState(v2, target), { installed: true, managed: true, current: true });
});

test("install refuses a missing bundle", () => {
	const root = temp();
	assert.throws(() => installPlugin(path.join(root, "nope"), pluginTarget(root)), /bundled Hermes plugin is missing/);
});

test("plugin status from `hermes plugins list --json`", () => {
	const out = `[\n  {"name": "other", "status": "enabled"},\n  {"name": "omp-sessions", "status": "disabled", "source": "user"}\n]`;
	assert.equal(parsePluginStatus(out), "disabled");
	assert.equal(parsePluginStatus(`warning: something\n${out}`), "disabled");
	assert.equal(parsePluginStatus("[]"), undefined);
	assert.equal(parsePluginStatus("not json"), undefined);
});

test("findHermes looks on PATH, then ~/.local/bin; hermes runs per target (-p for profiles)", { skip: process.platform === "win32" }, () => {
	const root = temp();
	const home = path.join(root, "home");
	const bin = path.join(home, ".local", "bin");
	fs.mkdirSync(bin, { recursive: true });
	assert.equal(findHermes({ PATH: path.join(root, "empty") }, home), undefined);
	const log = path.join(root, "calls.log");
	const fake = path.join(bin, "hermes");
	fs.writeFileSync(fake, `#!/bin/sh\necho "$HERMES_HOME $*" >> "${log}"\ncase "$*" in *"config get"*) echo true ;; *) echo "ok $1" ;; esac\n`, { mode: 0o755 });
	assert.equal(findHermes({ PATH: path.join(root, "empty") }, home), fake);
	const env = { ...process.env, HERMES_HOME: "/tmp/h" };
	const res = enablePlugin(fake, { label: "default", home: "/tmp/h" }, env);
	assert.equal(res.ok, true);
	assert.equal(res.output, "ok plugins\nok config");
	assert.equal(enablePlugin(fake, { label: "work", home: "/tmp/h/profiles/work", profile: "work" }, env).ok, true);
	assert.equal(laneEnabled(fake, { label: "work", home: "/tmp/h/profiles/work", profile: "work" }, env), true);
	assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
		"/tmp/h plugins enable omp-sessions",
		"/tmp/h config set plugins.entries.omp-sessions.allow_gateway_injection true",
		"/tmp/h -p work plugins enable omp-sessions",
		"/tmp/h -p work config set plugins.entries.omp-sessions.allow_gateway_injection true",
		"/tmp/h -p work config get plugins.entries.omp-sessions.settings.lane.enabled",
	]);
});

test("report line per profile", () => {
	const state = { installed: true, managed: true, current: false };
	assert.equal(reportLine({ label: "work", home: "/h", target: "/h/plugins/omp-sessions", state, status: "enabled", lane: true }), "work: outdated, run install to update, enabled · lane on (/h/plugins/omp-sessions)");
	assert.equal(reportLine({ label: "default", home: "/h", target: "/t", state: { installed: false, managed: false, current: false } }), "default: not installed (/t)");
});
