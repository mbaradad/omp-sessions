// Installs the omp-sessions skill (skills/omp-sessions/SKILL.md, shipped as out/omp-sessions.SKILL.md)
// where agent platforms look for skills, so Claude Code, Codex, omp itself and other tools that read
// ~/.agents/skills can drive omp-sessions. Hermes gets the skill with its plugin (hermes-plugin.ts). Only
// copies we wrote (frontmatter `managed-by: omp-sessions`) are replaced or removed. Node-only.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SKILL_NAME = "omp-sessions";
/** File name of the skill next to the bundled CLI / extension (build.mjs copies it into out/). */
export const SKILL_FILE = "omp-sessions.SKILL.md";
const MARKER = "managed-by: omp-sessions";

export type SkillPlatform = "agents" | "claude" | "codex";
export const SKILL_PLATFORMS: readonly SkillPlatform[] = ["agents", "claude", "codex"];

export const PLATFORM_LABEL: Record<SkillPlatform, string> = {
	agents: "Shared agent skills (~/.agents/skills: omp and other tools)",
	claude: "Claude Code (~/.claude/skills)",
	codex: "Codex (~/.codex/skills)",
};

export function isSkillPlatform(v: string): v is SkillPlatform {
	return (SKILL_PLATFORMS as readonly string[]).includes(v);
}

/** The directory the skill gets inside a skills root a platform reads. */
export interface SkillTarget {
	platform: SkillPlatform | "dir";
	dir: string;
}

/** Where `platform` would load the skill from; empty when the platform isn't installed. */
export function skillTargets(platform: SkillPlatform, home = os.homedir()): SkillTarget[] {
	const base = path.join(home, `.${platform}`);
	// ~/.agents/skills is a shared convention: create it even if nothing uses it yet.
	if (platform !== "agents" && !fs.existsSync(base)) return [];
	return [{ platform, dir: path.join(base, "skills", SKILL_NAME) }];
}

/** Platforms present on this machine (the shared ~/.agents location always counts). */
export function detectedPlatforms(home = os.homedir()): SkillPlatform[] {
	return SKILL_PLATFORMS.filter(p => skillTargets(p, home).length > 0);
}

export type InstallOutcome = "installed" | "updated" | "unchanged" | "skipped";

function managed(file: string): boolean {
	try {
		const text = fs.readFileSync(file, "utf8");
		return text.includes(MARKER);
	} catch {
		return false;
	}
}

/** Writes SKILL.md into `target.dir`. A SKILL.md we didn't write is left alone unless `force`. */
export function installSkill(target: SkillTarget, content: string, force = false): InstallOutcome {
	const file = path.join(target.dir, "SKILL.md");
	const exists = fs.existsSync(file);
	if (exists && !force && !managed(file)) return "skipped";
	if (exists && fs.readFileSync(file, "utf8") === content) return "unchanged";
	fs.mkdirSync(target.dir, { recursive: true });
	fs.writeFileSync(file, content);
	return exists ? "updated" : "installed";
}

/** Removes a copy we installed; true if something was removed. */
export function uninstallSkill(target: SkillTarget): boolean {
	const file = path.join(target.dir, "SKILL.md");
	if (!managed(file)) return false;
	fs.rmSync(file);
	try {
		fs.rmdirSync(target.dir);
	} catch {
		/* other files the user put there stay */
	}
	return true;
}

/** Installed copies that differ from `content` (an older extension wrote them). */
export function staleCopies(content: string, home = os.homedir()): SkillTarget[] {
	return SKILL_PLATFORMS.flatMap(p => skillTargets(p, home)).filter(t => {
		const file = path.join(t.dir, "SKILL.md");
		return managed(file) && fs.readFileSync(file, "utf8") !== content;
	});
}
