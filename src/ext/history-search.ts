// `omp.searchHistory`: live full-text search over the user/assistant text of omp transcripts
// (VS Code sessions and terminal sessions), scoped to the current workspace by default.

import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import * as vscode from "vscode";
import { isArchivedTranscript, locateTranscript } from "../shared/omp-paths";
import type { SessionMeta } from "../shared/protocol";
import { type TranscriptHead, TranscriptCache, listTranscripts, readTranscriptHead } from "../shared/transcript-files";
import type { OmpApi } from "./api";
import { plain } from "./plain";
import { configuredOmpPaths } from "./sessions";
import { type MessageText, type TranscriptHit, parseQuery, parseTextLine, searchMessages } from "./transcripts";

/** Extracted chat text per transcript, kept for the window's lifetime (only user/assistant text, not tool output). */
const textCache = new TranscriptCache<MessageText[]>(
	() => [],
	(acc, line) => {
		const m = parseTextLine(line);
		if (m) acc.push(m);
	},
);

interface Candidate {
	file: string;
	mtimeMs: number;
	head: TranscriptHead;
	meta?: SessionMeta;
}

interface HitItem extends vscode.QuickPickItem {
	candidate: Candidate;
}

const MAX_RESULTS = 100;
const DEBOUNCE_MS = 250;

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function workspaceFolders(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === "file").map(f => f.uri.fsPath);
}

/** Top-level transcripts in scope, newest first; VS Code sessions are matched to theirs. */
async function candidates(api: OmpApi, all: boolean): Promise<Candidate[]> {
	const byFile = new Map<string, SessionMeta>();
	for (const m of api.sessions.all()) {
		const file = m.ompSessionFile && locateTranscript(m.ompSessionFile);
		if (file) byFile.set(path.resolve(file), m);
	}
	const files = await listTranscripts(configuredOmpPaths());
	const listed = new Set(files.map(f => path.resolve(f.file)));
	for (const [file] of byFile) {
		if (listed.has(file)) continue;
		try {
			files.push({ file, mtimeMs: (await fs.promises.stat(file)).mtimeMs, archived: isArchivedTranscript(file) });
		} catch {
			/* transcript gone */
		}
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const folders = workspaceFolders();
	const out: Candidate[] = [];
	for (const { file, mtimeMs } of files) {
		const head = readTranscriptHead(file);
		if (!head || head.parentSession) continue;
		const meta = byFile.get(path.resolve(file));
		const cwd = meta?.cwd ?? head.cwd;
		if (!all && !folders.some(f => cwd && (isWithin(cwd, f) || isWithin(f, cwd)))) continue;
		out.push({ file, mtimeMs, head, meta });
	}
	return out;
}

function titleOf(c: Candidate): string {
	return c.meta?.title || c.head.title || textCache.peek(c.file)?.data.find(m => m.role === "user")?.text.slice(0, 80) || path.basename(c.file, ".jsonl");
}

function item(c: Candidate, hit?: TranscriptHit): HitItem {
	const icon = c.meta ? (c.meta.status === "stopped" ? "$(circle-outline)" : "$(comment-discussion)") : "$(terminal)";
	const when = new Date(hit?.message.ts || c.mtimeMs).toLocaleString();
	const where = path.basename(c.meta?.cwd ?? c.head.cwd) || "?";
	const count = hit && hit.count > 1 ? ` · ${hit.count} matches` : "";
	return {
		label: `${icon} ${titleOf(c)}`,
		description: `${when} · ${where}${c.meta ? "" : " · terminal"}${count}`,
		detail: hit ? `${hit.message.role === "user" ? "You" : "omp"}: ${hit.snippet}` : undefined,
		alwaysShow: true,
		candidate: c,
	};
}

export async function searchHistory(api: OmpApi): Promise<void> {
	const qp = vscode.window.createQuickPick<HitItem>();
	const hasWorkspace = workspaceFolders().length > 0;
	let all = !hasWorkspace;
	let pool: Promise<Candidate[]> | undefined;
	let generation = 0;
	let debounce: NodeJS.Timeout | undefined;

	const scopeButton = (): vscode.QuickInputButton =>
		all ? { iconPath: new vscode.ThemeIcon("root-folder"), tooltip: "Search this workspace only" } : { iconPath: new vscode.ThemeIcon("globe"), tooltip: "Search all omp sessions" };
	const decorate = () => {
		qp.placeholder = `Search omp transcripts — ${all ? "all sessions" : "this workspace"} (words must all occur; "quote phrases")`;
		qp.buttons = hasWorkspace ? [scopeButton()] : [];
	};

	const run = async (query: string) => {
		const gen = ++generation;
		qp.busy = true;
		try {
			pool ??= candidates(api, all);
			const list = await pool;
			if (gen !== generation) return;
			const terms = parseQuery(query);
			if (terms.length === 0 || query.trim().length < 2) {
				qp.items = list.slice(0, MAX_RESULTS).map(c => item(c));
				qp.title = list.length ? `${list.length} session${list.length === 1 ? "" : "s"}` : "No omp transcripts in scope";
				return;
			}
			const found: HitItem[] = [];
			let shownAt = Date.now();
			let scanned = 0;
			for (const c of list) {
				const e = await textCache.get(c.file);
				await yieldToLoop();
				if (gen !== generation) return;
				scanned++;
				const hit = e && searchMessages(e.data, terms);
				if (hit) found.push(item(c, hit));
				if (found.length >= MAX_RESULTS) break;
				if (Date.now() - shownAt > 300) {
					shownAt = Date.now();
					qp.items = found.slice();
					qp.title = `Searching… ${scanned}/${list.length}`;
				}
			}
			qp.items = found;
			qp.title = found.length ? `${found.length}${found.length >= MAX_RESULTS ? "+" : ""} matching session${found.length === 1 ? "" : "s"}` : `No matches in ${list.length} session${list.length === 1 ? "" : "s"}`;
		} catch (err) {
			if (gen === generation) qp.title = `Search failed: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			if (gen === generation) qp.busy = false;
		}
	};

	const accepted = Promise.withResolvers<Candidate | undefined>();
	qp.onDidChangeValue(v => {
		clearTimeout(debounce);
		generation++; // cancel the running search right away
		debounce = setTimeout(() => void run(v), DEBOUNCE_MS);
	});
	qp.onDidTriggerButton(() => {
		all = !all;
		pool = undefined;
		decorate();
		void run(qp.value);
	});
	qp.onDidAccept(() => {
		accepted.resolve(qp.selectedItems[0]?.candidate);
		qp.hide();
	});
	qp.onDidHide(() => {
		generation++;
		clearTimeout(debounce);
		accepted.resolve(undefined);
		qp.dispose();
	});
	decorate();
	qp.show();
	void run("");

	const pick = await accepted.promise;
	if (pick) await openCandidate(api, pick);
}

async function openCandidate(api: OmpApi, c: Candidate): Promise<void> {
	const meta = c.meta ? api.sessions.get(c.meta.id) : undefined;
	if (meta) {
		if (meta.status !== "stopped") {
			api.openPanel(meta.id);
			return;
		}
		const choice = await vscode.window.showInformationMessage(`"${meta.title}" is stopped.`, { modal: true, detail: "Resume it to continue the conversation, or just read the transcript." }, "Resume", "View Transcript");
		if (choice === "Resume") await vscode.commands.executeCommand("omp.resumeSession", meta.id);
		else if (choice === "View Transcript") api.openPanel(meta.id);
		return;
	}
	const cwd = c.head.cwd;
	const choice = await vscode.window.showInformationMessage(
		`"${titleOf(c)}" was not started by omp Sessions.`,
		{ modal: true, detail: cwd ? `Folder: ${cwd}` : "The transcript does not record its folder." },
		...(cwd ? ["Resume in Background"] : []),
		...(isArchivedTranscript(c.file) ? [] : ["Open Transcript File"]),
	);
	if (choice === "Resume in Background" && cwd) {
		if (!fs.existsSync(cwd)) {
			void vscode.window.showErrorMessage(plain(`The folder of this session no longer exists: ${cwd}`));
			return;
		}
		await api.launchAndOpen({ cwd, resumeFile: c.file, title: titleOf(c).slice(0, 80) });
	} else if (choice === "Open Transcript File") await vscode.window.showTextDocument(vscode.Uri.file(c.file), { preview: true });
}
