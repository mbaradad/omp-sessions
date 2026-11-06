import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import manifest from "../../package.json" with { type: "json" };
import {
	GROUPS,
	commandCenterEntries,
	commandGroup,
	commandLine,
	exportedPath,
	modelDetail,
	parseModels,
	pushRecent,
	quoteArg,
	shellKind,
	slugify,
	stripAnsi,
	withModel,
} from "../../src/ext/toolbox-core";

test("shellKind: recognizes shells by executable name on any platform", () => {
	assert.equal(shellKind("/bin/bash", "linux"), "posix");
	assert.equal(shellKind("/usr/bin/zsh", "darwin"), "posix");
	assert.equal(shellKind("/opt/homebrew/bin/fish", "darwin"), "fish");
	assert.equal(shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32"), "powershell");
	assert.equal(shellKind("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32"), "powershell");
	assert.equal(shellKind("C:\\Windows\\System32\\cmd.exe", "win32"), "cmd");
	assert.equal(shellKind("C:\\Program Files\\Git\\bin\\bash.exe", "win32"), "posix");
	assert.equal(shellKind(undefined, "win32"), "powershell");
	assert.equal(shellKind("", "linux"), "posix");
});

test("quoteArg: safe words stay bare, empty strings are quoted", () => {
	for (const kind of ["posix", "fish", "powershell", "cmd"] as const) {
		assert.equal(quoteArg("--resume", kind), "--resume");
		assert.equal(quoteArg("anthropic/claude-opus-4-6", kind), "anthropic/claude-opus-4-6");
		assert.notEqual(quoteArg("", kind), "");
	}
	assert.equal(quoteArg("", "posix"), "''");
	assert.equal(quoteArg("", "cmd"), '""');
});

test("quoteArg posix: quotes, spaces and metacharacters round-trip through sh", { skip: process.platform === "win32" }, () => {
	const nasty = ["it's here", "a b", "$HOME `id` $(id)", "semi;colon&&amp|pipe>out", 'dq"x', "back\\slash", "*?[glob]", "new\nline", "~/tilde", "-n"];
	for (const arg of nasty) {
		const res = spawnSync("sh", ["-c", `printf '%s' ${quoteArg(arg, "posix")}`], { encoding: "utf8" });
		assert.equal(res.stdout, arg, `round-trip ${JSON.stringify(arg)}`);
	}
});

test("quoteArg fish: escapes backslashes and single quotes inside single quotes", () => {
	assert.equal(quoteArg("it's", "fish"), "'it\\'s'");
	assert.equal(quoteArg("C:\\x y", "fish"), "'C:\\\\x y'");
	assert.equal(quoteArg("$HOME", "fish"), "'$HOME'");
});

test("quoteArg powershell: single quotes doubled, commas and @ quoted", () => {
	assert.equal(quoteArg("it's", "powershell"), "'it''s'");
	assert.equal(quoteArg("a,b", "powershell"), "'a,b'");
	assert.equal(quoteArg("@scope/pkg", "powershell"), "'@scope/pkg'");
	assert.equal(quoteArg("$env:PATH", "powershell"), "'$env:PATH'");
	assert.equal(quoteArg("it\u2019s", "powershell"), "'it\u2019\u2019s'");
	assert.equal(quoteArg("C:\\Users\\me\\s.jsonl", "powershell"), "C:\\Users\\me\\s.jsonl");
});

test("quoteArg cmd: double quotes doubled, trailing backslashes doubled", () => {
	assert.equal(quoteArg("a b", "cmd"), '"a b"');
	assert.equal(quoteArg('say "hi"', "cmd"), '"say ""hi"""');
	assert.equal(quoteArg("C:\\my dir\\", "cmd"), '"C:\\my dir\\\\"');
	assert.equal(quoteArg("a&b|c", "cmd"), '"a&b|c"');
	assert.equal(quoteArg("C:\\Users\\me\\s.jsonl", "cmd"), "C:\\Users\\me\\s.jsonl");
});

test("commandLine: PowerShell uses the call operator; others quote the executable", () => {
	const exe = "C:\\Users\\Jo Doe\\AppData\\Roaming\\npm\\omp.cmd";
	assert.equal(commandLine(exe, ["--resume", "C:\\s s.jsonl"], "powershell"), "& 'C:\\Users\\Jo Doe\\AppData\\Roaming\\npm\\omp.cmd' --resume 'C:\\s s.jsonl'");
	assert.equal(commandLine(exe, ["login"], "cmd"), '"C:\\Users\\Jo Doe\\AppData\\Roaming\\npm\\omp.cmd" login');
	assert.equal(commandLine("/home/me/.local/bin/omp", ["share", "/tmp/a b.jsonl", "--gist"], "posix"), "/home/me/.local/bin/omp share '/tmp/a b.jsonl' --gist");
});

test("stripAnsi: removes colors, cursor moves and OSC links", () => {
	assert.equal(stripAnsi("\u001b[1;32mok\u001b[0m \u001b[2K\u001b]8;;https://x\u0007link\u001b]8;;\u0007"), "ok link");
});

test("exportedPath: reads omp's confirmation, resolving relative paths", () => {
	assert.equal(exportedPath("Exported to: omp-session-s.html\n", "/out"), path.resolve("/out", "omp-session-s.html"));
	assert.equal(exportedPath("noise\nExported to: /abs/x.html\n", "/out"), path.resolve("/abs/x.html"));
	assert.equal(exportedPath("Error: File not found", "/out"), undefined);
});

test("slugify: file-safe, bounded, never empty", () => {
	assert.equal(slugify("Fix the Login bug: part 2/3!"), "fix-the-login-bug-part-23");
	assert.equal(slugify("Ünïcödé — títle"), "unicode-title");
	assert.equal(slugify("???"), "session");
	assert.ok(slugify("x".repeat(200)).length <= 60);
});

test("parseModels: keeps valid entries, derives selector, rejects other shapes", () => {
	const json = JSON.stringify({
		models: [
			{ provider: "anthropic", id: "claude-x", selector: "anthropic/claude-x", name: "Claude X", contextWindow: 200000, reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15 } },
			{ provider: "ollama", id: "llama3" },
			{ provider: "broken" },
			"junk",
		],
	});
	const models = parseModels(json);
	assert.equal(models.length, 2);
	assert.equal(models[1].selector, "ollama/llama3");
	assert.equal(models[1].name, "llama3");
	assert.equal(modelDetail(models[0]), "200K context · images · reasoning · $3/$15 per M tokens");
	assert.equal(modelDetail(models[1]), "");
	assert.throws(() => parseModels("[]"));
	assert.throws(() => parseModels("not json"));
});

test("withModel: replaces any previous model choice in extra args", () => {
	assert.deepEqual(withModel([], "a/b"), ["--model", "a/b"]);
	assert.deepEqual(withModel(["--thinking", "high", "--model", "old", "-m", "old2", "--model=old3", "--no-lsp"], "a/b"), ["--thinking", "high", "--no-lsp", "--model", "a/b"]);
});

test("commandGroup: explicit ids and keyword fallbacks", () => {
	assert.equal(commandGroup("omp.newSession"), "Sessions");
	assert.equal(commandGroup("omp.tasks.add"), "Tasks");
	assert.equal(commandGroup("omp.scm.commit"), "Review & git");
	assert.equal(commandGroup("omp.reviewChanges"), "Review & git");
	assert.equal(commandGroup("omp.login"), "omp account & tools");
	assert.equal(commandGroup("omp.models"), "omp account & tools");
	assert.equal(commandGroup("omp.openDocs"), "Help");
	assert.equal(commandGroup("omp.focus"), "Chat");
	assert.equal(commandGroup("omp.sendSelection"), "Chat");
	assert.equal(commandGroup("omp.continueInTerminal"), "Sessions");
	assert.equal(commandGroup("omp.somethingNew"), "Sessions");
});

test("commandCenterEntries: filters hidden/internal commands, groups in order, adds keybindings", () => {
	const manifest = {
		contributes: {
			commands: [
				{ command: "omp.openDocs", title: "Open Documentation", icon: "$(book)" },
				{ command: "omp.newSession", title: "New Session", icon: "$(add)" },
				{ command: "omp.tasks.delete", title: "Delete" },
				{ command: "omp.commandCenter", title: "Command Center" },
				{ command: "omp.openSessionFileDiff", title: "Open Session Diff" },
				{ command: "omp.focus", title: "Focus Chat" },
				{ command: "omp.newSession", title: "Duplicate" },
				{ command: "other.thing", title: "Not ours" },
				{ command: "omp.iconObject", title: "Icon Object", icon: { light: "a.svg", dark: "b.svg" } },
				{ title: "no id" },
			],
			menus: { commandPalette: [{ command: "omp.tasks.delete", when: "false" }, { command: "omp.focus", when: "editorIsOpen" }] },
			keybindings: [{ command: "omp.focus", key: "ctrl+alt+o", mac: "cmd+alt+o" }],
		},
	};
	const linux = commandCenterEntries(manifest, "linux");
	assert.deepEqual(
		linux.map(e => e.command),
		["omp.newSession", "omp.iconObject", "omp.focus", "omp.openDocs"],
	);
	assert.equal(linux[0].icon, "add");
	assert.equal(linux[1].icon, undefined);
	assert.equal(linux.find(e => e.command === "omp.focus")?.keybinding, "Ctrl+Alt+O");
	assert.equal(commandCenterEntries(manifest, "darwin").find(e => e.command === "omp.focus")?.keybinding, "⌘⌥O");
	const order = linux.map(e => GROUPS.indexOf(e.group));
	assert.deepEqual(order, [...order].sort((a, b) => a - b));
	assert.deepEqual(commandCenterEntries(undefined, "linux"), []);
	assert.deepEqual(commandCenterEntries({ contributes: { commands: "nope" } }, "linux"), []);
});

test("commandCenterEntries: the real package.json lists our commands and hides internal ones", () => {
	const entries = commandCenterEntries(manifest, "linux");
	const ids = new Set(entries.map(e => e.command));
	for (const id of ["omp.newSession", "omp.login", "omp.models", "omp.exportHtml", "omp.continueInTerminal", "omp.openDocs", "omp.tasks.add"]) assert.ok(ids.has(id), id);
	for (const id of ["omp.commandCenter", "omp.openSessionFileDiff", "omp.tasks.delete"]) assert.ok(!ids.has(id), id);
	for (const g of GROUPS) assert.ok(entries.some(e => e.group === g), `group ${g} not empty`);
});

test("pushRecent: most recent first, deduplicated, capped", () => {
	assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
	assert.deepEqual(pushRecent(["a", "b", "c", "d", "e"], "f"), ["f", "a", "b", "c", "d"]);
});
