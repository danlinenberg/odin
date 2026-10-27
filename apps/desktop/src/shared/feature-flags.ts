/**
 * Feature flags: which builds see a feature. A flag names the widest build
 * that gets it - "dev" is `bun dev` only, "internal" adds Odin Canary,
 * "everyone" is every build including stable. To ship a feature, move its
 * flag to "everyone", then delete the flag and its checks once it has settled.
 */
export type FlagStage = "dev" | "internal" | "everyone";

export const FEATURE_FLAGS = {
	/** Settings > Remote: EC2 host, iPhone app, Remote Control. */
	remoteSettings: "internal",
} as const satisfies Record<string, FlagStage>;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

export type FeatureFlags = Record<FeatureFlag, boolean>;

/** Which build this is: an unpackaged run, a prerelease, or a stable release. */
export type BuildKind = "dev" | "canary" | "stable";

const STAGES_FOR: Record<BuildKind, FlagStage[]> = {
	dev: ["dev", "internal", "everyone"],
	canary: ["internal", "everyone"],
	stable: ["everyone"],
};

export function resolveFeatureFlags(build: BuildKind): FeatureFlags {
	const stages = STAGES_FOR[build];
	return Object.fromEntries(
		Object.entries(FEATURE_FLAGS).map(([flag, stage]) => [
			flag,
			stages.includes(stage),
		]),
	) as FeatureFlags;
}
