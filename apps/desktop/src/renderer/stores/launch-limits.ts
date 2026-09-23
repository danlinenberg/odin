import { DEFAULT_LAUNCH_LIMITS, type LaunchLimits } from "shared/machine-load";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface LaunchLimitsState extends LaunchLimits {
	setLimits: (limits: Partial<LaunchLimits>) => void;
}

/**
 * Settings → Board's CPU and memory limits for the launch gate.
 *
 * ponytail: renderer localStorage, not a settings procedure — every reader
 * (launch, queue, header chip) lives in the renderer, and a new main-process
 * procedure only goes live after a restart that kills every session.
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
	};
}
