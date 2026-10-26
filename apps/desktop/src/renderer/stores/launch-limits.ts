import { DEFAULT_LAUNCH_LIMITS, type LaunchLimits } from "shared/machine-load";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface LaunchLimitsState extends LaunchLimits {
	setLimits: (limits: Partial<LaunchLimits>) => void;
}

/**
 * Settings → Sessions: the launch gate's CPU, memory, disk, session-count and
 * one-per-checkout limits.
 */
export const useLaunchLimits = create<LaunchLimitsState>()(
	persist(
		(set) => ({
			...DEFAULT_LAUNCH_LIMITS,
			setLimits: (limits) => set(limits),
		}),
		// A saved choice wins over the default, so only new installs start with
		// one-session-per-repo off.
		{
			name: "odin-launch-limits",
			version: 1,
			// v0 held disk as a percent; a saved 0 (no limit) stays 0, anything
			// else takes the GB default.
			migrate: (state) => {
				const { minFreeDiskPercent, ...rest } = state as LaunchLimits & {
					minFreeDiskPercent?: number;
				};
				return {
					...rest,
					minFreeDiskGb:
						minFreeDiskPercent === 0 ? 0 : DEFAULT_LAUNCH_LIMITS.minFreeDiskGb,
				} as LaunchLimitsState;
			},
		},
	),
);

/** The limits alone, for the pure gate functions. */
export function launchLimits(state: LaunchLimits): LaunchLimits {
	return {
		hostCpuPercent: state.hostCpuPercent,
		minFreeMemoryGb: state.minFreeMemoryGb,
		minFreeDiskGb: state.minFreeDiskGb,
		maxWorkingAgents: state.maxWorkingAgents,
		oneSessionPerCheckout: state.oneSessionPerCheckout,
	};
}
