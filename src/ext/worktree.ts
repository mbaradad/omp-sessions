// Parallel agents in isolated git worktrees: start a session on its own `omp/<slug>` branch in a
// sibling `<repo>.worktrees/<slug>` checkout, run the same task N times (best-of-N), compare a
// branch with its base, merge the winner back, remove the rest.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { sendToHost } from "../shared/launch";
import type { SessionMeta } from "../shared/protocol";
import type { OmpApi } from "./api";
import { loadModels } from "./launch-options";
import { plain } from "./plain";
import { projectRoot, resolveOmpPath } from "./sessions";
import {
	type ChangedFile,
	type CreatedWorktree,
	type WorktreeInfo,
	aheadCount,
	branchExists,
	changedSince,
	conflictedFiles,
	createWorktree,
	currentBranch,
	diffBase,
	git,
	gitOk,
	headOf,
	isDirty,
	localBranches,
	mainRepoRoot,
	readWorktreeInfo,
	resolveBase,
	slugify,
	taskTitle,
	writeWorktreeInfo,
} from "./worktree-git";

const GIT_SCHEME = "omp-git";

interface GitShowQuery {
	cwd: string;
	rev: string;
	path: string;
}

function isGitShowQuery(v: unknown): v is GitShowQuery {
	if (typeof v !== "object" || v === null) return false;
	const r: Record<string, unknown> = { ...v };
	return typeof r.cwd === "string" && typeof r.rev === "string" && typeof r.path === "string";
}

/** `git show <rev>:<path>` as a read-only document; an empty `rev` is an empty file (added/deleted side). */
class GitShowProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		let q: unknown;
		try {
			q = JSON.parse(uri.query);
		} catch {
			return "";
		}
		if (!isGitShowQuery(q) || !q.rev) return "";
		const res = await git(q.cwd, ["show", `${q.rev}:${q.path}`]);
		return res.code === 0 ? res.stdout : "";
	}
}

function gitUri(cwd: string, rev: string, rel: string): vscode.Uri {
	const query: GitShowQuery = { cwd, rev, path: rel };
	return vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${rel}`, query: JSON.stringify(query) });
}

/** A session's worktree: live from git when the folder is a linked worktree, else from `worktree.json`. */
interface SessionWorktree extends WorktreeInfo {
	present: boolean;
}

function worktreeOf(meta: SessionMeta): SessionWorktree | undefined {
	const stored = readWorktreeInfo(meta.id);
	const project = projectRoot(meta.cwd);
	if (project.worktree && fs.existsSync(project.worktree.root)) {
		return {
			mainRoot: project.root,
			worktree: project.worktree.root,
			branch: headOf(project.worktree.gitDir) ?? stored?.branch ?? "",
			base: stored?.base ?? "",
			baseCommit: stored?.baseCommit ?? "",
			createdAt: stored?.createdAt ?? 0,
			batch: stored?.batch,
			present: true,
		};
	}
	return stored ? { ...stored, present: fs.existsSync(stored.worktree) } : undefined;
}

/** Base of a worktree not created by this extension: the branch checked out in the main repository. */
async function withBase(wt: SessionWorktree): Promise<SessionWorktree> {
	if (wt.base || wt.baseCommit) return wt;
	const base = await resolveBase(wt.mainRoot);
	return { ...wt, ...base };
}

const STATUS_LABEL: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed", U: "conflict", "?": "untracked" };

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function confirm(message: string, detail: string, ...actions: string[]): Promise<string | undefined> {
	return vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions);
}

/** Sends the first prompt straight to the host (the chat may not be connected yet). */
async function startPrompt(api: OmpApi, id: string, text: string): Promise<boolean> {
	const meta = api.sessions.get(id);
	if (!meta || meta.status === "stopped") return false;
	return sendToHost(meta, { t: "rpc", cmd: { type: "prompt", message: text } });
}

/** Stops a running session and waits for its host to exit (so the worktree folder is no longer in use). */
async function stopAndWait(api: OmpApi, id: string): Promise<void> {
	const meta = api.sessions.get(id);
	if (!meta || meta.status === "stopped") return;
	const kill = () => {
		try {
			process.kill(meta.pid, "SIGTERM");
		} catch {
			/* already gone */
		}
	};
	if (!(await sendToHost(meta, { t: "stop" }))) kill();
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		api.sessions.refresh();
		if (api.sessions.get(id)?.status === "stopped") return;
		await sleep(200);
	}
	kill();
	await sleep(500);
}

// ---------- asking ----------

async function askTask(title: string): Promise<string | undefined> {
	const task = await vscode.window.showInputBox({
		title,
		prompt: "Task for omp — its first words name the branch and the session",
		placeHolder: "e.g. Add retries with backoff to the upload client",
		ignoreFocusOut: true,
		validateInput: v => (v.trim() ? undefined : "Describe the task"),
	});
	return task?.trim() || undefined;
}

type RefItem = vscode.QuickPickItem & { ref: string };

/** Base branch: current HEAD first, then local branches; typing any ref (origin/main, a tag, a commit) works too. */
async function askBase(cwd: string, title: string): Promise<string | undefined> {
	const current = await currentBranch(cwd);
	const branches = await localBranches(cwd);
	const fixed: RefItem[] = [
		{ label: `$(git-branch) ${current ?? "HEAD"}`, description: current ? "current branch" : "current commit (detached)", ref: current ?? "HEAD" },
		...branches.filter(b => b !== current).map(b => ({ label: `$(git-branch) ${b}`, ref: b })),
	];
	const qp = vscode.window.createQuickPick<RefItem>();
	qp.title = title;
	qp.placeholder = "Base branch (Enter = current); or type any branch, tag or commit";
	qp.items = fixed;
	qp.ignoreFocusOut = true;
	qp.onDidChangeValue(v => {
		const typed = v.trim();
		qp.items = typed && !fixed.some(i => i.ref === typed) ? [{ label: `$(edit) ${typed}`, description: "use this ref", ref: typed, alwaysShow: true }, ...fixed] : fixed;
	});
	const done = Promise.withResolvers<string | undefined>();
	qp.onDidAccept(() => done.resolve(qp.selectedItems[0]?.ref));
	qp.onDidHide(() => done.resolve(undefined));
	qp.show();
	const ref = await done.promise;
	qp.dispose();
	return ref;
}

type ModelItem = vscode.QuickPickItem & { selector: string };

/** Models for best-of-N runs (multi-select, typed selectors allowed); [] = default model. */
async function askModels(cwd: string, title: string): Promise<string[] | undefined> {
	const qp = vscode.window.createQuickPick<ModelItem>();
	qp.title = title;
	qp.placeholder = "Models to compare — runs cycle through the checked ones; none = default model. Type a selector to add one.";
	qp.canSelectMany = true;
	qp.ignoreFocusOut = true;
	qp.busy = true;
	let models: ModelItem[] = [];
	const custom: ModelItem[] = [];
	const render = () => {
		const selected = qp.selectedItems;
		const typed = qp.value.trim();
		const extra = typed && ![...custom, ...models].some(m => m.selector === typed) ? [{ label: `$(edit) ${typed}`, description: "custom model selector", selector: typed, alwaysShow: true }] : [];
		qp.items = [...extra, ...custom, ...models];
		qp.selectedItems = qp.items.filter(i => selected.some(s => s.selector === i.selector));
	};
	qp.onDidChangeValue(render);
	qp.onDidChangeSelection(sel => {
		for (const s of sel) if (s.description === "custom model selector" && !custom.some(c => c.selector === s.selector)) custom.push({ ...s, description: "custom" });
	});
	void loadModels(cwd).then(list => {
		models = list.models.map(m => ({ label: `${m.default ? "$(star-full) " : ""}${m.name}`, description: `${m.selector}${m.default ? " · default" : ""}`, selector: m.selector }));
		qp.busy = false;
		render();
	});
	const done = Promise.withResolvers<string[] | undefined>();
	qp.onDidAccept(() => done.resolve([...new Set(qp.selectedItems.map(i => i.selector))]));
	qp.onDidHide(() => done.resolve(undefined));
	qp.show();
	const picked = await done.promise;
	qp.dispose();
	return picked;
}

/** Folder in a git repository with omp available, or undefined after telling the user why not. */
async function repoFolder(api: OmpApi, arg: unknown): Promise<string | undefined> {
	const folder = await api.pickFolder(arg);
	if (!folder) return undefined;
	if (!resolveOmpPath()) {
		void vscode.window.showErrorMessage("Could not find the `omp` executable. Set `omp.path` in settings.");
		return undefined;
	}
	if (!(await mainRepoRoot(folder))) {
		void vscode.window.showErrorMessage(plain(`${folder} is not inside a git repository (or git is not installed). Worktree sessions need git.`));
		return undefined;
	}
	return folder;
}

// ---------- commands ----------

async function newWorktreeSession(api: OmpApi, arg: unknown): Promise<void> {
	const folder = await repoFolder(api, arg);
	if (!folder) return;
	const step = (n: number) => `New session in a git worktree (${n}/3)`;
	const task = await askTask(step(1));
	if (!task) return;
	const base = await askBase(folder, step(2));
	if (!base) return;
	const start = await vscode.window.showQuickPick(
		[
			{ label: "$(play) Start working on it", description: "send the task as the first prompt", start: true },
			{ label: "$(comment-discussion) Just open the chat", description: "the task only names the branch and session", start: false },
		],
		{ title: step(3), ignoreFocusOut: true },
	);
	if (!start) return;
	let created: CreatedWorktree;
	try {
		created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Creating git worktree…" }, () => createWorktree({ from: folder, slug: slugify(task), base }));
	} catch (err) {
		void vscode.window.showErrorMessage(plain(`Could not create the worktree: ${errorText(err)}`));
		return;
	}
	const panel = await api.launchAndOpen({ cwd: created.cwd, title: taskTitle(task) });
	if (!panel) return;
	writeWorktreeInfo(panel.sessionId, created);
	api.refreshTree();
	if (start.start && !(await startPrompt(api, panel.sessionId, task))) void vscode.window.showWarningMessage("The session did not accept the task; send it from the chat.");
	panel.focusComposer();
}

async function bestOfN(api: OmpApi, arg: unknown): Promise<void> {
	const folder = await repoFolder(api, arg);
	if (!folder) return;
	const step = (n: number) => `Best-of-N in git worktrees (${n}/4)`;
	const task = await askTask(step(1));
	if (!task) return;
	const models = await askModels(folder, step(2));
	if (!models) return;
	const runsFor = (n: number) => Array.from({ length: n }, (_, i) => (models.length ? models[i % models.length] : undefined));
	const minN = Math.min(4, Math.max(2, models.length));
	const count = await vscode.window.showQuickPick(
		[2, 3, 4]
			.filter(n => n >= minN)
			.map(n => ({ label: `${n} runs`, description: runsFor(n).map(m => m ?? "default model").join(", "), n })),
		{ title: step(3), placeHolder: "How many parallel runs?", ignoreFocusOut: true },
	);
	if (!count) return;
	const baseRef = await askBase(folder, step(4));
	if (!baseRef) return;
	let base: { base: string; baseCommit: string };
	try {
		base = await resolveBase(folder, baseRef);
	} catch (err) {
		void vscode.window.showErrorMessage(plain(errorText(err)));
		return;
	}
	const runs = runsFor(count.n);
	const batch = crypto.randomBytes(4).toString("hex");
	const slug = slugify(task, 34);
	const created: Array<{ wt: CreatedWorktree; model?: string; index: number }> = [];
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${runs.length} git worktrees…` }, async () => {
		// One at a time: concurrent `git worktree add` races on the repository's lock files.
		for (const [i, model] of runs.entries()) {
			try {
				created.push({ wt: await createWorktree({ from: folder, slug: `${slug}-${i + 1}`, ...base }), model, index: i + 1 });
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`Could not create worktree ${i + 1}: ${errorText(err)}`));
			}
		}
	});
	if (!created.length) return;
	const defaults = vscode.workspace.getConfiguration("omp").get<string[]>("extraArgs") ?? [];
	const title = taskTitle(task, 50);
	const started = await Promise.all(
		created.map(async ({ wt, model, index }) => {
			const panel = await api.launchAndOpen({
				cwd: wt.cwd,
				title: `${title} #${index}${model ? ` · ${model.split("/").pop()}` : ""}`,
				ompArgs: model ? [...defaults, "--model", model] : undefined,
			});
			if (!panel) return false;
			writeWorktreeInfo(panel.sessionId, { ...wt, batch });
			return startPrompt(api, panel.sessionId, task);
		}),
	);
	api.refreshTree();
	const ok = started.filter(Boolean).length;
	const pick = await vscode.window.showInformationMessage(
		plain(`Started ${ok} of ${runs.length} runs on ${created.map(c => c.wt.branch).join(", ")}. When they finish, compare each with "Compare with Base", merge the best one, then remove the others.`),
		"Show Sessions",
	);
	if (pick) await vscode.commands.executeCommand("omp.sessions.focus");
}

async function pickWorktreeSession(api: OmpApi, arg: unknown, placeHolder: string): Promise<{ meta: SessionMeta; wt: SessionWorktree } | undefined> {
	const id = api.idFrom(arg) ?? (await api.pickSession(placeHolder, m => !!worktreeOf(m)));
	const meta = id ? api.sessions.get(id) : undefined;
	if (!meta) return undefined;
	const wt = worktreeOf(meta);
	if (!wt) {
		void vscode.window.showInformationMessage(plain(`"${meta.title}" does not run in a git worktree.`));
		return undefined;
	}
	return { meta, wt };
}

function changesTuple(wt: SessionWorktree, rev: string, f: ChangedFile): [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined] {
	const abs = vscode.Uri.file(path.join(wt.worktree, f.path));
	const left = f.status === "A" || f.status === "?" ? undefined : gitUri(wt.worktree, rev, f.from ?? f.path);
	return [abs, left, f.status === "D" ? undefined : abs];
}

async function compareWithBase(api: OmpApi, arg: unknown): Promise<void> {
	const picked = await pickWorktreeSession(api, arg, "Compare which worktree session with its base?");
	if (!picked) return;
	if (!picked.wt.present) {
		void vscode.window.showErrorMessage(plain(`The worktree ${picked.wt.worktree} no longer exists.`));
		return;
	}
	let wt: SessionWorktree;
	let rev: string;
	let files: ChangedFile[];
	try {
		wt = await withBase(picked.wt);
		rev = await diffBase(wt.worktree, wt);
		files = await changedSince(wt.worktree, rev);
	} catch (err) {
		void vscode.window.showErrorMessage(plain(`Could not compare: ${errorText(err)}`));
		return;
	}
	const label = `${wt.branch} vs ${wt.base}`;
	if (!files.length) {
		void vscode.window.showInformationMessage(plain(`No changes on ${label}.`));
		return;
	}
	const items: Array<vscode.QuickPickItem & { file?: ChangedFile }> = [
		{ label: "$(diff-multiple) All changes", description: `${files.length} file${files.length === 1 ? "" : "s"} — committed, uncommitted and untracked` },
		...files.map(f => {
			const dir = path.posix.dirname(f.path);
			return { label: path.posix.basename(f.path), description: `${STATUS_LABEL[f.status] ?? f.status}${dir === "." ? "" : ` · ${dir}`}${f.from ? ` · from ${f.from}` : ""}`, file: f };
		}),
	];
	const pick = await vscode.window.showQuickPick(items, { title: label, placeHolder: "Open which diff?", matchOnDescription: true });
	if (!pick) return;
	if (!pick.file) {
		await vscode.commands.executeCommand("vscode.changes", `omp: ${label} — ${files.length} file${files.length === 1 ? "" : "s"}`, files.map(f => changesTuple(wt, rev, f)));
		return;
	}
	const [abs, left, right] = changesTuple(wt, rev, pick.file);
	await vscode.commands.executeCommand("vscode.diff", left ?? gitUri(wt.worktree, "", pick.file.path), right ?? gitUri(wt.worktree, "", pick.file.path), `${path.basename(abs.fsPath)} (${label})`);
}

async function mergeIntoMain(api: OmpApi, arg: unknown): Promise<void> {
	const picked = await pickWorktreeSession(api, arg, "Merge which worktree session's branch?");
	if (!picked) return;
	const { meta } = picked;
	const wt = picked.wt;
	if (!wt.branch || !(await branchExists(wt.mainRoot, wt.branch))) {
		void vscode.window.showErrorMessage(plain(`Branch ${wt.branch || "(unknown)"} does not exist in ${wt.mainRoot}.`));
		return;
	}
	if (meta.status === "working" && (await confirm(`"${meta.title}" is still working.`, "Merge what it has done so far?", "Merge Anyway")) !== "Merge Anyway") return;
	if (wt.present && (await isDirty(wt.worktree))) {
		const commit = await confirm(`${wt.branch} has uncommitted changes in its worktree.`, `Commit all of them (including untracked files) to ${wt.branch} and merge?`, "Commit and Merge");
		if (commit !== "Commit and Merge") return;
		try {
			await gitOk(wt.worktree, ["add", "-A"]);
			await gitOk(wt.worktree, ["commit", "-m", meta.title]);
		} catch (err) {
			void vscode.window.showErrorMessage(plain(`Could not commit in the worktree: ${errorText(err)}`));
			return;
		}
	}
	const into = await currentBranch(wt.mainRoot);
	if (!into) {
		void vscode.window.showErrorMessage(plain(`${wt.mainRoot} is not on a branch (detached HEAD). Check out the branch to merge into first.`));
		return;
	}
	if (into === wt.branch) {
		void vscode.window.showErrorMessage(plain(`The main checkout already has ${wt.branch} checked out.`));
		return;
	}
	const ahead = await aheadCount(wt.mainRoot, into, wt.branch);
	if (ahead === 0) {
		void vscode.window.showInformationMessage(plain(`${into} already contains everything on ${wt.branch}.`));
		return;
	}
	if (await isDirty(wt.mainRoot, true)) {
		const open = await vscode.window.showErrorMessage(plain(`${path.basename(wt.mainRoot)} has uncommitted changes. Commit or stash them before merging ${wt.branch}.`), "Open Source Control");
		if (open) await vscode.commands.executeCommand("workbench.view.scm");
		return;
	}
	const note = wt.base && wt.base !== into ? `\n\nNote: the branch started from ${wt.base}, but the main checkout is on ${into}.` : "";
	const go = await confirm(`Merge ${wt.branch} into ${into}?`, `${ahead} commit${ahead === 1 ? "" : "s"}; runs \`git merge --no-ff ${wt.branch}\` in ${wt.mainRoot}.${note}`, "Merge");
	if (go !== "Merge") return;
	const res = await git(wt.mainRoot, ["merge", "--no-ff", "-m", `Merge branch '${wt.branch}': ${meta.title}`, wt.branch]);
	if (res.code !== 0) {
		const conflicts = await conflictedFiles(wt.mainRoot);
		if (!conflicts.length) {
			void vscode.window.showErrorMessage(plain(`Merge failed: ${res.stderr.trim() || res.stdout.trim()}`));
			return;
		}
		const action = await vscode.window.showErrorMessage(
			plain(`Merging ${wt.branch} into ${into} stopped with conflicts in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}: ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? ", …" : ""}. Resolve them in Source Control and commit, or abort the merge.`),
			"Open Source Control",
			"Abort Merge",
		);
		if (action === "Abort Merge") {
			const abort = await git(wt.mainRoot, ["merge", "--abort"]);
			if (abort.code !== 0) void vscode.window.showErrorMessage(plain(`git merge --abort failed: ${abort.stderr}`));
		} else await vscode.commands.executeCommand("workbench.view.scm");
		return;
	}
	// Other sessions of the same best-of-N run.
	const siblings = wt.batch ? api.sessions.all().filter(m => m.id !== meta.id && readWorktreeInfo(m.id)?.batch === wt.batch) : [];
	const removeAll = siblings.length ? `Remove It and ${siblings.length} Other Run${siblings.length === 1 ? "" : "s"}` : undefined;
	const after = await vscode.window.showInformationMessage(plain(`Merged ${wt.branch} into ${into}.`), "Remove Worktree", ...(removeAll ? [removeAll] : []));
	if (after === "Remove Worktree") await removeSession(api, meta, wt, { deleteBranch: true, forceBranch: false });
	else if (after && removeAll) {
		const ok = await confirm(
			`Remove ${siblings.length + 1} worktree sessions?`,
			`Stops the sessions and deletes the worktrees and branches of:\n${[meta, ...siblings].map(m => `• ${m.title}`).join("\n")}\n\nUnmerged work on the other runs' branches is lost. omp transcripts are kept.`,
			"Remove All",
		);
		if (ok !== "Remove All") return;
		await removeSession(api, meta, wt, { deleteBranch: true, forceBranch: false });
		for (const m of siblings) {
			const other = worktreeOf(m);
			if (other) await removeSession(api, m, other, { deleteBranch: true, forceBranch: true });
		}
	}
}

async function removeSession(api: OmpApi, meta: SessionMeta, wt: SessionWorktree, opts: { deleteBranch: boolean; forceBranch: boolean }): Promise<boolean> {
	await stopAndWait(api, meta.id);
	if (fs.existsSync(wt.worktree)) {
		let res = await git(wt.mainRoot, ["worktree", "remove", wt.worktree]);
		if (res.code !== 0) {
			const force = await confirm(`Could not remove the worktree of "${meta.title}".`, `${res.stderr.trim()}\n\nForce removal deletes its uncommitted and untracked changes.`, "Force Remove");
			if (force !== "Force Remove") return false;
			res = await git(wt.mainRoot, ["worktree", "remove", "--force", wt.worktree]);
			if (res.code !== 0) {
				void vscode.window.showErrorMessage(plain(`git worktree remove failed: ${res.stderr.trim()}`));
				return false;
			}
		}
	} else await git(wt.mainRoot, ["worktree", "prune"]);
	try {
		fs.rmdirSync(path.dirname(wt.worktree)); // the `<repo>.worktrees` folder, once empty
	} catch {
		/* not empty */
	}
	if (opts.deleteBranch && wt.branch && (await branchExists(wt.mainRoot, wt.branch))) {
		let res = await git(wt.mainRoot, ["branch", "-d", wt.branch]);
		if (res.code !== 0) {
			const force = opts.forceBranch || (await confirm(`Branch ${wt.branch} is not fully merged.`, "Delete it anyway? Its commits are lost.", "Delete Branch")) === "Delete Branch";
			if (force) res = await git(wt.mainRoot, ["branch", "-D", wt.branch]);
			if (force && res.code !== 0) void vscode.window.showWarningMessage(plain(`Could not delete ${wt.branch}: ${res.stderr.trim()}`));
		}
	}
	api.closePanel(meta.id);
	api.sessions.remove(meta.id);
	api.refreshTree();
	return true;
}

async function removeWorktree(api: OmpApi, arg: unknown): Promise<void> {
	const picked = await pickWorktreeSession(api, arg, "Remove which worktree session?");
	if (!picked) return;
	const { meta, wt } = picked;
	const choice = await confirm(
		`Remove "${meta.title}" and its worktree?`,
		`${meta.status === "stopped" ? "" : "Stops the session, "}deletes the worktree folder\n${wt.worktree}\nand the session record. The omp transcript is kept.${wt.branch ? `\n\nBranch: ${wt.branch}` : ""}`,
		"Remove",
		"Remove and Delete Branch",
	);
	if (!choice) return;
	await removeSession(api, meta, wt, { deleteBranch: choice === "Remove and Delete Branch", forceBranch: false });
}

async function openWorktreeFolder(api: OmpApi, arg: unknown): Promise<void> {
	const picked = await pickWorktreeSession(api, arg, "Open which session's worktree?");
	if (!picked) return;
	if (!picked.wt.present) {
		void vscode.window.showErrorMessage(plain(`The worktree ${picked.wt.worktree} no longer exists.`));
		return;
	}
	await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(picked.wt.worktree), { forceNewWindow: true });
}

export function registerWorktrees(api: OmpApi): void {
	const reg = (name: string, fn: (arg?: unknown) => Promise<void>) => api.context.subscriptions.push(vscode.commands.registerCommand(name, (arg?: unknown) => fn(arg)));
	api.context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitShowProvider()));
	reg("omp.newWorktreeSession", arg => newWorktreeSession(api, arg));
	reg("omp.bestOfN", arg => bestOfN(api, arg));
	reg("omp.worktree.diff", arg => compareWithBase(api, arg));
	reg("omp.worktree.merge", arg => mergeIntoMain(api, arg));
	reg("omp.worktree.openFolder", arg => openWorktreeFolder(api, arg));
	reg("omp.worktree.remove", arg => removeWorktree(api, arg));
}
