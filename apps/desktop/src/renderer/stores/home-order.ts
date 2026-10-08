import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Where each card sits on Home, per profile: pane ids in order. Home rewrites
 * it to the sessions it shows, so it never holds more than those.
 */
export const useHomeOrder = create<{
	byProfile: Record<string, string[]>;
	setOrder: (profile: string, order: string[]) => void;
}>()(
	persist(
		(set) => ({
			byProfile: {},
			setOrder: (profile, order) =>
				set((state) => ({
					byProfile: { ...state.byProfile, [profile]: order },
				})),
		}),
		{ name: "odin-home-order" },
	),
);
