// Which harness a new session from VS Code runs, and when to ask (pure: no vscode, unit-tested).
// The resolution itself is src/ao/harness.ts; VS Code only asks when nobody chose: no Switchyard default
// (`switchyard.defaultHarness` / config.json `harness`), no project worker harness, and several authorized
// chat harnesses, so AO's default is a guess (`omp` among several, or the most used one).
import type { AoHarnessInfo, HarnessChoice } from "../ao/harness";

/** Ask the user which harness: the resolution fell through to AO's default among several authorized chat harnesses. */
export function shouldAskHarness(choice: Pick<HarnessChoice, "source">, harnesses: readonly AoHarnessInfo[]): boolean {
	return (choice.source === "omp" || choice.source === "usage") && harnesses.filter(h => h.authStatus === "authorized").length > 1;
}

export interface HarnessPickItem {
	harness: string;
	label: string;
	description: string;
	/** The resolved default: listed first. */
	isDefault: boolean;
}

/** The authorized chat harnesses to pick from, the resolved default first and labelled. */
export function harnessPickItems(harnesses: readonly AoHarnessInfo[], choice: Pick<HarnessChoice, "harness">): HarnessPickItem[] {
	const items = harnesses
		.filter(h => h.authStatus === "authorized")
		.map(h => {
			const isDefault = h.id === choice.harness;
			const used = h.usageCount ? `${h.usageCount} session${h.usageCount === 1 ? "" : "s"}` : "";
			return { harness: h.id, label: h.label && h.label !== h.id ? `${h.label} (${h.id})` : h.id, description: [isDefault ? "default" : "", used].filter(Boolean).join(" · "), isDefault };
		});
	return [...items.filter(i => i.isDefault), ...items.filter(i => !i.isDefault)];
}
