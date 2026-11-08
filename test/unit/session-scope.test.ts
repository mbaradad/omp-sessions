import assert from "node:assert/strict";
import { test } from "node:test";
import { isSessionScope, withinAny } from "../../src/ext/session-scope";

test("withinAny: the folder itself and its subfolders, not a sibling sharing a prefix", () => {
	assert.equal(withinAny(["/a/b"], ["/a/b"], "linux"), true);
	assert.equal(withinAny(["/a/b/c/d"], ["/a/b"], "linux"), true);
	assert.equal(withinAny(["/a/bc"], ["/a/b"], "linux"), false);
	assert.equal(withinAny(["/a"], ["/a/b"], "linux"), false, "a parent of the workspace folder is outside it");
	assert.equal(withinAny(["/a/b/../bc"], ["/a/b"], "linux"), false);
	assert.equal(withinAny(["/a/b/..x"], ["/a/b"], "linux"), true, "a folder named ..x is inside");
});

test("withinAny: multi-root, several candidate dirs, no folders", () => {
	assert.equal(withinAny(["/srv/two/x"], ["/srv/one", "/srv/two"], "linux"), true);
	assert.equal(withinAny(["/elsewhere", "/srv/one/main"], ["/srv/one"], "linux"), true, "a worktree counts for its main checkout");
	assert.equal(withinAny(["/srv/one"], [], "linux"), false);
});

test("withinAny: Windows paths compare case-insensitively, separators either way", () => {
	assert.equal(withinAny(["c:\\Users\\Me\\Proj\\src"], ["C:\\users\\me\\proj"], "win32"), true);
	assert.equal(withinAny(["C:/Users/Me/Proj"], ["C:\\Users\\Me\\Proj"], "win32"), true);
	assert.equal(withinAny(["C:\\Users\\Me\\Project"], ["C:\\Users\\Me\\Proj"], "win32"), false);
	assert.equal(withinAny(["D:\\Proj"], ["C:\\Proj"], "win32"), false);
	assert.equal(withinAny(["/A/b"], ["/a/b"], "linux"), false, "POSIX stays case-sensitive");
});

test("isSessionScope", () => {
	assert.equal(isSessionScope("workspace"), true);
	assert.equal(isSessionScope("all"), true);
	assert.equal(isSessionScope("everything"), false);
	assert.equal(isSessionScope(undefined), false);
});
