import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { OPEN_REQUEST_TTL_MS, type VscodeWindow, checkoutRoot, clearOpenRequest, folderProblem, isSessionId, readWindow, readWindows, recordWindow, requestOpen, takeOpenRequest, uriPath, vscodeFolderLink, vscodeLink } from "../../src/shared/vscode-open";

// stateRoot() reads OMP_VSCODE_HOME on every call.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vscode-open-"));
process.env.OMP_VSCODE_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const win = (w: Partial<VscodeWindow>): VscodeWindow => ({ id: "w", authority: "", scheme: "vscode", at: 1, folders: [], ...w });

test("links: a remote window gets a folder over its authority; a local one (or none) the extension's handler", () => {
	const s = { id: "mw6aaja98f08a3", cwd: "/home/me/projects/my app" };
	assert.equal(vscodeLink(s, win({ authority: "ssh-remote+ws" })), "vscode://vscode-remote/ssh-remote+ws/home/me/projects/my%20app");
	assert.equal(vscodeLink(s, win({ scheme: "vscode-insiders" })), "vscode-insiders://mbaradad.omp-sessions/open?session=mw6aaja98f08a3");
	assert.equal(vscodeLink(s, undefined), "vscode://mbaradad.omp-sessions/open?session=mw6aaja98f08a3");
	// The window's own folder (or its .code-workspace) when it holds the session: that focuses the window.
	assert.equal(vscodeLink({ id: "x", cwd: "/home/me/projects/my app/sub" }, win({ authority: "ssh-remote+ws", folders: ["/home/me/projects"] })), "vscode://vscode-remote/ssh-remote+ws/home/me/projects");
	assert.equal(vscodeLink({ id: "x", cwd: "/home/me/projects/a" }, win({ authority: "ssh-remote+ws", folders: ["/home/me/projects"], workspace: "/home/me/all.code-workspace" })), "vscode://vscode-remote/ssh-remote+ws/home/me/all.code-workspace");
});

test("uriPath: POSIX, drive letters and UNC paths", () => {
	assert.equal(uriPath("/a b/c#d"), "/a%20b/c%23d");
	assert.equal(uriPath("C:\\src\\a#b"), "/C:/src/a%23b");
	assert.equal(uriPath("\\\\server\\share\\my dir"), "//server/share/my%20dir");
});

test("checkoutRoot: the nearest folder with .git (a checkout or a linked worktree), else the folder", () => {
	const repo = fs.mkdtempSync(path.join(home, "repo-"));
	fs.mkdirSync(path.join(repo, ".git"));
	fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
	const wt = path.join(repo, "wt");
	fs.mkdirSync(path.join(wt, "pkg"), { recursive: true });
	fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../.git/worktrees/wt\n");
	assert.equal(checkoutRoot(path.join(repo, "src", "deep"), "/"), repo);
	assert.equal(checkoutRoot(path.join(wt, "pkg"), "/"), wt);
	const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vscode-plain-"));
	assert.equal(checkoutRoot(plainDir, os.tmpdir()), plainDir);
	fs.rmSync(plainDir, { recursive: true, force: true });
});

test("window records: one per window; the caller's authority, then the window holding the folder, then the last used", () => {
	fs.rmSync(path.join(home, "vscode-window.json"), { force: true });
	assert.equal(readWindow({}, {}), undefined);
	// The single record 0.5 extensions wrote still reads.
	fs.writeFileSync(path.join(home, "vscode-window.json"), JSON.stringify({ authority: "ssh-remote+old", scheme: "javascript:alert(1)//", at: 5 }));
	assert.deepEqual(readWindow({}, {}), win({ id: "", authority: "ssh-remote+old", at: 5 }));

	recordWindow({ id: "laptop", authority: "ssh-remote+ws", scheme: "vscode", folders: ["/srv/a"] }, 1000);
	recordWindow({ id: "desktop", authority: "ssh-remote+box", scheme: "vscode", folders: ["/srv/b"] }, 2000);
	recordWindow({ id: "local", authority: "", scheme: "vscode", folders: ["relative/ignored", "/srv/c"] }, 3000);
	assert.deepEqual(readWindows().map(w => w.id), ["local", "desktop", "laptop"], "newest first; the old record is dropped");
	assert.deepEqual(readWindows()[0].folders, ["/srv/c"]);

	assert.equal(readWindow({}, {})?.id, "local", "last used");
	assert.equal(readWindow({ cwd: "/srv/a/x" }, {})?.id, "laptop", "the window holding the session's folder");
	assert.equal(readWindow({ cwd: "/srv/a/x", authority: "ssh-remote+box" }, {})?.id, "desktop", "the caller's authority wins");
	assert.equal(readWindow({ cwd: "/srv/a/x" }, { OMP_SESSIONS_VSCODE_AUTHORITY: "ssh-remote+box" })?.id, "desktop", "authority from a VS Code terminal");
	assert.equal(readWindow({ authority: "ssh-remote+nowhere" }, {})?.id, "local", "an unknown authority falls back to all windows");

	recordWindow({ id: "laptop", authority: "ssh-remote+ws", scheme: "vscode", folders: ["/srv/a"] }, 4000);
	assert.deepEqual(readWindows().map(w => w.id), ["laptop", "local", "desktop"], "refocusing moves the record, no duplicate");
});

test("isSessionId: ids only, nothing a notification could render", () => {
	assert.equal(isSessionId("mw6aaja98f08a3"), true);
	assert.equal(isSessionId("ab_c-1"), true);
	for (const bad of ["", "[x](command:workbench.action.terminal.sendSequence)", "a b", "a/b", "x".repeat(129)]) assert.equal(isSessionId(bad), false, bad);
});

test("folder links: an existing absolute folder only; widened to its checkout unless exact", () => {
	const repo = fs.mkdtempSync(path.join(home, "proj "));
	fs.mkdirSync(path.join(repo, ".git"));
	const sub = path.join(repo, "pkg");
	fs.mkdirSync(sub);
	const file = path.join(repo, "f.txt");
	fs.writeFileSync(file, "");
	for (const bad of ["relative/dir", path.join(repo, "missing"), file, `${repo}\n--x`, `${repo}\u0000`]) {
		assert.ok(folderProblem(bad), bad);
		assert.throws(() => vscodeFolderLink(bad, undefined), bad);
	}
	assert.equal(folderProblem(sub), undefined);
	assert.equal(vscodeFolderLink(sub, undefined), `vscode://file${uriPath(repo)}`);
	assert.equal(vscodeFolderLink(sub, undefined, { exact: true }), `vscode://file${uriPath(sub)}`);
	assert.match(vscodeFolderLink(sub, win({ authority: "ssh-remote+ws", scheme: "vscode-insiders" })), /^vscode-insiders:\/\/vscode-remote\/ssh-remote\+ws\/.*proj%20/);
	assert.equal(vscodeFolderLink(sub, win({ authority: "ssh-remote+ws", folders: [repo], workspace: "/w/all.code-workspace" })), "vscode://vscode-remote/ssh-remote+ws/w/all.code-workspace");
});

test("a request is taken once, by a window that has the session, while fresh", () => {
	requestOpen("s1", 10_000);
	assert.equal(takeOpenRequest(id => id === "other", 10_500), undefined, "a window without the session leaves it");
	assert.equal(takeOpenRequest(id => id === "s1", 11_000), "s1");
	assert.equal(takeOpenRequest(() => true, 11_000), undefined, "already taken");

	requestOpen("s2", 0);
	assert.equal(takeOpenRequest(() => true, OPEN_REQUEST_TTL_MS + 1), undefined, "stale");
	assert.equal(fs.existsSync(path.join(home, "vscode-open.json")), false, "a stale request is removed");

	requestOpen("s3");
	clearOpenRequest("s4");
	assert.equal(fs.existsSync(path.join(home, "vscode-open.json")), true, "another session's request stays");
	clearOpenRequest("s3");
	assert.equal(fs.existsSync(path.join(home, "vscode-open.json")), false);
});
