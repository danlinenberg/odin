import { HOTKEYS, type HotkeyId } from "../../registry";
import { useHotkeyOverridesStore } from "../../stores/hotkeyOverridesStore";
import { getEffectiveLayoutMap } from "../../stores/keyboardLayoutStore";
import type { ShortcutBinding } from "../../types";
import { bindingToDispatchChord } from "../../utils/binding";
import { matchesChord } from "../../utils/resolveHotkeyFromEvent";

/**
 * Reactive: get the effective binding for a hotkey (override ?? default).
 * Returns the raw stored shape - bare chord string (legacy / shipped
 * defaults, treated as physical mode) or v2 object. Use `parseBinding` to
 * normalize.
 */
export function useBinding(id: HotkeyId): ShortcutBinding | null {
	return useHotkeyOverridesStore((state) => {
		if (!id) return null;
		if (id in state.overrides) return state.overrides[id] ?? null;
		return HOTKEYS[id]?.key ?? null;
	});
}

/** Imperative version of {@link useBinding} for non-React contexts. */
export function getBinding(id: HotkeyId): ShortcutBinding | null {
	const state = useHotkeyOverridesStore.getState();
	if (!id) return null;
	if (id in state.overrides) return state.overrides[id] ?? null;
	return HOTKEYS[id]?.key ?? null;
}

/**
 * Imperative dispatch-form chord (event.code-based, layout-translated for
 * logical bindings). Use when synthesizing KeyboardEvents that should match
 * the same registration `useHotkey` makes - otherwise the event won't fire
 * the bound handler on non-US layouts.
 */
export function getDispatchChord(id: HotkeyId): string | null {
	return bindingToDispatchChord(getBinding(id), getEffectiveLayoutMap());
}

/** True if `event` is the current binding of `id`: for a box's own key handler. */
export function isHotkey(id: HotkeyId, event: KeyboardEvent): boolean {
	const chord = getDispatchChord(id);
	return !!chord && matchesChord(event, chord);
}
