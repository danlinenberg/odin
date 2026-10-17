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
		{ name: "odin-launch-limits" },
	),
);

/** The limits alone, for the pure gate functions. */
export function launchLimits(state: LaunchLimits): LaunchLimits {
	return {
		hostCpuPercent: state.hostCpuPercent,
		minFreeMemoryGb: state.minFreeMemoryGb,
		minFreeDiskPercent: state.minFreeDiskPercent,
		maxWorkingAgents: state.maxWorkingAgents,
		oneSessionPerCheckout: state.oneSessionPerCheckout,
	};
}
