// "Install omp Sessions Skill for Agents…": copies the omp-sessions skill to the agent platforms the
// user picks, and keeps copies it installed earlier current when the extension updates.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { PLATFORM_LABEL, SKILL_FILE, type SkillPlatform, detectedPlatforms, installSkill, skillTargets, staleCopies } from "../shared/agent-skill";
import type { OmpApi } from "./api";

function skillContent(api: OmpApi): string | undefined {
	try {
		return fs.readFileSync(path.join(api.context.extensionPath, "out", SKILL_FILE), "utf8");
	} catch {
		return undefined;
	}
}

export function registerAgentSkill(api: OmpApi): void {
	const content = skillContent(api);
	// Copies an older version installed: refresh them so other agents learn the current CLI.
	if (content) {
		try {
			for (const t of staleCopies(content)) installSkill(t, content);
		} catch {
			/* a read-only skills folder: the command reports it when used */
		}
	}
	api.context.subscriptions.push(
		vscode.commands.registerCommand("omp.installAgentSkill", async () => {
			const text = skillContent(api);
			if (!text) {
				void vscode.window.showErrorMessage(`omp: ${SKILL_FILE} is missing from the extension; reinstall it.`);
				return;
			}
			const found = new Set(detectedPlatforms());
			const items = (Object.keys(PLATFORM_LABEL) as SkillPlatform[]).map(platform => ({
				label: PLATFORM_LABEL[platform],
				description: found.has(platform) ? undefined : "not found on this machine",
				picked: found.has(platform),
				platform,
			}));
			const picked = await vscode.window.showQuickPick(items, {
				canPickMany: true,
				title: "Install the omp-sessions skill",
				placeHolder: "Agents that should learn to start, schedule and check omp sessions through omp-sessions",
			});
			if (!picked?.length) return;
			const lines: string[] = [];
			for (const item of picked) {
				const targets = skillTargets(item.platform);
				if (!targets.length) {
					lines.push(`${item.label}: not found`);
					continue;
				}
				for (const t of targets) {
					try {
						const outcome = installSkill(t, text);
						lines.push(`${item.platform}: ${outcome === "skipped" ? "skipped, another SKILL.md is there" : outcome}`);
					} catch (err) {
						lines.push(`${item.platform}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
			void vscode.window.showInformationMessage("omp-sessions skill", { modal: true, detail: `${lines.join("\n")}\n\nAgents use it through the omp-sessions command; install that with "omp: Install omp-sessions Command" if you haven't.` });
		}),
	);
}
