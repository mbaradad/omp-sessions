import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import switchyardCheckpoints from "../../src/omp-extension/checkpoints";
import { type CheckpointPrompt, type FileChange, type SessionEntryLike, aoCheckpointDir, isPromptEntry, messageText, ompToolCallId, planRestore, readChanges, readState, redoStack, turnStatuses } from "../../src/shared/checkpoints";

// ---------- a fake omp: a session tree with omp's navigation rules, and the extension hooks ----------

type Entry = SessionEntryLike & { id: string; parentId: string | null; type: string };

class FakeOmp {
	entries: Entry[] = [];
	leaf: string | null = null;
	private seq = 0;
	readonly handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	readonly commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	readonly notices: string[] = [];

	constructor(readonly cwd: string) {
		switchyardCheckpoints({
			on: (event, handler) => this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler as (e: unknown, c: unknown) => unknown]),
			registerCommand: (name, opts) => this.commands.set(name, opts.handler as (args: string, ctx: unknown) => Promise<void>),
			appendEntry: (customType, data) => this.append({ type: "custom", customType, data }),
		});
	}

	private append(fields: SessionEntryLike & { type: string }): string {
		const id = `e${++this.seq}`;
		this.entries.push({ ...fields, id, parentId: this.leaf });
		this.leaf = id;
		return id;
	}

	private branch(): Entry[] {
		const byId = new Map(this.entries.map(e => [e.id, e]));
		const out: Entry[] = [];
		for (let e = this.leaf ? byId.get(this.leaf) : undefined; e; e = e.parentId ? byId.get(e.parentId) : undefined) out.unshift(e);
		return out;
	}

	private ctx(kind: "main" | "sub" = "main") {
		return {
			cwd: this.cwd,
			mode: "rpc",
			hasUI: true,
			agent: { kind },
			isIdle: () => true,
			waitForIdle: async () => {},
			ui: { notify: (m: string) => this.notices.push(m), confirm: async () => true },
			// omp's navigateTree: onto a prompt rewinds past it (leaf = its parent), else lands on the entry.
			navigateTree: async (id: string) => {
				const target = this.entries.find(e => e.id === id);
				this.leaf = target && isPromptEntry(target) ? target.parentId : id;
				return { cancelled: false };
			},
			sessionManager: {
				getSessionId: () => "omp-1",
				getSessionFile: () => undefined,
				getCwd: () => this.cwd,
				getLeafId: () => this.leaf,
				getEntry: (id: string) => this.entries.find(e => e.id === id),
				getBranch: () => this.branch(),
				getEntries: () => this.entries,
			},
		};
	}

	private async emit(event: string, payload: unknown, kind?: "main" | "sub"): Promise<void> {
		for (const h of this.handlers.get(event) ?? []) await h(payload, this.ctx(kind));
	}

	async start(): Promise<void> {
		await this.emit("session_start", {});
	}

	/** One prompt whose turn runs `edits` (each: file, new content or null to delete) through the edit tool. */
	async turn(text: string, edits: Array<[string, string | null]>, kind: "main" | "sub" = "main"): Promise<void> {
		this.append({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });
		for (const [file, content] of edits) {
			const toolCallId = `call${++this.seq}`;
			this.append({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "write" }] } });
			const input = { path: file };
			await this.emit("tool_call", { toolCallId, toolName: "write", input }, kind);
			const abs = path.join(this.cwd, file);
			if (content === null) fs.rmSync(abs);
			else fs.writeFileSync(abs, content);
			await this.emit("tool_result", { toolCallId, toolName: "write", input, details: undefined, content: [], isError: false }, kind);
		}
		this.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
		await this.emit("agent_end", {});
	}

	async command(line: string): Promise<void> {
		const [name, ...rest] = line.slice(1).split(" ");
		const handler = this.commands.get(name);
		assert.ok(handler, `command ${name} registered`);
		await handler(rest.join(" "), this.ctx());
	}

	/** What omp appends on its own when the process exits: metadata, not conversation. */
	exit(): void {
		this.append({ type: "custom", customType: "session_exit", data: {} });
	}

	read(file: string): string | null {
		const abs = path.join(this.cwd, file);
		return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
	}

	activePrompts(): string[] {
		return this.branch().filter(isPromptEntry).map(messageText);
	}
}

function setup(): { omp: FakeOmp; dir: string } {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-ckpt-"));
	const cwd = path.join(tmp, "work");
	fs.mkdirSync(cwd);
	process.env.SWITCHYARD_HOME = path.join(tmp, "switchyard");
	process.env.AO_SESSION_ID = "proj-1";
	return { omp: new FakeOmp(cwd), dir: aoCheckpointDir("proj-1") };
}

test("undo rewinds the last prompt and puts its files back; redo brings both back", async () => {
	const { omp } = setup();
	fs.writeFileSync(path.join(omp.cwd, "a.txt"), "a0");
	await omp.start();
	await omp.turn("first", [["a.txt", "a1"]]);
	await omp.turn("second", [["a.txt", "a2"], ["new.txt", "n"]]);

	await omp.command("/undo");
	assert.deepEqual(omp.activePrompts(), ["first"]);
	assert.equal(omp.read("a.txt"), "a1");
	assert.equal(omp.read("new.txt"), null, "a file the undone prompt created is deleted");

	await omp.command("/undo");
	assert.deepEqual(omp.activePrompts(), []);
	assert.equal(omp.read("a.txt"), "a0");

	await omp.command("/redo");
	assert.deepEqual(omp.activePrompts(), ["first"]);
	assert.equal(omp.read("a.txt"), "a1");
	await omp.command("/redo");
	assert.deepEqual(omp.activePrompts(), ["first", "second"]);
	assert.equal(omp.read("a.txt"), "a2");
	assert.equal(omp.read("new.txt"), "n");
	await omp.command("/redo");
	assert.match(omp.notices.at(-1) ?? "", /Nothing to redo/);
});

test("undo of an earlier prompt reverts every later prompt's edits too", async () => {
	const { omp } = setup();
	fs.writeFileSync(path.join(omp.cwd, "a.txt"), "a0");
	fs.writeFileSync(path.join(omp.cwd, "b.txt"), "b0");
	await omp.start();
	await omp.turn("one", [["a.txt", "a1"]]);
	await omp.turn("two", [["b.txt", null]]);
	const two = omp.entries.find(e => e.type === "message" && JSON.stringify(e.message).includes('"one"'));
	await omp.command(`/undo ${two?.id}`);
	assert.deepEqual(omp.activePrompts(), []);
	assert.equal(omp.read("a.txt"), "a0");
	assert.equal(omp.read("b.txt"), "b0", "a deleted file comes back");
});

test("the redo history survives an omp restart but not a new prompt", async () => {
	const { omp, dir } = setup();
	fs.writeFileSync(path.join(omp.cwd, "a.txt"), "a0");
	await omp.start();
	await omp.turn("first", [["a.txt", "a1"]]);
	await omp.command("/undo");
	omp.exit();
	await omp.start();
	assert.equal(readState(dir)?.redo.length, 1);
	await omp.command("/redo");
	assert.equal(omp.read("a.txt"), "a1");

	await omp.command("/undo");
	await omp.turn("instead", [["a.txt", "b1"]]);
	assert.equal(readState(dir)?.redo.length, 0);
	await omp.command("/redo");
	assert.equal(omp.read("a.txt"), "b1");
});

test("subagent edits belong to the main session's prompt", async () => {
	const { omp, dir } = setup();
	fs.writeFileSync(path.join(omp.cwd, "a.txt"), "a0");
	await omp.start();
	await omp.turn("delegate", [["a.txt", "sub"]], "sub");
	const prompt = omp.entries.find(e => e.type === "message")?.id;
	assert.deepEqual(
		readChanges(dir).map(c => c.prompt),
		[prompt],
	);
	await omp.command("/undo");
	assert.equal(omp.read("a.txt"), "a0");
});

test("undo keeps later changes elsewhere in a file (a person's edit, a merge from a parent task) and refuses overlapping ones unless forced", async () => {
	const { omp, dir } = setup();
	const lines = (...l: string[]) => `${l.join("\n")}\n`;
	fs.writeFileSync(path.join(omp.cwd, "a.txt"), lines("1", "2", "3", "4", "5", "6", "7", "8"));
	await omp.start();
	await omp.turn("edit the top", [["a.txt", lines("1", "TWO", "3", "4", "5", "6", "7", "8")]]);
	// Someone (or a merge) changes the bottom of the file afterwards.
	fs.writeFileSync(path.join(omp.cwd, "a.txt"), lines("1", "TWO", "3", "4", "5", "6", "7", "EIGHT"));
	await omp.command("/undo");
	assert.equal(omp.read("a.txt"), lines("1", "2", "3", "4", "5", "6", "7", "EIGHT"), "only omp's change is reverted");
	assert.deepEqual(readState(dir)?.last?.merged.map(f => path.basename(f)), ["a.txt"]);
	await omp.command("/redo");
	assert.equal(omp.read("a.txt"), lines("1", "TWO", "3", "4", "5", "6", "7", "EIGHT"), "redo reapplies it on top");

	// An overlapping change: nothing happens (not even the conversation) until --force.
	fs.writeFileSync(path.join(omp.cwd, "a.txt"), lines("1", "MINE", "3", "4", "5", "6", "7", "EIGHT"));
	await omp.command("/undo");
	assert.equal(omp.read("a.txt"), lines("1", "MINE", "3", "4", "5", "6", "7", "EIGHT"));
	assert.deepEqual(omp.activePrompts(), ["edit the top"], "the conversation did not move");
	assert.equal(readState(dir)?.last?.ok, false);
	assert.equal(readState(dir)?.last?.conflicts.length, 1);
	await omp.command("/undo --force");
	assert.equal(omp.read("a.txt"), lines("1", "2", "3", "4", "5", "6", "7", "8"));
	assert.deepEqual(omp.activePrompts(), []);
	assert.equal(readState(dir)?.last?.forced, true);
});

test("an omp AO did not start (no AO_SESSION_ID) gets no hooks and no commands", () => {
	const { omp } = setup();
	delete process.env.AO_SESSION_ID;
	const own = new FakeOmp(omp.cwd);
	assert.equal(own.handlers.size + own.commands.size, 0);
});

test("state.json lists every prompt and marks the undone ones", async () => {
	const { omp, dir } = setup();
	await omp.start();
	await omp.turn("kept", [["k.txt", "k"]]);
	await omp.turn("dropped", []);
	await omp.command("/undo");
	const state = readState(dir);
	assert.deepEqual(
		state?.prompts.map(p => [p.text, p.active, p.files]),
		[
			["kept", true, 1],
			["dropped", false, 0],
		],
	);
	assert.equal(state?.last?.op, "undo");
	assert.equal(state?.last?.prompt, "dropped");
});

// ---------- planning ----------

const change = (prompt: string, timestamp: number, ...files: Array<[string, string | null, string | null]>): FileChange => ({
	toolCallId: `${prompt}-${timestamp}`,
	toolName: "edit",
	timestamp,
	prompt,
	files: files.map(([p, before, after]) => ({ path: p, op: before === null ? "create" : after === null ? "delete" : "update", before, after })),
});

test("a restore takes each file's content before the first change and after the last", () => {
	const changes = [change("p1", 1, ["/a", "a0", "a1"]), change("p2", 2, ["/a", "a1", "a2"], ["/n", null, "n1"]), change("p2", 3, ["/a", "a2", "a3"]), change("p3", 4, ["/b", "b0", null])];
	assert.deepEqual(
		planRestore(changes, new Set(["p2", "p3"])).sort((x, y) => x.path.localeCompare(y.path)),
		[
			{ path: "/a", before: "a1", after: "a3" },
			{ path: "/b", before: "b0", after: null },
			{ path: "/n", before: null, after: "n1" },
		],
	);
	assert.deepEqual(planRestore([change("p", 1, ["/a", "a0", "a1"]), change("p", 2, ["/a", "a1", "a0"])], new Set(["p"])), [], "edited back to the original: nothing to restore");
});

test("a new conversation entry after the marker ends the redo history; metadata does not", () => {
	const marker: SessionEntryLike = { type: "custom", customType: "switchyard.checkpoint", data: { v: 1, op: "undo", redo: [{ leaf: "x", prompt: "p", files: [] }] } };
	assert.equal(redoStack([marker, { type: "custom", customType: "session_exit" }, { type: "model_change" }]).length, 1);
	assert.equal(redoStack([marker, { type: "message", message: { role: "user" } }]).length, 0);
	assert.equal(redoStack([marker, { type: "compaction" }]).length, 0);
});

// ---------- AO turns ----------

const prompt = (id: string, text: string, at: number, active: boolean): CheckpointPrompt => ({ id, text, at, active, files: 0 });

test("AO turns of undone prompts and of /undo, /redo are flagged; the rest stay", () => {
	const prompts = [prompt("u1", "fix it", 1_000, true), prompt("u2", "add tests", 60_000, false)];
	const turns = [
		{ id: "t1", text: "fix it", at: 1_500 },
		{ id: "t2", text: "add tests", at: 60_400 },
		{ id: "t3", text: "/undo", at: 90_000 },
		{ id: "t4", text: "/redo ", at: 91_000 },
		{ id: "t5", text: "never reached omp", at: 95_000 },
		{ id: "t6", text: "/undone is not a command", at: 96_000 },
	];
	assert.deepEqual(
		[...turnStatuses(turns, prompts)].sort(),
		[
			["t2", "undone"],
			["t3", "command"],
			["t4", "command"],
		],
	);
});

test("a prompt resent after undoing it matches its own turn, not the undone one", () => {
	const prompts = [prompt("old", "do X", 10_000, false), prompt("new", "do X", 40_000, true)];
	const turns = [
		{ id: "first", text: "do X", at: 10_200 },
		{ id: "undo", text: "/undo", at: 30_000 },
		{ id: "again", text: "do X", at: 40_100 },
	];
	assert.deepEqual([...turnStatuses(turns, prompts)].sort(), [
		["first", "undone"],
		["undo", "command"],
	]);
});

test("an AO tool activity's providerItemId yields omp's tool call id", () => {
	assert.equal(ompToolCallId("acp:41:6e889c62-20eb-4f97-9697-9ddc2825fc40:root30:toolu_01GB2yKQBKRp28yvuSu74J7a"), "toolu_01GB2yKQBKRp28yvuSu74J7a");
	assert.equal(ompToolCallId("acp:6:a:b:é5:x:y:z"), "x:y:z", "lengths are UTF-8 bytes; parts may hold colons");
	assert.equal(ompToolCallId("ao-plan-1"), "ao-plan-1");
	assert.equal(ompToolCallId("acp:99:short"), "acp:99:short", "malformed stays as is");
});
