/** A one-line preview of a reply: its first `max` characters without Markdown markup. */
export function plainExcerpt(text: string, max = 240): string {
	return text
		.replace(/```[\s\S]*?(```|$)/g, " ")
		.replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, "")
		.replace(/(\*\*|__|`|~~)/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}
