// omp's folders (profiles, XDG, overrides), `omp gc` archived transcripts, and the shared cost
// aggregation behind meta.cost and the dashboard.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { TranscriptUsage, sessionTranscripts, totalCost } from "../../src/shared/cost";
import { archivedTranscriptPath, ompPaths, ompPathsForArgs, prepareResume } from "../../src/shared/omp-paths";
import { listSubagentTranscripts, listTranscripts, readTranscriptHead } from "../../src/shared/transcript-files";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omp-data-"));
}

const header = (id: string, cwd: string) => `${JSON.stringify({ type: "title", v: 1, title: `T ${id}`, pad: "    " })}\n${JSON.stringify({ type: "session", version: 3, id, cwd })}\n`;
const call = (ts: number, cost: number, model = "m") => JSON.stringify({ type: "message", id: `e${ts}`, message: { role: "assistant", content: [], provider: "p", model, usage: { totalTokens: 10, cost: { total: cost } }, timestamp: ts } });
const side = (ts: number, cost: number) => JSON.stringify({ type: "model_usage", provider: "p", model: "small", usage: { totalTokens: 5, cost: { total: cost } }, timestamp: ts });

test("ompPaths: omp's precedence for profiles, PI_CODING_AGENT_DIR, XDG and --session-dir", () => {
	const home = tmp();
	try {
		const base = path.join(home, ".omp");
		// Defaults.
		let p = ompPaths({ env: {}, home, platform: "linux" });
		assert.equal(p.agentDir, path.join(base, "agent"));
		assert.equal(p.sessionsDir, path.join(base, "agent", "sessions"));
		assert.equal(p.archivedSessionsDir, path.join(base, "agent", "archive", "sessions"));
		assert.equal(p.sessionDir, undefined);
		// PI_CONFIG_DIR renames the root; PI_CODING_AGENT_DIR overrides the default profile's agent folder.
		assert.equal(ompPaths({ env: { PI_CONFIG_DIR: ".pi" }, home, platform: "linux" }).agentDir, path.join(home, ".pi", "agent"));
		p = ompPaths({ env: { PI_CODING_AGENT_DIR: "/custom/agent" }, home, platform: "linux" });
		assert.equal(p.agentDir, path.resolve("/custom/agent"));
		assert.equal(p.sessionsDir, path.join(path.resolve("/custom/agent"), "sessions"));
		// A named profile ignores PI_CODING_AGENT_DIR; OMP_PROFILE wins over PI_PROFILE, even when empty.
		p = ompPaths({ env: { OMP_PROFILE: "work", PI_PROFILE: "old", PI_CODING_AGENT_DIR: "/custom/agent" }, home, platform: "linux" });
		assert.equal(p.profile, "work");
		assert.equal(p.agentDir, path.join(base, "profiles", "work", "agent"));
		assert.equal(ompPaths({ env: { OMP_PROFILE: "", PI_PROFILE: "old" }, home, platform: "linux" }).profile, undefined);
		assert.equal(ompPaths({ env: { PI_PROFILE: "old" }, home, platform: "linux" }).profile, "old");
		assert.equal(ompPaths({ env: { OMP_PROFILE: "default" }, home, platform: "linux" }).profile, undefined);
		// A PI_CODING_AGENT_DIR that is a bypassed PI_PROFILE's folder doesn't count as an override.
		assert.equal(ompPaths({ env: { OMP_PROFILE: "", PI_PROFILE: "old", PI_CODING_AGENT_DIR: path.join(base, "profiles", "old", "agent") }, home, platform: "linux" }).agentDir, path.join(base, "agent"));
		// --profile beats the environment; --session-dir beats PI_CODING_AGENT_SESSION_DIR.
		p = ompPathsForArgs(["--model", "x", "--profile=lab", "--session-dir", "/flat"], { env: { OMP_PROFILE: "work", PI_CODING_AGENT_SESSION_DIR: "/env-flat" }, home, platform: "linux" });
		assert.equal(p.profile, "lab");
		assert.equal(p.sessionDir, path.resolve("/flat"));
		assert.equal(ompPaths({ env: { PI_CODING_AGENT_SESSION_DIR: "/env-flat" }, home, platform: "linux" }).sessionDir, path.resolve("/env-flat"));

		// XDG data home: only when $XDG_DATA_HOME/omp exists, drops the agent/ level, not on Windows,
		// not with an agent folder override; named profiles need their own XDG folder.
		const xdg = path.join(home, "xdg");
		assert.equal(ompPaths({ env: { XDG_DATA_HOME: xdg }, home, platform: "linux" }).sessionsDir, path.join(base, "agent", "sessions"));
		fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });
		p = ompPaths({ env: { XDG_DATA_HOME: xdg }, home, platform: "linux" });
		assert.equal(p.sessionsDir, path.join(xdg, "omp", "sessions"));
		assert.equal(p.archivedSessionsDir, path.join(xdg, "omp", "archive", "sessions"));
		assert.equal(p.agentDir, path.join(base, "agent"), "config stays in the agent folder");
		assert.equal(ompPaths({ env: { XDG_DATA_HOME: xdg }, home, platform: "win32" }).sessionsDir, path.join(base, "agent", "sessions"));
		assert.equal(ompPaths({ env: { XDG_DATA_HOME: xdg, PI_CODING_AGENT_DIR: "/custom/agent" }, home, platform: "linux" }).sessionsDir, path.join(path.resolve("/custom/agent"), "sessions"));
		assert.equal(ompPaths({ env: { XDG_DATA_HOME: xdg, OMP_PROFILE: "work" }, home, platform: "linux" }).sessionsDir, path.join(base, "profiles", "work", "agent", "sessions"));
		fs.mkdirSync(path.join(xdg, "omp", "profiles", "work"), { recursive: true });
		assert.equal(ompPaths({ env: { XDG_DATA_HOME: xdg, OMP_PROFILE: "work" }, home, platform: "linux" }).sessionsDir, path.join(xdg, "omp", "profiles", "work", "sessions"));
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("archived transcripts: listed, read gunzipped (subagents too), restored for resume", async () => {
	const home = tmp();
	try {
		const paths = ompPaths({ env: {}, home, platform: "linux" });
		const slug = "--work-proj--";
		const live = path.join(paths.sessionsDir, slug, "2026-01-02T00-00-00-000Z_live.jsonl");
		fs.mkdirSync(path.dirname(live), { recursive: true });
		fs.writeFileSync(live, `${header("live", "/work/proj")}${call(3000, 1)}\n`);
		fs.utimesSync(live, new Date(3000_000), new Date(3000_000));
		// What `omp gc --archive` leaves: gzipped transcript + the artifact folder moved next to it.
		const original = path.join(paths.sessionsDir, slug, "2026-01-01T00-00-00-000Z_old.jsonl");
		const archived = path.join(paths.archivedSessionsDir, slug, `${path.basename(original)}.gz`);
		assert.equal(archivedTranscriptPath(original), archived);
		fs.mkdirSync(path.join(path.dirname(archived), path.basename(original, ".jsonl"), "Scout"), { recursive: true });
		fs.writeFileSync(archived, zlib.gzipSync(`${header("old", "/work/proj")}${call(1000, 2)}\n${side(1500, 0.5)}\n`));
		fs.writeFileSync(path.join(path.dirname(archived), path.basename(original, ".jsonl"), "Scout", "Scout.jsonl"), `${header("sub", "/work/proj")}${call(1200, 4, "sub")}\n`);
		fs.utimesSync(archived, new Date(1000_000), new Date(1000_000));

		const listed = await listTranscripts(paths);
		assert.deepEqual(
			listed.map(t => [path.basename(t.file), t.archived]),
			[
				[path.basename(live), false],
				[path.basename(archived), true],
			],
		);
		assert.deepEqual(readTranscriptHead(archived), { title: "T old", cwd: "/work/proj", id: "old", parentSession: "" });
		assert.equal((await listSubagentTranscripts(archived)).length, 1);

		// meta.ompSessionFile still names the original path: the cost follows the archive.
		const usage = new TranscriptUsage();
		assert.equal(totalCost(await usage.records([original])), 6.5);

		// Resume: an archived transcript is put back where omp wrote it, artifacts included.
		const target = prepareResume(original);
		assert.deepEqual(target, { kind: "restored", file: original, archive: archived });
		assert.ok(fs.existsSync(original) && !fs.existsSync(archived));
		assert.ok(fs.existsSync(path.join(paths.sessionsDir, slug, path.basename(original, ".jsonl"), "Scout", "Scout.jsonl")));
		assert.equal(readTranscriptHead(original)?.id, "old");
		assert.deepEqual(prepareResume(original), { kind: "present", file: original });
		assert.equal(prepareResume(path.join(paths.sessionsDir, slug, "gone.jsonl")).kind, "missing");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("session cost: every transcript of the session, subagents and side calls, copies once", async () => {
	const dir = tmp();
	try {
		const first = path.join(dir, "first.jsonl");
		const second = path.join(dir, "second.jsonl");
		fs.writeFileSync(first, `${header("a", "/w")}${call(1000, 1)}\n${side(1100, 0.25)}\n`);
		// After a fresh-context switch; the second file also carries a copy of an earlier call (fork).
		fs.writeFileSync(second, `${header("b", "/w")}${call(1000, 1)}\n${call(2000, 2)}\n`);
		fs.mkdirSync(path.join(dir, "second", "Worker"), { recursive: true });
		fs.writeFileSync(path.join(dir, "second", "Worker", "Worker.jsonl"), `${header("w", "/w")}${call(2100, 4, "sub")}\n`);
		const files = sessionTranscripts({ ompSessionFile: second, ompSessionFiles: [first] });
		assert.deepEqual(files, [first, second]);
		const usage = new TranscriptUsage();
		const records = await usage.records(files);
		assert.equal(records.length, 4);
		assert.equal(totalCost(records), 7.25);
		// Only the current transcript (what meta.cost used to count, minus subagents) is less.
		assert.equal(totalCost(await usage.records([second])), 7);
		// Appended calls are picked up on the next read.
		fs.appendFileSync(second, `${call(3000, 0.5)}\n`);
		assert.equal(totalCost(await usage.records(files)), 7.75);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
