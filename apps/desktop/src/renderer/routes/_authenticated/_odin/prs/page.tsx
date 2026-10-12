import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import {
	TABLE_LIST,
	TaskRow,
	TaskTableHeader,
	useTaskRows,
} from "../all/TaskTable";
import { useFeedItems } from "../all/use-all-items";
import {
	FeedDivider,
	FeedHeader,
	FeedSearch,
	FeedSelect,
	FilterPill,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { isBot } from "../components/feed-counts";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";

/** A row as Done wants it: its All-feed key, and enough to list it later. */
const doable = (pull: {
	id: number | string;
	repo: string;
	number: number;
	title: string;
	url: string;
}) => ({
	key: `pr:${pull.id}`,
	title: `${pull.repo}#${pull.number}: ${pull.title}`,
	source: "GitHub",
	url: pull.url,
});

export const Route = createFileRoute("/_authenticated/_odin/prs/")({
	component: MyPullRequestsPage,
});

/**
 * My PRs - open pull requests I opened, plus ones waiting on my review, with a
 * click to start an agent session on one (review it, or push the fix).
 */

const KIND_TABS = [
	{ id: "review" as const, label: "To review" },
	{ id: "mine" as const, label: "Mine" },
	{ id: "mentioned" as const, label: "Mentions" },
];
type Kind = (typeof KIND_TABS)[number]["id"];

function MyPullRequestsPage() {
	const [kind, setKind] = useState<Kind>("review");
	const [repoFilter, setRepoFilter] = useState("");
	// Free text over title, author, repo and number.
	const [search, setSearch] = useState("");
	const needle = search.trim().toLowerCase();
	// Same feeds the shell warms on boot - rows are usually already cached.
	const {
		pulls: pullsQuery,
		workConfig: config,
		syncAll,
		isSyncing,
	} = useOdinFeeds();

	// Bot PRs (renovate, CI workflow rollouts) can be dozens of identical rows
	// that bury the human reviews - hidden by default, one click to show.
	const [showBots, setShowBots] = useState(false);

	// Hidden PRs drop out first, so the bot count and tab counts agree with
	// what's on screen.
	const { isDone } = useDone();
	const allPulls = useMemo(
		() =>
			(pullsQuery.data?.pulls ?? []).filter((pull) => !isDone(doable(pull))),
		[pullsQuery.data, isDone],
	);
	const pulls = useMemo(
		() => (showBots ? allPulls : allPulls.filter((p) => !isBot(p.author))),
		[allPulls, showBots],
	);
	const botCount = useMemo(
		() => allPulls.filter((p) => isBot(p.author)).length,
		[allPulls],
	);
	const counts = useMemo(
		() => ({
			review: pulls.filter((pull) => pull.kind === "review").length,
			mine: pulls.filter((pull) => pull.kind === "mine").length,
			mentioned: pulls.filter((pull) => pull.kind === "mentioned").length,
		}),
		[pulls],
	);

	const repos = useMemo(() => {
		const counts = new Map<string, number>();
		for (const pull of pulls.filter((p) => p.kind === kind))
			counts.set(pull.repo, (counts.get(pull.repo) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [pulls, kind]);

	const rows = useMemo(
		() =>
			pulls
				.filter((pull) => pull.kind === kind)
				.filter((pull) => !repoFilter || pull.repo === repoFilter)
				.filter(
					(pull) =>
						!needle ||
						`${pull.title} ${pull.author ?? ""} ${pull.repo} #${pull.number}`
							.toLowerCase()
							.includes(needle),
				),
		[pulls, kind, repoFilter, needle],
	);

	const items = useFeedItems({ pulls: allPulls });
	const taskRows = useTaskRows();
	const now = Date.now();

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				{KIND_TABS.map((tab) => (
					<FilterPill
						key={tab.id}
						active={kind === tab.id}
						count={counts[tab.id]}
						onClick={() => {
							setKind(tab.id);
							setRepoFilter("");
						}}
					>
						{tab.label}
					</FilterPill>
				))}
				<div className="ml-auto flex items-center gap-2.5">
					<FeedSearch
						value={search}
						onChange={setSearch}
						label="Search pull requests"
					/>
					{botCount > 0 && (
						<button
							type="button"
							onClick={() => setShowBots((v) => !v)}
							className="shrink-0 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
						>
							{showBots ? "hide" : "show"} bot PRs ({botCount})
						</button>
					)}
					{repos.length > 0 && (
						<FeedSelect
							value={repoFilter}
							onChange={setRepoFilter}
							title="Filter by repo"
						>
							<option value="">All repos</option>
							{repos.map(([repo, count]) => (
								<option key={repo} value={repo}>
									{repo} ({count})
								</option>
							))}
						</FeedSelect>
					)}
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={TABLE_LIST}>
				{config && !config.hasGithub && (
					<ConnectNotice
						provider="github"
						text="GitHub isn't connected - sign in to see your pull requests and review requests."
					/>
				)}
				<FeedError error={pullsQuery.error} />
				{pullsQuery.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						{needle
							? "No PRs match your search"
							: kind === "review"
								? "No PRs waiting on your review 🎉"
								: kind === "mentioned"
									? "Nobody has mentioned you"
									: "You have no open PRs"}
					</div>
				)}

				{rows.length > 0 && <TaskTableHeader />}
				{rows.map((pull) => {
					const item = items.get(`pr:${pull.id}`);
					return (
						item && (
							<TaskRow key={item.key} item={item} rows={taskRows} now={now} />
						)
					);
				})}
			</div>
		</div>
	);
}
