import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { cn } from "@odin/ui/utils";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useDone } from "../hooks/useDone";
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
	const { reactions, jira, pulls, notion, emails, workConfig, notionConfig } =
		useOdinFeeds();
	// todos, not tasks: an automation runs itself, so it isn't waiting on you.
	const { todos } = useMyTasks();
	// A row put away with Done is gone from its feed, so it's gone from the
	// badge too — same keys each feed page filters on.
	const { isDone } = useDone();
	const counts = feedCounts({
		tasks: todos.filter((task) => !isDone({ key: `task:${task.id}` })).length,
		// Filtered here too, not left to the row's status: that only reads "Done"
		// after slack.setDone lands and the feed refetches, so the badge lagged.
		slack: (reactions.data?.rows ?? []).filter(
			(row) => !isDone({ key: `slack:${row.id}`, url: row.permalink }),
		),
		jira: (jira.data?.issues ?? []).filter(
			(issue) => !isDone({ key: `jira:${issue.key}`, url: issue.url }),
		),
		pulls: (pulls.data?.pulls ?? []).filter(
			(pull) => !isDone({ key: `pr:${pull.id}`, url: pull.url }),
		),
		notion: (notion.data?.rows ?? []).filter(
			(row) => !isDone({ key: `notion:${row.pageId}`, url: row.pageUrl }),
		),
		emails: (emails.data?.emails ?? []).filter(
			(email) =>
				email.junk !== true &&
				!isDone({ key: `email:${email.id}`, url: email.url }),
		),
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
		"/email": { connected: workConfig?.hasGmail, failed: emails.isError },
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
										? "bg-secondary text-foreground ring-1 ring-inset ring-border"
										: "text-muted-foreground hover:text-foreground",
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
											issue === "off" ? "bg-attention" : "bg-danger",
										)}
									/>
								)}
								{count > 0 && (
									<span
										className={cn(
											"rounded-[10px] px-1.5 text-[11px] font-semibold tabular-nums",
											isActive
												? "bg-accent text-soft-foreground"
												: "bg-secondary text-muted-foreground",
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
