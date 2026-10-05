/** Keys you can double-tap to open Odin, by Karabiner key_code. */
export const DOUBLE_TAP_KEYS = {
	right_command: "Right ⌘",
	left_command: "Left ⌘",
	right_option: "Right ⌥",
	left_option: "Left ⌥",
	right_control: "Right ⌃",
	left_control: "Left ⌃",
	right_shift: "Right ⇧",
	left_shift: "Left ⇧",
} as const;

export type DoubleTapKey = keyof typeof DOUBLE_TAP_KEYS;
