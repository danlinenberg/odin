import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { cn } from "@odin/ui/utils";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";
import { FEED_TABS, feedCounts, feedIssues } from "./feed-counts";

/**
 * The one Tasks tab, from the inside: a strip that sits where each feed's title
 * used to, so All / Tasks / Slack / Jira / PRs / Notion are one place you
 * switch sources in rather than a rail icon each to hunt between. Each source
 * shows as its own mark — six words of chrome was more than the header could
 * spend — with the name in a tooltip.
 */
export function FeedTabs() {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	// Same queries the shell warms on boot — React Query serves them from cache,
	// so the badges cost nothing beyond a render.
	const { reactions, jira, pulls, notion, workConfig, notionConfig } =
		useOdinFeeds();
	const { tasks } = useMyTasks();
	const counts = feedCounts({
		tasks: tasks.length,
		slack: reactions.data?.rows ?? [],
		jira: jira.data?.issues ?? [],
		pulls: pulls.data?.pulls ?? [],
		notion: notion.data?.rows ?? [],
	});

	// A tab that's empty because its account is signed out — or because its
	// token stopped working — shouldn't read as "nothing to do". Every signal
	// here is already in the feeds' cache, so saying so costs no extra probe.
	const issues = feedIssues({
		"/reactions": {
			connected: reactions.data?.connected,
			failed: reactions.isError || !!reactions.data?.syncError,
		},
		"/jira": { connected: workConfig?.hasJira, failed: jira.isError },
		"/prs": { connected: workConfig?.hasGithub, failed: pulls.isError },
		"/notion": { connected: notionConfig?.hasToken, failed: notion.isError },
	});

	const active = FEED_TABS.find((tab) => !!matchRoute({ to: tab.to }))?.to;

	return (
		<div className="flex items-center gap-0.5">
			{FEED_TABS.map(({ to, label, Icon }) => {
				const isActive = active === to;
				const count = counts[to];
				const issue = issues[to];
				const note =
					issue === "off"
						? "not connected"
						: issue === "error"
							? "not working"
							: null;
				return (
					<Tooltip key={to} delayDuration={300}>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={note ? `${label} — ${note}` : label}
								aria-current={isActive ? "page" : undefined}
								onClick={() => navigate({ to })}
								className={cn(
									"relative flex items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-[13px] font-semibold transition-colors",
									isActive
										? "bg-[#25252e] text-[#f5f5f7]"
										: "text-[#8a8a97] hover:text-[#f5f5f7]",
								)}
							>
								<Icon
									className={cn("size-[15px]", issue === "off" && "opacity-40")}
								/>
								{issue && (
									<span
										aria-hidden
										className={cn(
											"absolute right-1 top-1 size-[5px] rounded-full",
											// Amber: nothing signed in. Red: signed in, but the feed
											// is failing — the tab itself carries the reason.
											issue === "off" ? "bg-[#f5b83d]" : "bg-[#f0647a]",
										)}
									/>
								)}
								{count > 0 && (
									<span
										className={cn(
											"rounded-[10px] px-1.5 text-[11px] font-semibold tabular-nums",
											isActive
												? "bg-[#35353f] text-[#c8c8d2]"
												: "bg-[#1f1f27] text-[#8a8a97]",
										)}
									>
										{/* A 670-row Notion database shouldn't set the strip's width. */}
										{count > 99 ? "99+" : count}
									</span>
								)}
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{note ? `${label} — ${note}` : label}
						</TooltipContent>
					</Tooltip>
				);
			})}
		</div>
	);
}
