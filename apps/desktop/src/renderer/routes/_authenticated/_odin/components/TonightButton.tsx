import { cn } from "@odin/ui/utils";
import { LuMoon } from "react-icons/lu";
import {
	canPickForTonight,
	MAX_NIGHT_PICKS,
	toggleNightPick,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { useNightAgentIntro } from "../board/NightAgentIntro";
import { ROW_LINK_BUTTON } from "./FeedChrome";

/**
 * Tonight on a Tasks row: the same pick as the moon on Next in line, so a
 * task can go to the Night Agent from the list you're already reading.
 */
export function TonightButton({
	item,
}: {
	item: { key: string; source: string };
}) {
	const picked = useNextInLinePrompt((s) => s.offHours.picked);
	// ponytail: one closed dialog per row - cheap at a few hundred rows.
	const nightIntro = useNightAgentIntro();
	if (!canPickForTonight(item)) return null;
	const on = picked.includes(item.key);
	const full = !on && picked.length >= MAX_NIGHT_PICKS;
	return (
		<>
			<button
				type="button"
				onClick={() =>
					on
						? toggleNightPick(item.key)
						: nightIntro.gate(() => toggleNightPick(item.key))
				}
				disabled={full}
				aria-pressed={on}
				title={
					on
						? "Take off tonight's picks"
						: full
							? `Tonight's picks are full (${MAX_NIGHT_PICKS})`
							: "Pick for tonight - the Night Agent starts picks first"
				}
				className={cn(
					ROW_LINK_BUTTON,
					"inline-flex items-center gap-1 disabled:opacity-40",
					on && "text-primary",
				)}
			>
				<LuMoon className="size-3" aria-hidden />
				{on ? "Tonight ✓" : "Tonight"}
			</button>
			{nightIntro.dialog}
		</>
	);
}
