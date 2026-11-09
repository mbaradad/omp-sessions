import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import ompSessionsTodos from "../../src/omp-extension/todos";
import { type TodoPhase, latestTodoPhases, phasesToMarkdown, readTodoMirror, todoMirrorFile } from "../../src/shared/omp-todos";

const toolResult = (phases: unknown, extra: Record<string, unknown> = {}) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details: { op: "replace", phases }, ...extra } });
const userEdit = (phases: unknown) => ({ type: "custom", customType: "user_todo_edit", data: { phases } });
const build: TodoPhase[] = [{ name: "Build", tasks: [{ content: "alpha", status: "in_progress" }] }];
const ship: TodoPhase[] = [{ name: "Ship", tasks: [{ content: "gamma", status: "pending" }] }];

describe("latestTodoPhases", () => {
	test("the newest snapshot wins, whether the todo tool or a /todo command wrote it", () => {
		assert.deepEqual(latestTodoPhases([toolResult(build), { type: "message", message: { role: "assistant" } }, userEdit(ship)]), ship);
		assert.deepEqual(latestTodoPhases([userEdit(ship), toolResult(build)]), build);
	});

	test("view calls and failed tool calls don't count; no snapshot means no todos", () => {
		const view = { type: "message", message: { role: "toolResult", toolName: "todo", details: { op: "view", phases: ship } } };
		assert.deepEqual(latestTodoPhases([toolResult(build), view, toolResult(ship, { isError: true })]), build);
		assert.deepEqual(latestTodoPhases([{ type: "message", message: { role: "user" } }]), []);
	});

	test("an emptied list is a snapshot too (it hides the older one)", () => {
		assert.deepEqual(latestTodoPhases([toolResult(build), userEdit([])]), []);
	});
});

describe("phasesToMarkdown", () => {
	test("writes omp's checklist: one heading per phase, a marker per status, the blocker in a comment", () => {
		const md = phasesToMarkdown([
			{ name: "Build", tasks: [{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }, { content: "c", status: "completed" }] },
			{ name: "Ship", tasks: [{ content: "d", status: "abandoned" }, { content: "e", status: "blocked", blocker: "waits for review" }] },
		]);
		assert.equal(md, "# Build\n- [ ] a\n- [/] b\n- [x] c\n\n# Ship\n- [-] d\n- [!] e <!-- blocker: waits for review -->\n");
	});

	test("multi-line text stays on its line (omp parses line by line) and an empty list still imports", () => {
		assert.equal(phasesToMarkdown([{ name: "Two\nlines", tasks: [{ content: "first\n\nsecond", status: "pending" }] }]), "# Two lines\n- [ ] first second\n");
		assert.equal(phasesToMarkdown([]), "# Todos\n");
	});
});

describe("omp extension: todo mirror", () => {
	let dir: string;
	const saved = { id: process.env.AO_SESSION_ID, home: process.env.SWITCHYARD_HOME };
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-todos-"));
		process.env.SWITCHYARD_HOME = dir;
	});
	afterEach(() => {
		for (const [k, v] of [["AO_SESSION_ID", saved.id], ["SWITCHYARD_HOME", saved.home]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** A stand-in for omp: records handlers, exposes a branch the test edits, runs the poll on demand. */
	function fakeOmp(kind: "main" | "sub" = "main") {
		const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
		const branch: unknown[] = [];
		let poll: (() => void) | undefined;
		const ctx = {
			agent: { kind },
			sessionManager: { getLeafId: () => String(branch.length), getBranch: () => branch, getSessionId: () => "omp-1" },
			setInterval: (fn: () => void) => {
				poll = fn;
				return 1;
			},
		};
		ompSessionsTodos({ on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler as (e: unknown, ctx: unknown) => unknown]) });
		return { branch, start: () => handlers.get("session_start")?.forEach(h => h({}, ctx)), poll: () => poll?.(), handlers };
	}

	test("mirrors the plan at start and again when it changes", () => {
		process.env.AO_SESSION_ID = "proj-3";
		const omp = fakeOmp();
		omp.branch.push(toolResult(build));
		omp.start();
		const file = todoMirrorFile(dir, "proj-3");
		assert.deepEqual(readTodoMirror(file)?.phases, build);
		assert.equal(readTodoMirror(file)?.aoSessionId, "proj-3");
		omp.branch.push(userEdit(ship));
		omp.poll();
		assert.deepEqual(readTodoMirror(file)?.phases, ship);
	});

	test("does nothing outside AO, and ignores subagents", () => {
		delete process.env.AO_SESSION_ID;
		assert.equal(fakeOmp().handlers.size, 0);
		process.env.AO_SESSION_ID = "proj-4";
		const sub = fakeOmp("sub");
		sub.branch.push(toolResult(build));
		sub.start();
		assert.equal(fs.existsSync(todoMirrorFile(dir, "proj-4")), false);
	});
});
