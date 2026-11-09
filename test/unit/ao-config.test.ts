// ~/.switchyard/config.json: the CLI's settings, the nested `omp.extraArgs` the omp shim reads (G34), and the opt-in hibernation (G28).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readSwitchyardConfig, writeSwitchyardConfig } from "../../src/ao/config";
import { readHibernationSetting } from "../../src/ao/native";

test("config.json: writes keep keys other Switchyard parts own; extraArgs is the nested omp key; bad values read as unset", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sy-config-"));
	try {
		const file = path.join(dir, "config.json");
		fs.writeFileSync(file, JSON.stringify({ model: "a/b", mode: "bogus", planner: { x: 1 }, omp: { extraArgs: ["--profile", 3, "work"] } }));
		assert.deepEqual(readSwitchyardConfig(file), { model: "a/b", omp: { extraArgs: ["--profile", "work"] } }, "an invalid mode is dropped, non-string args are filtered");
		writeSwitchyardConfig({ mode: "edits" }, file);
		const raw: Record<string, unknown> = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.deepEqual(raw.planner, { x: 1 }, "an unknown key survives the write");
		writeSwitchyardConfig({ omp: { extraArgs: ["--advisor"] }, model: undefined }, file);
		assert.deepEqual(readSwitchyardConfig(file), { mode: "edits", omp: { extraArgs: ["--advisor"] } });
		writeSwitchyardConfig({ omp: undefined }, file);
		assert.equal(readSwitchyardConfig(file).omp, undefined);
		assert.deepEqual(readSwitchyardConfig(path.join(dir, "missing.json")), {});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("config.json hibernation: only on/off count, set and unset keep the rest, and ensureDaemon's reader agrees", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sy-config-"));
	try {
		const file = path.join(dir, "config.json");
		assert.equal(readSwitchyardConfig(file).hibernation, undefined);
		assert.equal(readHibernationSetting(dir), undefined);
		writeSwitchyardConfig({ hibernation: "on", model: "a/b" }, file);
		assert.deepEqual(readSwitchyardConfig(file), { model: "a/b", hibernation: "on" });
		assert.equal(readHibernationSetting(dir), true);
		writeSwitchyardConfig({ hibernation: "off" }, file);
		assert.equal(readHibernationSetting(dir), false);
		// Unset = leave AO alone, in both readers.
		writeSwitchyardConfig({ hibernation: undefined }, file);
		assert.deepEqual(readSwitchyardConfig(file), { model: "a/b" });
		assert.equal(readHibernationSetting(dir), undefined);
		// A value that is not on/off reads as unset in both.
		fs.writeFileSync(file, JSON.stringify({ hibernation: "yes" }));
		assert.equal(readSwitchyardConfig(file).hibernation, undefined);
		assert.equal(readHibernationSetting(dir), undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
