import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { detectedPlatforms, installSkill, skillTargets, staleCopies, uninstallSkill } from "../../src/shared/agent-skill";

const SKILL_V1 = "---\nname: omp-sessions\nmetadata:\n  omp-sessions:\n    managed-by: omp-sessions\n---\nv1\n";
const SKILL_V2 = SKILL_V1.replace("v1", "v2");

const temps: string[] = [];
after(() => {
	for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-skill-"));
	temps.push(dir);
	return dir;
}
test("skill targets follow the platforms installed", () => {
	const home = tempHome();
	assert.deepEqual(detectedPlatforms(home), ["agents"]);
	fs.mkdirSync(path.join(home, ".claude"));
	assert.deepEqual(detectedPlatforms(home), ["agents", "claude"]);
	assert.deepEqual(
		skillTargets("claude", home).map(t => path.relative(home, t.dir)),
		[".claude/skills/omp-sessions"],
	);
	assert.deepEqual(skillTargets("codex", home), []);
});

test("install updates our own copy, never replaces someone else's skill unless forced", () => {
	const home = tempHome();
	const [target] = skillTargets("agents", home);
	assert.equal(installSkill(target, SKILL_V1), "installed");
	assert.equal(installSkill(target, SKILL_V1), "unchanged");
	assert.deepEqual(staleCopies(SKILL_V2, home).map(t => t.dir), [target.dir]);
	assert.equal(installSkill(target, SKILL_V2), "updated");
	assert.deepEqual(staleCopies(SKILL_V2, home), []);

	const [claude] = skillTargets("agents", path.join(home, "other"));
	fs.mkdirSync(claude.dir, { recursive: true });
	fs.writeFileSync(path.join(claude.dir, "SKILL.md"), "---\nname: omp-sessions\n---\nmine\n");
	assert.equal(installSkill(claude, SKILL_V2), "skipped");
	assert.equal(uninstallSkill(claude), false);
	assert.equal(fs.readFileSync(path.join(claude.dir, "SKILL.md"), "utf8"), "---\nname: omp-sessions\n---\nmine\n");
	assert.equal(installSkill(claude, SKILL_V2, true), "updated");

	assert.equal(uninstallSkill(target), true);
	assert.equal(fs.existsSync(target.dir), false);
});

test("a copy 0.5.0 and earlier installed (the old managed-by mark) is still ours", () => {
	const home = tempHome();
	const [target] = skillTargets("agents", home);
	fs.mkdirSync(target.dir, { recursive: true });
	fs.writeFileSync(path.join(target.dir, "SKILL.md"), "---\nname: omp-sessions\nmetadata:\n  omp-sessions:\n    managed-by: omp-vs\n---\nv0\n");
	assert.deepEqual(staleCopies(SKILL_V2, home).map(t => t.dir), [target.dir]);
	assert.equal(installSkill(target, SKILL_V2), "updated");
	assert.equal(fs.readFileSync(path.join(target.dir, "SKILL.md"), "utf8"), SKILL_V2);
});
