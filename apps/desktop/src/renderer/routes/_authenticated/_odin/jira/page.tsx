import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { PullRequestRow } from "lib/trpc/routers/work";
import { useMemo, useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { openUrl } from "renderer/stores/in-app-browser";
import { useTabsStore } from "renderer/stores/tabs/store";
import { DoneButton } from "../components/DoneButton";
import {
	FEED_LIST,
	FEED_ROW,
	FeedDivider,
	FeedHeader,
	FeedSearch,
	FeedSelect,
	FilterPill,
	META_DATE,
	META_PERSON,
	META_STATUS,
	META_TAG,
	META_TEXT,
	ROW_LINK_BUTTON,
	ROW_LINK_SLOT,
	ROW_LIVE_BUTTON,
	ROW_PRIMARY_SLOT,
	ROW_START_BUTTON,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { PersonChip } from "../components/PersonChip";
import { PILL } from "../components/pill";
import { DueChip, META_DUE, OverdueMark } from "../components/Reminders";
import { askSessionContext } from "../components/SessionContextDialog";
import { buildIssuePrompt } from "../feed-prompts";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { reviewPullFor } from "./review-pull";

/** A row as Done wants it: its All-feed key, and enough to list it later. */
const doable = (issue: { key: string; title: string; url: string }) => ({
	key: `jira:${issue.key}`,
	title: `${issue.key}: ${issue.title}`,
	source: "Jira",
	url: issue.url,
});

export const Route = createFileRoute("/_authenticated/_odin/jira/")({
	component: MyJiraPage,
});

/**
 * My Jira - open issues assigned to me, ones I filed (BUGT triage tickets are
 * reported by me, not assigned), and ones where a comment @-mentions me; split
 * by role, grouped by status category, with one click to start an agent session
 * on one (or jump to a running one).
 */

const CATEGORY_ORDER = ["In Progress", "To Do", "Done"];
const categoryRank = (c: string) => {
	const i = CATEGORY_ORDER.findIndex(
		(x) => x.toLowerCase() === c.toLowerCase(),
	);
	return i === -1 ? CATEGORY_ORDER.length : i;
};
const isHotPriority = (p: string | null) =>
	/highest|urgent|critical|p0|p1|high/i.test(p ?? "");

// Jira's "In Progress" category lumps Open / On Hold / In Review / rejected
// together, so the status chip is toned to say which of those are parked.
// Blue means one thing only: an Odin session is running on the ticket.
type Tone = "review" | "parked" | "idle";
const statusTone = (status: string): Tone => {
	const s = status.toLowerCase();
	if (/hold|block|reject|pend|wait|defer/.test(s)) return "parked";
	if (/review|qa|verif|test|approv/.test(s)) return "review";
	return "idle";
};
const TONE_CHIP: Record<Tone, string> = {
	review: PILL.working,
	parked: PILL.attention,
	idle: "bg-secondary text-muted-foreground",
};

function shortDate(iso: string | null): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const ROLE_TABS = [
	{ id: "assigned" as const, label: "Assigned to me" },
	{ id: "reported" as const, label: "Reported by me" },
	{ id: "mentioned" as const, label: "Mentioning me" },
	{ id: "all" as const, label: "All" },
];

/** The "why is this here" chip on every row - unless a PR on it waits on my review. */
const ROLE_BADGE = {
	assigned: { label: "mine", className: PILL.neutral },
	reported: { label: "I filed", className: PILL.neutral },
	mentioned: { label: "@me", className: PILL.attention },
};
type Role = (typeof ROLE_TABS)[number]["id"];

function MyJiraPage() {
	const [projectFilter, setProjectFilter] = useState("");
	// Default to All: BUGT tickets are reported-not-assigned, and hiding them
	// behind a tab made "my Jira" look like it was missing whole projects.
	const [role, setRole] = useState<Role>("all");
	// Free text over key, title, reporter, status and project.
	const [search, setSearch] = useState("");
	const needle = search.trim().toLowerCase();
	// Same feeds the shell warms on boot - rows are usually already cached.
	const {
		jira: issuesQuery,
		pulls: pullsQuery,
		workConfig: config,
		syncAll,
		isSyncing,
	} = useOdinFeeds();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const navigate = useNavigate();
	const panes = useTabsStore((s) => s.panes);

	// Done tickets drop out before the role tabs are counted.
	const { isDone, markDone } = useDone();
	const allIssues = useMemo(
		() =>
			(issuesQuery.data?.issues ?? []).filter(
				(issue) => !isDone({ ...doable(issue), mention: issue.mention }),
			),
		[issuesQuery.data, isDone],
	);
	const roleCounts = useMemo(
		() => ({
			assigned: allIssues.filter((i) => i.role === "assigned").length,
			reported: allIssues.filter((i) => i.role === "reported").length,
			mentioned: allIssues.filter((i) => i.role === "mentioned").length,
			all: allIssues.length,
		}),
		[allIssues],
	);
	// BUGT tickets are ones I filed, not ones assigned to me - hence the split.
	const issues = useMemo(
		() =>
			role === "all" ? allIssues : allIssues.filter((i) => i.role === role),
		[allIssues, role],
	);

	// Issue key → the pane of the session running on it (pane task titles are
	// persisted as `KEY: title`). One pass, so rows and counts share it.
	const livePaneByKey = useMemo(() => {
		const map = new Map<string, string>();
		for (const pane of Object.values(panes))
			if (!pane.completed && pane.odinTaskTitle)
				map.set(pane.odinTaskTitle.split(":")[0], pane.id);
		return map;
	}, [panes]);

	// Issue key → the open PR on it that's waiting on me (see reviewPullFor).
	const reviewPullByKey = useMemo(() => {
		const pulls = pullsQuery.data?.pulls ?? [];
		const map = new Map<string, PullRequestRow>();
		for (const issue of allIssues) {
			const pull = reviewPullFor(issue.key, pulls);
			if (pull) map.set(issue.key, pull);
		}
		return map;
	}, [allIssues, pullsQuery.data]);

	const projects = useMemo(() => {
		const counts = new Map<string, number>();
		for (const issue of issues)
			counts.set(issue.project, (counts.get(issue.project) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [issues]);

	// Group by status category (In Progress first), then keep Jira's updated order.
	const groups = useMemo(() => {
		const filtered = issues
			.filter((issue) => !projectFilter || issue.project === projectFilter)
			.filter(
				(issue) =>
					!needle ||
					`${issue.key} ${issue.title} ${issue.reporter ?? ""} ${issue.status} ${issue.project}`
						.toLowerCase()
						.includes(needle),
			);
		const byCategory = new Map<string, typeof issues>();
		for (const issue of filtered) {
			const key = issue.statusCategory;
			(byCategory.get(key) ?? byCategory.set(key, []).get(key))?.push(issue);
		}
		// Tickets with a live Odin session to the top of their group, parked ones
		// to the bottom; Jira's updated order survives inside each band.
		const rank = (issue: (typeof issues)[number]) =>
			livePaneByKey.has(issue.key)
				? 0
				: statusTone(issue.status) === "parked"
					? 2
					: 1;
		for (const rows of byCategory.values())
			rows.sort((a, b) => rank(a) - rank(b));
		return [...byCategory.entries()].sort(
			(a, b) => categoryRank(a[0]) - categoryRank(b[0]),
		);
	}, [issues, projectFilter, needle, livePaneByKey]);

	const handleStart = async (issue: (typeof issues)[number]) => {
		const title = `${issue.key}: ${issue.title}`;
		const context = await askSessionContext(title);
		if (!context) return;
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		const result = await launch({
			...context,
			key: issue.key,
			workspaceId: ensured.workspace.id,
			title,
			description: buildIssuePrompt(issue.key, issue.url, issue.title),
			contact: issue.reporter,
			brief: `${title}\n${issue.url}`,
			source: "jira",
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
				{ROLE_TABS.map((tab) => (
					<FilterPill
						key={tab.id}
						active={role === tab.id}
						count={roleCounts[tab.id]}
						onClick={() => {
							setRole(tab.id);
							setProjectFilter("");
						}}
					>
						{tab.label}
					</FilterPill>
				))}
				<div className="ml-auto flex items-center gap-2.5">
					<FeedSearch
						value={search}
						onChange={setSearch}
						label="Search Jira issues"
					/>
					{projects.length > 0 && (
						<FeedSelect
							value={projectFilter}
							onChange={setProjectFilter}
							title="Filter by project"
						>
							<option value="">All projects ({issues.length})</option>
							{projects.map(([project, count]) => (
								<option key={project} value={project}>
									{project} ({count})
								</option>
							))}
						</FeedSelect>
					)}
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={FEED_LIST}>
				{config && !config.hasJira && (
					<ConnectNotice
						provider="jira"
						text="Jira isn't connected - sign in to see the issues assigned to you."
					/>
				)}
				<FeedError error={issuesQuery.error} />
				{issuesQuery.data && issues.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						Nothing assigned to you 🎉
					</div>
				)}
				{needle && issues.length > 0 && groups.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						No issues match your search
					</div>
				)}

				{groups.map(([category, rows]) => (
					<div key={category} className="mb-1">
						<div className="flex items-center gap-2 py-1 pl-1 text-[11px] font-medium uppercase tracking-[.3px] text-muted-foreground">
							<span
								className={cn(
									"size-1.5 rounded-full",
									category.toLowerCase() === "in progress"
										? "bg-working"
										: "bg-muted-foreground",
								)}
							/>
							{category}
							<span className="rounded-[10px] bg-secondary px-1.5 font-medium text-muted-foreground">
								{rows.length}
							</span>
							{(() => {
								const live = rows.filter((r) =>
									livePaneByKey.has(r.key),
								).length;
								return live > 0 ? (
									<span className="rounded-[10px] bg-working/12 px-1.5 font-medium text-working">
										{live} live
									</span>
								) : null;
							})()}
						</div>
						<div className="flex flex-col gap-1.5">
							{rows.map((issue) => {
								const activePaneId = livePaneByKey.get(issue.key) ?? null;
								const date = shortDate(issue.updated);
								const tone = statusTone(issue.status);
								const reviewPull = reviewPullByKey.get(issue.key);
								return (
									<div
										key={issue.key}
										className={cn(
											FEED_ROW,
											activePaneId && "border-l-2 border-l-working",
											!activePaneId && tone === "parked" && "opacity-60",
										)}
									>
										{/* One line per ticket: title takes the slack, meta rides in
										    the space that used to be empty to its right. A grid, not a
										    flex row, so the mention below can sit in the title's column. */}
										<div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2.5">
											<span className="shrink-0 font-mono text-[11px] font-semibold text-muted-foreground">
												{issue.key}
											</span>
											<span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
												<OverdueMark
													itemKey={`jira:${issue.key}`}
													upstream={issue.dueDate}
												/>
												{issue.title}
											</span>
											<div className="flex shrink-0 items-center gap-2 text-[11px]">
												<span className={META_PERSON}>
													{issue.reporter && (
														<PersonChip
															name={issue.reporter}
															className="max-w-full truncate"
														/>
													)}
												</span>
												{/* What the row wants from me: a review when a PR on it
												    waits on me (click opens the PR), else why it's here. */}
												<span className={META_TAG}>
													{reviewPull ? (
														<button
															type="button"
															onClick={() => openUrl(reviewPull.url)}
															title={`Waiting on your review: ${reviewPull.repo}#${reviewPull.number} ${reviewPull.title}`}
															className={cn(
																"rounded-[5px] px-[7px] py-[1px] font-semibold",
																PILL.attention,
															)}
														>
															review
														</button>
													) : (
														<span
															className={cn(
																"rounded-[5px] px-[7px] py-[1px]",
																ROLE_BADGE[issue.role].className,
															)}
														>
															{ROLE_BADGE[issue.role].label}
														</span>
													)}
												</span>
												<span className={META_TAG}>
													{activePaneId && (
														<span
															className={cn(
																"inline-flex items-center gap-1 rounded-[5px] px-[7px] py-[1px] font-semibold",
																PILL.working,
															)}
														>
															<span className="size-1.5 animate-pulse rounded-full bg-current" />
															Live
														</span>
													)}
												</span>
												<span className={META_STATUS}>
													<span
														className={cn(
															"truncate rounded-[5px] px-[7px] py-[1px] font-semibold",
															TONE_CHIP[tone],
														)}
													>
														{issue.status}
													</span>
												</span>
												<span className={META_TAG}>
													{/* Someone asked me directly - High, whatever the ticket says. */}
													{(issue.mention ||
														(issue.priority &&
															isHotPriority(issue.priority))) && (
														<span
															className={cn(
																"rounded-[5px] px-[7px] py-[1px]",
																PILL.danger,
															)}
														>
															{issue.mention ? "High" : issue.priority}
														</span>
													)}
												</span>
												<span className={META_TEXT}>{issue.project}</span>
												<span
													title={issue.updated ?? undefined}
													className={META_DATE}
												>
													{date}
												</span>
												{/* Same key the All view sets a date under, so a
												    ticket has one due date wherever you set it. */}
												<span className={META_DUE}>
													<DueChip
														itemKey={`jira:${issue.key}`}
														title={`${issue.key}: ${issue.title}`}
														upstream={issue.dueDate}
													/>
												</span>
											</div>
											<div className="flex shrink-0 items-center gap-1.5">
												<span className={ROW_LINK_SLOT}>
													<button
														type="button"
														onClick={() => openUrl(issue.url)}
														className={ROW_LINK_BUTTON}
													>
														Ticket ↗
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
															onClick={() => void handleStart(issue)}
															className={ROW_START_BUTTON}
														>
															{launchingKey === issue.key
																? "Starting…"
																: "Start session"}
														</button>
													)}
												</span>
												<DoneButton onClick={() => markDone(doable(issue))} />
											</div>
											{/* A mention row exists because of one comment - so it
											    shows that comment, not just the ticket it sits on.
											    Column 2 keeps it under the title, not under the key. */}
											{issue.mention && (
												<div className="col-start-2 mt-1.5 line-clamp-2 select-text cursor-text text-[11.5px] leading-relaxed text-muted-foreground">
													<span className="font-semibold text-soft-foreground">
														{issue.mention.author ?? "Someone"}
														{": "}
													</span>
													{issue.mention.text}
												</div>
											)}
										</div>
									</div>
								);
							})}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
