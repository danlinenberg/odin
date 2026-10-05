/**
 * Keys you can double-tap to open Odin, by Karabiner key_code, with the
 * KeyboardEvent.code the window sees for each. Karabiner matches rules after
 * its Simple Modifications, and the window sees keys after them too, so a key
 * recorded in the window is the key the rule fires on, whatever is swapped.
 */
export const DOUBLE_TAP_KEYS = {
	right_command: { label: "Right ⌘", code: "MetaRight" },
	left_command: { label: "Left ⌘", code: "MetaLeft" },
	right_option: { label: "Right ⌥", code: "AltRight" },
	left_option: { label: "Left ⌥", code: "AltLeft" },
	right_control: { label: "Right ⌃", code: "ControlRight" },
	left_control: { label: "Left ⌃", code: "ControlLeft" },
	right_shift: { label: "Right ⇧", code: "ShiftRight" },
	left_shift: { label: "Left ⇧", code: "ShiftLeft" },
} as const;

export type DoubleTapKey = keyof typeof DOUBLE_TAP_KEYS;

export function doubleTapKeyForCode(code: string): DoubleTapKey | null {
	const hit = Object.entries(DOUBLE_TAP_KEYS).find(([, k]) => k.code === code);
	return hit ? (hit[0] as DoubleTapKey) : null;
}
