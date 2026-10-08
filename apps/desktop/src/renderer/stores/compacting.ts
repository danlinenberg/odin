import { create } from "zustand";

/** When each pane's running compaction began - Claude's PreCompact hook. */
export const useCompacting = create<{
	since: Record<string, number>;
	mark: (paneId: string, at: number | null) => void;
}>()((set) => ({
	since: {},
	mark: (paneId, at) =>
		set((state) => {
			const { [paneId]: _, ...rest } = state.since;
			return { since: at === null ? rest : { ...rest, [paneId]: at } };
		}),
}));
