import { create } from "zustand";
import { persist } from "zustand/middleware";

type IdleCompactState = {
	enabled: boolean;
	setEnabled: (enabled: boolean) => void;
};

/**
 * v0 was a delay in minutes after a session left Working, 0 = never. The
 * trigger is the move into Idle now, so any delay you had set means on.
 */
export function migrateIdleCompact(
	state: unknown,
	version: number,
): { enabled: boolean } {
	const s = (state ?? {}) as { enabled?: boolean; minutes?: number };
	if (version < 1) return { enabled: (s.minutes ?? 0) > 0 };
	return { enabled: s.enabled ?? false };
}

/**
 * Settings → Sessions: whether the board types /compact into a session the
 * moment its card moves into Idle. Off by default. Renderer localStorage for
 * the same reason as idle-close: the board is the only reader.
 */
export const useIdleCompact = create<IdleCompactState>()(
	persist(
		(set) => ({ enabled: false, setEnabled: (enabled) => set({ enabled }) }),
		{
			name: "odin-idle-compact",
			version: 1,
			migrate: (state, version) =>
				migrateIdleCompact(state, version) as IdleCompactState,
		},
	),
);
