// `switchyard migrate`: the transcript graft that hands an old omp conversation to an AO session, the
// organize.json merge, and which old sessions a run adopts or skips.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { graftTranscript, isFreshTranscript, readTranscriptHeader, transcriptsForCwd } from "../../src/migrate/graft";
import { readLegacyState } from "../../src/migrate/legacy";
import { type Ledger, mergeOrganize, planSessions } from "../../src/migrate/migrate";
import { emptyOrgData, type OrgData } from "../../src/shared/organize";

const temps: string[] = [];
after(() => {
	for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sy-migrate-"));
	temps.push(dir);
	return dir;
}

const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const TITLE = { type: "title", v: 1, title: "t", source: "user", pad: "    " };

/** A transcript as omp writes it: padded title line, session header, then entries. */
function transcript(file: string, id: string, cwd: string, entries: object[] = []): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, line(TITLE) + line({ type: "session", version: 3, id, timestamp: "2026-11-01T00:00:00.000Z", cwd, title: "old" }) + entries.map(line).join(""));
	return file;
}

const CONVERSATION = [
	{ type: "model_change", id: "m1", parentId: null, model: "anthropic/claude-opus-5-5" },
	{ type: "message", id: "u1", parentId: "m1", message: { role: "user", content: "hello" } },
	{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
];

function entries(file: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l) as Record<string, unknown>);
}

test("graft: the fresh AO transcript takes the old entries verbatim under its own id and cwd; the source is untouched", () => {
	const dir = temp();
	const source = transcript(path.join(dir, "sessions", "-old", "2026_OLD.jsonl"), "OLD", "/old/cwd", CONVERSATION);
	fs.mkdirSync(path.join(dir, "sessions", "-old", "2026_OLD"));
	fs.writeFileSync(path.join(dir, "sessions", "-old", "2026_OLD", "1.bash.log"), "artifact");
	const target = transcript(path.join(dir, "sessions", "-ao", "2027_NEW.jsonl"), "NEW", "/ao/ws", [{ type: "model_change", id: "x", parentId: null, model: "m" }]);
	const before = fs.readFileSync(source, "utf8");

	assert.equal(isFreshTranscript(target), true);
	const result = graftTranscript({ source, target });
	assert.deepEqual(result, { sourceId: "OLD", targetId: "NEW", entries: 4, artifactsCopied: true });
	assert.equal(fs.readFileSync(source, "utf8"), before);
	const header = readTranscriptHeader(target);
	assert.equal(header?.id, "NEW");
	assert.equal(header?.cwd, "/ao/ws");
	assert.equal(header?.parentSession, "OLD");
	assert.equal(header?.timestamp, "2026-11-01T00:00:00.000Z");
	assert.deepEqual(entries(target).slice(2), CONVERSATION);
	assert.equal(entries(target)[0].type, "title");
	assert.equal(fs.readFileSync(path.join(dir, "sessions", "-ao", "2027_NEW", "1.bash.log"), "utf8"), "artifact");
	assert.equal(isFreshTranscript(target), false);
});

test("graft --model: a model switch continues the active leaf, including a late-usage marker's leaf", () => {
	const dir = temp();
	const late = { type: "usage", id: "late", parentId: "u1", activeLeafId: "a1" };
	const source = transcript(path.join(dir, "o.jsonl"), "OLD", "/o", [...CONVERSATION, late]);
	const target = transcript(path.join(dir, "n.jsonl"), "NEW", "/n");
	graftTranscript({ source, target, model: "vllm/qwen", now: new Date("2026-11-09T00:00:00Z") });
	const last = entries(target).at(-1);
	assert.equal(last?.type, "model_change");
	assert.equal(last?.model, "vllm/qwen");
	assert.equal(last?.parentId, "a1");
	assert.match(String(last?.id), /^[0-9a-f]{8}$/);
});

test("graft refuses a target with its own conversation; repeats only on a graft that was not continued", () => {
	const dir = temp();
	const source = transcript(path.join(dir, "o.jsonl"), "OLD", "/o", CONVERSATION);
	const busy = transcript(path.join(dir, "busy.jsonl"), "B", "/b", CONVERSATION);
	assert.throws(() => graftTranscript({ source, target: busy }), /already holds a conversation/);
	assert.deepEqual(entries(busy).slice(2), CONVERSATION);

	const target = transcript(path.join(dir, "n.jsonl"), "NEW", "/n");
	graftTranscript({ source, target, model: "x/y" });
	const grafted = fs.readFileSync(target, "utf8");
	graftTranscript({ source, target, model: "x/y" });
	assert.equal(entries(target).length, grafted.split("\n").filter(Boolean).length);

	fs.appendFileSync(target, line({ type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "new turn" } }));
	fs.appendFileSync(target, line({ type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: "ok" } }));
	assert.throws(() => graftTranscript({ source, target }), /already holds a conversation/);
	assert.equal(entries(target).at(-1)?.id, "a2");
});

test("transcriptsForCwd finds the spawn's transcript by header cwd, newer than the spawn", () => {
	const dir = temp();
	const a = transcript(path.join(dir, "-ws", "a.jsonl"), "A", "/ao/ws/s-1");
	transcript(path.join(dir, "-ws", "b.jsonl"), "B", "/ao/ws/s-2");
	const old = transcript(path.join(dir, "-ws", "c.jsonl"), "C", "/ao/ws/s-1");
	fs.utimesSync(old, new Date(1000), new Date(1000));
	assert.deepEqual(transcriptsForCwd(dir, "/ao/ws/s-1", 10_000), [a]);
});

function legacyHomeWith(sessions: Record<string, object>, extra: Record<string, unknown> = {}): string {
	const home = temp();
	for (const [id, meta] of Object.entries(sessions)) {
		fs.mkdirSync(path.join(home, "sessions", id), { recursive: true });
		fs.writeFileSync(path.join(home, "sessions", id, "meta.json"), JSON.stringify({ id, title: id, status: "stopped", pid: 0, createdAt: 1, ...meta }));
	}
	for (const [name, value] of Object.entries(extra)) fs.writeFileSync(path.join(home, name), JSON.stringify(value));
	return home;
}

test("plan: adopts sessions with a transcript; skips busy, empty and transcript-less ones; done stays done", () => {
	const dir = temp();
	const repo = path.join(dir, "repo");
	fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
	execFileSync("git", ["init", "-q", repo]);
	const plain = path.join(dir, "plain");
	fs.mkdirSync(plain);
	const t = (id: string, conv = CONVERSATION) => transcript(path.join(dir, "sessions", "-x", `2026_${id}.jsonl`), id, "/x", conv);
	const home = legacyHomeWith({
		inRepo: { cwd: path.join(repo, "sub"), ompSessionFile: t("o1"), ompArgs: [] },
		plainDir: { cwd: plain, ompSessionId: "o2", permissionMode: "ask" },
		gone: { cwd: path.join(dir, "deleted"), ompSessionFile: t("o3") },
		busy: { cwd: plain, ompSessionFile: t("o4"), status: "working", pid: process.pid },
		empty: { cwd: plain, ompSessionFile: t("o5", []) },
		none: { cwd: plain },
		finished: { cwd: plain, ompSessionFile: t("o6") },
	});
	fs.writeFileSync(path.join(home, "sessions", "plainDir", "launch.json"), JSON.stringify({ ompArgs: ["--approval-mode", "edits", "--thinking", "high"] }));
	t("o2");
	const state = readLegacyState(home);
	const ledger: Ledger = { version: 1, source: home, backups: [], sessions: { finished: { aoSessionId: "repo-9", state: "done", title: "f", cwd: plain, sourceTranscript: "x", spawnedAt: 0, updatedAt: 0 } } };
	const byId = Object.fromEntries(planSessions(state, ledger, { sessionsDir: path.join(dir, "sessions"), projects: [{ id: "repo", path: fs.realpathSync(repo) }] }).map(a => [a.id, a]));

	assert.deepEqual({ kind: byId.inRepo.kind, projectId: "projectId" in byId.inRepo && byId.inRepo.projectId }, { kind: "adopt", projectId: "repo" });
	const plainAction = byId.plainDir;
	assert.ok(plainAction.kind === "adopt");
	assert.equal(plainAction.standaloneReason, "folder is not in a git repo");
	assert.equal(plainAction.approvalMode, "accept-edits");
	assert.match(plainAction.transcript, /2026_o2\.jsonl$/);
	assert.deepEqual(plainAction.notes, ["omp flags not carried over: --thinking high"]);
	assert.ok(byId.gone.kind === "adopt" && byId.gone.standaloneReason === "folder no longer exists");
	assert.ok(byId.busy.kind === "skip" && /busy/.test(byId.busy.reason));
	assert.ok(byId.empty.kind === "skip" && /empty/.test(byId.empty.reason));
	assert.ok(byId.none.kind === "skip" && byId.none.reason === "no omp transcript");
	assert.deepEqual(byId.finished, { kind: "done", id: "finished", title: "finished", aoSessionId: "repo-9" });
});

test("organize merge: old ids become AO ids, adopted pins leave the file, existing entries win, a partial run's entries move", () => {
	const legacy: OrgData = {
		...emptyOrgData(),
		groups: [{ id: "g1", name: "Work", order: 0 }],
		lanes: [{ id: "doing", name: "Doing", order: 0 }],
		sessions: {
			a: { groupId: "g1", priority: "high", tags: ["x"], pinned: true },
			b: { archived: true },
			c: { color: "red", pinned: true },
		},
		collapsed: { g1: true },
	};
	const existing: OrgData = { ...emptyOrgData(), groups: [{ id: "g1", name: "Renamed", order: 3 }], sessions: { "ao-b": { color: "blue" } }, collapsed: { g1: false } };

	const first = mergeOrganize(existing, legacy, { a: "ao-a", b: "ao-b" });
	assert.deepEqual(first.data.groups, [{ id: "g1", name: "Renamed", order: 3 }]);
	assert.deepEqual(first.data.lanes, legacy.lanes);
	assert.deepEqual(first.data.sessions, { "ao-a": { groupId: "g1", priority: "high", tags: ["x"] }, "ao-b": { color: "blue" }, c: { color: "red", pinned: true } });
	assert.deepEqual(first.data.collapsed, { g1: false });

	// `c` is adopted by a later run: its entry moves to the AO id, without the pin (AO holds it).
	const second = mergeOrganize(first.data, legacy, { a: "ao-a", b: "ao-b", c: "ao-c" });
	assert.deepEqual(Object.keys(second.data.sessions).sort(), ["ao-a", "ao-b", "ao-c"]);
	assert.deepEqual(second.data.sessions["ao-c"], { color: "red" });
	assert.deepEqual(mergeOrganize(second.data, legacy, { a: "ao-a", b: "ao-b", c: "ao-c" }).data, second.data);
});
