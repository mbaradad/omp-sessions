import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
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
	socketCheck,
	summary,
} from "../../src/ext/doctor-report";
import { HOST_CRASHED, HOST_DIED, isAuthError, isOutdated, needsRestore, settleDeadHost } from "../../src/shared/health";
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
		hostVersion: "0.4.0",
		...over,
	};
}

function facts(over: Partial<SessionFacts> = {}): SessionFacts {
	return { meta: meta(), hostAlive: true, socketOk: true, blobBytes: 0, ...over };
}

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
		socket: { platform: "linux", sessionsRoot: "/home/u/.omp/vscode/sessions", tmpdir: "/tmp" },
		sessions: [],
		cleanupDays: 14,
		...over,
	};
}

// ---------- stale / crash detection ----------

test("settleDeadHost: dead host mid-turn → stopped with HOST_CRASHED; idle → HOST_DIED; alive or stopped untouched", () => {
	for (const status of ["working", "waiting"] as const) {
		const m = meta({ status });
		const settled = settleDeadHost(m, false);
		assert.equal(settled.status, "stopped");
		assert.equal(settled.exitReason, HOST_CRASHED);
		assert.equal(m.status, status, "input not mutated");
	}
	assert.equal(settleDeadHost(meta({ status: "idle" }), false).exitReason, HOST_DIED);
	assert.equal(settleDeadHost(meta({ status: "starting" }), false).exitReason, HOST_DIED);
	const alive = meta({ status: "working" });
	assert.equal(settleDeadHost(alive, true), alive);
	const stopped = meta({ status: "stopped", exitReason: "stopped" });
	assert.equal(settleDeadHost(stopped, false), stopped);
});

test("needsRestore: only stopped sessions whose host crashed mid-turn and have a transcript", () => {
	assert.equal(needsRestore(settleDeadHost(meta({ status: "working" }), false)), true);
	assert.equal(needsRestore(settleDeadHost(meta({ status: "idle" }), false)), false);
	assert.equal(needsRestore(meta({ status: "stopped", exitReason: "stopped" })), false);
	assert.equal(needsRestore(meta({ status: "stopped", exitReason: HOST_CRASHED, ompSessionFile: undefined })), false);
	assert.equal(needsRestore(meta({ status: "working", exitReason: HOST_CRASHED })), false, "a running session is never restored");
});

test("isOutdated: running sessions on another (or unknown) host version", () => {
	assert.equal(isOutdated(meta({ hostVersion: "0.3.0" }), "0.4.0"), true);
	assert.equal(isOutdated(meta({ hostVersion: undefined }), "0.4.0"), true);
	assert.equal(isOutdated(meta({ hostVersion: "0.4.0" }), "0.4.0"), false);
	assert.equal(isOutdated(meta({ hostVersion: "0.3.0", status: "stopped" }), "0.4.0"), false);
});

test("isAuthError: recognizes omp's login/API-key failures, not ordinary errors", () => {
	for (const msg of [
		"No API key found for anthropic",
		"No API key available",
		"OpenAI API key was rejected (401)",
		"Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.",
		"No credentials found. Run `omp` and use /login to add accounts.",
		"No model selected",
		"No model is currently selected.",
		"no model is available",
		"401 Unauthorized",
		"Authentication failed",
	]) {
		assert.equal(isAuthError(msg), true, msg);
	}
	for (const msg of ["fake provider error", "Request was aborted", "Rate limit exceeded (429)", "context window exceeded", undefined, ""]) {
		assert.equal(isAuthError(msg), false, String(msg));
	}
});

// ---------- redaction ----------

test("redact: API keys, tokens, passwords, URL credentials, auth headers, home folder", () => {
	const input = [
		"ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
		'{"apiKey": "AIzaSyA1234567890abcdefghijklmnopqrstuv"}',
		"token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"password=hunter2hunter2",
		"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
		"proxy https://user:s3cret@proxy.example.com:8080",
		"aws AKIAABCDEFGHIJKLMNOP",
		"slack xoxb-1234567890-abcdefghij",
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

test("assessSession: stale working session → error with mark-stopped/resume fixes and restore hint", () => {
	const check = assessSession(facts({ meta: meta({ status: "working" }), hostAlive: false, socketOk: undefined, logTail: "boom" }), "0.4.0");
	assert.equal(check.level, "error");
	assert.match(check.title, /host died while working/);
	assert.match(check.detail ?? "", /--restore/);
	assert.equal(check.code, "boom");
	assert.deepEqual(
		check.fixes?.map(f => f.command),
		["omp.doctor.markStopped", "omp.resumeSession", "omp.showLog"],
	);
	assert.deepEqual(check.fixes?.[0].args, ["abc123"]);
});

test("assessSession: running states", () => {
	assert.equal(assessSession(facts(), "0.4.0").level, "ok");
	const outdated = assessSession(facts({ meta: meta({ hostVersion: "0.3.0" }) }), "0.4.0");
	assert.equal(outdated.level, "warn");
	assert.match(outdated.title, /update available/);
	assert.deepEqual(outdated.fixes?.map(f => f.command), ["omp.upgradeSession"]);
	const deaf = assessSession(facts({ socketOk: false }), "0.4.0");
	assert.equal(deaf.level, "warn");
	assert.match(deaf.title, /not answering/);
	const auth = assessSession(facts({ meta: meta({ authProblem: "no model is available" }) }), "0.4.0");
	assert.equal(auth.level, "warn");
	assert.deepEqual(auth.fixes?.map(f => f.command), ["omp.login"]);
});

test("assessSession: stopped sessions — normal is ok, failures warn with the log", () => {
	assert.equal(assessSession(facts({ meta: meta({ status: "stopped", exitReason: "stopped" }), hostAlive: false }), "0.4.0").level, "ok");
	assert.equal(assessSession(facts({ meta: meta({ status: "stopped", exitReason: "exited", exitCode: 0 }), hostAlive: false }), "0.4.0").level, "ok");
	const failed = assessSession(facts({ meta: meta({ status: "stopped", exitReason: "exit code 1", exitCode: 1 }), hostAlive: false, logTail: "Error: x" }), "0.4.0");
	assert.equal(failed.level, "warn");
	assert.equal(failed.code, "Error: x");
	const crashed = assessSession(facts({ meta: meta({ status: "stopped", exitReason: HOST_CRASHED }), hostAlive: false }), "0.4.0");
	assert.equal(crashed.level, "warn");
	assert.match(crashed.detail ?? "", /--restore/);
});

// ---------- cleanup / sockets / misc ----------

test("cleanupCandidates: stopped (or dead) sessions older than N days that have snapshots", () => {
	const all = [
		facts({ meta: meta({ id: "old", status: "stopped", updatedAt: NOW - 30 * DAY }), hostAlive: false, blobBytes: 100 }),
		facts({ meta: meta({ id: "recent", status: "stopped", updatedAt: NOW - 2 * DAY }), hostAlive: false, blobBytes: 100 }),
		facts({ meta: meta({ id: "running", updatedAt: NOW - 30 * DAY }), hostAlive: true, blobBytes: 100 }),
		facts({ meta: meta({ id: "dead", status: "working", updatedAt: NOW - 30 * DAY }), hostAlive: false, blobBytes: 100 }),
		facts({ meta: meta({ id: "empty", status: "stopped", updatedAt: NOW - 30 * DAY }), hostAlive: false, blobBytes: 0 }),
	];
	assert.deepEqual(
		cleanupCandidates(all, 14, NOW).map(s => s.meta.id),
		["old", "dead"],
	);
	assert.deepEqual(
		cleanupCandidates(all, 0, NOW).map(s => s.meta.id),
		["old", "recent", "dead"],
	);
});

test("socketCheck: short paths ok, long state dirs fall back to tmp, both too long is an error, Windows pipes", () => {
	const j = path.posix.join;
	assert.equal(socketCheck("linux", "/home/u/.omp/vscode/sessions", "/tmp", j).level, "ok");
	const long = `/home/u/${"deep/".repeat(20)}sessions`;
	assert.equal(socketCheck("linux", long, "/tmp", j).level, "info");
	assert.equal(socketCheck("darwin", long, `/var/${"x".repeat(100)}`, j).level, "error");
	assert.equal(socketCheck("win32", long, "C:\\tmp", path.win32.join).level, "ok");
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

test("buildReport: missing omp is an error with install/set-path fixes", () => {
	const report = buildReport(doctorFacts({ omp: { exists: false }, bun: undefined }), path.posix.join);
	const omp = report.sections[0].checks[0];
	assert.equal(omp.level, "error");
	assert.match(omp.title, /not installed/);
	assert.deepEqual(omp.fixes?.map(f => f.command), ["omp.installOmp", "omp.setOmpPath"]);
	const broken = buildReport(doctorFacts({ omp: { configured: "/nope/omp", resolved: "/nope/omp", exists: false } }), path.posix.join);
	assert.match(broken.sections[0].checks[0].title, /missing file/);
	const failing = buildReport(doctorFacts({ omp: { resolved: "/x/omp", exists: true, versionError: "/usr/bin/env: 'bun': No such file or directory" }, bun: undefined }), path.posix.join);
	assert.match(failing.sections[0].checks[0].detail ?? "", /runs on Bun/);
});

test("buildReport: healthy setup has no errors; problems are counted and sorted first", () => {
	const healthy = buildReport(doctorFacts({ sessions: [facts()] }), path.posix.join);
	assert.deepEqual(summary(healthy), { errors: 0, warnings: 0 });
	const sick = buildReport(
		doctorFacts({
			writable: false,
			writeError: "EACCES",
			sessions: [facts(), facts({ meta: meta({ id: "dead", status: "working" }), hostAlive: false }), facts({ meta: meta({ id: "old", hostVersion: "0.3.0" }) }), facts({ meta: meta({ id: "old2", hostVersion: "0.3.0" }) })],
		}),
		path.posix.join,
	);
	const { errors, warnings } = summary(sick);
	assert.equal(errors, 2); // unwritable dir + dead host
	assert.ok(warnings >= 3);
	const sessions = sick.sections.find(s => s.title.startsWith("Sessions"));
	assert.ok(sessions);
	assert.match(sessions.checks[0].title, /2 sessions run an older host/);
	assert.deepEqual(sessions.checks[0].fixes?.map(f => f.command), ["omp.upgradeAllSessions"]);
	assert.equal(sessions.checks[1].level, "error");
	assert.ok(reportCommands(sick).includes("omp.doctor.markStopped"));
});

test("buildReport: disk section offers cleanup for old stopped sessions", () => {
	const report = buildReport(doctorFacts({ sessions: [facts({ meta: meta({ status: "stopped", exitReason: "stopped", updatedAt: NOW - 40 * DAY }), hostAlive: false, blobBytes: 2048 })] }), path.posix.join);
	const disk = report.sections.find(s => s.title === "Disk");
	assert.ok(disk);
	assert.match(disk.checks[1].title, /2\.0 KB in 1 session\(s\) stopped for over 14 days/);
	assert.deepEqual(disk.checks[1].fixes?.map(f => f.command), ["omp.cleanUpSnapshots"]);
});

test("reportToMarkdown: icons, details, log tails, secrets redacted, no command links", () => {
	const report = buildReport(
		doctorFacts({ sessions: [facts({ meta: meta({ status: "stopped", exitReason: "exit code 1", exitCode: 1, cwd: "/home/alice/proj" }), hostAlive: false, logTail: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv failed" })] }),
		path.posix.join,
	);
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
	const report = buildReport(doctorFacts({ sessions: [facts({ meta: meta({ title: "<img src=x onerror=alert(1)>", status: "working" }), hostAlive: false })] }), path.posix.join);
	const html = reportToHtml(report);
	assert.ok(!html.includes("<img src=x"));
	assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
	assert.ok(!/<script/i.test(html));
	assert.ok(html.includes(`href="command:omp.doctor.markStopped?${encodeURIComponent(JSON.stringify(["abc123"])).replace(/"/g, "&quot;")}"`));
	assert.equal(commandLink({ label: "x", command: "omp.doctor" }), "command:omp.doctor");
});
