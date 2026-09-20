/**
 * Is someone already typing somewhere? The drawer re-claims the terminal on a
 * 5s poll, not once on open, so every such claim has to ask first — otherwise
 * a box you opened over the pane (quick add, rename, a dialog's fields) loses
 * the keyboard mid-word and the rest of the sentence lands in the session.
 *
 * xterm's own input is a textarea, so it can't count as "someone else".
 */
export const isTypingElsewhere = (active: Element | null) =>
	!!active &&
	!active.classList.contains("xterm-helper-textarea") &&
	((active as HTMLElement).isContentEditable ||
		/^(?:INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
