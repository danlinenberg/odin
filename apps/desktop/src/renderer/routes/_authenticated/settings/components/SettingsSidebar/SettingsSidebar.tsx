import { cn } from "@odin/ui/utils";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { HiArrowLeft } from "react-icons/hi2";
import {
	LuBell,
	LuKeyboard,
	LuListOrdered,
	LuPlug,
	LuSquareTerminal,
} from "react-icons/lu";
import { useSettingsOriginRoute } from "renderer/stores/settings-state";

/**
 * Odin's settings screens, each with the things on it spelled out underneath,
 * so you can tell where a setting lives without opening every screen. The
 * inherited workspace sections keep their routes but have no entry here.
 */
const SCREENS = [
	{
		to: "/settings/connections",
		label: "Connections",
		hint: "Profiles, accounts, iCloud backup",
		icon: LuPlug,
	},
	{
		to: "/settings/sessions",
		label: "Sessions",
		hint: "Default repo, launch limits, idle close",
		icon: LuSquareTerminal,
	},
	{
		to: "/settings/backlog",
		label: "Backlog",
		hint: "Next in line, Night Agent, Review sweep",
		icon: LuListOrdered,
	},
	{
		to: "/settings/ringtones",
		label: "Notifications",
		hint: "Banners, sound, reminder time",
		icon: LuBell,
	},
	{
		to: "/settings/keyboard",
		label: "Keyboard",
		hint: "Shortcuts for every screen",
		icon: LuKeyboard,
	},
] as const;

export function SettingsSidebar() {
	const originRoute = useSettingsOriginRoute();
	const matchRoute = useMatchRoute();

	return (
		<div className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar px-3 py-3">
			<Link
				to={originRoute}
				className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
			>
				<HiArrowLeft className="h-4 w-4" />
				<span>Back</span>
			</Link>

			<h1 className="mt-2 mb-4 px-2 text-lg font-semibold">Settings</h1>

			<nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
				{SCREENS.map(({ to, label, hint, icon: Icon }) => {
					const isActive = !!matchRoute({ to, fuzzy: true });
					return (
						<Link
							key={to}
							to={to}
							className={cn(
								"group flex items-start gap-3 rounded-lg px-2.5 py-2 transition-colors",
								isActive
									? "bg-primary/12 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_28%,transparent)]"
									: "hover:bg-accent/60",
							)}
						>
							<Icon
								className={cn(
									"mt-0.5 size-4 shrink-0",
									isActive
										? "text-primary"
										: "text-muted-foreground group-hover:text-foreground",
								)}
							/>
							<span className="min-w-0">
								<span
									className={cn(
										"block text-sm",
										isActive
											? "font-medium text-foreground"
											: "text-soft-foreground",
									)}
								>
									{label}
								</span>
								<span className="block text-xs leading-snug text-muted-foreground">
									{hint}
								</span>
							</span>
						</Link>
					);
				})}
			</nav>
		</div>
	);
}
