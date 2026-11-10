import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { OPEN_REQUEST_TTL_MS, type VscodeWindow, checkoutRoot, clearOpenRequest, folderProblem, intentOfParams, isSessionId, readWindow, readWindows, recordWindow, requestOpen, resolveSessionId, takeOpenRequest, uriPath, vscodeFolderLink, vscodeLink } from "../../src/shared/vscode-open";

// stateRoot() reads SWITCHYARD_HOME on every call.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-open-"));
process.env.SWITCHYARD_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const win = (w: Partial<VscodeWindow>): VscodeWindow => ({ id: "w", authority: "", scheme: "vscode", at: 1, folders: [], ...w });

test("links: a remote window gets a folder over its authority; a local one (or none) the extension's handler", () => {
	const s = { id: "mw6aaja98f08a3", cwd: "/home/me/projects/my app" };
	assert.equal(vscodeLink(s, win({ authority: "ssh-remote+ws" })), "vscode://vscode-remote/ssh-remote+ws/home/me/projects/my%20app");
	assert.equal(vscodeLink(s, win({ scheme: "vscode-insiders" })), "vscode-insiders://mbaradad.switchyard/open?session=mw6aaja98f08a3");
	assert.equal(vscodeLink(s, undefined), "vscode://mbaradad.switchyard/open?session=mw6aaja98f08a3");
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
	assert.equal(readWindow({ cwd: "/srv/a/x" }, { SWITCHYARD_VSCODE_AUTHORITY: "ssh-remote+box" })?.id, "desktop", "authority from a VS Code terminal");
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
	assert.deepEqual(takeOpenRequest(id => id === "s1", 11_000), { session: "s1" });
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

test("a request carries the review intent; a stale one is dropped with it; a malformed intent degrades to none", () => {
	requestOpen("s1", 10_000, { review: "pr", pr: 7 });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "vscode-open.json"), "utf8")), { session: "s1", at: 10_000, review: "pr", pr: 7 });
	assert.deepEqual(takeOpenRequest(() => true, 10_100), { session: "s1", review: "pr", pr: 7 });

	requestOpen("s2", 10_000, { review: "pr" });
	assert.deepEqual(takeOpenRequest(() => true, 10_100), { session: "s2", review: "pr" }, "no PR number: the window picks");

	requestOpen("s3", 10_000, { pr: 7 });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "vscode-open.json"), "utf8")), { session: "s3", at: 10_000 }, "a PR without review is no intent");
	assert.deepEqual(takeOpenRequest(() => true, 10_100), { session: "s3" });

	requestOpen("s4", 0, { review: "pr", pr: 7 });
	assert.equal(takeOpenRequest(() => true, OPEN_REQUEST_TTL_MS + 1), undefined, "stale, intent included");
	assert.equal(fs.existsSync(path.join(home, "vscode-open.json")), false);

	for (const bad of [{ review: "merge", pr: 7 }, { review: "pr", pr: -1 }, { review: "pr", pr: 1.5 }, { review: "pr", pr: "7" }]) {
		fs.writeFileSync(path.join(home, "vscode-open.json"), JSON.stringify({ session: "s5", at: 10_000, ...bad }));
		const taken = takeOpenRequest(() => true, 10_100);
		assert.equal(taken?.session, "s5");
		assert.equal(taken?.pr, undefined, JSON.stringify(bad));
		if (bad.review !== "pr") assert.equal(taken?.review, undefined);
	}
});

test("URI parameters: review is only pr, pr a positive integer and only with review", () => {
	assert.deepEqual(intentOfParams(null, null), {});
	assert.deepEqual(intentOfParams("pr", null), { review: "pr" });
	assert.deepEqual(intentOfParams("pr", "42"), { review: "pr", pr: 42 });
	for (const [review, pr] of [["merge", null], ["", null], ["PR", null], [null, "7"], ["pr", "0"], ["pr", "-3"], ["pr", "1.5"], ["pr", "abc"], ["pr", ""], ["pr", "007"], ["pr", "12345678901234567890"]] as const) {
		assert.equal(intentOfParams(review, pr), undefined, `${review} ${pr}`);
	}
});

test("a local link carries the intent; a remote folder link does not (the request file does)", () => {
	const s = { id: "s1", cwd: "/home/me/p" };
	assert.equal(vscodeLink(s, undefined, { review: "pr" }), "vscode://mbaradad.switchyard/open?session=s1&review=pr");
	assert.equal(vscodeLink(s, undefined, { review: "pr", pr: 9 }), "vscode://mbaradad.switchyard/open?session=s1&review=pr&pr=9");
	assert.equal(vscodeLink(s, win({ authority: "ssh-remote+ws" }), { review: "pr", pr: 9 }), "vscode://vscode-remote/ssh-remote+ws/home/me/p");
});

test("an orchestrator's id opens like a session's: a request waits for the window that holds it, a link names it exactly or by a unique prefix", () => {
	// `has` is SessionManager.get, which holds the orchestrator sessions too (only its lists leave them out).
	const held = new Set(["orch-1", "repo-7"]);
	requestOpen("orch-1", 20_000);
	assert.deepEqual(takeOpenRequest(id => held.has(id), 20_100), { session: "orch-1" });
	assert.equal(resolveSessionId("orch-1", ["repo-7", "orch-1"]), "orch-1");
	assert.equal(resolveSessionId("orch", ["repo-7", "orch-1"]), "orch-1");
	assert.equal(resolveSessionId("orc", ["repo-7", "orch-1"]), undefined, "a prefix under 4 characters is not enough");
	assert.equal(resolveSessionId("repo", ["repo-7", "repo-8"]), undefined, "an ambiguous prefix names nothing");
	assert.equal(resolveSessionId("gone-1", ["repo-7"]), undefined);
});
