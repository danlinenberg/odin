import { BasicIndex } from "@tanstack/db";
import {
	createCollection,
	localStorageCollectionOptions,
} from "@tanstack/react-db";
import {
	healV2UserPreferences,
	type V2TerminalPresetRow,
	type V2UserPreferencesRow,
	v2TerminalPresetSchema,
	v2UserPreferencesSchema,
} from "./schema";
import { withReadHeal } from "./withReadHeal";

/**
 * Applied to every localStorage-backed collection:
 * - `startSync: true` + `gcTime: 0`: hydrate at construction, never GC. Write
 *   helpers read `.state` non-reactively, and a write into a not-yet-hydrated
 *   (or GC'd) collection rewrites the whole storage key from empty memory —
 *   erasing every persisted row.
 * - `withReadHeal`: per-row tolerant reads — one malformed entry escaping to
 *   the library's hydration catch-all would blank the entire store.
 */
const hardenLocalCollection = <T>(
	options: T,
	heal?: (raw: unknown) => unknown,
): T => withReadHeal({ ...options, startSync: true, gcTime: 0 } as T, heal);

export const v2TerminalPresets = createCollection(
	localStorageCollectionOptions(
		hardenLocalCollection({
			id: "v2_terminal_presets",
			storageKey: "v2-terminal-presets",
			schema: v2TerminalPresetSchema,
			// Explicit type for the same reason `withReadHeal` needs one: a
			// passthrough generic drops the contextual typing that would
			// otherwise narrow the key to string.
			getKey: (item: V2TerminalPresetRow) => item.id,
		}),
	),
);
v2TerminalPresets.createIndex((preset) => preset.tabOrder, {
	indexType: BasicIndex,
});

export const v2UserPreferences = createCollection(
	localStorageCollectionOptions(
		hardenLocalCollection(
			{
				id: "v2_user_preferences",
				storageKey: "v2-user-preferences",
				schema: v2UserPreferencesSchema,
				// Cast widens the inferred literal "preferences" key to string so
				// the singleton collection keys like the others.
				getKey: (item: V2UserPreferencesRow) => item.id as string,
			},
			healV2UserPreferences,
		),
	),
);
