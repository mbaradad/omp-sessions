// omp Doctor: checks → report (markdown for clipboard/issues, HTML with fix links for the panel).
// Pure: facts are gathered by doctor.ts; everything here is unit-tested without VS Code.

import { HOST_CRASHED, HOST_DIED, isOutdated, settleDeadHost } from "../shared/health";
import type { SessionMeta } from "../shared/protocol";
import { type HermesFacts, hermesChecks } from "./doctor-hermes";

export type Level = "ok" | "warn" | "error" | "info";

/** A button in the report: runs `command` with `args`. */
export interface Fix {
	label: string;
	command: string;
	args?: unknown[];
}

export interface Check {
	level: Level;
	title: string;
	detail?: string;
	/** Preformatted text (log tail). */
	code?: string;
	fixes?: Fix[];
}

export interface Section {
	title: string;
	checks: Check[];
}

export interface Report {
	generatedAt: number;
	sections: Section[];
}

/** What doctor.ts found about one session folder. */
export interface SessionFacts {
	/** meta.json as written (not settled). */
	meta: SessionMeta;
	hostAlive: boolean;
	/** Whether the host answered on its socket; only probed for live hosts. */
	socketOk?: boolean;
	blobBytes: number;
	/** Last lines of host.log, read for sessions that need attention. */
	logTail?: string;
}

export interface DoctorFacts {
	now: number;
	extensionVersion: string;
	vscodeVersion: string;
	nodeVersion: string;
	platform: string;
	arch: string;
	osRelease: string;
	/** `vscode.env.remoteName` (ssh-remote, wsl, …); undefined for a local window. */
	remoteName?: string;
	omp: {
		/** `omp.path` setting, when set. */
		configured?: string;
		/** Executable that would be launched. */
		resolved?: string;
		exists: boolean;
		version?: string;
		versionError?: string;
	};
	bun?: string;
	stateDir: string;
	writable: boolean;
	writeError?: string;
	socket: { platform: string; sessionsRoot: string; tmpdir: string };
	sessions: SessionFacts[];
	cleanupDays: number;
	/** Set when Hermes Agent is on this machine (a Hermes home or the hermes command). */
	hermes?: HermesFacts;
}

export const ICON: Record<Level, string> = { ok: "✅", warn: "⚠️", error: "❌", info: "ℹ️" };

const SEVERITY: Record<Level, number> = { info: 0, ok: 0, warn: 1, error: 2 };

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	// URL credentials
	[/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
	// Authorization headers
	[/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [REDACTED]"],
	// key: value / key=value / "key": "value" for secret-looking keys
	[/\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|password|passwd|credential|authorization|cookie)[A-Za-z0-9_.-]*)("?\s*[:=]\s*"?)([^\s"',;}]{4,})/gi, "$1$2[REDACTED]"],
	// Well-known token shapes
	[/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
	[/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED]"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
];

/** Strips secrets (API keys, tokens, passwords, URL credentials) and shortens the home folder to `~`. */
export function redact(text: string, home?: string): string {
	let out = text;
	for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
	if (home && home.length > 1) out = out.replace(new RegExp(`${escapeRegExp(home)}(?=$|[\\\\/\\s"'\`:)\\]])`, "g"), "~");
	return out;
}

/** Last `lines` non-empty lines of a log. */
export function tail(text: string, lines = 20): string {
	return text.split(/\r?\n/).filter(l => l.trim()).slice(-lines).join("\n");
}

/** Stopped for a reason other than the user stopping it or omp exiting normally. */
export function abnormalStop(meta: SessionMeta): boolean {
	return meta.status === "stopped" && !!meta.exitReason && meta.exitReason !== "stopped" && meta.exitReason !== "exited";
}

/** Sessions whose snapshots can go: stopped and untouched for `days` days. */
export function cleanupCandidates(sessions: readonly SessionFacts[], days: number, now: number): SessionFacts[] {
	const cutoff = now - days * 86_400_000;
	return sessions.filter(s => settleDeadHost(s.meta, s.hostAlive).status === "stopped" && s.meta.updatedAt < cutoff && s.blobBytes > 0);
}

/**
 * Unix socket paths are capped at ~104 bytes; the host uses `<session>/s.sock` when it fits and
 * falls back to a short temp path otherwise. Windows uses named pipes.
 */
export function socketCheck(platform: string, sessionsRoot: string, tmpdir: string, join: (...parts: string[]) => string): Check {
	if (platform === "win32") return { level: "ok", title: "Session sockets: Windows named pipes" };
	const sampleId = "x".repeat(16);
	const preferred = join(sessionsRoot, sampleId, "s.sock");
	if (Buffer.byteLength(preferred) < 100) return { level: "ok", title: `Session socket path length OK (${Buffer.byteLength(preferred)} bytes)` };
	const fallback = join(tmpdir, "ompv-0000", `${sampleId}.sock`);
	if (Buffer.byteLength(fallback) < 100) {
		return { level: "info", title: "Session sockets use the temp folder", detail: `The state folder path is too long for a Unix socket (${Buffer.byteLength(preferred)} bytes); hosts listen under ${join(tmpdir, "ompv-<uid>")} instead.` };
	}
	return { level: "error", title: "Socket paths are too long", detail: `Both ${preferred} and ${fallback} exceed the ~104-byte Unix socket limit. Set OMP_VSCODE_HOME or TMPDIR to a shorter folder.` };
}

/** One line per session: is it what meta.json claims, and what to do about it. */
export function assessSession(s: SessionFacts, extensionVersion: string): Check {
	const m = s.meta;
	const settled = settleDeadHost(m, s.hostAlive);
	const name = `${m.title} (${m.id})`;
	const lines = [`Folder: ${m.cwd}`, `Snapshots: ${formatBytes(s.blobBytes)}`];
	const showLog: Fix = { label: "Show log", command: "omp.showLog", args: [m.id] };
	if (settled !== m) {
		const crashed = settled.exitReason === HOST_CRASHED;
		lines.unshift(`meta.json says "${m.status}" but host process ${m.pid} is gone${crashed ? " — it died mid-turn" : ""}.`);
		if (crashed && settled.ompSessionFile) lines.push("Resume asks omp to continue the interrupted turn (an interrupted queued task goes back to the queue instead).");
		return {
			level: "error",
			title: `${name}: host died while ${m.status}`,
			detail: lines.join("\n"),
			code: s.logTail,
			fixes: [{ label: "Mark stopped", command: "omp.doctor.markStopped", args: [m.id] }, { label: crashed ? "Resume and continue" : "Resume", command: "omp.resumeSession", args: [m.id] }, showLog],
		};
	}
	if (m.status === "stopped") {
		lines.unshift(`Stopped${m.exitReason ? `: ${m.exitReason}` : ""}${typeof m.exitCode === "number" ? ` (exit code ${m.exitCode})` : ""}.`);
		if (m.exitReason === HOST_CRASHED && m.ompSessionFile) lines.push("Resume asks omp to continue the interrupted turn (an interrupted queued task goes back to the queue instead).");
		if (abnormalStop(m) || m.exitReason === HOST_DIED) {
			return { level: "warn", title: `${name}: stopped unexpectedly`, detail: lines.join("\n"), code: s.logTail, fixes: [{ label: "Resume", command: "omp.resumeSession", args: [m.id] }, showLog] };
		}
		return { level: "ok", title: `${name}: stopped`, detail: lines.join("\n") };
	}
	lines.unshift(`Running (${m.status}), host pid ${m.pid}, host version ${m.hostVersion ?? "unknown (older than 0.4)"}.`);
	if (s.socketOk === false) {
		return { level: "warn", title: `${name}: host is not answering`, detail: `${lines.join("\n")}\nThe host process is alive but does not accept connections on ${m.socket}.`, code: s.logTail, fixes: [showLog, { label: "Stop", command: "omp.stopSession", args: [m.id] }] };
	}
	const fixes: Fix[] = [];
	let level: Level = "ok";
	let title = `${name}: ${m.status}`;
	if (m.authProblem) {
		level = "warn";
		title = `${name}: omp can't use a model`;
		lines.push(`omp reported: ${m.authProblem}`);
		fixes.push({ label: "Log in", command: "omp.login" });
	}
	if (isOutdated(m, extensionVersion)) {
		level = "warn";
		if (!m.authProblem) title = `${name}: update available`;
		lines.push(`Started by extension ${m.hostVersion ?? "< 0.4"}; this is ${extensionVersion}. Restart it on the current host when idle.`);
		fixes.push({ label: "Upgrade host", command: "omp.upgradeSession", args: [m.id] });
	}
	return { level, title, detail: lines.join("\n"), fixes: fixes.length ? fixes : undefined };
}

export function buildReport(f: DoctorFacts, join: (...parts: string[]) => string): Report {
	const omp: Check[] = [];
	const install: Fix = { label: "Install omp", command: "omp.installOmp" };
	const setPath: Fix = { label: "Set path…", command: "omp.setOmpPath" };
	if (!f.omp.resolved) {
		omp.push({ level: "error", title: "omp is not installed", detail: "No `omp` executable on PATH, in ~/.bun/bin, ~/.local/bin, ~/.npm-global/bin, /opt/homebrew/bin or /usr/local/bin.", fixes: [install, setPath] });
	} else if (!f.omp.exists) {
		omp.push({ level: "error", title: "omp.path points to a missing file", detail: f.omp.resolved, fixes: [setPath, install] });
	} else if (f.omp.versionError) {
		const bunHint = /bun/i.test(f.omp.versionError) && !f.bun ? "\nomp runs on Bun (≥ 1.3.14), which was not found." : "";
		omp.push({ level: "error", title: "`omp --version` failed", detail: `${f.omp.resolved}\n${f.omp.versionError}${bunHint}`, fixes: [install, setPath] });
	} else {
		omp.push({ level: "ok", title: `omp ${f.omp.version ?? "(unknown version)"}`, detail: `${f.omp.resolved}${f.omp.configured ? " (from omp.path)" : ""}` });
	}
	omp.push(f.bun ? { level: "ok", title: "Bun found", detail: f.bun } : { level: f.omp.exists && !f.omp.versionError ? "info" : "warn", title: "Bun not found on PATH", detail: "omp runs on Bun; the installer sets it up." });
	const unauthenticated = f.sessions.filter(s => s.hostAlive && s.meta.status !== "stopped" && s.meta.authProblem);
	omp.push(
		unauthenticated.length
			? { level: "warn", title: `${unauthenticated.length} running session(s) can't use a model`, detail: "Not logged in to a provider, or the API key is missing or rejected.", fixes: [{ label: "Log in", command: "omp.login" }] }
			: { level: "info", title: "Model providers", detail: "No running session reports a login problem.", fixes: [{ label: "Log in to a provider", command: "omp.login" }] },
	);

	const env: Check[] = [
		{ level: "info", title: `omp Sessions ${f.extensionVersion}` },
		{ level: "info", title: `VS Code ${f.vscodeVersion}, Node ${f.nodeVersion}` },
		{ level: "info", title: `Platform ${f.platform} ${f.arch} (${f.osRelease})` },
		{ level: "info", title: f.remoteName ? `Remote: ${f.remoteName}` : "Local window", detail: f.remoteName ? "omp and the session hosts run on the remote machine." : undefined },
	];

	const storage: Check[] = [
		f.writable ? { level: "ok", title: "Sessions folder is writable", detail: f.stateDir } : { level: "error", title: "Sessions folder is not writable", detail: `${f.stateDir}\n${f.writeError ?? ""}`.trim() },
		socketCheck(f.socket.platform, f.socket.sessionsRoot, f.socket.tmpdir, join),
	];

	const sessions = [...f.sessions].sort((a, b) => b.meta.updatedAt - a.meta.updatedAt).map(s => assessSession(s, f.extensionVersion));
	sessions.sort((a, b) => SEVERITY[b.level] - SEVERITY[a.level]);
	const outdated = f.sessions.filter(s => s.hostAlive && isOutdated(s.meta, f.extensionVersion));
	if (outdated.length > 1) sessions.unshift({ level: "warn", title: `${outdated.length} sessions run an older host`, fixes: [{ label: "Upgrade idle sessions", command: "omp.upgradeAllSessions" }] });
	if (sessions.length === 0) sessions.push({ level: "info", title: "No sessions yet" });

	const total = f.sessions.reduce((n, s) => n + s.blobBytes, 0);
	const old = cleanupCandidates(f.sessions, f.cleanupDays, f.now);
	const oldBytes = old.reduce((n, s) => n + s.blobBytes, 0);
	const disk: Check[] = [
		{ level: "info", title: `File snapshots: ${formatBytes(total)} in ${f.sessions.length} session(s)` },
		old.length
			? { level: oldBytes > 512 * 1024 * 1024 ? "warn" : "info", title: `${formatBytes(oldBytes)} in ${old.length} session(s) stopped for over ${f.cleanupDays} days`, detail: "Deleting snapshots only loses the diffs/reverts of those sessions; transcripts stay.", fixes: [{ label: "Clean up…", command: "omp.cleanUpSnapshots" }] }
			: { level: "ok", title: `Nothing to clean up (no stopped session older than ${f.cleanupDays} days with snapshots)` },
	];

	return {
		generatedAt: f.now,
		sections: [
			{ title: "omp", checks: omp },
			{ title: "Environment", checks: env },
			{ title: "Storage", checks: storage },
			{ title: `Sessions (${f.sessions.length})`, checks: sessions },
			{ title: "Disk", checks: disk },
			...(f.hermes ? [{ title: "Hermes", checks: hermesChecks(f.hermes) }] : []),
		],
	};
}

/** Error and warning counts, for the summary line. */
export function summary(report: Report): { errors: number; warnings: number } {
	let errors = 0;
	let warnings = 0;
	for (const s of report.sections)
		for (const c of s.checks) {
			if (c.level === "error") errors++;
			else if (c.level === "warn") warnings++;
		}
	return { errors, warnings };
}

/** Plain markdown (no command links), redacted: for the clipboard and issue reports. */
export function reportToMarkdown(report: Report, home?: string): string {
	const { errors, warnings } = summary(report);
	const out = [`# omp Doctor`, "", `${new Date(report.generatedAt).toISOString()} — ${errors} error(s), ${warnings} warning(s)`, ""];
	for (const section of report.sections) {
		out.push(`## ${section.title}`, "");
		for (const c of section.checks) {
			out.push(`- ${ICON[c.level]} ${c.title}`);
			if (c.detail) for (const line of c.detail.split("\n")) out.push(`  ${line}`);
			if (c.code) out.push("  ```", ...c.code.split("\n").map(l => `  ${l}`), "  ```");
		}
		out.push("");
	}
	return redact(out.join("\n"), home);
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function commandLink(fix: Fix): string {
	return `command:${fix.command}${fix.args?.length ? `?${encodeURIComponent(JSON.stringify(fix.args))}` : ""}`;
}

/** Commands the report may link to (the webview only enables these). */
export function reportCommands(report: Report): string[] {
	const ids = new Set(["omp.doctor", "omp.copyDiagnostics", "omp.reportIssue"]);
	for (const s of report.sections) for (const c of s.checks) for (const f of c.fixes ?? []) ids.add(f.command);
	return [...ids];
}

/** Self-contained page for the Doctor webview: no scripts; fixes are command links. */
export function reportToHtml(report: Report, home?: string): string {
	const { errors, warnings } = summary(report);
	const clean = (s: string) => escapeHtml(redact(s, home));
	const parts: string[] = [];
	for (const section of report.sections) {
		parts.push(`<h2>${escapeHtml(section.title)}</h2><ul>`);
		for (const c of section.checks) {
			parts.push(`<li class="${c.level}"><span class="icon">${ICON[c.level]}</span><div><div class="title">${clean(c.title)}</div>`);
			if (c.detail) parts.push(`<div class="detail">${clean(c.detail).replace(/\n/g, "<br>")}</div>`);
			if (c.code) parts.push(`<pre>${clean(c.code)}</pre>`);
			if (c.fixes?.length) parts.push(`<div class="fixes">${c.fixes.map(fx => `<a class="button" href="${escapeHtml(commandLink(fx))}">${escapeHtml(fx.label)}</a>`).join("")}</div>`);
			parts.push("</div></li>");
		}
		parts.push("</ul>");
	}
	const headline = errors || warnings ? `${errors} error(s), ${warnings} warning(s)` : "Everything looks good";
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:0 20px 24px;line-height:1.5;max-width:960px}
h1{font-size:1.5em;margin-bottom:0}h2{font-size:1.1em;margin:1.4em 0 .4em;border-bottom:1px solid var(--vscode-widget-border,#8884);padding-bottom:4px}
ul{list-style:none;padding:0;margin:0}li{display:flex;gap:10px;padding:6px 0}.icon{width:1.4em;flex:none}
.title{font-weight:600}.detail{color:var(--vscode-descriptionForeground);font-size:.95em}
pre{background:var(--vscode-textCodeBlock-background);padding:8px;overflow:auto;font-size:.85em;max-height:280px}
.fixes{margin-top:4px;display:flex;gap:8px;flex-wrap:wrap}.toolbar{display:flex;gap:8px;margin:12px 0}
a.button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:2px 10px;border-radius:3px;text-decoration:none}
a.button:hover{background:var(--vscode-button-secondaryHoverBackground)}a.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
</style></head><body><h1>omp Doctor</h1><p class="detail">${escapeHtml(headline)} · ${escapeHtml(new Date(report.generatedAt).toLocaleString())}</p>
<div class="toolbar"><a class="button primary" href="command:omp.doctor">Re-run</a><a class="button" href="command:omp.copyDiagnostics">Copy diagnostics</a><a class="button" href="command:omp.reportIssue">Report issue…</a></div>
${parts.join("\n")}</body></html>`;
}

export const OMP_PACKAGE = "@oh-my-pi/pi-coding-agent";

function shQuote(s: string): string {
	return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function psQuote(s: string): string {
	return `"${s.replace(/[`"$]/g, "`$&")}"`;
}

/**
 * The command that installs omp, by what is available: Bun's global install (omp runs on Bun);
 * else npm, which can install Bun alongside; else Bun's official installer, then Bun.
 * Windows commands are PowerShell.
 */
export function installCommand(platform: string, bun: string | undefined, npm: string | undefined): string {
	const win = platform === "win32";
	const run = (exe: string) => (win ? `& ${psQuote(exe)}` : shQuote(exe));
	if (bun) return `${run(bun)} install -g ${OMP_PACKAGE}`;
	if (npm) return `${run(npm)} install -g bun ${OMP_PACKAGE}`;
	if (win) return `irm bun.sh/install.ps1 | iex; & "$env:USERPROFILE\\.bun\\bin\\bun.exe" install -g ${OMP_PACKAGE}`;
	return `curl -fsSL https://bun.sh/install | bash && "$HOME/.bun/bin/bun" install -g ${OMP_PACKAGE}`;
}

/** GitHub-style new-issue URL with the report prefilled; undefined when it would be too long for a URL. */
export function issueUrl(bugsUrl: string, title: string, body: string, maxLength = 7500): string | undefined {
	const base = bugsUrl.replace(/\/+$/, "");
	const url = `${base}/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
	return url.length <= maxLength ? url : undefined;
}
