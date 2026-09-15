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
	META_STATUS,
	META_TAG,
	META_TEXT,
	ROW_LINK_BUTTON,
	ROW_LINK_SLOT,
	ROW_LIVE_BUTTON,
	ROW_PRIMARY_BUTTON,
	ROW_PRIMARY_SLOT,
	RowActions,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import {
	HiddenToggle,
	HideButton,
	useHiddenFilter,
} from "../components/HiddenItems";
import { PersonChip } from "../components/PersonChip";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePendingFocus } from "../hooks/usePendingFocus";

export const Route = createFileRoute("/_authenticated/_odin/jira/")({
	component: MyJiraPage,
});

/**
 * My Jira — open issues assigned to me, ones I filed (BUGT triage tickets are
 * reported by me, not assigned), and ones where a comment @-mentions me; split
 * by role, grouped by status category, with one click to start an agent session
 * on one (or jump to a running one).
 */

/** Investigate-first prompt, so the agent reads the ticket before touching code. */
function buildIssuePrompt(key: string, url: string, title: string): string {
	return [
		`This task is Jira issue ${key}: ${title}`,
		`Ticket: ${url}`,
		"",
		"PHASE 1 — UNDERSTAND (do this first):",
		`- Read ${key} in full: description, acceptance criteria, comments, linked issues and attachments.`,
		"- If the repo isn't obvious from the ticket, work it out from the code before changing anything.",
		"",
		"PHASE 2 — EXECUTE:",
		"- Investigate the root cause, make the change, and verify it when practical.",
		"",
		"Rules: do NOT comment on the ticket or move it — everything stays in this session for review.",
	].join("\n");
}

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
// Green means one thing only: an Odin session is running on the ticket.
type Tone = "review" | "parked" | "idle";
const statusTone = (status: string): Tone => {
	const s = status.toLowerCase();
	if (/hold|block|reject|pend|wait|defer/.test(s)) return "parked";
	if (/review|qa|verif|test|approv/.test(s)) return "review";
	return "idle";
};
const TONE_CHIP: Record<Tone, string> = {
	review: "bg-[#16283a] text-[#7ec4ff]",
	parked: "bg-[#221d12] text-[#f5b83d]",
	idle: "bg-[#1f1f27] text-[#a5a5b3]",
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

/** The "why is this here" chip the All view puts on every row. */
const ROLE_BADGE = {
	assigned: { label: "mine", className: "bg-[#14301f] text-[#3ecf8e]" },
	reported: { label: "I filed", className: "bg-[#211d3a] text-[#a394ff]" },
	mentioned: { label: "@me", className: "bg-[#221d12] text-[#f5b83d]" },
};
type Role = (typeof ROLE_TABS)[number]["id"];

function MyJiraPage() {
	const [projectFilter, setProjectFilter] = useState("");
	// Default to All: BUGT tickets are reported-not-assigned, and hiding them
	// behind a tab made "my Jira" look like it was missing whole projects.
	const [role, setRole] = useState<Role>("all");
	// Same feeds the shell warms on boot — rows are usually already cached.
	const {
		jira: issuesQuery,
		workConfig: config,
		syncAll,
		isSyncing,
	} = useOdinFeeds();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const navigate = useNavigate();
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const panes = useTabsStore((s) => s.panes);

	// Hidden tickets drop out before the role tabs are counted.
	const hide = useHiddenFilter(
		"jira",
		issuesQuery.data?.issues ?? [],
		(issue) => issue.key,
	);
	const allIssues = hide.rows;
	const roleCounts = useMemo(
		() => ({
			assigned: allIssues.filter((i) => i.role === "assigned").length,
			reported: allIssues.filter((i) => i.role === "reported").length,
			mentioned: allIssues.filter((i) => i.role === "mentioned").length,
			all: allIssues.length,
		}),
		[allIssues],
	);
	// BUGT tickets are ones I filed, not ones assigned to me — hence the split.
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

	const projects = useMemo(() => {
		const counts = new Map<string, number>();
		for (const issue of issues)
			counts.set(issue.project, (counts.get(issue.project) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [issues]);

	// Group by status category (In Progress first), then keep Jira's updated order.
	const groups = useMemo(() => {
		const filtered = projectFilter
			? issues.filter((issue) => issue.project === projectFilter)
			: issues;
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
	}, [issues, projectFilter, livePaneByKey]);

	const handleStart = async (issue: (typeof issues)[number]) => {
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		const title = `${issue.key}: ${issue.title}`;
		const result = await launch({
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
					<HiddenToggle
						count={hide.hiddenCount}
						showing={hide.showHidden}
						onToggle={() => hide.setShowHidden(!hide.showHidden)}
					/>
					{projects.length > 0 && (
						<select
							value={projectFilter}
							onChange={(e) => setProjectFilter(e.target.value)}
							title="Filter by project"
							className={cn(
								"cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium outline-none",
								projectFilter
									? "border-[#a394ff] bg-[#211d3a] text-[#f5f5f7]"
									: "border-[#25252e] bg-[#16161b] text-[#a5a5b3] hover:text-[#f5f5f7]",
							)}
						>
							<option value="">All projects ({issues.length})</option>
							{projects.map(([project, count]) => (
								<option key={project} value={project}>
									{project} ({count})
								</option>
							))}
						</select>
					)}
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={FEED_LIST}>
				{config && !config.hasJira && (
					<ConnectNotice
						provider="jira"
						text="Jira isn't connected — sign in to see the issues assigned to you."
					/>
				)}
				<FeedError error={issuesQuery.error} />
				{issuesQuery.data && issues.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						Nothing assigned to you 🎉
					</div>
				)}

				{groups.map(([category, rows]) => (
					<div key={category} className="mb-1">
						<div className="flex items-center gap-2 py-1 pl-1 text-[11px] font-medium uppercase tracking-[.3px] text-[#8a8a97]">
							<span
								className={cn(
									"size-1.5 rounded-full",
									category.toLowerCase() === "in progress"
										? "bg-[#3ecf8e]"
										: "bg-[#8a8a97]",
								)}
							/>
							{category}
							<span className="rounded-[10px] bg-[#1f1f27] px-1.5 font-medium text-[#a5a5b3]">
								{rows.length}
							</span>
							{(() => {
								const live = rows.filter((r) =>
									livePaneByKey.has(r.key),
								).length;
								return live > 0 ? (
									<span className="rounded-[10px] bg-[#14301f] px-1.5 font-medium text-[#3ecf8e]">
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
								return (
									<div
										key={issue.key}
										className={cn(
											FEED_ROW,
											activePaneId &&
												"border-[#1a4029] border-l-2 border-l-[#3ecf8e] bg-[#0f1613]",
											!activePaneId && tone === "parked" && "opacity-60",
											hide.isHidden(issue) && "opacity-40",
										)}
									>
										{/* One line per ticket: title takes the slack, meta rides in
										    the space that used to be empty to its right. */}
										<div className="flex items-center gap-2.5">
											<span className="shrink-0 font-mono text-[11px] font-semibold text-[#a394ff]">
												{issue.key}
											</span>
											<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#f5f5f7]">
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
												{/* Only the All view mixes roles, so only it needs to say why a row is here. */}
												{role === "all" && (
													<span className={META_TAG}>
														<span
															className={cn(
																"rounded-[5px] px-[7px] py-[1px]",
																ROLE_BADGE[issue.role].className,
															)}
														>
															{ROLE_BADGE[issue.role].label}
														</span>
													</span>
												)}
												<span className={META_TAG}>
													{activePaneId && (
														<span className="inline-flex items-center gap-1 rounded-[5px] bg-[#14301f] px-[7px] py-[1px] font-semibold text-[#3ecf8e]">
															<span className="size-1.5 animate-pulse rounded-full bg-current" />
															live
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
													{issue.priority && isHotPriority(issue.priority) && (
														<span className="rounded-[5px] bg-[#3a1a20] px-[7px] py-[1px] text-[#f0647a]">
															{issue.priority}
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
											</div>
											<div className="flex shrink-0 items-center gap-1.5">
												<span className={ROW_LINK_SLOT}>
													<button
														type="button"
														onClick={() => openUrl.mutate(issue.url)}
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
															className={ROW_PRIMARY_BUTTON}
														>
															{launchingKey === issue.key
																? "Starting…"
																: "Start session"}
														</button>
													)}
												</span>
												<RowActions>
													<HideButton
														hidden={hide.isHidden(issue)}
														onClick={() => hide.toggle(issue)}
													/>
												</RowActions>
											</div>
										</div>
										{/* A mention row exists because of one comment — so it
										    shows that comment, not just the ticket it sits on. */}
										{issue.mention && (
											<div className="mt-1.5 line-clamp-2 select-text cursor-text text-[11.5px] leading-relaxed text-[#a5a5b3]">
												<span className="font-semibold text-[#f5b83d]">
													{issue.mention.author ?? "Someone"}
													{": "}
												</span>
												{issue.mention.text}
											</div>
										)}
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
