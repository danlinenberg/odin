import type { GsdAllow } from "shared/gsd-policy";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type GsdLimitsState = GsdAllow & {
	set: (kind: keyof GsdAllow, on: boolean) => void;
};

/**
 * Settings → Sessions → GSD Mode: what GSD Mode may do by itself. All off by
 * default. Renderer localStorage: three booleans, a fixed-size singleton, and
 * the chat that runs GSD Mode is the only reader.
 */
export const useGsdLimits = create<GsdLimitsState>()(
	persist(
		(set) => ({
			merge: false,
			destructive: false,
			sensitive: false,
			set: (kind, on) => set({ [kind]: on }),
		}),
		{ name: "odin-gsd-limits", version: 1 },
	),
);

/** The limits as they are now, for code outside a component. */
export function gsdAllow(): GsdAllow {
	const { merge, destructive, sensitive } = useGsdLimits.getState();
	return { merge, destructive, sensitive };
}
