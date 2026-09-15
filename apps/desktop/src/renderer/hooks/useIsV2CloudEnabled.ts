import { useV2LocalOverrideStore } from "renderer/stores/v2-local-override";

/**
 * Returns whether the v2 surface is active. v2 is the default; the
 * Experimental settings toggle is the only way back to v1.
 */
export function useIsV2CloudEnabled(): boolean {
	return useV2LocalOverrideStore((s) => s.optInV2) ?? true;
}
