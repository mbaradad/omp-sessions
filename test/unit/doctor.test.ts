import assert from "node:assert/strict";
import { test } from "node:test";
import { type AoFacts, aoChecks, gateChecks, plannerChecks } from "../../src/ext/doctor-ao";
import {
	type DoctorFacts,
	type SessionFacts,
	assessSession,
	buildReport,
	cleanupCandidates,
	commandLink,
	formatBytes,
	installCommand,
	issueUrl,
	redact,
	reportCommands,
	reportToHtml,
	reportToMarkdown,
	summary,
} from "../../src/ext/doctor-report";
import type { SessionMeta } from "../../src/shared/protocol";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6);

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
	return {
		id: "abc123",
		cwd: "/home/u/proj",
		title: "Fix bug",
		status: "idle",
		pid: 4242,
		socket: "/home/u/.omp/vscode/sessions/abc123/s.sock",
		createdAt: NOW - 2 * DAY,
		updatedAt: NOW - DAY,
		ompSessionFile: "/home/u/.omp/agent/sessions/x.jsonl",
		changedFiles: 0,
		...over,
	};
}

function facts(over: Partial<SessionFacts> = {}): SessionFacts {
	return { meta: meta(), blobBytes: 0, ...over };
}

const AO_OK: AoFacts = { url: "http://127.0.0.1:3001", pid: 7, unit: "ao-daemon", sessions: 1, serviceAvailable: true, omp: { installation: "installed", authentication: "authorized" } };

function doctorFacts(over: Partial<DoctorFacts> = {}): DoctorFacts {
	return {
		now: NOW,
		extensionVersion: "0.4.0",
		vscodeVersion: "1.100.0",
		nodeVersion: "22.0.0",
		platform: "linux",
		arch: "x64",
		osRelease: "6.1",
		omp: { resolved: "/usr/local/bin/omp", exists: true, version: "18.12.6" },
		bun: "/home/u/.bun/bin/bun",
		stateDir: "/home/u/.omp/vscode/sessions",
		writable: true,
		ao: AO_OK,
		planner: { version: "0.7.0", pid: 8 },
		gate: { gate: true, shim: true, extensionDir: "/h/.omp/agent/extensions/switchyard", shimFile: "/h/.switchyard/bin/omp" },
		sessions: [],
		snapshots: [],
		cleanupDays: 14,
		...over,
	};
}

// ---------- redaction ----------

test("redact: API keys, tokens, passwords, URL credentials, auth headers, home folder", () => {
	// Fake secrets, assembled at runtime so secret scanners don't flag this file as a leak.
	const fake = (...parts: string[]) => parts.join("");
	const input = [
		`ANTHROPIC_API_KEY=${fake("sk-ant-", "api03-abcdefghijklmnopqrstuvwxyz0123")}`,
		`{"apiKey": "${fake("AIza", "SyA1234567890abcdefghijklmnopqrstuv")}"}`,
		`token: ${fake("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789")}`,
		"password=hunter2hunter2",
		"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
		"proxy https://user:s3cret@proxy.example.com:8080",
		`aws ${fake("AKIA", "ABCDEFGHIJKLMNOP")}`,
		`slack ${fake("xoxb-", "1234567890-abcdefghij")}`,
		"spawn /home/alice/.bun/bin/omp in /home/alice/proj",
		"other user /home/alicex/file",
	].join("\n");
	const out = redact(input, "/home/alice");
	for (const secret of ["sk-ant-api03", "AIzaSy", "ghp_abc", "hunter2", "eyJhbGci", "s3cret", "AKIAABCD", "xoxb-1234"]) {
		assert.ok(!out.includes(secret), `leaked ${secret}:\n${out}`);
	}
	assert.match(out, /ANTHROPIC_API_KEY=\[REDACTED\]/);
	assert.match(out, /https:\/\/\[REDACTED\]@proxy\.example\.com/);
	assert.match(out, /spawn ~\/\.bun\/bin\/omp in ~\/proj/);
	assert.match(out, /\/home\/alicex\/file/, "only the exact home folder is shortened");
});

test("redact: leaves ordinary diagnostics alone", () => {
	const text = "omp 18.12.6 at /usr/local/bin/omp\nchild exit 1 null\ntokens used: 1234";
	assert.equal(redact(text), text.replace("tokens used: 1234", "tokens used: 1234"));
});

// ---------- session assessment ----------

test("assessSession: AO sessions — running and plain stops are ok; a stop with a reason or a login problem warns with its fix", () => {
	assert.equal(assessSession(meta()).level, "ok");
	assert.equal(assessSession(meta({ status: "stopped" })).level, "ok");
	const failed = assessSession(meta({ status: "stopped", exitReason: "provisioning failed: no default branch" }));
	assert.equal(failed.level, "warn");
	assert.match(failed.title, /stopped unexpectedly/);
	assert.deepEqual(failed.fixes?.map(f => [f.command, f.args]), [["switchyard.resumeSession", ["abc123"]]]);
	const auth = assessSession(meta({ authProblem: "no model is available" }));
	assert.equal(auth.level, "warn");
	assert.deepEqual(auth.fixes?.map(f => f.command), ["switchyard.login"]);
	assert.equal(assessSession(meta({ status: "stopped", authProblem: "x" })).level, "ok");
});

test("aoChecks: unreachable daemon is an error; AO's view of omp; supervision", () => {
	const down = aoChecks({ error: "connect ECONNREFUSED", serviceAvailable: true });
	assert.equal(down.length, 1);
	assert.equal(down[0].level, "error");
	assert.deepEqual(down[0].fixes?.map(f => f.command), ["switchyard.server.start", "switchyard.server.showLog"]);
	assert.deepEqual(aoChecks(AO_OK).map(c => c.level), ["ok", "ok", "ok"]);
	const noOmp = aoChecks({ ...AO_OK, omp: { installation: "not_installed", installationReason: "OMP is not installed.", authentication: "unknown" } }).at(-1);
	assert.equal(noOmp?.level, "error");
	assert.deepEqual(noOmp?.fixes?.map(f => f.command), ["switchyard.installOmp"]);
	const loggedOut = aoChecks({ ...AO_OK, omp: { installation: "installed", authentication: "unauthorized" } }).at(-1);
	assert.equal(loggedOut?.level, "warn");
	assert.deepEqual(loggedOut?.fixes?.map(f => f.command), ["switchyard.login"]);
	const plain = aoChecks({ ...AO_OK, unit: undefined })[1];
	assert.deepEqual(plain.fixes?.map(f => f.command), ["switchyard.server.install"]);
	assert.equal(aoChecks({ ...AO_OK, unit: undefined, serviceAvailable: false })[1].fixes, undefined);
});

test("gateChecks (G46): a missing gate is an error that says modes are not enforced; a missing shim is a warning; both offer the install", () => {
	const facts = { extensionDir: "/e", shimFile: "/s/omp" };
	assert.deepEqual(gateChecks({ ...facts, gate: true, shim: true }).map(c => c.level), ["ok", "ok"]);
	const [gate, shim] = gateChecks({ ...facts, gate: false, shim: false });
	assert.equal(gate.level, "error");
	assert.match(gate.detail ?? "", /NOT enforced/);
	assert.equal(shim.level, "warn");
	assert.equal(gate.fixes?.[0].command, "switchyard.installOmpIntegration");
	assert.equal(gateChecks({ ...facts, gate: true, shim: false })[1].level, "warn");
});

test("plannerChecks: a planner that doesn't answer warns with Start", () => {
	assert.equal(plannerChecks({ version: "0.7.0", pid: 1 })[0].level, "ok");
	const down = plannerChecks({ error: "No planner answers on its socket." })[0];
	assert.equal(down.level, "warn");
	assert.deepEqual(down.fixes?.map(f => f.command), ["switchyard.server.start", "switchyard.server.showLog"]);
});

// ---------- cleanup / misc ----------

test("cleanupCandidates: sessions untouched for N days that have snapshots (a folder claiming to run counts as stopped)", () => {
	const all = [
		facts({ meta: meta({ id: "old", status: "stopped", updatedAt: NOW - 30 * DAY }), blobBytes: 100 }),
		facts({ meta: meta({ id: "recent", status: "stopped", updatedAt: NOW - 2 * DAY }), blobBytes: 100 }),
		facts({ meta: meta({ id: "running", updatedAt: NOW - 30 * DAY }), blobBytes: 100 }),
		facts({ meta: meta({ id: "dead", status: "working", updatedAt: NOW - 30 * DAY }), blobBytes: 100 }),
		facts({ meta: meta({ id: "empty", status: "stopped", updatedAt: NOW - 30 * DAY }), blobBytes: 0 }),
	];
	assert.deepEqual(
		cleanupCandidates(all, 14, NOW).map(s => s.meta.id),
		["old", "running", "dead"],
	);
	assert.deepEqual(
		cleanupCandidates(all, 0, NOW).map(s => s.meta.id),
		["old", "recent", "running", "dead"],
	);
});

test("formatBytes", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(1536), "1.5 KB");
	assert.equal(formatBytes(300 * 1024 * 1024), "300 MB");
});

test("installCommand: bun first, npm brings Bun along, else Bun's installer; PowerShell on Windows", () => {
	assert.equal(installCommand("linux", "/home/u/.bun/bin/bun", "/usr/bin/npm"), "/home/u/.bun/bin/bun install -g @oh-my-pi/pi-coding-agent");
	assert.equal(installCommand("linux", undefined, "/usr/bin/npm"), "/usr/bin/npm install -g bun @oh-my-pi/pi-coding-agent");
	assert.match(installCommand("darwin", undefined, undefined), /^curl -fsSL https:\/\/bun\.sh\/install \| bash && "\$HOME\/\.bun\/bin\/bun" install -g @oh-my-pi\/pi-coding-agent$/);
	assert.equal(installCommand("linux", "/opt/my tools/bun", undefined), "'/opt/my tools/bun' install -g @oh-my-pi/pi-coding-agent");
	assert.equal(installCommand("win32", "C:\\Users\\u\\.bun\\bin\\bun.exe", undefined), '& "C:\\Users\\u\\.bun\\bin\\bun.exe" install -g @oh-my-pi/pi-coding-agent');
	assert.match(installCommand("win32", undefined, undefined), /^irm bun\.sh\/install\.ps1 \| iex; /);
});

test("issueUrl: GitHub new-issue link with encoded title/body; undefined when too long", () => {
	const url = issueUrl("https://github.com/o/r/issues/", "Bug & crash", "a=b&c\n#x");
	assert.equal(url, "https://github.com/o/r/issues/new?title=Bug%20%26%20crash&body=a%3Db%26c%0A%23x");
	assert.equal(issueUrl("https://github.com/o/r/issues", "t", "x".repeat(10_000)), undefined);
});

// ---------- whole report ----------

test("buildReport: missing omp is an error with an install fix", () => {
	const report = buildReport(doctorFacts({ omp: { exists: false }, bun: undefined }));
	const omp = report.sections[0].checks[0];
	assert.equal(omp.level, "error");
	assert.match(omp.title, /not installed/);
	assert.deepEqual(omp.fixes?.map(f => f.command), ["switchyard.installOmp"]);
	const broken = buildReport(doctorFacts({ omp: { resolved: "/nope/omp", exists: false } }));
	assert.match(broken.sections[0].checks[0].title, /executable is missing/);
	const failing = buildReport(doctorFacts({ omp: { resolved: "/x/omp", exists: true, versionError: "/usr/bin/env: 'bun': No such file or directory" }, bun: undefined }));
	assert.match(failing.sections[0].checks[0].detail ?? "", /runs on Bun/);
});

test("buildReport: healthy setup has no errors; problems are counted and sorted first", () => {
	const healthy = buildReport(doctorFacts({ sessions: [meta()] }));
	assert.deepEqual(summary(healthy), { errors: 0, warnings: 0 });
	assert.deepEqual(
		healthy.sections.map(s => s.title).slice(0, 3),
		["omp", "Agent Orchestrator", "Planner"],
	);
	const sick = buildReport(
		doctorFacts({
			writable: false,
			writeError: "EACCES",
			ao: { error: "connect ECONNREFUSED 127.0.0.1:3001", serviceAvailable: true },
			planner: { error: "No planner answers on its socket." },
			sessions: [meta(), meta({ id: "failed", status: "stopped", exitReason: "provisioning failed" })],
		}),
	);
	const { errors, warnings } = summary(sick);
	assert.equal(errors, 2); // unwritable state dir + AO unreachable
	assert.equal(warnings, 2); // planner down + stopped unexpectedly
	const sessions = sick.sections.find(s => s.title.startsWith("Sessions"));
	assert.ok(sessions);
	assert.equal(sessions.checks[0].level, "warn");
	assert.ok(reportCommands(sick).includes("switchyard.server.start"));
	assert.match(buildReport(doctorFacts({ ao: { serviceAvailable: false } })).sections.find(s => s.title.startsWith("Sessions"))?.checks[0].title ?? "", /AO is not reachable/);
});

test("buildReport: disk section offers cleanup of the old session host's snapshots", () => {
	const report = buildReport(doctorFacts({ snapshots: [facts({ meta: meta({ status: "stopped", exitReason: "stopped", updatedAt: NOW - 40 * DAY }), blobBytes: 2048 })] }));
	const disk = report.sections.find(s => s.title === "Disk");
	assert.ok(disk);
	assert.match(disk.checks[1].title, /2\.0 KB in 1 session\(s\) stopped for over 14 days/);
	assert.deepEqual(disk.checks[1].fixes?.map(f => f.command), ["switchyard.cleanUpSnapshots"]);
});

test("reportToMarkdown: icons, details, secrets redacted, no command links", () => {
	const report = buildReport(doctorFacts({ sessions: [meta({ status: "stopped", exitReason: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv failed", cwd: "/home/alice/proj" })] }));
	const md = reportToMarkdown(report, "/home/alice");
	assert.match(md, /^# omp Doctor/);
	assert.match(md, /✅ omp 18\.12\.6/);
	assert.match(md, /⚠️ Fix bug \(abc123\): stopped unexpectedly/);
	assert.match(md, /Folder: ~\/proj/);
	assert.match(md, /OPENAI_API_KEY=\[REDACTED\] failed/);
	assert.ok(!md.includes("sk-proj"));
	assert.ok(!md.includes("command:"));
});

test("reportToHtml: escapes content, links fixes as command URIs, no scripts", () => {
	const report = buildReport(doctorFacts({ sessions: [meta({ title: "<img src=x onerror=alert(1)>", status: "stopped", exitReason: "boom" })] }));
	const html = reportToHtml(report);
	assert.ok(!html.includes("<img src=x"));
	assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
	assert.ok(!/<script/i.test(html));
	assert.ok(html.includes(`href="command:switchyard.resumeSession?${encodeURIComponent(JSON.stringify(["abc123"])).replace(/"/g, "&quot;")}"`));
	assert.equal(commandLink({ label: "x", command: "switchyard.doctor" }), "command:switchyard.doctor");
});

test("aoChecks: running orchestrators are informational lines (harness, workers); none running says how to start one", () => {
	const none = aoChecks({ ...AO_OK, orchestrators: [] }).at(-1);
	assert.equal(none?.level, "info");
	assert.equal(none?.title, "No orchestrator running");
	assert.deepEqual(none?.fixes?.map(f => f.command), ["switchyard.orchestrator.submit"]);
	const checks = aoChecks({ ...AO_OK, orchestrators: [{ projectId: "app", project: "app", harness: "claude-code", workers: 3, openPrs: 2 }, { projectId: "lib", project: "lib", workers: 1, openPrs: 0 }] });
	const lines = checks.slice(-2);
	assert.deepEqual(lines.map(c => [c.level, c.title, c.detail]), [["info", "Orchestrator of app running", "claude-code · 3 workers · 2 open PRs"], ["info", "Orchestrator of lib running", "1 worker"]]);
	assert.deepEqual(lines[0].fixes?.map(f => [f.command, f.args]), [["switchyard.orchestrator.openChat", ["app"]]]);
	assert.deepEqual(aoChecks(AO_OK).map(c => c.level), ["ok", "ok", "ok"], "AO could not list them: no line");
});
