// Pull requests of the sessions, reviewed in VS Code's own editors. AO owns the PRs (SCM polling, CI, review
// state, its reviewer, merging, feeding CI failures and review comments to the agent); this module shows AO's
// data: a Pull Requests view (state, failing checks, unresolved review threads, conflicts, files, commits), the
// PR's base and head of each file as read-only documents (`switchyard-pr:`, read from AO's PR file revisions)
// opened in the multi-file diff editor, review threads as comments on the head side, and AO's actions on a PR
// (merge, its reviewer, claiming a PR, resolving threads, hand CI and review problems to the agent by itself).
import * as path from "node:path";
import * as vscode from "vscode";
import { AoError } from "../ao/client";
import { type PrFiles, prDetailOf, prFactsOf, prFiles, prRevisionText } from "../ao/pr";
import { type PrCommit, type PrDetail, type PrFacts, type PrFile, type PrRevisionRef, type PrThread, PR_SCHEME, lineCounts, parsePrRevision, prNeedsAttention, prRevisionParts, prSummaryLine } from "../shared/pr-review";
import type { OmpApi } from "./api";
import { plain } from "./plain";

const errorMessage = (err: unknown): string => {
	// AO reads a PR's files from the session's own repository: a branch nobody fetched there is unavailable, whatever the PR says.
	if (err instanceof AoError && err.code === "PR_SOURCE_UNAVAILABLE") return `${err.message}: the PR's commits are not in the session's repository yet (fetch its branch there)`;
	return err instanceof Error ? err.message : String(err);
};

// ---------- the data: AO's PRs of the sessions ----------

interface PrRef {
	session: string;
	facts: PrFacts;
}

/** Sessions with PRs, from the session views the extension already holds, with AO's PR details read on demand. */
class PrStore implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly details = new Map<string, PrDetail>();
	private readonly loading = new Map<string, Promise<void>>();
	private readonly files = new Map<string, Promise<PrFiles>>();
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly api: OmpApi) {}

	/** Every PR of every worker session, most recently updated first. */
	list(): PrRef[] {
		const out: PrRef[] = [];
		for (const meta of this.api.sessions.all()) {
			for (const p of this.api.sessions.model(meta.id)?.view.prs ?? []) out.push({ session: meta.id, facts: prFactsOf(p) });
		}
		return out.sort((a, b) => Date.parse(b.facts.updatedAt) - Date.parse(a.facts.updatedAt));
	}

	private key = (r: { session: string; number: number }) => `${r.session}#${r.number}`;

	/** The details when read and still current for these facts. */
	cached(ref: PrRef): PrDetail | undefined {
		const d = this.details.get(this.key({ session: ref.session, number: ref.facts.number }));
		return d && d.updatedAt === ref.facts.updatedAt ? d : undefined;
	}

	/** Reads (once at a time per session) what AO says about the session's PRs; the view refreshes when it lands. */
	ensure(ref: PrRef): Promise<PrDetail | undefined> {
		const known = this.cached(ref);
		if (known) return Promise.resolve(known);
		const pending = this.loading.get(ref.session) ?? this.load(ref.session);
		return pending.then(() => this.details.get(this.key({ session: ref.session, number: ref.facts.number })));
	}

	private load(session: string): Promise<void> {
		const p = this.api.ao
			.client()
			.then(client => client.sessionPrs(session))
			.then(res => {
				for (const s of res.prs) this.details.set(this.key({ session, number: s.number }), prDetailOf(session, s));
				this.emitter.fire();
			})
			.catch(() => undefined)
			.finally(() => this.loading.delete(session));
		this.loading.set(session, p);
		return p;
	}

	/** A PR's files and commits, read once per head. */
	filesOf(pr: PrDetail): Promise<PrFiles> {
		const key = `${pr.session}#${pr.number}@${pr.headSha}`;
		let cached = this.files.get(key);
		if (!cached) {
			cached = this.api.ao.client().then(client => prFiles(client, pr.session, pr));
			cached.catch(() => this.files.delete(key));
			this.files.set(key, cached);
		}
		return cached;
	}

	/** Re-reads after the session views changed; AO's SCM observer updates them, a burst of events is one refresh. */
	refreshSoon(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.emitter.fire(), 400);
	}

	/** Forgets what was read (the manual refresh). */
	reload(): void {
		this.details.clear();
		this.files.clear();
		this.emitter.fire();
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.emitter.dispose();
	}
}

// ---------- the PR's files as documents ----------

/** Read-only documents: one side of one file of a PR, read from AO. */
class PrContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private readonly api: OmpApi) {}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const ref = parsePrRevision(uri);
		if (!ref) return "";
		try {
			const client = await this.api.ao.client();
			const text = await prRevisionText(client, ref.session, { number: ref.number, url: ref.url ?? "" }, ref.side, ref.path, ref.commit);
			return text.truncated ? `${text.text}\n… (AO cut this file; open it in the session's worktree for the rest)` : text.text;
		} catch (err) {
			return `(could not read this revision from AO: ${errorMessage(err)})`;
		}
	}
}

const revisionUri = (ref: PrRevisionRef): vscode.Uri => vscode.Uri.from(prRevisionParts(ref));

/** The two sides of one PR file: its path before (the previous one for a rename) and after. */
function sides(pr: PrDetail, file: PrFile, commit?: string): { left: vscode.Uri; right: vscode.Uri } {
	const base = { session: pr.session, number: pr.number, url: pr.url, head: pr.headSha, ...(commit && { commit }) };
	return { left: revisionUri({ ...base, side: "before", path: file.previousPath ?? file.path }), right: revisionUri({ ...base, side: "after", path: file.path }) };
}

// ---------- nodes ----------

type Node =
	| { kind: "pr"; ref: PrRef; detail?: PrDetail }
	| { kind: "group"; group: "checks" | "threads" | "conflicts" | "files" | "commits"; pr: PrDetail }
	| { kind: "check"; pr: PrDetail; name: string; status: string; url?: string }
	| { kind: "thread"; pr: PrDetail; thread: PrThread }
	| { kind: "conflict"; pr: PrDetail; file: string }
	| { kind: "file"; pr: PrDetail; file: PrFile; commit?: string }
	| { kind: "commit"; pr: PrDetail; commit: PrCommit }
	| { kind: "info"; text: string };

const STATE_ICON: Record<PrFacts["state"], string> = { draft: "git-pull-request-draft", open: "git-pull-request", merged: "git-merge", closed: "git-pull-request-closed" };

function prIcon(f: PrFacts): vscode.ThemeIcon {
	if (f.state === "merged") return new vscode.ThemeIcon(STATE_ICON.merged, new vscode.ThemeColor("charts.purple"));
	if (f.state === "closed") return new vscode.ThemeIcon(STATE_ICON.closed, new vscode.ThemeColor("charts.red"));
	const bad = f.ci === "failing" || f.review === "changes_requested" || f.mergeability === "conflicting";
	const good = f.ci === "passing" && f.review === "approved" && f.mergeability === "mergeable";
	return new vscode.ThemeIcon(STATE_ICON[f.state], new vscode.ThemeColor(bad ? "charts.red" : good ? "charts.green" : "charts.yellow"));
}

const fileIcon = (status: PrFile["status"]): vscode.ThemeIcon =>
	new vscode.ThemeIcon(status === "added" ? "diff-added" : status === "deleted" ? "diff-removed" : status === "renamed" ? "diff-renamed" : "diff-modified", new vscode.ThemeColor(status === "added" ? "gitDecoration.addedResourceForeground" : status === "deleted" ? "gitDecoration.deletedResourceForeground" : "gitDecoration.modifiedResourceForeground"));

function fileItem(node: Extract<Node, { kind: "file" }>): vscode.TreeItem {
	const { file } = node;
	const dir = path.posix.dirname(file.path);
	const item = new vscode.TreeItem(path.posix.basename(file.path), vscode.TreeItemCollapsibleState.None);
	item.description = `${dir === "." ? "" : `${dir} · `}${file.binary ? "binary" : lineCounts(file.additions, file.deletions)}${file.previousPath ? ` · from ${file.previousPath}` : ""}`;
	item.tooltip = `${file.path}\n${file.status}${file.binary ? ", binary" : `, ${lineCounts(file.additions, file.deletions)}`}`;
	item.iconPath = fileIcon(file.status);
	item.contextValue = "pr.file";
	item.resourceUri = vscode.Uri.from({ scheme: PR_SCHEME, authority: node.pr.session, path: `/${file.path}`, query: "decoration=1" });
	item.command = { command: "switchyard.pr.openFile", title: "Open Diff", arguments: [node] };
	return item;
}

class PrTree implements vscode.TreeDataProvider<Node> {
	private readonly emitter = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(
		private readonly store: PrStore,
		private readonly api: OmpApi,
	) {
		store.onDidChange(() => this.emitter.fire(undefined));
	}

	/** Count of open PRs that need someone, for the view badge. */
	attention(): number {
		return this.store.list().filter(r => prNeedsAttention(r.facts)).length;
	}

	getTreeItem(node: Node): vscode.TreeItem {
		switch (node.kind) {
			case "info":
				return new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
			case "pr": {
				const d = node.detail;
				const owner = this.api.sessions.get(node.ref.session);
				const item = new vscode.TreeItem(`#${node.ref.facts.number}${d?.title ? ` ${d.title}` : ""}`, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = `${owner?.title ?? node.ref.session} · ${prSummaryLine(node.ref.facts, { unresolvedThreads: d?.unresolvedThreads }).replace(/^#\d+ /, "")}`;
				const tip = new vscode.MarkdownString(undefined, true);
				tip.appendMarkdown(`**#${node.ref.facts.number}${d?.title ? ` ${d.title}` : ""}**  \n`);
				if (d) tip.appendMarkdown(`${d.sourceBranch} → ${d.targetBranch} · ${d.author} · ${lineCounts(d.additions, d.deletions)} in ${d.changedFiles} file${d.changedFiles === 1 ? "" : "s"}  \n`);
				tip.appendText(`${prSummaryLine(node.ref.facts, { unresolvedThreads: d?.unresolvedThreads })}\nsession ${node.ref.session}${owner ? ` — ${owner.title}` : ""}`);
				if (d?.mergeReasons.length) tip.appendText(`\nAO: ${d.mergeReasons.join("; ")}`);
				item.tooltip = tip;
				item.iconPath = prIcon(node.ref.facts);
				item.contextValue = `pr.${node.ref.facts.state}`;
				item.command = { command: "switchyard.pr.review", title: "Review Pull Request", arguments: [node] };
				return item;
			}
			case "group": {
				const labels = { checks: "Failing checks", threads: "Unresolved review comments", conflicts: "Conflicts", files: "Files", commits: "Commits" } as const;
				const icons = { checks: "error", threads: "comment-unresolved", conflicts: "warning", files: "files", commits: "git-commit" } as const;
				const item = new vscode.TreeItem(labels[node.group], node.group === "files" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
				item.iconPath = new vscode.ThemeIcon(icons[node.group]);
				item.contextValue = `pr.group.${node.group}`;
				return item;
			}
			case "check": {
				const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
				item.description = node.status;
				item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
				if (node.url) item.command = { command: "vscode.open", title: "Open Check", arguments: [vscode.Uri.parse(node.url)] };
				return item;
			}
			case "thread": {
				const t = node.thread;
				const place = t.file ? `${path.posix.basename(t.file)}${t.line ? `:${t.line}` : ""}` : "";
				const item = new vscode.TreeItem(`${t.reviewer}${t.isBot ? " (bot)" : ""}${place ? ` on ${place}` : ""}`, vscode.TreeItemCollapsibleState.None);
				item.description = t.body?.split("\n")[0];
				item.tooltip = new vscode.MarkdownString(`${t.file ? `\`${t.file}${t.line ? `:${t.line}` : ""}\`\n\n` : ""}${plain(t.body ?? "(no text)")}`);
				item.iconPath = new vscode.ThemeIcon("comment-unresolved", new vscode.ThemeColor("charts.yellow"));
				item.contextValue = "pr.thread";
				item.command = t.file ? { command: "switchyard.pr.openThread", title: "Open Comment", arguments: [node] } : t.url ? { command: "vscode.open", title: "Open Comment", arguments: [vscode.Uri.parse(t.url)] } : undefined;
				return item;
			}
			case "conflict": {
				const item = new vscode.TreeItem(path.posix.basename(node.file), vscode.TreeItemCollapsibleState.None);
				item.description = path.posix.dirname(node.file) === "." ? undefined : path.posix.dirname(node.file);
				item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.orange"));
				return item;
			}
			case "file":
				return fileItem(node);
			case "commit": {
				const item = new vscode.TreeItem(node.commit.subject, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = `${node.commit.sha.slice(0, 8)} · ${node.commit.author}`;
				item.iconPath = new vscode.ThemeIcon("git-commit");
				item.contextValue = "pr.commit";
				return item;
			}
		}
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (!node) {
			const refs = this.store.list();
			if (!refs.length) return [{ kind: "info", text: "No session has a pull request yet." }];
			return refs.map(ref => ({ kind: "pr", ref, detail: this.store.cached(ref) }) satisfies Node);
		}
		if (node.kind === "pr") {
			const pr = await this.store.ensure(node.ref);
			if (!pr) return [{ kind: "info", text: "AO could not describe this PR." }];
			const groups: Node[] = [];
			if (pr.failingChecks.length) groups.push({ kind: "group", group: "checks", pr });
			if (pr.threads.length || pr.unresolvedThreads) groups.push({ kind: "group", group: "threads", pr });
			if (pr.conflictFiles.length) groups.push({ kind: "group", group: "conflicts", pr });
			groups.push({ kind: "group", group: "files", pr }, { kind: "group", group: "commits", pr });
			return groups;
		}
		if (node.kind === "group") return this.groupChildren(node);
		if (node.kind === "commit") return node.commit.files.map(file => ({ kind: "file", pr: node.pr, file, commit: node.commit.sha }) satisfies Node);
		return [];
	}

	private async groupChildren(node: Extract<Node, { kind: "group" }>): Promise<Node[]> {
		const { pr } = node;
		switch (node.group) {
			case "checks":
				return pr.failingChecks.map(c => ({ kind: "check", pr, name: c.name, status: c.conclusion || c.status, ...(c.url && { url: c.url }) }) satisfies Node);
			case "threads": {
				const rows: Node[] = pr.threads.map(thread => ({ kind: "thread", pr, thread }) satisfies Node);
				const unplaced = pr.unresolvedThreads - pr.threads.length;
				if (unplaced > 0) rows.push({ kind: "info", text: `${unplaced} more unresolved thread${unplaced === 1 ? "" : "s"} AO can't place; read them on the PR.` });
				return rows;
			}
			case "conflicts":
				return pr.conflictFiles.map(file => ({ kind: "conflict", pr, file }) satisfies Node);
			case "files":
			case "commits": {
				try {
					const res = await this.store.filesOf(pr);
					const rows: Node[] = node.group === "files" ? res.files.map(file => ({ kind: "file", pr, file }) satisfies Node) : res.commits.map(commit => ({ kind: "commit", pr, commit }) satisfies Node);
					if (res.truncated) rows.push({ kind: "info", text: "AO cut the list: this PR is very large." });
					return rows.length ? rows : [{ kind: "info", text: node.group === "files" ? "No changed files." : "No commits." }];
				} catch (err) {
					return [{ kind: "info", text: `Could not read from AO: ${errorMessage(err)}` }];
				}
			}
		}
	}
}

// ---------- review threads as comments on the head side ----------

/** AO's unresolved review comments of the PR under review, placed on its head-side documents (read-only: replies belong on the PR). */
class PrThreads implements vscode.Disposable {
	private readonly controller = vscode.comments.createCommentController("switchyard.pr", "Pull request review");
	private threads: vscode.CommentThread[] = [];

	constructor() {
		this.controller.commentingRangeProvider = undefined;
	}

	/** Shows the PR's placed threads (replacing the previous PR's). */
	show(pr: PrDetail): void {
		this.clear();
		for (const t of pr.threads) {
			if (!t.file || !t.line) continue;
			const uri = revisionUri({ session: pr.session, number: pr.number, url: pr.url, head: pr.headSha, side: "after", path: t.file });
			const range = new vscode.Range(Math.max(0, t.line - 1), 0, Math.max(0, t.line - 1), 0);
			const thread = this.controller.createCommentThread(uri, range, [{ author: { name: `${t.reviewer}${t.isBot ? " (bot)" : ""}` }, body: new vscode.MarkdownString(plain(t.body ?? "(no text)")), mode: vscode.CommentMode.Preview }]);
			thread.canReply = false;
			thread.label = "Unresolved";
			thread.contextValue = "pr.thread";
			this.registry.set(thread, { pr, thread: t });
			this.threads.push(thread);
		}
	}

	/** The PR thread a VS Code comment thread was made from (the comment menu passes the VS Code one). */
	readonly registry = new WeakMap<object, { pr: PrDetail; thread: PrThread }>();

	clear(): void {
		for (const t of this.threads) t.dispose();
		this.threads = [];
	}

	dispose(): void {
		this.clear();
		this.controller.dispose();
	}
}

// ---------- commands ----------

const PR_NODE_KINDS: Record<string, true> = { pr: true, group: true, check: true, thread: true, conflict: true, file: true, commit: true, info: true };

/** One of this view's nodes (the Sessions view's nodes carry a `kind` too). */
function isNode(arg: unknown): arg is Node {
	return !!arg && typeof arg === "object" && "kind" in arg && typeof arg.kind === "string" && Object.hasOwn(PR_NODE_KINDS, arg.kind);
}

/** A session's PR by number: what an open request with a PR hands `switchyard.pr.review`. */
function isSessionPr(arg: unknown): arg is { session: string; pr: number } {
	return !!arg && typeof arg === "object" && "session" in arg && typeof arg.session === "string" && "pr" in arg && typeof arg.pr === "number" && !("kind" in arg);
}

export function registerPrReview(api: OmpApi): void {
	const { context } = api;
	const store = new PrStore(api);
	const tree = new PrTree(store, api);
	const threads = new PrThreads();
	const view = vscode.window.createTreeView("switchyard.pullRequests", { treeDataProvider: tree, showCollapseAll: true });
	const updateBadge = () => {
		const n = tree.attention();
		view.badge = n ? { value: n, tooltip: `${n} pull request${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention (failing CI, changes requested or conflicts)` } : undefined;
	};
	context.subscriptions.push(store, threads, view, vscode.workspace.registerTextDocumentContentProvider(PR_SCHEME, new PrContentProvider(api)), api.sessions.onDidChange(() => store.refreshSoon()), store.onDidChange(updateBadge));
	updateBadge();

	/** The PR a command was invoked for: a tree node, `{ session, pr }` (a session's PR by number, from an open request), or one picked from the sessions' PRs. */
	async function pickPr(arg: unknown, placeHolder: string): Promise<PrDetail | undefined> {
		if (isNode(arg) && "pr" in arg) return arg.pr;
		let ref: PrRef | undefined;
		if (isNode(arg) && arg.kind === "pr") ref = arg.ref;
		else if (isSessionPr(arg)) {
			ref = store.list().find(r => r.session === arg.session && r.facts.number === arg.pr);
			if (!ref) {
				void vscode.window.showInformationMessage(`That session has no pull request #${arg.pr}.`);
				return undefined;
			}
		} else {
			// From the Sessions view (or a session id): that session's PRs; from the palette: everyone's.
			const sessionId = isNode(arg) ? undefined : api.idFrom(arg);
			const refs = store.list().filter(r => !sessionId || r.session === sessionId);
			if (!refs.length) {
				void vscode.window.showInformationMessage(sessionId ? "That session has no pull request." : "No session has a pull request yet.");
				return undefined;
			}
			ref =
				sessionId && refs.length === 1
					? refs[0]
					: (
							await vscode.window.showQuickPick(
								refs.map(r => ({ label: `#${r.facts.number} ${store.cached(r)?.title ?? ""}`.trim(), description: `${api.sessions.get(r.session)?.title ?? r.session} · ${prSummaryLine(r.facts).replace(/^#\d+ /, "")}`, ref: r })),
								{ placeHolder, matchOnDescription: true },
							)
						)?.ref;
		}
		if (!ref) return undefined;
		const detail = await store.ensure(ref);
		if (!detail) void vscode.window.showErrorMessage("AO could not describe that pull request.");
		return detail;
	}

	const reg = (id: string, fn: (arg?: unknown) => Promise<void> | void) => context.subscriptions.push(vscode.commands.registerCommand(id, async (arg?: unknown) => {
		try {
			await fn(arg);
		} catch (err) {
			void vscode.window.showErrorMessage(plain(errorMessage(err)));
		}
	}));

	reg("switchyard.pr.refresh", () => store.reload());

	reg("switchyard.pr.review", async arg => {
		const pr = await pickPr(arg, "Review which pull request?");
		if (!pr) return;
		const res = await store.filesOf(pr);
		if (!res.files.length) {
			void vscode.window.showInformationMessage(`#${pr.number} changes no files.`);
			return;
		}
		threads.show(pr);
		const resources = res.files.map(file => {
			const { left, right } = sides(pr, file);
			return [right, left, right] as const;
		});
		await vscode.commands.executeCommand("vscode.changes", `PR #${pr.number} ${pr.title} — ${res.files.length} file${res.files.length === 1 ? "" : "s"}${res.truncated ? " (AO cut the list)" : ""}`, resources);
	});

	reg("switchyard.pr.openFile", async arg => {
		if (!isNode(arg) || arg.kind !== "file") return;
		threads.show(arg.pr);
		const { left, right } = sides(arg.pr, arg.file, arg.commit);
		await vscode.commands.executeCommand("vscode.diff", left, right, `${path.posix.basename(arg.file.path)} (#${arg.pr.number}${arg.commit ? ` @ ${arg.commit.slice(0, 8)}` : ""})`, { preview: true });
	});

	reg("switchyard.pr.openThread", async arg => {
		if (!isNode(arg) || arg.kind !== "thread" || !arg.thread.file) return;
		threads.show(arg.pr);
		const { left, right } = sides(arg.pr, { path: arg.thread.file, status: "modified", additions: 0, deletions: 0, binary: false });
		const line = Math.max(0, (arg.thread.line ?? 1) - 1);
		await vscode.commands.executeCommand("vscode.diff", left, right, `${path.posix.basename(arg.thread.file)} (#${arg.pr.number} review comment)`, { preview: true, selection: new vscode.Range(line, 0, line, 0) });
	});

	reg("switchyard.pr.openInWorktree", async arg => {
		if (!isNode(arg) || arg.kind !== "file") return;
		const cwd = api.sessions.get(arg.pr.session)?.cwd;
		if (!cwd) return void vscode.window.showWarningMessage(`Session ${arg.pr.session} has no workspace on this machine.`);
		const uri = vscode.Uri.file(path.join(cwd, arg.file.path));
		try {
			await vscode.workspace.fs.stat(uri);
		} catch {
			return void vscode.window.showWarningMessage(plain(`${arg.file.path} is not in the session's worktree (${cwd}): it was deleted, or the worktree is on another branch.`));
		}
		await vscode.window.showTextDocument(uri, { preview: true });
	});

	reg("switchyard.pr.openInBrowser", async arg => {
		const pr = await pickPr(arg, "Open which pull request?");
		if (pr) await vscode.env.openExternal(vscode.Uri.parse(pr.url));
	});

	reg("switchyard.pr.copyUrl", async arg => {
		const pr = await pickPr(arg, "Copy which pull request's link?");
		if (pr) await vscode.env.clipboard.writeText(pr.url);
	});

	reg("switchyard.pr.openChat", async arg => {
		const pr = await pickPr(arg, "Open the chat of which pull request's session?");
		if (pr) api.openPanel(pr.session);
	});

	reg("switchyard.pr.merge", async arg => {
		const pr = await pickPr(arg, "Merge which pull request?");
		if (!pr) return;
		if (pr.state === "merged" || pr.state === "closed") return void vscode.window.showInformationMessage(`#${pr.number} is already ${pr.state}.`);
		// AO says what stands in the way; the merge itself is AO's (it refuses when the head moved since we looked).
		const detail = [prSummaryLine(pr, { unresolvedThreads: pr.unresolvedThreads }), ...pr.mergeReasons.map(r => `AO: ${r}`)].join("\n");
		const go = await vscode.window.showWarningMessage(plain(`Merge #${pr.number} ${pr.title} into ${pr.targetBranch}?`), { modal: true, detail }, "Merge");
		if (go !== "Merge") return;
		const client = await api.ao.client();
		try {
			await client.mergePr(pr.number, { prUrl: pr.url, expectedHeadSha: pr.headSha });
		} catch (err) {
			if (err instanceof AoError && err.status === 409) {
				store.reload();
				throw new Error(`AO refused the merge: ${err.message} (the PR changed since it was shown; it was reloaded)`);
			}
			throw err;
		}
		void vscode.window.showInformationMessage(plain(`Merged #${pr.number}.`));
		store.reload();
	});

	reg("switchyard.pr.requestReview", async arg => {
		const pr = await pickPr(arg, "Have AO's reviewer review which pull request?");
		if (!pr) return;
		const client = await api.ao.client();
		const res = await client.triggerReview(pr.session, { prUrl: pr.url, source: "manual" });
		void vscode.window.showInformationMessage(plain(res.created ? `AO's reviewer is looking at #${pr.number}.` : `#${pr.number} already has a review of this head (or one is running).`));
	});

	reg("switchyard.pr.resolveThreads", async arg => {
		const pr = await pickPr(arg, "Resolve the review threads of which pull request?");
		if (!pr) return;
		const go = await vscode.window.showWarningMessage(plain(`Resolve every review thread on #${pr.number}?`), { modal: true, detail: "AO marks them resolved on the pull request." }, "Resolve");
		if (go !== "Resolve") return;
		const client = await api.ao.client();
		const n = await client.resolvePrComments(pr.number);
		void vscode.window.showInformationMessage(`Resolved ${n} thread${n === 1 ? "" : "s"} on #${pr.number}.`);
		store.reload();
	});

	reg("switchyard.pr.autoFeed", async arg => {
		const pr = await pickPr(arg, "Which pull request's session?");
		if (!pr) return;
		const view = api.sessions.model(pr.session)?.view;
		const options = [
			{ label: "Failing CI checks", description: "AO hands them to the agent", picked: !!view?.autoInjectCI, key: "ci" as const },
			{ label: "New review comments", description: "AO hands them to the agent", picked: !!view?.autoInjectReview, key: "review" as const },
			{ label: "AO's own reviewer on every new head", description: "its comments reach the agent", picked: !!view?.autoReviewEnabled, key: "reviewer" as const },
		];
		const chosen = await vscode.window.showQuickPick(options, { canPickMany: true, title: `Let AO act on #${pr.number} by itself`, placeHolder: "Tick what AO should do without asking" });
		if (!chosen) return;
		const client = await api.ao.client();
		const on = new Set(chosen.map(c => c.key));
		await client.setAutoInject(pr.session, "ci", on.has("ci"));
		await client.setAutoInject(pr.session, "review", on.has("review"));
		await client.setAutoReview(pr.session, on.has("reviewer"));
	});

	reg("switchyard.pr.claim", async () => {
		const text = await vscode.window.showInputBox({ title: "Attach a pull request to a session", prompt: "Pull request URL or owner/repo#number", placeHolder: "https://github.com/owner/repo/pull/12", ignoreFocusOut: true });
		if (!text?.trim()) return;
		const session = await api.pickSession("Attach it to which session? (the session's agent continues the PR)", m => m.status !== "stopped");
		if (!session) return;
		const client = await api.ao.client();
		const claim = (allowTakeover: boolean) => client.claimPr(session, { pr: text.trim(), ...(allowTakeover && { allowTakeover: true }) });
		try {
			await claim(false);
		} catch (err) {
			if (!(err instanceof AoError && err.status === 409)) throw err;
			const go = await vscode.window.showWarningMessage(plain(`${err.message}`), { modal: true, detail: "Take it over from the session that has it?" }, "Take Over");
			if (go !== "Take Over") return;
			await claim(true);
		}
		store.reload();
	});

	// A review comment's own menu: tell the session's agent about this one comment (AO's automatic feed carries all of them).
	reg("switchyard.pr.thread.sendToAgent", async arg => {
		// From the tree: the thread's node. From a comment's menu: the VS Code thread the registry was keyed with.
		const entry = isNode(arg) && arg.kind === "thread" ? { pr: arg.pr, thread: arg.thread } : arg && typeof arg === "object" ? threads.registry.get(arg) : undefined;
		if (!entry) return;
		const t = entry.thread;
		const client = await api.ao.client();
		await client.sendMessage(entry.pr.session, { text: `Review comment on #${entry.pr.number} (${entry.pr.url}) by ${t.reviewer} at ${t.file}${t.line ? `:${t.line}` : ""}${t.url ? ` ${t.url}` : ""}:\n\n${t.body ?? ""}\n\nPlease address it: make the change, or reply with why not.` });
		void vscode.window.showInformationMessage(plain(`Sent to ${api.sessions.get(entry.pr.session)?.title ?? entry.pr.session}.`));
	});
}
