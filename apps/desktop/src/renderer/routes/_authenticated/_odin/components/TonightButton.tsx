import { cn } from "@odin/ui/utils";
import { LuMoon } from "react-icons/lu";
import {
	canPickForTonight,
	MAX_NIGHT_PICKS,
	toggleNightPick,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { useNightAgentIntro } from "../board/NightAgentIntro";
import { IconTip, ROW_ICON_BUTTON, ROW_LINK_BUTTON } from "./FeedChrome";

/**
 * Tonight on a Tasks row: the same pick as the moon on Next in line, so a
 * task can go to the Night Agent from the list you're already reading.
 */
export function TonightButton({
	item,
	iconOnly = false,
}: {
	item: { key: string; source: string };
	/** The moon alone - a table row's action column. */
	iconOnly?: boolean;
}) {
	const picked = useNextInLinePrompt((s) => s.offHours.picked);
	const nightIntro = useNightAgentIntro();
	if (!canPickForTonight(item)) return null;
	const on = picked.includes(item.key);
	const full = !on && picked.length >= MAX_NIGHT_PICKS;
	const label = on
		? "Take off tonight's picks"
		: full
			? `Tonight's picks are full (${MAX_NIGHT_PICKS})`
			: "Pick for tonight - the Night Agent starts picks first";
	const button = (
		<button
			type="button"
			onClick={() =>
				on
					? toggleNightPick(item.key)
					: nightIntro.gate(() => toggleNightPick(item.key))
			}
			disabled={full}
			aria-pressed={on}
			title={iconOnly ? undefined : label}
			aria-label={label}
			className={cn(
				iconOnly ? ROW_ICON_BUTTON : ROW_LINK_BUTTON,
				"inline-flex items-center gap-1 disabled:opacity-40",
				on && "text-primary",
			)}
		>
			<LuMoon className={iconOnly ? "size-3.5" : "size-3"} aria-hidden />
			{!iconOnly && (on ? "Tonight ✓" : "Tonight")}
		</button>
	);
	return (
		<>
			{iconOnly ? <IconTip label={label}>{button}</IconTip> : button}
			{nightIntro.dialog}
		</>
	);
}
