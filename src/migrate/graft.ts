// Transcript graft: how `switchyard migrate` gives an AO omp Chat session the history of an older omp
// session on stock AO (GAPS.md G8). AO only ever loads the omp session it created itself (its stored
// provider id N), so the migration lets AO create N (a prompt-less spawn writes a header-only
// transcript), stops the agent, and replaces N's transcript with a copy of the old one. On resume AO
// runs ACP `session/load N`; omp finds the file by its header id from any cwd and replays the old
// turns, which AO imports into its conversation.
//
// The copy keeps every entry verbatim and changes only the `session` header: `id` (N), `cwd` (the AO
// workspace) and `parentSession` (the old id), as omp's own fork does. The old transcript and its
// artifacts are only read. Node-only.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { isArchivedTranscript, TRANSCRIPT_SUFFIX, transcriptArtifactsDir } from "../shared/omp-paths";
import { isRecord } from "../shared/transcript-files";

/** The fields of omp's `session` header entry the graft reads or writes (others are kept as they are). */
export interface TranscriptHeader {
	type: "session";
	id: string;
	cwd: string;
	timestamp?: string;
	parentSession?: string;
	[key: string]: unknown;
}

function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		const v: unknown = JSON.parse(line);
		return isRecord(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

function asHeader(entry: Record<string, unknown> | undefined): TranscriptHeader | undefined {
	return entry?.type === "session" && typeof entry.id === "string" && typeof entry.cwd === "string" ? (entry as TranscriptHeader) : undefined;
}

/** A transcript's text (`.jsonl`, or an `omp gc` archive `.jsonl.gz`). */
export function readTranscriptText(file: string): string {
	const raw = fs.readFileSync(file);
	return isArchivedTranscript(file) ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8");
}

/** The `session` header of a live transcript. omp writes a padded `title` line first, then the header. */
export function readTranscriptHeader(file: string): TranscriptHeader | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(64 * 1024);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		const lines = buf.subarray(0, n).toString("utf8").split("\n");
		// The last piece may be cut mid-line; the header is always among the first few lines.
		for (const line of lines.slice(0, Math.min(lines.length - 1, 4))) {
			const header = asHeader(parseLine(line));
			if (header) return header;
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** Entry types omp writes into a session before any user turn (`session/new` bootstrap). */
const BOOTSTRAP_TYPES: Record<string, true> = { title: true, session: true, model_change: true, thinking_level_change: true, service_tier_change: true, credential_pin: true, custom: true, title_change: true };

/** True while the transcript holds no conversation yet: only omp's bootstrap entries, no message. */
export function isFreshTranscript(file: string): boolean {
	for (const line of readTranscriptText(file).split("\n")) {
		if (!line.trim()) continue;
		const entry = parseLine(line);
		if (!entry || typeof entry.type !== "string" || !BOOTSTRAP_TYPES[entry.type]) return false;
	}
	return true;
}

/**
 * The transcripts directly under `sessionsDir/<slug>/` (and flat in `sessionsDir`) whose header cwd is
 * `cwd`, modified at or after `sinceMs`. Used to find the transcript AO's spawn made for a workspace.
 */
export function transcriptsForCwd(sessionsDir: string, cwd: string, sinceMs = 0): string[] {
	const want = path.resolve(cwd);
	const out: string[] = [];
	const consider = (file: string): void => {
		if (!file.endsWith(TRANSCRIPT_SUFFIX)) return;
		try {
			if (fs.statSync(file).mtimeMs < sinceMs) return;
		} catch {
			return;
		}
		const header = readTranscriptHeader(file);
		if (header && path.resolve(header.cwd) === want) out.push(file);
	};
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = path.join(sessionsDir, e.name);
		if (e.isFile()) consider(p);
		else if (e.isDirectory()) {
			let files: string[];
			try {
				files = fs.readdirSync(p);
			} catch {
				continue;
			}
			for (const f of files) consider(path.join(p, f));
		}
	}
	return out.sort();
}

export interface GraftOptions {
	/** The old transcript (`.jsonl` or `omp gc` archive), read only. */
	source: string;
	/** The fresh transcript AO's spawn made; overwritten. */
	target: string;
	/**
	 * Append a model switch so `session/load` restores this model instead of the transcript's last one
	 * (omp refuses to load a session whose model it cannot restore, e.g. without credentials).
	 */
	model?: string;
	now?: Date;
}

export interface GraftResult {
	/** The old omp session id (`parentSession` of the copy). */
	sourceId: string;
	/** The id the copy now carries: AO's provider id N. */
	targetId: string;
	entries: number;
	artifactsCopied: boolean;
}

/**
 * Replaces `target` (a fresh transcript) with `source`'s entries under `target`'s identity. Refuses a
 * target that already holds a conversation, so it never overwrites real work. Repeating it on a target
 * grafted from the same source that has not been continued since (an interrupted run) is allowed.
 */
export function graftTranscript(opts: GraftOptions): GraftResult {
	const targetHeader = readTranscriptHeader(opts.target);
	if (!targetHeader) throw new Error(`${opts.target}: no omp session header`);
	const lines = readTranscriptText(opts.source).split("\n");
	let sourceHeader: TranscriptHeader | undefined;
	for (const line of lines.slice(0, 4)) {
		sourceHeader = asHeader(parseLine(line));
		if (sourceHeader) break;
	}
	if (!sourceHeader) throw new Error(`${opts.source}: no omp session header`);
	const countEntries = (text: string) => text.split("\n").filter(l => l.trim()).length;
	// A finished graft holds the source's entries plus at most the model switch; more means new turns.
	const regraft = targetHeader.parentSession === sourceHeader.id && countEntries(readTranscriptText(opts.target)) <= countEntries(lines.join("\n")) + 1;
	if (!regraft && !isFreshTranscript(opts.target)) throw new Error(`${opts.target} already holds a conversation; not overwriting it`);

	const out: string[] = [];
	let last: Record<string, unknown> | undefined;
	for (const line of lines) {
		if (!line.trim()) continue;
		const entry = parseLine(line);
		if (asHeader(entry)) {
			const header: TranscriptHeader = { ...(entry as TranscriptHeader), id: targetHeader.id, cwd: targetHeader.cwd, parentSession: sourceHeader.id };
			if (targetHeader.timestamp) header.timestamp = targetHeader.timestamp;
			out.push(JSON.stringify(header));
			continue;
		}
		out.push(line);
		if (entry && typeof entry.id === "string") last = entry;
	}
	if (opts.model) {
		// omp's entry ids are 8 hex characters. The new entry continues the active branch: a late-usage
		// marker points at the leaf it belongs to.
		const leaf = last ? (typeof last.activeLeafId === "string" || last.activeLeafId === null ? last.activeLeafId : last.id) : null;
		out.push(JSON.stringify({ type: "model_change", id: randomBytes(4).toString("hex"), parentId: leaf, timestamp: (opts.now ?? new Date()).toISOString(), model: opts.model }));
	}
	const tmp = `${opts.target}.${process.pid}.migrate.tmp`;
	try {
		fs.writeFileSync(tmp, `${out.join("\n")}\n`, { mode: 0o644 });
		fs.renameSync(tmp, opts.target);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
	const fromArtifacts = transcriptArtifactsDir(opts.source);
	let artifactsCopied = false;
	if (fs.existsSync(fromArtifacts) && fs.statSync(fromArtifacts).isDirectory()) {
		fs.cpSync(fromArtifacts, transcriptArtifactsDir(opts.target), { recursive: true, force: false, errorOnExist: false });
		artifactsCopied = true;
	}
	return { sourceId: sourceHeader.id, targetId: targetHeader.id, entries: out.length - 1, artifactsCopied };
}
