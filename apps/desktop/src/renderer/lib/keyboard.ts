/**
 * Is someone already typing somewhere? A terminal re-asserts DOM focus at
 * several unprompted moments — when its xterm is (re)created, when a cold
 * restore lands, when the board's drawer re-runs on its 5s poll — and none of
 * those are the user asking for it. If a box is open over the pane (quick add,
 * rename, a dialog's fields, an open menu), taking the keyboard off it mid-word sends the
 * rest of the sentence to the session.
 *
 * xterm's own input is a textarea, so it can't count as "someone else".
 */
export const isTypingElsewhere = (active: Element | null) =>
	!!active &&
	!active.classList.contains("xterm-helper-textarea") &&
	((active as HTMLElement).isContentEditable ||
		/^(?:INPUT|TEXTAREA|SELECT)$/.test(active.tagName) ||
		// An open dropdown holds focus on its menu, not a field; taking it closes
		// the menu out from under a hovering pointer.
		!!active.closest('[role="menu"],[role="listbox"],[role="dialog"]'));

/** The unprompted-refocus guard, at the call sites that just want to ask. */
export const canClaimKeyboard = () =>
	!isTypingElsewhere(document.activeElement);
