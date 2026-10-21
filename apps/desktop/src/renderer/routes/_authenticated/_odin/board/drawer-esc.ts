// Odin's panels take Esc at the window, before anything on screen sees it.
// These say when the key belongs to what is focused instead.

function closestOf(target: EventTarget | null, selector: string): boolean {
	const closest = (target as Element | null)?.closest;
	if (typeof closest !== "function") return false;
	return closest.call(target, selector) !== null;
}

/** True when the Esc lands on an element that has something of its own to
 * close right now: it carries `data-owns-esc` (the reply box with its @ or /
 * list open). */
export function targetOwnsEsc(target: EventTarget | null): boolean {
	return closestOf(target, "[data-owns-esc]");
}

/** The drawer's rule: a box opened over the pane cancels itself on Esc, and
 * so does anything that owns Esc. */
export function escStaysWithTarget(target: EventTarget | null): boolean {
	return closestOf(target, "[role=dialog], [data-owns-esc]");
}

/** The chat view's reply box closes its @ or / list on Esc, and leaves bash
 * mode on an empty `!` line. Otherwise Esc is the drawer's. */
export function replyBoxOwnsEsc(box: {
	menuOpen: boolean;
	bash: boolean;
	draft: string;
}): boolean {
	return box.menuOpen || (box.bash && !box.draft);
}
