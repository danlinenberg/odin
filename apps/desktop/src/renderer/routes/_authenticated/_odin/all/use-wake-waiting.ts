import { toast } from "@odin/ui/sonner";
import { useEffect } from "react";
import { dayOf } from "../components/Reminders";
import { useTaskMeta } from "./task-meta";

/**
 * On launch and every minute after: a row waiting on someone else whose day
 * has come goes back on top of Up next, with a note saying so. Mounted with
 * the due-date pings, so it runs whatever screen is open.
 */
export function useWakeWaiting(): void {
	useEffect(() => {
		const tick = () => {
			const before = useTaskMeta.getState().waiting;
			const keys = useTaskMeta.getState().wake(dayOf(Date.now()));
			if (!keys.length) return;
			const titles = keys.map((key) => before[key]?.title || "A task");
			toast.info(
				keys.length === 1
					? "Back on Up next - its wait is over"
					: `${keys.length} tasks back on Up next - their wait is over`,
				{ description: titles.join("\n") },
			);
		};
		tick();
		const id = setInterval(tick, 60_000);
		return () => clearInterval(id);
	}, []);
}
