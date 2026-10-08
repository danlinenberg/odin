const KEYS: Record<string, string> = {
	comma: ",",
	period: ".",
	slash: "/",
	backslash: "\\",
	semicolon: ";",
	quote: "'",
	backquote: "`",
	bracketleft: "[",
	bracketright: "]",
	minus: "-",
	equal: "=",
	enter: "Enter",
	escape: "Escape",
	esc: "Escape",
	backspace: "Backspace",
	delete: "Delete",
	tab: "Tab",
	space: "Space",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
	insert: "Insert",
};

const MODIFIERS: Record<string, string> = {
	meta: "Super",
	ctrl: "Control",
	alt: "Alt",
	shift: "Shift",
};

/**
 * A hotkey chord ("meta+shift+a") as an Electron accelerator ("Command+Shift+A").
 * Null for anything that would hijack plain typing in every other app - a bare
 * key or shift+key - or that has no accelerator name.
 */
export function chordToAccelerator(chord: string): string | null {
	const tokens = chord.toLowerCase().split("+");
	const key = tokens.pop() ?? "";
	const mods = tokens.map((t) => MODIFIERS[t]);
	if (mods.some((m) => !m) || !mods.some((m) => m !== "Shift")) return null;
	const name = /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4]))$/.test(key)
		? key.toUpperCase()
		: KEYS[key];
	return name ? [...mods, name].join("+") : null;
}
