/** Where a session drawer opens: over the board or Sessions list, or beside
 * Today and Auto pilot. Each keeps its own width, so a session previewed
 * beside Today doesn't shrink the full-width drawer over the list. */
export type DrawerView = "list" | "today";

/** Share of the width beside the icon rail, per view, per machine. */
export const DRAWER_WIDTH_KEY = "odin:drawer-width";

/** Full width over the list; beside Today, room for the page to stay usable. */
export const DEFAULT_DRAWER_FRACTIONS: Record<DrawerView, number> = {
	list: 1,
	today: 0.6,
};

const clampFraction = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value)
		? Math.min(Math.max(value, 0), 1)
		: fallback;

export function loadDrawerFractions(
	storage: Storage,
): Record<DrawerView, number> {
	try {
		const saved = JSON.parse(storage.getItem(DRAWER_WIDTH_KEY) ?? "{}");
		return {
			list: clampFraction(saved?.list, DEFAULT_DRAWER_FRACTIONS.list),
			today: clampFraction(saved?.today, DEFAULT_DRAWER_FRACTIONS.today),
		};
	} catch {
		return { ...DEFAULT_DRAWER_FRACTIONS };
	}
}

/** A fixed two-number singleton: one key, overwritten in place. */
export function saveDrawerFractions(
	storage: Storage,
	fractions: Record<DrawerView, number>,
): void {
	try {
		storage.setItem(DRAWER_WIDTH_KEY, JSON.stringify(fractions));
	} catch {}
}
