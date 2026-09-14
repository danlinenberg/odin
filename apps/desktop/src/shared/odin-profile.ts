/**
 * Odin profiles — one set of accounts (Slack, Jira, GitHub, Notion) and the
 * work that belongs to them.
 *
 * The credentials live in the main process (`~/.config/odin.json`), but the id
 * is stamped on things the renderer owns too — board sessions on the pane, my
 * tasks in localStorage — so it lives here, where both sides can see it.
 */

/**
 * The profile everything created before profiles existed belongs to. Rows and
 * panes from back then carry no id at all, so an absent id reads as this one
 * rather than as "belongs to nobody" — otherwise the first switch would look
 * like every session had been deleted.
 */
export const DEFAULT_PROFILE_ID = "default";

/** The profile a stamped-or-not thing belongs to. */
export function profileOf(id: string | undefined | null): string {
	return id || DEFAULT_PROFILE_ID;
}
