import { cn } from "@odin/ui/utils";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { HiArrowLeft } from "react-icons/hi2";
import { LuSearch } from "react-icons/lu";
import { useSettingsOriginRoute } from "renderer/stores/settings-state";
import { useSearchHotkey } from "../../../_odin/components/FeedChrome";
import {
	SCREENS,
	type SettingEntry,
	screenLabel,
	searchSettings,
} from "./settings-index";

export function SettingsSidebar() {
	const originRoute = useSettingsOriginRoute();
	const matchRoute = useMatchRoute();
	const navigate = useNavigate();
	const { ref: searchRef, hint } = useSearchHotkey();
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const results = searchSettings(query);

	const open = (entry: SettingEntry) => {
		setQuery("");
		void navigate({ to: entry.to }).then(() => revealSetting(entry.label));
	};

	return (
		<div className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar px-3 py-3">
			<Link
				to={originRoute}
				className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
			>
				<HiArrowLeft className="h-4 w-4" />
				<span>Back</span>
			</Link>

			<h1 className="mt-2 mb-3 px-2 text-lg font-semibold">Settings</h1>

			<div className="relative mb-3">
				<LuSearch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<input
					ref={searchRef}
					type="search"
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setActive(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							e.preventDefault();
							const step = e.key === "ArrowDown" ? 1 : -1;
							setActive((i) =>
								Math.min(Math.max(i + step, 0), results.length - 1),
							);
						} else if (e.key === "Enter" && results[active]) {
							open(results[active]);
						} else if (e.key === "Escape") {
							if (query) setQuery("");
							else e.currentTarget.blur();
						}
					}}
					placeholder={`Search settings${hint}`}
					aria-label="Search settings"
					className={cn(
						"h-8 w-full rounded-lg border bg-card pr-2 pl-8 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary",
						query ? "border-primary" : "border-border",
					)}
				/>
			</div>

			<nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
				{query ? (
					results.length === 0 ? (
						<p className="px-2.5 py-2 text-xs text-muted-foreground">
							No setting matches "{query}".
						</p>
					) : (
						results.map((entry, i) => (
							<button
								key={`${entry.to}:${entry.label}`}
								type="button"
								onClick={() => open(entry)}
								onMouseMove={() => setActive(i)}
								className={cn(
									"rounded-lg px-2.5 py-2 text-left transition-colors",
									i === active &&
										"bg-primary/12 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_28%,transparent)]",
								)}
							>
								<span className="block text-sm text-foreground">
									{entry.label}
								</span>
								<span className="block text-xs text-muted-foreground">
									{[screenLabel(entry.to), entry.section]
										.filter((part) => part !== entry.label)
										.join(" › ")}
								</span>
							</button>
						))
					)
				) : (
					SCREENS.map(({ to, label, hint, icon: Icon }) => {
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
					})
				)}
			</nav>
		</div>
	);
}

/**
 * Scroll a setting's row into view and flash it. Polls while its screen mounts,
 * then waits out the layout's scroll-to-top on a screen change.
 * ponytail: a fixed 80ms wait; hand the target to useScrollReset if it ever
 * loses that race.
 */
function revealSetting(label: string, framesLeft = 60) {
	const row = document.querySelector<HTMLElement>(
		`[data-setting="${CSS.escape(label)}"]`,
	);
	if (!row) {
		if (framesLeft > 0)
			requestAnimationFrame(() => revealSetting(label, framesLeft - 1));
		return;
	}
	setTimeout(() => {
		row.scrollIntoView({ block: "center", behavior: "smooth" });
		row.animate(
			[
				{
					backgroundColor:
						"color-mix(in oklab, var(--primary) 22%, transparent)",
				},
				{ backgroundColor: "transparent" },
			],
			{ duration: 1800, easing: "ease-out" },
		);
	}, 80);
}
