// Pull requests of AO sessions: AO's facts and details mapped to the shape every client shows
// (src/shared/pr-review.ts), and a PR's files, commits and file revisions. Merging, AO's reviewer and claiming a
// PR are AO's own calls (AoClient.mergePr, triggerReview, claimPr): clients call those directly.
import type { AoClient, AoSchemas } from "./client";
import type { PrCommit, PrDetail, PrFacts, PrFile, PrThread } from "../shared/pr-review";

type SessionPRFacts = AoSchemas["SessionPRFacts"];
type SessionPRSummary = AoSchemas["SessionPRSummary"];
type FileSummary = AoSchemas["WorkspaceFileSummary"];

/** The facts of a session view's `prs`. */
export function prFactsOf(f: SessionPRFacts): PrFacts {
	return { number: f.number, url: f.url, state: f.state, ci: f.ci, review: f.review, mergeability: f.mergeability, reviewComments: f.reviewComments, updatedAt: f.updatedAt };
}

function threadsOf(summary: SessionPRSummary): PrThread[] {
	const out: PrThread[] = [];
	for (const reviewer of summary.review.unresolvedBy) {
		for (const link of reviewer.links) {
			out.push({
				reviewer: reviewer.reviewerId,
				...(reviewer.isBot && { isBot: true }),
				...(link.file && { file: link.file }),
				...(link.line !== undefined && { line: link.line }),
				...(link.body && { body: link.body }),
				...((link.url ?? reviewer.reviewUrl) && { url: link.url ?? reviewer.reviewUrl }),
			});
		}
	}
	return out;
}

/** A PR as AO describes it in full. `session` owns it. */
export function prDetailOf(session: string, s: SessionPRSummary): PrDetail {
	return {
		session,
		number: s.number,
		url: s.url,
		title: s.title,
		repo: s.repo,
		provider: s.provider,
		state: s.state,
		ci: s.ci.state,
		review: s.review.decision,
		mergeability: s.mergeability.state,
		reviewComments: s.review.hasUnresolvedHumanComments || (s.review.unresolvedThreadCount ?? 0) > 0 || s.review.unresolvedBy.some(r => r.count > 0),
		updatedAt: s.updatedAt,
		sourceBranch: s.sourceBranch,
		targetBranch: s.targetBranch,
		author: s.author,
		additions: s.additions,
		deletions: s.deletions,
		changedFiles: s.changedFiles,
		headSha: s.headSha,
		failingChecks: s.ci.failingChecks.map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion, ...(c.url && { url: c.url }) })),
		unresolvedThreads: s.review.unresolvedThreadCount ?? s.review.unresolvedBy.reduce((n, r) => n + r.count, 0),
		threads: threadsOf(s),
		mergeReasons: s.mergeability.reasons,
		conflictFiles: (s.mergeability.conflictFiles ?? []).map(f => f.path),
	};
}

/** The PRs a session owns, newest first. */
export async function sessionPrDetails(client: AoClient, sessionId: string): Promise<PrDetail[]> {
	const { prs } = await client.sessionPrs(sessionId);
	return prs.map(p => prDetailOf(sessionId, p)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

const fileOf = (f: FileSummary): PrFile => ({ path: f.path, ...(f.previousPath && { previousPath: f.previousPath }), status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary });

export interface PrFiles {
	files: PrFile[];
	commits: PrCommit[];
	/** AO cut the list (a very large PR): not every file or commit is here. */
	truncated: boolean;
	additions: number;
	deletions: number;
}

/** A PR's files (base to head) and commits. */
export async function prFiles(client: AoClient, sessionId: string, pr: Pick<PrFacts, "number" | "url">): Promise<PrFiles> {
	const res = await client.sessionPrFiles(sessionId, pr.number, pr.url);
	return {
		files: res.files.map(fileOf),
		commits: res.commits.map(c => ({ sha: c.sha, subject: c.subject, author: c.author, timestamp: c.timestamp, files: c.files.map(fileOf) })),
		truncated: res.truncated || !!res.commitsTruncated,
		additions: res.summary.additions,
		deletions: res.summary.deletions,
	};
}

export interface PrRevisionText {
	text: string;
	/** The file does not exist on this side (added file's `before`, deleted file's `after`). */
	exists: boolean;
	binary: boolean;
	truncated: boolean;
}

/** The text of one side of one PR file. */
export async function prRevisionText(client: AoClient, sessionId: string, pr: Pick<PrFacts, "number" | "url">, side: "before" | "after", path: string, commit?: string): Promise<PrRevisionText> {
	const res = await client.sessionPrFileRevision(sessionId, pr.number, { path, side, sourceUrl: pr.url, ...(commit && { commitSha: commit }) });
	if (!res.exists) return { text: "", exists: false, binary: false, truncated: false };
	if (res.binary) return { text: `(binary file${res.mediaType ? `, ${res.mediaType}` : ""}, ${res.size} bytes)`, exists: true, binary: true, truncated: false };
	const text = res.encoding === "base64" ? Buffer.from(res.content, "base64").toString("utf8") : res.content;
	return { text, exists: true, binary: false, truncated: res.truncated };
}
