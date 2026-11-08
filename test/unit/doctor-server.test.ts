import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, reportCommands } from "../../src/ext/doctor-report";
import { type ServerFacts, parseMachineStatus, serverChecks } from "../../src/ext/doctor-server";
import type { MachineStatus } from "../../src/shared/server-status";

const NOW = Date.UTC(2026, 10, 8);

function status(over: Partial<MachineStatus> = {}): MachineStatus {
	return {
		ok: true,
		problems: [],
		home: "/home/u/.omp/vscode",
		server: { running: true, pid: 77, version: "0.6.0", startedAt: NOW - 3 * 3_600_000, socket: "/home/u/.omp/vscode/server.sock", log: "/home/u/.omp/vscode/server.log" },
		service: { kind: "systemd", installed: true, autoInstall: true, file: "/home/u/.config/systemd/user/omp-sessions.service", home: "/home/u/.omp/vscode", servesThisHome: true, node: "/usr/bin/node", nodeExists: true, script: "/home/u/.omp/vscode/runtime/server.js", scriptExists: true },
		omp: { path: "/home/u/.bun/bin/omp", extraArgs: [], defaultModel: "anthropic/claude-sonnet-4" },
		sessions: { total: 2, archived: 0, byState: { idle: 2 } },
		tasks: { pending: 0, running: 0 },
		scheduler: { maxConcurrent: 2, running: 0, waiting: 0, scheduled: 0, server: true },
		remote: { enabled: false, bind: "tailscale", port: 7413, https: false, trustedProxy: false, tokenSet: false },
		...over,
	};
}

function facts(s?: MachineStatus, error?: string): ServerFacts {
	return { status: s, error, extensionVersion: "0.6.0", now: NOW };
}

const levels = (f: ServerFacts) => serverChecks(f).map(c => c.level);
const commands = (f: ServerFacts) => serverChecks(f).flatMap(c => (c.fixes ?? []).map(x => x.command));

test("serverChecks: healthy machine has no warnings or errors", () => {
	const checks = serverChecks(facts(status()));
	assert.ok(checks.every(c => c.level === "ok" || c.level === "info"));
	assert.ok(!commands(facts(status())).some(c => c === "omp.server.start" || c === "omp.server.install" || c === "omp.server.restart"));
});

test("serverChecks: no status at all offers the terminal and the log", () => {
	const checks = serverChecks(facts(undefined, "boom"));
	assert.deepEqual(checks.map(c => c.level), ["warn"]);
	assert.deepEqual(checks[0].fixes?.map(f => f.command), ["omp.server.statusInTerminal", "omp.server.showLog"]);
});

test("serverChecks: server not running warns with Start server", () => {
	const s = status({ ok: false, problems: ["the server is not running"], server: { running: false, log: "/l" }, scheduler: { maxConcurrent: 0, running: 0, waiting: 0, scheduled: 0, server: false } });
	const first = serverChecks(facts(s))[0];
	assert.equal(first.level, "warn");
	assert.equal(first.fixes?.[0].command, "omp.server.start");
	assert.ok(first.fixes?.some(f => f.command === "omp.server.statusInTerminal"));
	// The problem list is repeated (info) with the terminal fix.
	const last = serverChecks(facts(s)).at(-1);
	assert.equal(last?.level, "info");
	assert.deepEqual(last?.fixes?.map(f => f.command), ["omp.server.statusInTerminal"]);
});

test("serverChecks: a server older than the extension offers Restart", () => {
	const first = serverChecks({ ...facts(status({ server: { running: true, pid: 1, version: "0.5.9", startedAt: NOW, log: "/l" } })) })[0];
	assert.equal(first.level, "warn");
	assert.equal(first.fixes?.[0].command, "omp.server.restart");
	const newer = serverChecks(facts(status({ server: { running: true, pid: 1, version: "0.7.0", startedAt: NOW, log: "/l" } })))[0];
	assert.equal(newer.level, "ok");
});

test("serverChecks: login service states", () => {
	const service = (svc: Partial<MachineStatus["service"]>) => serverChecks(facts(status({ service: { kind: "systemd", installed: false, ...svc } })))[1];
	const missing = service({ autoInstall: true });
	assert.equal(missing.level, "info");
	assert.deepEqual(missing.fixes?.map(f => f.command), ["omp.server.install"]);
	assert.equal(service({ autoInstall: false, noAutoInstall: "not the default data home" }).fixes, undefined);
	const broken = service({ installed: true, servesThisHome: true, node: "/gone/node", nodeExists: false, script: "/s.js", scriptExists: true });
	assert.equal(broken.level, "error");
	assert.equal(broken.fixes?.[0].command, "omp.server.install");
	assert.equal(service({ installed: true, servesThisHome: false, home: "/other" }).level, "info");
	const none = serverChecks(facts(status({ service: { kind: null, installed: false } })))[1];
	assert.equal(none.level, "info");
	assert.equal(none.fixes, undefined);
});

test("serverChecks: omp missing and launch errors are errors with fixes", () => {
	const noOmp = serverChecks(facts(status({ omp: { extraArgs: [], error: "omp is not on PATH" } })));
	const err = noOmp.find(c => c.level === "error");
	assert.deepEqual(err?.fixes?.map(f => f.command), ["omp.setOmpPath", "omp.installOmp"]);
	const launch = serverChecks(facts(status({ omp: { path: "/omp", extraArgs: [], launchError: "spawn EACCES" } })));
	assert.deepEqual(launch.filter(c => c.level === "error").flatMap(c => c.fixes?.map(f => f.command) ?? []), ["omp.server.showLog", "omp.server.statusInTerminal"]);
});

test("serverChecks: scheduler paused with work waiting warns", () => {
	const paused = status({ scheduler: { maxConcurrent: 1, paused: true, running: 0, waiting: 2, scheduled: 0, server: true } });
	assert.ok(levels(facts(paused)).includes("warn"));
	const idle = status({ scheduler: { maxConcurrent: 1, paused: true, running: 0, waiting: 0, scheduled: 0, server: true } });
	assert.ok(!levels(facts(idle)).includes("warn"));
});

test("serverChecks: remote access", () => {
	const remote = (r: Partial<MachineStatus["remote"]>, running = true) => {
		const s = status({ remote: { ...status().remote, enabled: true, ...r }, ...(running ? {} : { server: { running: false, log: "/l" } }) });
		return serverChecks(facts(s)).filter(c => /remote/i.test(c.title))[0];
	};
	assert.equal(remote({ listening: { host: "100.1.2.3", port: 7413 }, url: "http://100.1.2.3:7413/", tokenSet: true }).level, "ok");
	const down = remote({ error: "no Tailscale address" });
	assert.equal(down.level, "error");
	assert.deepEqual(down.fixes?.map(f => f.command), ["omp.server.restart", "omp.server.showLog"]);
	const stopped = remote({}, false);
	assert.equal(stopped.level, "info");
	assert.deepEqual(stopped.fixes?.map(f => f.command), ["omp.server.start"]);
});

test("parseMachineStatus: accepts the CLI's JSON, rejects anything else", () => {
	assert.ok(parseMachineStatus(JSON.stringify({ cli: "0.6.0", ...status() })));
	assert.equal(parseMachineStatus("not json"), undefined);
	assert.equal(parseMachineStatus(JSON.stringify({ ok: true })), undefined);
});

test("buildReport: server section and its fix commands", () => {
	const report = buildReport(
		{
			now: NOW,
			extensionVersion: "0.6.0",
			vscodeVersion: "1.100.0",
			nodeVersion: "22.0.0",
			platform: "linux",
			arch: "x64",
			osRelease: "6",
			omp: { resolved: "/omp", exists: true, version: "1.0.0" },
			stateDir: "/s",
			writable: true,
			socket: { platform: "linux", sessionsRoot: "/s", tmpdir: "/tmp" },
			sessions: [],
			cleanupDays: 14,
			server: facts(status({ server: { running: false, log: "/l" } })),
		},
		(...p) => p.join("/"),
	);
	assert.ok(report.sections.some(s => s.title === "omp-sessions server"));
	assert.ok(reportCommands(report).includes("omp.server.start"));
});
