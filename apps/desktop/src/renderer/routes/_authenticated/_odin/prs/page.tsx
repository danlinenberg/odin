import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	FEED_LIST,
	FEED_ROW,
	FeedDivider,
	FeedHeader,
	FilterPill,
	META_DATE,
	META_PERSON,
	META_TAG,
	META_TEXT,
	ROW_LINK_BUTTON,
	ROW_LINK_SLOT,
	ROW_LIVE_BUTTON,
	ROW_META,
	ROW_PRIMARY_BUTTON,
	ROW_PRIMARY_SLOT,
	RowActions,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { isBot } from "../components/feed-counts";
import {
	HiddenToggle,
	HideButton,
	useHiddenFilter,
} from "../components/HiddenItems";
import { PersonChip } from "../components/PersonChip";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePendingFocus } from "../hooks/usePendingFocus";

export const Route = createFileRoute("/_authenticated/_odin/prs/")({
	component: MyPullRequestsPage,
});

/**
 * My PRs — open pull requests I opened, plus ones waiting on my review, with a
 * click to start an agent session on one (review it, or push the fix).
 */

const KIND_TABS = [
	{ id: "review" as const, label: "To review" },
	{ id: "mine" as const, label: "Mine" },
];
type Kind = (typeof KIND_TABS)[number]["id"];

function buildReviewPrompt(
	url: string,
	title: string,
	repo: string,
	kind: Kind,
): string {
	const shared = [
		`Pull request: ${url}`,
		`Repo: ${repo}`,
		`Title: ${title}`,
		"",
		"PHASE 1 — READ (do this first):",
		"- Read the PR: description, the full diff, CI status, and existing review comments.",
		"- Check out the branch locally if you need to run or trace anything.",
		"",
	];
	return kind === "review"
		? [
				`Review this pull request: ${title}`,
				...shared,
				"PHASE 2 — REVIEW:",
				"- Look for correctness bugs first, then missing tests, then simplifications.",
				"- Report findings with file:line and a concrete fix for each.",
				"",
				"Rules: do NOT post the review to GitHub — leave it here for me to send.",
			].join("\n")
		: [
				`Work on my pull request: ${title}`,
				...shared,
				"PHASE 2 — EXECUTE:",
				"- Address outstanding review comments and failing CI.",
				"- Verify your changes, then summarise what's left.",
				"",
				"Rules: do NOT merge, and do NOT comment on GitHub — everything stays here for review.",
			].join("\n");
}

function shortDate(iso: string | null): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function MyPullRequestsPage() {
	const [kind, setKind] = useState<Kind>("review");
	const [repoFilter, setRepoFilter] = useState("");
	// Same feeds the shell warms on boot — rows are usually already cached.
	const {
		pulls: pullsQuery,
		workConfig: config,
		syncAll,
		isSyncing,
	} = useOdinFeeds();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const navigate = useNavigate();
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const panes = useTabsStore((s) => s.panes);

	// Bot PRs (renovate, CI workflow rollouts) can be dozens of identical rows
	// that bury the human reviews — hidden by default, one click to show.
	const [showBots, setShowBots] = useState(false);

	// Hidden PRs drop out first, so the bot count and tab counts agree with
	// what's on screen.
	const hide = useHiddenFilter("pr", pullsQuery.data?.pulls ?? [], (pull) =>
		String(pull.id),
	);
	const allPulls = hide.rows;
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
		}),
		[pulls],
	);

	// A session already running for this PR (pane title carries "repo#number").
	const activePaneForPull = (repo: string, number: number): string | null => {
		const tag = `${repo}#${number}`;
		return (
			Object.values(panes).find(
				(pane) => !pane.completed && pane.odinTaskTitle?.includes(tag),
			)?.id ?? null
		);
	};

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
				.filter((pull) => !repoFilter || pull.repo === repoFilter),
		[pulls, kind, repoFilter],
	);

	const handleStart = async (pull: (typeof pulls)[number]) => {
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		const title = `${pull.repo}#${pull.number}: ${pull.title}`;
		const result = await launch({
			key: pull.url,
			workspaceId: ensured.workspace.id,
			title,
			description: buildReviewPrompt(
				pull.url,
				pull.title,
				pull.repo,
				pull.kind,
			),
			contact: pull.author,
			brief: `${title}\n${pull.url}`,
			source: "pr",
		});
		if (result.ok) {
			usePendingFocus.getState().focus(result.paneId);
			navigate({ to: "/board" });
		} else {
			toast.error(result.error);
		}
	};

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
					{botCount > 0 && (
						<button
							type="button"
							onClick={() => setShowBots((v) => !v)}
							className="shrink-0 text-[12px] text-[#8a8a97] transition-colors hover:text-[#a5a5b3]"
						>
							{showBots ? "hide" : "show"} bot PRs ({botCount})
						</button>
					)}
					<HiddenToggle
						count={hide.hiddenCount}
						showing={hide.showHidden}
						onToggle={() => hide.setShowHidden(!hide.showHidden)}
					/>
					{repos.length > 0 && (
						<select
							value={repoFilter}
							onChange={(e) => setRepoFilter(e.target.value)}
							title="Filter by repo"
							className={cn(
								"cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium outline-none",
								repoFilter
									? "border-[#a394ff] bg-[#211d3a] text-[#f5f5f7]"
									: "border-[#25252e] bg-[#16161b] text-[#a5a5b3] hover:text-[#f5f5f7]",
							)}
						>
							<option value="">All repos</option>
							{repos.map(([repo, count]) => (
								<option key={repo} value={repo}>
									{repo} ({count})
								</option>
							))}
						</select>
					)}
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={FEED_LIST}>
				{config && !config.hasGithub && (
					<ConnectNotice
						provider="github"
						text="GitHub isn't connected — sign in to see your pull requests and review requests."
					/>
				)}
				<FeedError error={pullsQuery.error} />
				{pullsQuery.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						{kind === "review"
							? "No PRs waiting on your review 🎉"
							: "You have no open PRs"}
					</div>
				)}

				{rows.map((pull) => {
					const activePaneId = activePaneForPull(pull.repo, pull.number);
					const date = shortDate(pull.updated);
					return (
						<div
							key={pull.id}
							className={cn(FEED_ROW, hide.isHidden(pull) && "opacity-40")}
						>
							<div className="flex items-center gap-3">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="font-mono text-[11px] font-semibold text-[#a394ff]">
											#{pull.number}
										</span>
										<span className="truncate text-[13px] font-semibold text-[#f5f5f7]">
											{pull.title}
										</span>
										{pull.draft && (
											<span className="shrink-0 rounded-[5px] bg-[#1f1f27] px-[7px] text-[10px] font-semibold uppercase text-[#a5a5b3]">
												draft
											</span>
										)}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-2 text-[11px]">
									<span className={META_PERSON}>
										{pull.author && (
											<PersonChip
												name={pull.author}
												className="max-w-full truncate"
											/>
										)}
									</span>
									<span className={META_TAG}>
										{pull.comments > 0 && (
											<span className={ROW_META}>💬 {pull.comments}</span>
										)}
									</span>
									<span className={META_TEXT}>{pull.repo}</span>
									<span title={pull.updated ?? undefined} className={META_DATE}>
										{date}
									</span>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									<span className={ROW_LINK_SLOT}>
										<button
											type="button"
											onClick={() => openUrl.mutate(pull.url)}
											className={ROW_LINK_BUTTON}
										>
											PR ↗
										</button>
									</span>
									<span className={ROW_PRIMARY_SLOT}>
										{activePaneId ? (
											<button
												type="button"
												onClick={() => {
													usePendingFocus.getState().focus(activePaneId);
													navigate({ to: "/board" });
												}}
												className={ROW_LIVE_BUTTON}
											>
												Go to session →
											</button>
										) : (
											<button
												type="button"
												disabled={isLaunching}
												onClick={() => void handleStart(pull)}
												className={ROW_PRIMARY_BUTTON}
											>
												{launchingKey === pull.url
													? "Starting…"
													: kind === "review"
														? "Review it"
														: "Start session"}
											</button>
										)}
									</span>
									<RowActions>
										<HideButton
											hidden={hide.isHidden(pull)}
											onClick={() => hide.toggle(pull)}
										/>
									</RowActions>
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
