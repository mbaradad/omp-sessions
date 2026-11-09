// Editor actions under AO worktrees (MAPPING D10). A session runs in AO's own worktree of the project, which has
// neither the user's branch nor their uncommitted edits, but the editor action is about what the user has open.
// omp's tools are not confined to the session folder, so the prompt names the user's checkout by absolute path.
// Pure (no vscode): unit-tested.
import { findProject } from "./worktree-git";

/** The user's checkout `file` (or folder) belongs to: its git repository root (a linked worktree maps to its main repository), else its folder. */
export function checkoutRoot(fileOrFolder: string): string {
	return findProject(fileOrFolder).root;
}

/** `prompt` told to work in the user's checkout instead of the session's own worktree. */
export function inCheckout(prompt: string, fileOrFolder: string): string {
	const root = checkoutRoot(fileOrFolder);
	return `The user's working copy is \`${root}\`, not your own worktree: read and edit files there (paths below are absolute) and run git with \`git -C ${root}\`.\n\n${prompt}`;
}
