import {
	DEFAULT_OFF_HOURS,
	type NightLogEntry,
	type OffHours,
} from "shared/night-agent";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export {
	DEFAULT_OFF_HOURS,
	inOffHours,
	type NightLogEntry,
	type OffHours,
} from "shared/night-agent";

/** About a week of nights; the oldest lines drop first. */
const MAX_NIGHT_LOG = 300;

/** A cap on picks, so the saved list stays a few hundred bytes. */
export const MAX_NIGHT_PICKS = 20;

/**
 * The sources Next in line is built from - the only rows the Night Agent can
 * start. An email or ClickUp row picked for tonight would never start.
 */
const NIGHT_SOURCES = new Set(["Tasks", "Slack", "Jira", "GitHub", "Notion"]);

/** Whether the Night Agent can start this row. */
export function canPickForTonight(item: { source: string }): boolean {
	return NIGHT_SOURCES.has(item.source);
}

/** Adds or removes a row from tonight's picks. Adding is refused at the cap. */
export function toggleNightPick(key: string): void {
	const { offHours, setOffHours } = useNextInLinePrompt.getState();
	const picked = offHours.picked;
	if (picked.includes(key)) {
		setOffHours({ picked: picked.filter((pick) => pick !== key) });
	} else if (picked.length < MAX_NIGHT_PICKS) {
		setOffHours({ picked: [...picked, key] });
	}
}

/**
 * Settings → Backlog's "how to sort it": your own words, handed to the
 * model with every ranking. Empty = the model judges importance by itself.
 *
 * Renderer storage, same reason as launch-limits: the only reader is the
 * board, which sends it along in the ranking call.
 */
export const useNextInLinePrompt = create<{
	prompt: string;
	setPrompt: (prompt: string) => void;
	/** How long past its date a task still pins under Due. */
	pinOverdueDays: number;
	setPinOverdueDays: (days: number) => void;
	/** Night Agent: work through Next in line, one session at a time, overnight. */
	offHours: OffHours;
	setOffHours: (patch: Partial<OffHours>) => void;
	/** Sessions started in the current window - reset once it closes. */
	offHoursStarted: number;
	setOffHoursStarted: (count: number) => void;
	/** Whether this window has started a pick - reset once it closes. */
	offHoursFromPicks: boolean;
	setOffHoursFromPicks: (fromPicks: boolean) => void;
	/** What each tick decided, newest last. A repeat of the last line isn't added. */
	nightLog: NightLogEntry[];
	logNight: (event: string) => void;
	/** When the runner last ticked, so a gap (Odin shut, computer asleep) shows. */
	nightLastTick: string;
	setNightLastTick: (at: string) => void;
}>()(
	persist(
		(set) => ({
			prompt: "",
			setPrompt: (prompt) => set({ prompt }),
			pinOverdueDays: 30,
			setPinOverdueDays: (pinOverdueDays) => set({ pinOverdueDays }),
			offHours: DEFAULT_OFF_HOURS,
			setOffHours: (patch) =>
				set((state) => ({ offHours: { ...state.offHours, ...patch } })),
			offHoursStarted: 0,
			setOffHoursStarted: (offHoursStarted) => set({ offHoursStarted }),
			offHoursFromPicks: false,
			setOffHoursFromPicks: (offHoursFromPicks) => set({ offHoursFromPicks }),
			nightLog: [],
			logNight: (event) =>
				set((state) =>
					state.nightLog.at(-1)?.event === event
						? state
						: {
								nightLog: [
									...state.nightLog,
									{ at: new Date().toISOString(), event },
								].slice(-MAX_NIGHT_LOG),
							},
				),
			nightLastTick: "",
			setNightLastTick: (nightLastTick) => set({ nightLastTick }),
		}),
		{
			name: "odin-next-in-line-prompt",
			// A profile saved before Night Agent existed gets the defaults, not undefined.
			merge: (saved, current) => {
				const persisted = saved as Partial<typeof current> | undefined;
				return {
					...current,
					...persisted,
					offHours: {
						...DEFAULT_OFF_HOURS,
						// Already turned on before the notice existed: it was their first time.
						introSeen: !!persisted?.offHours?.enabled,
						...persisted?.offHours,
					},
				};
			},
		},
	),
);
