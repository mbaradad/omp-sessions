import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { checkoutRoot, inCheckout } from "../../src/ext/checkout";

function repo(): string {
	// .native: Windows's TEMP may be an 8.3 short path (C:\Users\RUNNER~1), which git spells out in full.
	const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omp-checkout-")));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@l", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "a.ts"), "x\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	return dir;
}

test("inCheckout: the prompt names the user's checkout (the repository root of the file) and asks for git -C there", () => {
	const dir = repo();
	try {
		const file = path.join(dir, "src", "a.ts");
		assert.equal(checkoutRoot(file), dir);
		const text = inCheckout(`Explain ${file}`, file);
		assert.ok(text.startsWith(`The user's working copy is \`${dir}\``));
		assert.ok(text.includes(`git -C ${dir}`));
		assert.ok(text.endsWith(`Explain ${file}`));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("checkoutRoot: a linked worktree of the repository maps to the main checkout; a folder outside git is itself", () => {
	const dir = repo();
	const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omp-nogit-")));
	const wt = `${dir}-wt`;
	try {
		execFileSync("git", ["worktree", "add", "-q", "-b", "other", wt], { cwd: dir, stdio: "ignore" });
		assert.equal(checkoutRoot(wt), dir);
		assert.equal(checkoutRoot(outside), outside);
	} finally {
		fs.rmSync(wt, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});
