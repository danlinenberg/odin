/** Modifiers you can double-tap to show or hide Odin, either side. */
export const DOUBLE_TAP_MODIFIERS = [
	"command",
	"option",
	"control",
	"shift",
] as const;

export type DoubleTapModifier = (typeof DOUBLE_TAP_MODIFIERS)[number];

export const DOUBLE_TAP_LABELS: Record<DoubleTapModifier, string> = {
	command: "⌘",
	option: "⌥",
	control: "⌃",
	shift: "⇧",
};
