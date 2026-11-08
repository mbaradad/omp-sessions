// VS Code renders `[label](command:…)`, `[label](https:…)` and `[label](file:…)` links in notification messages
// and runs them on click. Text the extension doesn't control (session titles, Hermes card names, omp's own
// output, paths, error messages) goes through `plain` before it reaches a non-modal
// showInformation/Warning/ErrorMessage. No vscode import: unit-tested.

/** `text` with markdown link syntax broken by a zero-width space between `]` and `(`: shows as typed, but no link. */
export function plain(text: string): string {
	return text.replace(/\]\(/g, "]\u200b(");
}
