/** The session list beside an open session: how wide you dragged it, per machine. */
export const SESSION_LIST_WIDTH_KEY = "odin:drawer-sessions-width";
/** The narrowest the header still fits once it is down to icons and short sort
 * labels: 166px measured in the built app, plus the list's border. */
export const MIN_SESSION_LIST_W = 168;
export const DEFAULT_SESSION_LIST_W = 210;
/** The list never takes more than this share of the panel it sits in:
 * wider and it eats the room the chat and brief need. */
export const MAX_SESSION_LIST_SHARE = 0.5;

/** How the list header's sort select, Group and Select draw at a width. */
export type SessionListControls = "full" | "icons" | "tight";
/** Narrower and the worded Group and Select stop fitting beside the widest
 * sort label (234px measured). */
export const FULL_CONTROLS_MIN_W = 240;
/** Narrower and the long sort labels stop fitting beside the icon buttons
 * (192px measured). */
export const ICON_CONTROLS_MIN_W = 200;

export function sessionListControls(width: number): SessionListControls {
	if (width >= FULL_CONTROLS_MIN_W) return "full";
	if (width >= ICON_CONTROLS_MIN_W) return "icons";
	return "tight";
}

/** The widest the list can be in a panel this wide, never under the minimum. */
export function maxSessionListWidth(panelWidth: number): number {
	if (!Number.isFinite(panelWidth)) return Number.POSITIVE_INFINITY;
	return Math.max(
		MIN_SESSION_LIST_W,
		Math.floor(panelWidth * MAX_SESSION_LIST_SHARE),
	);
}

/** With no panel width, only the minimum applies: a saved width is kept as is. */
export function clampSessionListWidth(
	width: number,
	panelWidth = Number.POSITIVE_INFINITY,
): number {
	if (!Number.isFinite(width)) return DEFAULT_SESSION_LIST_W;
	return Math.round(
		Math.min(
			Math.max(width, MIN_SESSION_LIST_W),
			maxSessionListWidth(panelWidth),
		),
	);
}

/** The saved width, not clamped to a panel: a narrow window shows it clamped
 * and a wider one gets it back. */
export function loadSessionListWidth(storage: Storage): number {
	try {
		const saved = storage.getItem(SESSION_LIST_WIDTH_KEY);
		return saved === null
			? DEFAULT_SESSION_LIST_W
			: clampSessionListWidth(Number(saved));
	} catch {
		return DEFAULT_SESSION_LIST_W;
	}
}

/** The default width is stored as no key, so a reset leaves nothing behind. */
export function saveSessionListWidth(storage: Storage, width: number): void {
	const clamped = clampSessionListWidth(width);
	try {
		if (clamped === DEFAULT_SESSION_LIST_W) {
			storage.removeItem(SESSION_LIST_WIDTH_KEY);
		} else {
			storage.setItem(SESSION_LIST_WIDTH_KEY, String(clamped));
		}
	} catch {}
}
