import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { OPEN_REQUEST_TTL_MS, clearOpenRequest, readWindow, recordWindow, requestOpen, takeOpenRequest, vscodeLink } from "../../src/shared/vscode-open";

// stateRoot() reads OMP_VSCODE_HOME on every call.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vscode-open-"));
process.env.OMP_VSCODE_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

test("links: a remote window gets its folder over its authority; a local one (or none) the extension's handler", () => {
	const s = { id: "mw6aaja98f08a3", cwd: "/home/me/projects/my app" };
	assert.equal(vscodeLink(s, { authority: "ssh-remote+ws", scheme: "vscode", at: 1 }), "vscode://vscode-remote/ssh-remote+ws/home/me/projects/my%20app");
	assert.equal(vscodeLink(s, { authority: "", scheme: "vscode-insiders", at: 1 }), "vscode-insiders://mbaradad.omp-sessions/open?session=mw6aaja98f08a3");
	assert.equal(vscodeLink(s, undefined), "vscode://mbaradad.omp-sessions/open?session=mw6aaja98f08a3");
	assert.equal(vscodeLink({ id: "x", cwd: "C:\\src\\a#b" }, { authority: "ssh-remote+win", scheme: "vscode", at: 1 }), "vscode://vscode-remote/ssh-remote+win/C:/src/a%23b");
});

test("the window record round-trips; a bad scheme falls back to vscode", () => {
	assert.equal(readWindow(), undefined);
	recordWindow("ssh-remote+ws", "vscode", 1000);
	assert.deepEqual(readWindow(), { authority: "ssh-remote+ws", scheme: "vscode", at: 1000 });
	recordWindow("", "javascript:alert(1)//", 2000);
	assert.deepEqual(readWindow(), { authority: "", scheme: "vscode", at: 2000 });
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
