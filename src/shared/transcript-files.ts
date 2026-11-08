// Reading omp transcript files without loading them whole, live (`*.jsonl`) or archived by
// `omp gc` (`*.jsonl.gz`, see omp-paths.ts). Node-only.
//
// Transcript facts (omp 18.x): line 1 is a `title` record rewritten in place (padded to keep its size),
// line 2 the `session` header (`cwd`, `id`, `parentSession` for subagents). Subagent transcripts live
// in `<transcript without .jsonl>/<Agent>.jsonl` (possibly nested deeper). Apart from the title line,
// live transcripts are append-only, so caches parse only the new tail.

import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { type OmpPaths, type TranscriptRoot, ARCHIVED_SUFFIX, TRANSCRIPT_SUFFIX, isArchivedTranscript, locateTranscript, ompPaths, transcriptArtifactsDir, transcriptRoots } from "./omp-paths";

const gunzip = promisify(zlib.gunzip);

/** The transcript readers' one JSON-object guard. */
export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One transcript line as a JSON object; undefined for torn or non-object lines. */
export function parseTranscriptLine(line: string): Record<string, unknown> | undefined {
	try {
		const o: unknown = JSON.parse(line);
		return isRecord(o) ? o : undefined;
	} catch {
		return undefined;
	}
}

export interface TranscriptHead {
	title: string;
	cwd: string;
	/** omp session id. */
	id: string;
	/** Set on subagent transcripts. */
	parentSession: string;
}

/** Title/session records from the first lines of a transcript. */
export function parseHead(text: string): TranscriptHead {
	const head: TranscriptHead = { title: "", cwd: "", id: "", parentSession: "" };
	for (const line of text.split("\n").slice(0, 4)) {
		const o = parseTranscriptLine(line);
		if (o?.type === "title" && typeof o.title === "string") head.title = o.title;
		else if (o?.type === "session") {
			head.cwd = typeof o.cwd === "string" ? o.cwd : "";
			head.id = typeof o.id === "string" ? o.id : "";
			head.parentSession = typeof o.parentSession === "string" ? o.parentSession : "";
			if (!head.title && typeof o.title === "string") head.title = o.title;
		}
	}
	return head;
}

/** About the first `bytes` bytes of a transcript as text (decompressed for archived ones); throws when unreadable. */
export function readTranscriptStart(file: string, bytes: number): string {
	const fd = fs.openSync(file, "r");
	let raw: Buffer;
	try {
		const buf = Buffer.alloc(bytes);
		raw = buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0));
	} finally {
		fs.closeSync(fd);
	}
	if (!isArchivedTranscript(file)) return raw.toString("utf8");
	// A truncated gzip stream decompresses up to where it was cut with a sync flush.
	return zlib.gunzipSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).subarray(0, bytes).toString("utf8");
}

/** Head of a transcript file (8 KiB read); undefined when unreadable. */
export function readTranscriptHead(file: string): TranscriptHead | undefined {
	try {
		return parseHead(readTranscriptStart(file, 8192));
	} catch {
		return undefined;
	}
}

/** Whole text of a session's transcript: `file`, else its `omp gc` archive gunzipped; "" when neither is readable. */
export function readTranscriptText(file: string): string {
	const found = locateTranscript(file);
	if (!found) return "";
	try {
		const raw = fs.readFileSync(found);
		return (isArchivedTranscript(found) ? zlib.gunzipSync(raw) : raw).toString("utf8");
	} catch {
		return "";
	}
}

/** Lines longer than this are skipped (huge tool results; never usage or chat text worth indexing). */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

/**
 * Streams complete lines of `file` from byte `start`; returns the offset just past the last complete
 * line, so a later call continues where this one stopped (a torn last line is re-read then).
 * Archived (`.jsonl.gz`) transcripts are read whole; offsets then count decompressed bytes.
 */
export async function scanLines(file: string, start: number, onLine: (line: string) => void): Promise<number> {
	if (isArchivedTranscript(file)) {
		const text = (await gunzip(await fs.promises.readFile(file))).subarray(start);
		let end = start;
		let from = 0;
		for (;;) {
			const nl = text.indexOf(10, from);
			if (nl < 0) break;
			if (nl - from <= MAX_LINE_BYTES) {
				const line = text.subarray(from, nl).toString("utf8");
				if (line) onLine(line);
			}
			from = nl + 1;
			end = start + from;
		}
		return end;
	}
	const fh = await fs.promises.open(file, "r");
	try {
		const buf = Buffer.alloc(CHUNK_BYTES);
		let pos = start;
		let lineStart = start;
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		let skipping = false;
		for (;;) {
			const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, pos);
			if (bytesRead === 0) break;
			let from = 0;
			for (;;) {
				const nl = buf.indexOf(10, from);
				if (nl < 0 || nl >= bytesRead) break;
				if (!skipping) {
					const piece = buf.subarray(from, nl);
					const line = pending.length ? Buffer.concat([...pending, piece]).toString("utf8") : piece.toString("utf8");
					if (line) onLine(line);
				}
				pending = [];
				pendingBytes = 0;
				skipping = false;
				from = nl + 1;
				lineStart = pos + from;
			}
			if (from < bytesRead && !skipping) {
				pendingBytes += bytesRead - from;
				if (pendingBytes > MAX_LINE_BYTES) {
					skipping = true;
					pending = [];
				} else pending.push(Buffer.from(buf.subarray(from, bytesRead)));
			}
			pos += bytesRead;
		}
		return lineStart;
	} finally {
		await fh.close();
	}
}

export interface CachedTranscript<T> {
	file: string;
	head: TranscriptHead;
	size: number;
	mtimeMs: number;
	data: T;
}

interface Entry<T> extends CachedTranscript<T> {
	offset: number;
}

/**
 * Per-file parse cache: unchanged files (size + mtime) cost one stat; grown files parse only the
 * appended lines; shrunk (and changed archived) files are parsed again from scratch.
 */
export class TranscriptCache<T> {
	private readonly entries = new Map<string, Entry<T>>();
	private readonly inFlight = new Map<string, Promise<CachedTranscript<T> | undefined>>();

	constructor(
		private readonly init: () => T,
		private readonly onLine: (data: T, line: string) => void,
	) {}

	get(file: string): Promise<CachedTranscript<T> | undefined> {
		let p = this.inFlight.get(file);
		if (!p) {
			p = this.load(file).finally(() => this.inFlight.delete(file));
			this.inFlight.set(file, p);
		}
		return p;
	}

	/** Last parsed state without touching the disk. */
	peek(file: string): CachedTranscript<T> | undefined {
		return this.entries.get(file);
	}

	private async load(file: string): Promise<CachedTranscript<T> | undefined> {
		let st: fs.Stats;
		try {
			st = await fs.promises.stat(file);
		} catch {
			this.entries.delete(file);
			return undefined;
		}
		let e = this.entries.get(file);
		if (e && e.size === st.size && e.mtimeMs === st.mtimeMs) return e;
		try {
			const head = parseHead(readTranscriptStart(file, 8192));
			if (!e || st.size < e.offset || isArchivedTranscript(file)) e = { file, head, size: 0, mtimeMs: 0, offset: 0, data: this.init() };
			const entry = e;
			entry.offset = await scanLines(file, entry.offset, line => this.onLine(entry.data, line));
			entry.head = head;
			entry.size = st.size;
			entry.mtimeMs = st.mtimeMs;
			this.entries.set(file, entry);
			return entry;
		} catch {
			return e;
		}
	}
}

export interface TranscriptFile {
	file: string;
	mtimeMs: number;
	/** Gzipped by `omp gc` (see omp-paths.ts). */
	archived: boolean;
}

async function listRoot(root: TranscriptRoot, out: TranscriptFile[]): Promise<void> {
	const suffix = root.archived ? ARCHIVED_SUFFIX : TRANSCRIPT_SUFFIX;
	let dirs: string[];
	try {
		dirs = root.flat ? [root.dir] : (await fs.promises.readdir(root.dir)).map(d => path.join(root.dir, d));
	} catch {
		return;
	}
	for (const dir of dirs) {
		let names: string[];
		try {
			names = await fs.promises.readdir(dir);
		} catch {
			continue;
		}
		for (const n of names) {
			if (!n.endsWith(suffix)) continue;
			const file = path.join(dir, n);
			try {
				const st = await fs.promises.stat(file);
				if (st.isFile()) out.push({ file, mtimeMs: st.mtimeMs, archived: root.archived });
			} catch {
				/* vanished */
			}
		}
	}
}

/** Top-level transcripts (not subagents) of omp's session folders and gc archive, newest first. */
export async function listTranscripts(paths: OmpPaths = ompPaths()): Promise<TranscriptFile[]> {
	const out: TranscriptFile[] = [];
	for (const root of transcriptRoots(paths)) await listRoot(root, out);
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Subagent transcripts of `file`: every `.jsonl` below its artifact folder, a few levels deep. */
export async function listSubagentTranscripts(file: string, maxDepth = 4): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isFile() && (e.name.endsWith(TRANSCRIPT_SUFFIX) || e.name.endsWith(ARCHIVED_SUFFIX))) out.push(full);
			else if (e.isDirectory() && depth < maxDepth) await walk(full, depth + 1);
		}
	};
	const dir = transcriptArtifactsDir(file);
	if (dir !== file) await walk(dir, 1);
	return out;
}
