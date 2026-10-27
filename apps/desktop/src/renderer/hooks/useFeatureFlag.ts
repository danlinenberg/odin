import { electronTrpc } from "renderer/lib/electron-trpc";
import type { FeatureFlag, FeatureFlags } from "shared/feature-flags";

/** Every flag for this build, or undefined until main answers. */
export function useFeatureFlags(): FeatureFlags | undefined {
	const { data } = electronTrpc.system.featureFlags.useQuery(undefined, {
		staleTime: Number.POSITIVE_INFINITY,
	});
	return data;
}

/** Whether a flagged feature is on in this build. Off until main answers. */
export function useFeatureFlag(flag: FeatureFlag): boolean {
	return useFeatureFlags()?.[flag] ?? false;
}
