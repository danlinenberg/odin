import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useDangerMode } from "./danger-mode";

/**
 * EXPERIMENT: GSD Mode. Off by default - no GSD Mode switch under the reply
 * box and no GSD Mode section in Settings > Sessions. Settings > Advanced >
 * Experimental turns it on. Renderer localStorage: one boolean.
 */
export const useGsdModeEnabled = create<{
	enabled: boolean;
	setEnabled: (enabled: boolean) => void;
}>()(
	persist(
		(set) => ({
			enabled: false,
			setEnabled: (enabled) => {
				// Turned off: no session stays in GSD Mode with no switch to end it.
				if (!enabled) useDangerMode.setState({ on: {} });
				set({ enabled });
			},
		}),
		{ name: "gsd-mode-enabled" },
	),
);
