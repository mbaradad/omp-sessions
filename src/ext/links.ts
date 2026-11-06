import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionMeta } from "../shared/protocol";
import { openFile } from "./diff";
import { resolveOmpPath } from "./sessions";

/** Commands that `command:` links in the chat may run (see openLink). */
const SAFE_LINK_COMMANDS: Record<string, true> = { "omp.login": true, "omp.doctor": true, "omp.installOmp": true, "omp.setOmpPath": true };

/** `<session>.jsonl` → `<session>/`: where omp keeps artifacts and the `local://` root. */
function artifactsDir(meta: SessionMeta | undefined): string | undefined {
	return meta?.ompSessionFile?.replace(/\.jsonl$/, "");
}

function lineFrom(fragment: string): number | undefined {
	const m = /^L?(\d+)/.exec(fragment);
	return m ? Number(m[1]) : undefined;
}

async function showText(text: string, language = "markdown"): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({ content: text, language });
	await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
}

function ompRead(url: string, cwd: string): Promise<string> {
	const omp = resolveOmpPath();
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	if (!omp) {
		reject(new Error("omp executable not found"));
		return promise;
	}
	execFile(omp, ["read", url], { cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
		if (err && !stdout) reject(new Error(stderr.trim() || err.message));
		else resolve(stdout);
	});
	return promise;
}

/**
 * Opens any link that appears in a session: web URLs in the browser, files (with `#L12` / `:12`)
 * in the editor, `artifact://`/`local://` from the session's artifact dir, and every other
 * omp internal URL (`skill://`, `omp://`, `agent://`, `mcp://`, …) through `omp read`.
 */
export async function openLink(url: string, meta: SessionMeta | undefined, chatColumn?: vscode.ViewColumn): Promise<void> {
	const cwd = meta?.cwd ?? os.homedir();
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
	if (!scheme || scheme.length === 1) {
		// bare path (or Windows drive letter)
		const [file, frag] = url.split("#");
		const m = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(file) ?? [];
		const abs = path.resolve(cwd, (m[1] ?? file).replace(/^~\//, `${os.homedir()}/`));
		await openFile(abs, m[2] ? Number(m[2]) : frag ? lineFrom(frag) : undefined, m[3] ? Number(m[3]) : undefined, chatColumn);
		return;
	}
	if (scheme === "http" || scheme === "https" || scheme === "mailto") {
		await vscode.env.openExternal(vscode.Uri.parse(url, true));
		return;
	}
	if (scheme === "file") {
		const uri = vscode.Uri.parse(url, true);
		await openFile(uri.fsPath, uri.fragment ? lineFrom(uri.fragment) : undefined, undefined, chatColumn);
		return;
	}
	if (scheme === "command") {
		// Only argument-less helper commands the host puts in its notices; never arbitrary
		// commands from model-written markdown.
		const id = url.slice("command:".length);
		if (SAFE_LINK_COMMANDS[id]) await vscode.commands.executeCommand(id);
		return;
	}
	const dir = artifactsDir(meta);
	const rest = url.slice(scheme.length + 3).split(/[?#]/)[0];
	if (scheme === "artifact" && dir) {
		const id = rest.split(/[/:]/)[0];
		const hit = fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f.startsWith(`${id}.`)) : undefined;
		if (hit) {
			await openFile(path.join(dir, hit), undefined, undefined, chatColumn);
			return;
		}
	}
	if (scheme === "local" && dir) {
		const file = path.join(dir, "local", decodeURIComponent(rest));
		if (fs.existsSync(file)) {
			await openFile(file, undefined, undefined, chatColumn);
			return;
		}
	}
	try {
		await showText(await ompRead(url, cwd));
	} catch (err) {
		void vscode.window.showWarningMessage(`Could not open ${url}: ${(err as Error).message}`);
	}
}
