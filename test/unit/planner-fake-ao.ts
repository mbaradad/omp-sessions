// Shared by the planner service tests: an in-memory AO that behaves like AO where it matters (spawn
// dedupes on clientRequestId, messages on clientMessageId, turns finish when the test says so) and, with
// `git`, gives every project session its own real git worktree the way AO does.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AoError } from "../../src/ao/client";
import { type AoConversationInfo, type AoPort, type AoStreamHandlers, type AoTurnInfo, DispatchRefused, type StartSession } from "../../src/planner/ao-port";
import { Planner, type PlannerOptions } from "../../src/planner/planner";
import { loadPlan } from "../../src/planner/store";
import type { Task } from "../../src/planner/types";

interface FakeSession {
	id: string;
	terminated: boolean;
	turns: AoTurnInfo[];
	conv: AoConversationInfo;
	spawnBody: Record<string, unknown>;
	/** The agent's host died (or the session was stopped): AO reads it as exited. */
	exited?: boolean;
	branch?: string;
	/** Real git worktree of a project session. */
	worktree?: string;
}

/** Runs git in `cwd` (tests only). */
export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
}

/** A scratch repo with one commit on main. */
export function scratchRepo(t: TestContext): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "planner-git-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const repo = path.join(dir, "repo");
	fs.mkdirSync(repo);
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	fs.writeFileSync(path.join(repo, "x.txt"), "base\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	return repo;
}

export class FakeAo implements AoPort {
	readonly url = "fake://ao";
	sessions = new Map<string, FakeSession>();
	byKey = new Map<string, string>();
	/** Sessions actually created (a replayed spawn doesn't count). */
	created = 0;
	/** While set, spawn calls reach AO (are recorded) but their answers never come back. */
	dropAnswers = false;
	private handlers: AoStreamHandlers | undefined;
	private seq = 0;

	/** With a repo, sessions spawned in project "p" get a real worktree on a branch (ao/<id>/root, or the requested one). */
	constructor(readonly repo?: string) {}

	/** Model ids AO lists; empty = AO can't say (nothing is refused). */
	modelIds: string[] = [];
	/** How often each agent was resumed (`resumeAgent`). */
	resumed: string[] = [];

	private event(session: string, activity = "idle"): void {
		this.handlers?.onEvent(++this.seq, session, activity);
	}

	private turn(s: FakeSession, text: string, clientMessageId?: string): string {
		const id = `${s.id}-t${s.conv.turns.length + 1}`;
		s.conv.turns.push({ id, state: "running", requestedAt: Date.now() + s.conv.turns.length });
		s.conv.messages.push({ turnId: id, role: "user", text, streaming: false, ...(clientMessageId ? { clientMessageId } : {}) });
		return id;
	}

	async spawn(body: Record<string, unknown>) {
		const key = String(body.clientRequestId);
		let id = this.byKey.get(key);
		if (!id) {
			id = `s${++this.created}`;
			const s: FakeSession = { id, terminated: false, turns: [], conv: { turns: [], messages: [], cost: 0 }, spawnBody: body };
			s.turns = s.conv.turns;
			if (this.repo && body.projectId === "p") {
				s.branch = typeof body.branch === "string" ? body.branch : `ao/${id}/root`;
				s.worktree = path.join(path.dirname(this.repo), "wt", id);
				const exists = git(this.repo, "branch", "--list", s.branch) !== "";
				git(this.repo, "worktree", "add", "-q", ...(exists ? [s.worktree, s.branch] : ["-b", s.branch, s.worktree, "main"]));
			}
			this.sessions.set(id, s);
			this.byKey.set(key, id);
			if (typeof body.prompt === "string") this.turn(s, body.prompt);
		}
		if (this.dropAnswers) return new Promise<never>(() => {});
		const created = this.sessions.get(id);
		return { session: id, ...(created?.branch ? { branch: created.branch } : {}) };
	}

	/** The D11 sequence as the port sees it: spawn (idempotent in the key), then the prompt (idempotent in the key). */
	async startSession(opts: StartSession) {
		if (this.modelIds.length && opts.model && !this.modelIds.includes(opts.model)) throw new DispatchRefused(`Unknown omp model "${opts.model}"`);
		const { prompt, key, ...rest } = opts;
		const res = await this.spawn({ ...rest, harness: "omp", approvalMode: "bypass-permissions", clientRequestId: key });
		const s = this.sessions.get(res.session);
		assert.ok(s);
		let turn = s.conv.messages.find(m => m.clientMessageId === key)?.turnId;
		if (!turn) turn = this.turn(s, prompt, key);
		return { ...res, turn };
	}

	async send(session: string, text: string, clientMessageId: string) {
		const s = this.sessions.get(session);
		assert.ok(s && !s.terminated && !s.exited, `send to ${session}: terminated or exited`);
		const dup = s.conv.messages.find(m => m.clientMessageId === clientMessageId);
		return { turn: dup ? undefined : this.turn(s, text, clientMessageId) } as { turn?: string };
	}

	async conversation(session: string) {
		const s = this.sessions.get(session);
		if (!s) throw Object.assign(new Error("not found"), { status: 404 });
		return structuredClone(s.conv);
	}

	async session(id: string) {
		const s = this.sessions.get(id);
		return s && { id, terminated: s.terminated, ...(s.exited ? { activity: "exited" } : {}) };
	}

	async activeSessions() {
		return [];
	}

	async interrupt(session: string) {
		this.finishTurn(session, "interrupted");
	}

	async resumeAgent(session: string) {
		const s = this.sessions.get(session);
		if (s) s.exited = false;
		this.resumed.push(session);
	}

	async models() {
		return this.modelIds;
	}

	/** An AO event for the session with the given activity (someone chatted: active, then idle). */
	poke(session: string, activity: string): void {
		this.event(session, activity);
	}

	/** Simulates the chat host dying mid-turn: the turn stays running, the session reads exited. */
	killHost(session: string): void {
		const s = this.sessions.get(session);
		assert.ok(s, `no session ${session}`);
		s.exited = true;
		this.event(session, "exited");
	}

	/** The host died and no event told anyone (a missed SSE event). */
	killHostSilently(session: string): void {
		const s = this.sessions.get(session);
		assert.ok(s, `no session ${session}`);
		s.exited = true;
	}

	async restore(session: string) {
		const s = this.sessions.get(session);
		if (s) s.terminated = false;
	}

	async setModel() {
		return undefined;
	}

	async setThinking() {
		return undefined;
	}

	/** Folders registered as projects, as AO refuses a second registration of the same path. */
	registered = new Set<string>();
	/** Set to make registration slow (the window in which concurrent registrations race). */
	registerDelayMs = 0;

	async projectFor(cwd: string) {
		if (!this.repo) return undefined;
		if (this.registered.has(cwd)) return "p";
		await sleep(this.registerDelayMs);
		if (this.registered.has(cwd)) throw new AoError("A project at this path is already registered (/api/v1/projects)", 409, "PROJECT_ALREADY_REGISTERED");
		this.registered.add(cwd);
		return "p";
	}

	async sessionGit(session: string) {
		const s = this.sessions.get(session);
		return this.repo && s?.branch ? { repo: this.repo, branch: s.branch } : {};
	}

	async projectPath(id: string) {
		return this.repo && id === "p" ? this.repo : undefined;
	}

	/** The worktree of a session (git tests edit files there as the agent would). */
	worktreeOf(session: string): string {
		const wt = this.sessions.get(session)?.worktree;
		assert.ok(wt, `session ${session} has no worktree`);
		return wt;
	}

	subscribe(_after: number | undefined, handlers: AoStreamHandlers) {
		this.handlers = handlers;
		setImmediate(() => handlers.onOpen(false));
		return { close: () => (this.handlers = undefined), lastEventId: undefined };
	}

	/** Ends the session's running turn. */
	finishTurn(session: string, state: AoTurnInfo["state"], reply?: string, cost = 0.1): void {
		const s = this.sessions.get(session);
		const turn = s?.conv.turns.find(t => t.state === "running");
		assert.ok(s && turn, `no running turn in ${session}`);
		turn.state = state;
		if (reply) s.conv.messages.push({ turnId: turn.id, role: "assistant", text: reply, streaming: false });
		s.conv.cost = (s.conv.cost ?? 0) + cost;
		this.event(session);
	}

	promptOf(session: string): string {
		return this.sessions.get(session)?.conv.messages.find(m => m.role === "user")?.text ?? "";
	}
}

/** Polls `fn`; the bound only stops a hang (generous: the suite may share a loaded machine). */
export async function until<T>(what: string, fn: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

export function tempPlan(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, "plan.json");
}

export function start(file: string, ao: FakeAo, hooks: Pick<PlannerOptions, "undone" | "rewind"> = {}): Planner {
	const p = new Planner({ ...hooks, file, initial: loadPlan(file), connect: async () => ao, pollMs: 100, retryBaseMs: 50, livenessMs: 50 });
	p.start();
	return p;
}

export const byTitle = (p: Planner, title: string): Task => p.state.tasks.find(t => t.title === title) as Task;
export const running = (p: Planner) => p.state.tasks.filter(t => t.status === "running").map(t => t.title);
