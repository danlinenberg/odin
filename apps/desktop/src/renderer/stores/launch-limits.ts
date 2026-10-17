import { DEFAULT_LAUNCH_LIMITS, type LaunchLimits } from "shared/machine-load";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface LaunchLimitsState extends LaunchLimits {
	setLimits: (limits: Partial<LaunchLimits>) => void;
}

/**
 * Settings → Sessions: the launch gate's CPU, memory, disk, session-count and
 * one-per-checkout limits.
 *
 * ponytail: renderer localStorage, not a settings procedure - every reader
 * (launch, queue, header chip) lives in the renderer, and a new main-process
 * procedure only goes live after a restart that kills every session.
 */
export const useLaunchLimits = create<LaunchLimitsState>()(
	persist(
		(set) => ({
			...DEFAULT_LAUNCH_LIMITS,
			setLimits: (limits) => set(limits),
		}),
		{
			name: "odin-launch-limits",
			// v0 saved one-session-per-repo on by default.
			version: 1,
			migrate: (persisted, version) =>
				migrateLaunchLimits(persisted, version) as LaunchLimitsState,
		},
	),
);

/**
 * Persisted state from an older version, brought up to today's shape. v0
 * wrote `oneSessionPerCheckout: true` for everyone who never touched it, so
 * it can't tell them from someone who turned it on: all get the new default.
 */
export function migrateLaunchLimits(
	persisted: unknown,
	version: number,
): unknown {
	const state = persisted as Partial<LaunchLimits> | undefined;
	if (version < 1 && state)
		state.oneSessionPerCheckout = DEFAULT_LAUNCH_LIMITS.oneSessionPerCheckout;
	return state;
}

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
