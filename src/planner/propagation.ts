// Graph propagation (GRAPH-PROPAGATION.md): a parent's committed work flows to its children's branches.
//
// - A git task's work is committed on its branch when its turn ends (`commitWork`); a done parent counts
//   as finished for its children only once that commit is recorded (engine `resolved`).
// - A child's branch is seeded at its parent's head (several parents: the first, the others merged in a
//   temporary worktree) and AO checks that branch out for the child's session (`prepareSpawn`).
// - A parent that changes later (re-run, follow-up, a person's edits) propagates to every child, in
//   order along the graph: a working child gets the merge when its turn ends plus a follow-up run; an
//   idle one gets the merge (and the note in its next run's prompt); a finished one gets the merge and
//   is marked `upstream-changed`, never re-run by itself. A conflict aborts the merge (no MERGE_HEAD
//   left) and gives the child a run that resolves it; if that fails the edge is `conflict`.
// - Each step is recorded in the plan (edge `pending` → `merged`/…, before/after SHAs) and every git
//   step is idempotent (a merge whose target is already an ancestor is done), so a planner restart
//   mid-propagation finishes it exactly once.
import * as fs from "node:fs";
import { abortMerge, changesBetween, commitAll, git, isAncestor, merge, mergeInProgress, revParse, seedBranch, withRepoLock, worktreeOf } from "./git";
import type { EdgeSync, PlanState, Task } from "./types";

export interface PropagationHost {
	state(): PlanState;
	/** Mutates and persists the plan (no-op once the planner stopped). */
	commit(mutate: (s: PlanState) => void): void;
	log(...parts: unknown[]): void;
	now(): number;
	/** The plan changed so that dispatch may proceed (a child was requeued). */
	changed(): void;
}

function real(p: string): string {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return p;
	}
}

/** Branch the planner gives a graph child (seeded at its parent's head). */
export function childBranch(taskId: string): string {
	return `switchyard/${taskId}`;
}

/** What seeding a git task's branch from its parents decided. */
export interface SeedResult {
	/** The branch AO checks out for the task's session. */
	branch?: string;
	/** The task's edges to its parents. */
	sync?: Record<string, EdgeSync>;
	/** Run note: merges the parents' branches that conflicted while seeding. */
	followUp?: string;
}

export class Propagation {
	/** Propagation steps run one at a time (they read and then write the same edges). */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(private readonly host: PropagationHost) {}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.catch(() => undefined).then(fn);
		this.chain = next.catch(err => this.host.log("propagation failed", err instanceof Error ? (err.stack ?? err.message) : String(err)));
		return next;
	}

	private task(id: string): Task | undefined {
		return this.host.state().tasks.find(t => t.id === id);
	}

	/** Parents of `t` whose committed work is in `repo` (done, with a head), in edge order. */
	gitParents(t: Task, repo?: string): Task[] {
		const s = this.host.state();
		return (t.after ?? [])
			.map(id => s.tasks.find(x => x.id === id))
			.filter((p): p is Task => !!p && p.status === "done" && !!p.git?.head && (!repo || real(p.git.repo) === real(repo)));
	}

	/**
	 * Before a git task's first spawn: seeds its branch from its parents (when it has git parents in
	 * `repo`). Returns the branch AO must check out, the parent edges and a note for conflicted parents.
	 */
	async prepareSpawn(t: Task, repo: string): Promise<SeedResult> {
		const parents = this.gitParents(t, repo);
		if (!parents.length) return {};
		const branch = childBranch(t.id);
		const heads = parents.map(p => ({ branch: p.git?.branch as string, head: p.git?.head as string }));
		const tip = await revParse(repo, `refs/heads/${branch}`);
		const { conflicts } = await withRepoLock(repo, () => seedBranch(repo, branch, heads, b => `switchyard: merge ${b} into ${t.title.slice(0, 80)}`));
		const now = this.host.now();
		const sync: Record<string, EdgeSync> = {};
		const notes: string[] = [];
		for (const p of parents) {
			const head = p.git?.head as string;
			const conflict = conflicts.find(c => c.branch === p.git?.branch);
			// A branch that existed already (a respawn) keeps its work: parents it lacks merge after its first turn.
			const behind = tip !== undefined && !(await isAncestor(repo, head, tip));
			if (conflict) sync[p.id] = { state: "resolving", pendingHead: head, files: conflict.files, at: now };
			else if (behind) sync[p.id] = { state: "pending", pendingHead: head, at: now };
			else sync[p.id] = { state: "in-sync", head, at: now };
			if (conflict) notes.push(resolveNote(p, conflict.files));
		}
		this.host.log("seeded", t.id, branch, "from", heads.map(h => `${h.branch}@${h.head.slice(0, 8)}`).join(", "), conflicts.length ? `(${conflicts.length} conflicted)` : "");
		return { branch, sync, ...(notes.length ? { followUp: notes.join("\n\n") } : {}) };
	}

	/** After AO created the session: records the task's branch and worktree. */
	async recordSession(id: string, repo: string, branch: string): Promise<void> {
		const worktree = await worktreeOf(repo, branch).catch(() => undefined);
		this.host.commit(s => {
			const t = s.tasks.find(x => x.id === id);
			if (!t) return;
			t.git = { ...t.git, repo, branch, ...(worktree ? { worktree } : {}) };
		});
	}

	/** The worktree of a git task (looked up again when it moved or wasn't known yet). */
	private async worktree(t: Task): Promise<string | undefined> {
		if (!t.git) return undefined;
		if (t.git.worktree && fs.existsSync(t.git.worktree)) return t.git.worktree;
		const found = await worktreeOf(t.git.repo, t.git.branch).catch(() => undefined);
		if (found) this.host.commit(s => {
			const x = s.tasks.find(y => y.id === t.id);
			if (x?.git) x.git.worktree = found;
		});
		return found;
	}

	/** Commits what the task's turn left uncommitted; its branch head (undefined: no usable worktree). */
	async commitWork(t: Task): Promise<string | undefined> {
		const wt = await this.worktree(t);
		if (!wt || !t.git) return undefined;
		try {
			const { head, committed } = await withRepoLock(t.git.repo, () => commitAll(wt, t.title, t.id));
			if (committed) this.host.log("committed", t.id, t.git.branch, head.slice(0, 8));
			return head;
		} catch (err) {
			this.host.log("commit failed", t.id, String(err));
			return revParse(wt, "HEAD");
		}
	}

	/** A turn of `id` ended and its outcome is recorded: settle its own edges, then flow its work to its children. */
	afterTurn(id: string): Promise<void> {
		return this.serial(() => this.afterTurnNow(id));
	}

	private async afterTurnNow(id: string): Promise<void> {
		await this.settleResolving(id);
		const requeued = await this.applyPending(id);
		if (!requeued) await this.propagate(id);
	}

	/** By hand (`sync` op) or when a finished task's session went idle (a person's follow-up). */
	sync(id: string): Promise<void> {
		return this.serial(async () => {
			const t = this.task(id);
			if (!t?.git || t.status === "running") return;
			const head = await this.commitWork(t);
			if (head && head !== t.git.head) {
				this.host.commit(s => {
					const x = s.tasks.find(y => y.id === id);
					if (x?.git) x.git.head = head;
				});
			}
			await this.afterTurnNow(id);
		});
	}

	/** Pending edges of every idle child (after a restart, nothing else would apply them). */
	resume(): Promise<void> {
		return this.serial(async () => {
			for (const t of this.host.state().tasks) {
				if (t.status === "running" || !t.sync) continue;
				if (Object.values(t.sync).some(e => e.state === "pending")) await this.applyPending(t.id);
			}
		});
	}

	/** New parent head → every child's edge (pending for working children; applied for idle ones). */
	private async propagate(parentId: string): Promise<void> {
		const parent = this.task(parentId);
		const head = parent?.git?.head;
		if (!parent?.git || !head || parent.status !== "done") return;
		const children = this.host.state().tasks.filter(c => c.after?.includes(parentId) && c.git && real(c.git.repo) === real(parent.git?.repo ?? ""));
		for (const c of children) {
			const edge = c.sync?.[parentId];
			if (edge?.head === head || edge?.pendingHead === head) continue;
			this.setEdge(c.id, parentId, { ...edge, state: "pending", pendingHead: head, ...(c.status === "running" ? { prompt: true } : {}), at: this.host.now() });
			if (c.status === "running") continue;
			// Idle or finished children take the merge now; what their own head moved to flows on to their children.
			const requeued = await this.applyPending(c.id);
			if (!requeued) await this.propagate(c.id);
		}
	}

	private setEdge(child: string, parent: string, edge: EdgeSync): void {
		this.host.commit(s => {
			const c = s.tasks.find(x => x.id === child);
			if (!c) return;
			c.sync = { ...c.sync, [parent]: edge };
		});
	}

	/**
	 * Merges each pending parent head into the (idle) child's worktree. Returns true when the child was
	 * put back to pending for a follow-up or resolve run.
	 */
	private async applyPending(childId: string): Promise<boolean> {
		let requeued = false;
		for (;;) {
			const c = this.task(childId);
			if (!c?.git || c.status === "running" || !c.sync) return requeued;
			const entry = Object.entries(c.sync).find(([, e]) => e.state === "pending" && e.pendingHead);
			if (!entry) return requeued;
			const [parentId, edge] = entry;
			const parent = this.task(parentId);
			const target = edge.pendingHead as string;
			const wt = await this.worktree(c);
			if (!parent?.git || !wt) {
				this.setEdge(childId, parentId, { ...edge, state: "conflict", at: this.host.now() });
				this.host.log("propagation impossible", childId, parentId, !wt ? "no worktree" : "parent has no branch");
				continue;
			}
			const repo = c.git.repo;
			const result = await withRepoLock(repo, async () => {
				await commitAll(wt, c.title, c.id);
				const before = await git(wt, ["rev-parse", "HEAD"]);
				if (await isAncestor(wt, target, before)) return { ok: true as const, before, after: before };
				const res = await merge(wt, target, `switchyard: merge ${parent.git?.branch} (${parent.title.slice(0, 60)}) into ${c.git?.branch}`);
				return res.ok ? { ok: true as const, before, after: res.head } : { ok: false as const, before, files: res.conflicts ?? [] };
			});
			const changes = await changesBetween(repo, edge.head, target);
			const now = this.host.now();
			const wasWorking = edge.prompt === true;
			if (result.ok) {
				this.host.log("merged", parent.git.branch, target.slice(0, 8), "into", c.git.branch, `${result.before.slice(0, 8)} → ${result.after.slice(0, 8)}`);
				const note = upstreamNote(parent, changes);
				this.host.commit(s => {
					const x = s.tasks.find(y => y.id === childId);
					if (!x?.git) return;
					const finished = x.status === "done" || x.status === "failed" || x.status === "skipped";
					x.sync = { ...x.sync, [parentId]: { state: finished && !wasWorking ? "upstream-changed" : "merged", head: target, before: result.before, after: result.after, at: now } };
					x.git.head = result.after;
					x.followUp = x.followUp ? `${x.followUp}\n\n${note}` : note;
					// A child that was working when the change came gets a follow-up run; a finished one is
					// only marked (a person re-runs it), an idle pending one sees the note in its next run.
					if (wasWorking && finished) requeueForFollowUp(x);
				});
				if (wasWorking) requeued = true;
			} else {
				this.host.log("merge conflict", parent.git.branch, "into", c.git.branch, result.files.join(", "));
				this.host.commit(s => {
					const x = s.tasks.find(y => y.id === childId);
					if (!x) return;
					x.sync = { ...x.sync, [parentId]: { state: "resolving", head: edge.head, pendingHead: target, files: result.files, before: result.before, at: now } };
					x.followUp = resolveNote(parent, result.files);
					if (x.status !== "pending") requeueForFollowUp(x);
				});
				requeued = true;
			}
			this.host.changed();
		}
	}

	/** After a resolve run: merged when the parent head is in, else `conflict` (no MERGE_HEAD left). */
	private async settleResolving(childId: string): Promise<void> {
		const c = this.task(childId);
		if (!c?.git || !c.sync) return;
		for (const [parentId, edge] of Object.entries(c.sync)) {
			if (edge.state !== "resolving" || !edge.pendingHead) continue;
			const wt = await this.worktree(c);
			if (!wt) continue;
			const target = edge.pendingHead;
			const { merged, head } = await withRepoLock(c.git.repo, async () => {
				if (await mergeInProgress(wt)) await abortMerge(wt);
				const now = await git(wt, ["rev-parse", "HEAD"]);
				return { merged: await isAncestor(wt, target, now), head: now };
			});
			this.host.log("resolve", childId, parentId, merged ? "merged" : "still conflicting");
			this.host.commit(s => {
				const x = s.tasks.find(y => y.id === childId);
				if (!x?.git) return;
				x.git.head = head;
				x.sync = { ...x.sync, [parentId]: merged ? { state: "merged", head: target, before: edge.before, after: head, at: this.host.now() } : { ...edge, state: "conflict", at: this.host.now() } };
			});
		}
	}
}

/** Back to pending for one more run in its own session (the follow-up or the merge resolution). */
function requeueForFollowUp(t: Task): void {
	t.status = "pending";
	t.followUpOnly = true;
	for (const k of ["startedAt", "finishedAt", "attempts", "interrupted", "holdUntil", "paused"] as const) delete t[k];
}

function upstreamNote(parent: Task, changes: { subjects: string[]; files: string[] }): string {
	const lines = [`Upstream task "${parent.title}" changed. Its branch ${parent.git?.branch} is merged into your worktree.`];
	if (changes.subjects.length) lines.push(`Commits: ${changes.subjects.slice(0, 10).join("; ")}`);
	if (changes.files.length) lines.push(`Changed files: ${changes.files.slice(0, 30).join(", ")}`);
	if (parent.summary) lines.push(`Its latest reply: ${parent.summary.slice(0, 1500)}`);
	lines.push("Re-check your work against it.");
	return lines.join("\n");
}

function resolveNote(parent: Task, files: string[]): string {
	return [
		`Upstream task "${parent.title}" changed and its branch ${parent.git?.branch} conflicts with yours${files.length ? ` in ${files.join(", ")}` : ""}.`,
		`Merge it into your branch: run \`git merge ${parent.git?.branch}\`, resolve the conflicts keeping both sides' intent, and commit the merge. Then re-check your work against it.`,
	].join("\n");
}
