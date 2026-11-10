// Pull requests of AO sessions as the clients show them. AO owns everything about a PR (its SCM polling, CI and
// review state, merge, its reviewer, feeding CI failures and review comments back to the agent); this file is
// only the shape the VS Code extension, the CLI and the Hermes page share, and the words they print. No `vscode`
// and no AO imports.

export type PrState = "draft" | "open" | "merged" | "closed";
export type PrCi = "unknown" | "pending" | "passing" | "failing";
export type PrReview = "none" | "approved" | "changes_requested" | "review_required";
export type PrMergeability = "unknown" | "mergeable" | "conflicting" | "blocked" | "unstable";

/** What AO's session view says about one pull request (`prs` of a session). */
export interface PrFacts {
	number: number;
	url: string;
	state: PrState;
	ci: PrCi;
	review: PrReview;
	mergeability: PrMergeability;
	/** The PR has review comments that still need an answer. */
	reviewComments: boolean;
	updatedAt: string;
}

export interface PrFailingCheck {
	name: string;
	status: "failed" | "cancelled";
	conclusion: string;
	url?: string;
}

/** One unresolved review comment, where AO knows its place. */
export interface PrThread {
	reviewer: string;
	isBot?: boolean;
	file?: string;
	line?: number;
	body?: string;
	url?: string;
}

export type PrFileStatus = "unmodified" | "modified" | "added" | "deleted" | "renamed";

export interface PrFile {
	path: string;
	previousPath?: string;
	status: PrFileStatus;
	additions: number;
	deletions: number;
	binary: boolean;
}

export interface PrCommit {
	sha: string;
	subject: string;
	author: string;
	timestamp: string;
	files: PrFile[];
}

/** A pull request in full, as AO's session PR list describes it. */
export interface PrDetail extends PrFacts {
	session: string;
	title: string;
	repo: string;
	provider: "github" | "gitlab";
	sourceBranch: string;
	targetBranch: string;
	author: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	headSha: string;
	failingChecks: PrFailingCheck[];
	/** Unresolved review threads AO counted (a thread may have no `threads` entry when AO knows no place for it). */
	unresolvedThreads: number;
	threads: PrThread[];
	/** Why AO says the PR can't merge yet. */
	mergeReasons: string[];
	conflictFiles: string[];
}

/** Why an open PR needs someone (failing CI, requested changes, merge conflicts); empty for one that doesn't, and for a finished one. */
export function prAttentionReasons(f: PrFacts): string[] {
	if (f.state !== "open" && f.state !== "draft") return [];
	return [f.ci === "failing" ? "CI failing" : "", f.review === "changes_requested" ? "changes requested" : "", f.mergeability === "conflicting" ? "conflicts" : ""].filter(Boolean);
}

export const prNeedsAttention = (f: PrFacts): boolean => prAttentionReasons(f).length > 0;

const PR_CI_LABEL: Readonly<Record<PrCi, string>> = { unknown: "CI unknown", pending: "CI running", passing: "CI passing", failing: "CI failing" };
const PR_REVIEW_LABEL: Readonly<Record<PrReview, string>> = { none: "no review", approved: "approved", changes_requested: "changes requested", review_required: "review required" };
const PR_MERGE_LABEL: Readonly<Record<PrMergeability, string>> = { unknown: "merge status unknown", mergeable: "mergeable", conflicting: "conflicts", blocked: "merge blocked", unstable: "merge unstable" };

/** `#12 open · CI passing · approved · mergeable`: the parts that say something; nothing but the state for a finished PR. */
export function prSummaryLine(f: PrFacts, extra: { unresolvedThreads?: number } = {}): string {
	const parts: string[] = [f.state];
	if (f.state === "open" || f.state === "draft") {
		if (f.ci !== "unknown") parts.push(PR_CI_LABEL[f.ci]);
		if (f.review !== "none") parts.push(PR_REVIEW_LABEL[f.review]);
		if (extra.unresolvedThreads) parts.push(`${extra.unresolvedThreads} unresolved`);
		else if (f.reviewComments) parts.push("unresolved comments");
		if (f.mergeability !== "unknown") parts.push(PR_MERGE_LABEL[f.mergeability]);
	}
	return `#${f.number} ${parts.join(" · ")}`;
}

/** `+12 −3`. */
export function lineCounts(additions: number, deletions: number): string {
	return `+${additions} −${deletions}`;
}

// ---------- the revision documents (a PR's files at its base and head) ----------

export const PR_SCHEME = "switchyard-pr";

export interface PrRevisionRef {
	session: string;
	number: number;
	/** The PR's stable URL, for PRs that share a number across repositories. */
	url?: string;
	side: "before" | "after";
	/** Repository-relative path (the side's own path: a renamed file's `before` has its previous one). */
	path: string;
	/** Read one commit's change instead of the whole PR. */
	commit?: string;
	/** The PR's head the document was made for: a new head makes a different document. */
	head?: string;
}

/** The URI parts of a revision document: `switchyard-pr://<session>/<path>?n=&u=&s=&c=&h=`. */
export function prRevisionParts(ref: PrRevisionRef): { scheme: string; authority: string; path: string; query: string } {
	const q = new URLSearchParams({ n: String(ref.number), s: ref.side });
	if (ref.url) q.set("u", ref.url);
	if (ref.commit) q.set("c", ref.commit);
	if (ref.head) q.set("h", ref.head);
	return { scheme: PR_SCHEME, authority: ref.session, path: `/${ref.path.replace(/^\/+/, "")}`, query: q.toString() };
}

/** The revision a document URI names; undefined for a URI that is not one of ours. */
export function parsePrRevision(uri: { scheme: string; authority: string; path: string; query: string }): PrRevisionRef | undefined {
	if (uri.scheme !== PR_SCHEME || !uri.authority) return undefined;
	const q = new URLSearchParams(uri.query);
	const number = Number(q.get("n"));
	const side = q.get("s");
	if (!Number.isInteger(number) || number <= 0 || (side !== "before" && side !== "after")) return undefined;
	const path = uri.path.replace(/^\/+/, "");
	if (!path) return undefined;
	const url = q.get("u");
	const commit = q.get("c");
	const head = q.get("h");
	return { session: uri.authority, number, side, path, ...(url && { url }), ...(commit && { commit }), ...(head && { head }) };
}
