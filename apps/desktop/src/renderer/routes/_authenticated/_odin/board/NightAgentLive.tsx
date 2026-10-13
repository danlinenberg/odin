import { useEffect, useState } from "react";
import { LuMoon } from "react-icons/lu";
import {
	inOffHours,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";

/**
 * Board header pill while the Night Agent's window is open, so you can see
 * at a glance that it is the one starting sessions. Hidden at any other time.
 */
export function NightAgentLive({ onClick }: { onClick: () => void }) {
	const offHours = useNextInLinePrompt((s) => s.offHours);
	const started = useNextInLinePrompt((s) => s.offHoursStarted);
	// Re-check the window each minute, the runner's own tick.
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 60_000);
		return () => clearInterval(id);
	}, []);
	if (!offHours.enabled || !inOffHours(now, offHours.start, offHours.end))
		return null;
	return (
		<button
			type="button"
			onClick={onClick}
			title={`Night Agent is running until ${offHours.end}: it starts Next in line one at a time. ${started} of at most ${offHours.maxSessions} started tonight.`}
			className="flex items-center gap-1.5 rounded-full border border-primary/60 bg-primary/15 px-2.5 py-1 text-[12px] font-medium text-foreground"
		>
			<span className="relative flex size-2" aria-hidden>
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
				<span className="relative inline-flex size-2 rounded-full bg-primary" />
			</span>
			<LuMoon className="size-3.5" aria-hidden />
			Night Agent running
			<span className="text-muted-foreground tabular-nums">
				{started}/{offHours.maxSessions}
			</span>
		</button>
	);
}
