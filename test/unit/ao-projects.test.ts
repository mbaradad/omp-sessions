import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { gitRoot } from "../../src/ao/projects";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args], { stdio: "ignore" });

test("gitRoot: a linked worktree counts for its main checkout; submodules and plain folders do not", () => {
	// .native: Windows's TEMP may be an 8.3 short path (C:\Users\RUNNER~1), which git and gitRoot spell out in full.
	const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ao-projects-test-")));
	try {
		const main = path.join(tmp, "main");
		fs.mkdirSync(path.join(main, "src"), { recursive: true });
		git(tmp, "init", "-q", "-b", "main", main);
		git(main, "commit", "-q", "--allow-empty", "-m", "init");
		// The main checkout, and a folder inside it.
		assert.equal(gitRoot(main), main);
		assert.equal(gitRoot(path.join(main, "src")), main);
		// A linked worktree, its subfolder, and one created from another worktree: all the main checkout.
		const wt = path.join(tmp, "wt");
		git(main, "worktree", "add", "-q", wt, "-b", "feat");
		fs.mkdirSync(path.join(wt, "sub"));
		assert.equal(gitRoot(wt), main);
		assert.equal(gitRoot(path.join(wt, "sub")), main);
		const wt2 = path.join(tmp, "wt2");
		git(wt, "worktree", "add", "-q", wt2, "-b", "feat2");
		assert.equal(gitRoot(wt2), main);
		// A submodule is its own repository: not the superproject.
		const sub = path.join(tmp, "subrepo");
		git(tmp, "init", "-q", "-b", "main", sub);
		git(sub, "commit", "-q", "--allow-empty", "-m", "init");
		git(main, "submodule", "add", "-q", sub, "vendor");
		assert.equal(gitRoot(path.join(main, "vendor")), path.join(main, "vendor"));
		// Outside git.
		const plain = path.join(tmp, "plain");
		fs.mkdirSync(plain);
		assert.equal(gitRoot(plain), undefined);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
