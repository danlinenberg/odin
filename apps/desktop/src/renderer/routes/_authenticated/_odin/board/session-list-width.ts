/** The session list beside an open session: how wide you dragged it, per machine. */
export const SESSION_LIST_WIDTH_KEY = "odin:drawer-sessions-width";
/** Narrower and the sort select, Group and Select stop fitting on one line:
 * they need 239px (measured in the built app), so the default is the minimum. */
export const MIN_SESSION_LIST_W = 240;
export const DEFAULT_SESSION_LIST_W = MIN_SESSION_LIST_W;
/** Wider and the list eats the room the chat and brief need. */
export const MAX_SESSION_LIST_W = 480;

export function clampSessionListWidth(width: number): number {
	if (!Number.isFinite(width)) return DEFAULT_SESSION_LIST_W;
	return Math.round(
		Math.min(Math.max(width, MIN_SESSION_LIST_W), MAX_SESSION_LIST_W),
	);
}

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
