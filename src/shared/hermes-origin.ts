// Where a session came from in Hermes Agent, read from its tags (organize.json): the switchyard
// plugin's kanban lane tags its sessions `hermes`, `hermes:<board>` and `card:<task id>`
// (integrations/hermes/switchyard/lane.py). Pure; shared by the Sessions view and the chat.

export interface HermesOrigin {
	/** Kanban board slug. */
	board?: string;
	/** Kanban task id. */
	card?: string;
}

/** The session's Hermes origin; undefined for sessions without the lane's tags. */
export function hermesOrigin(tags: readonly string[] | undefined): HermesOrigin | undefined {
	if (!tags?.length) return undefined;
	let tagged = false;
	const origin: HermesOrigin = {};
	for (const t of tags) {
		const lower = t.toLowerCase();
		if (lower === "hermes") tagged = true;
		else if (lower.startsWith("hermes:") && t.length > 7) origin.board = t.slice(7);
		else if (lower.startsWith("card:") && t.length > 5) origin.card = t.slice(5);
	}
	// A `card:` tag alone could be anything; the board tag or `hermes` makes it the lane's.
	if (!tagged && !origin.board) return undefined;
	return origin;
}

/** Tags hermesOrigin reads (shown as the Hermes chip instead of as plain #tags). */
export function isHermesTag(tag: string, origin: HermesOrigin): boolean {
	const lower = tag.toLowerCase();
	return lower === "hermes" || (!!origin.board && lower.startsWith("hermes:")) || (!!origin.card && lower.startsWith("card:"));
}

/** "Hermes · lightscale · t_1a2b". */
export function originLabel(origin: HermesOrigin): string {
	return ["Hermes", origin.board, origin.card].filter(Boolean).join(" · ");
}

/** The Hermes dashboard's Kanban page (it has no deep link to a board or card: it opens the board picked last). */
export function kanbanUrl(dashboardUrl: string): string {
	return `${dashboardUrl.trim().replace(/\/+$/, "")}/kanban`;
}

/** Board slugs and card ids the lane makes; anything else (a tag someone typed) is not passed to hermes. */
const HERMES_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Arguments of `hermes kanban [--board <slug>] show <id>` (boards are machine-wide: no profile flag), run
 * without a shell; undefined when the board or card isn't a plain id.
 */
export function showCardArgs(origin: HermesOrigin & { card: string }): string[] | undefined {
	if (!HERMES_ID.test(origin.card) || (origin.board !== undefined && !HERMES_ID.test(origin.board))) return undefined;
	return ["kanban", ...(origin.board ? ["--board", origin.board] : []), "show", origin.card];
}
