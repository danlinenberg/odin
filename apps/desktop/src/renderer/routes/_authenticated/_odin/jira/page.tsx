import { cn } from "@odin/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { openUrl } from "renderer/stores/in-app-browser";
import { useTabsStore } from "renderer/stores/tabs/store";
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
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import {
	PhaseHeading,
	phasesOf,
	SprintHeading,
	sprintGroupsOf,
} from "./sprints";

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

const ROLE_TABS = [
	{ id: "assigned" as const, label: "Assigned to me" },
	{ id: "reported" as const, label: "Reported by me" },
	{ id: "mentioned" as const, label: "Mentioning me" },
	{ id: "all" as const, label: "All" },
];

type Role = (typeof ROLE_TABS)[number]["id"];

const GROUP_BY = [
	{ id: "sprint" as const, label: "Sprints" },
	{ id: "project" as const, label: "Projects" },
];

type GroupBy = (typeof GROUP_BY)[number]["id"];

function MyJiraPage() {
	const [projectFilter, setProjectFilter] = useState("");
	// Default to All: BUGT tickets are reported-not-assigned, and hiding them
	// behind a tab made "my Jira" look like it was missing whole projects.
	const [role, setRole] = useState<Role>("all");
	// Free text over key, title, reporter, status and project.
	const [search, setSearch] = useState("");
	// Jira's board by sprint, or a section per project with its epics.
	const [groupBy, setGroupBy] = useState<GroupBy>("sprint");
	const needle = search.trim().toLowerCase();
	// Same feeds the shell warms on boot - rows are usually already cached.
	const {
		jira: issuesQuery,
		workConfig: config,
		syncAll,
		isSyncing,
	} = useOdinFeeds();
	const panes = useTabsStore((s) => s.panes);

	// Done tickets drop out before the role tabs are counted.
	const { isDone } = useDone();
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

	const projects = useMemo(() => {
		const counts = new Map<string, number>();
		for (const issue of issues)
			counts.set(issue.project, (counts.get(issue.project) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [issues]);

	// Rows go In Progress first, then a live session first and parked last;
	// Jira's updated order survives inside each band (sort is stable).
	const visible = useMemo(() => {
		const filtered = issues
			.filter((issue) => !projectFilter || issue.project === projectFilter)
			.filter(
				(issue) =>
					!needle ||
					`${issue.key} ${issue.title} ${issue.reporter ?? ""} ${issue.status} ${issue.project} ${issue.epic?.title ?? ""}`
						.toLowerCase()
						.includes(needle),
			);
		const rank = (issue: (typeof issues)[number]) =>
			categoryRank(issue.statusCategory) * 3 +
			(livePaneByKey.has(issue.key)
				? 0
				: statusTone(issue.status) === "parked"
					? 2
					: 1);
		return [...filtered].sort((a, b) => rank(a) - rank(b));
	}, [issues, projectFilter, needle, livePaneByKey]);

	const sprints = useMemo(() => sprintGroupsOf(visible), [visible]);

	// One section per project, one group per epic inside it ("No epic" last).
	const groups = useMemo(() => {
		const byProject = new Map<
			string,
			Map<
				string,
				{ epic: (typeof issues)[number]["epic"]; rows: typeof issues }
			>
		>();
		for (const issue of visible) {
			const epics =
				byProject.get(issue.project) ??
				byProject.set(issue.project, new Map()).get(issue.project);
			const epicKey = issue.epic?.key ?? "";
			const group =
				epics?.get(epicKey) ??
				epics?.set(epicKey, { epic: issue.epic, rows: [] }).get(epicKey);
			group?.rows.push(issue);
		}
		return [...byProject.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([project, epics]) => ({
				project,
				count: [...epics.values()].reduce((n, g) => n + g.rows.length, 0),
				epics: [...epics.values()].sort(
					(a, b) =>
						Number(!a.epic) - Number(!b.epic) ||
						(a.epic?.title ?? "").localeCompare(b.epic?.title ?? ""),
				),
			}));
	}, [visible]);

	const items = useFeedItems({ jira: allIssues });
	const taskRows = useTaskRows();
	const now = Date.now();

	const renderRow = (issue: (typeof issues)[number]) => {
		const item = items.get(`jira:${issue.key}`);
		return (
			item && <TaskRow key={item.key} item={item} rows={taskRows} now={now} />
		);
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
					<fieldset
						aria-label="Group issues by"
						className="m-0 flex gap-0.5 rounded-full border-0 bg-tertiary p-[3px]"
					>
						{GROUP_BY.map((mode) => (
							<button
								key={mode.id}
								type="button"
								aria-pressed={groupBy === mode.id}
								onClick={() => setGroupBy(mode.id)}
								className={cn(
									"h-[26px] rounded-md px-3 text-[12px] transition-colors",
									groupBy === mode.id
										? "bg-secondary font-medium text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{mode.label}
							</button>
						))}
					</fieldset>
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

			<div className={TABLE_LIST}>
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
				{needle && issues.length > 0 && visible.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						No issues match your search
					</div>
				)}

				{visible.length > 0 && <TaskTableHeader />}
				{groupBy === "sprint" &&
					sprints.map((group) => (
						<div key={group.id} className="mb-4">
							<SprintHeading group={group} />
							{phasesOf(group.rows).map(({ phase, rows }) => (
								<div key={phase} className="mb-3">
									<PhaseHeading phase={phase} count={rows.length} />
									{rows.map(renderRow)}
								</div>
							))}
						</div>
					))}
				{groupBy === "project" &&
					groups.map(({ project, count, epics }) => (
						<div key={project} className="mb-3">
							<div className="flex items-center gap-2 py-1 pl-1 text-[12px] font-semibold text-foreground">
								{project}
								<span className="rounded-[10px] bg-secondary px-1.5 text-[11px] font-medium text-muted-foreground">
									{count}
								</span>
							</div>
							{epics.map(({ epic, rows }) => {
								const live = rows.filter((r) =>
									livePaneByKey.has(r.key),
								).length;
								return (
									<div key={epic?.key ?? ""} className="mb-1">
										<div className="flex items-center gap-2 py-1 pl-1 text-[11px] font-medium uppercase tracking-[.3px] text-muted-foreground">
											<span className="size-1.5 rounded-full bg-muted-foreground" />
											{epic ? (
												<button
													type="button"
													title={`Open epic ${epic.key} in Jira`}
													onClick={() =>
														openUrl(rows[0].url.replace(rows[0].key, epic.key))
													}
													className="truncate uppercase hover:text-foreground"
												>
													{epic.title}
												</button>
											) : (
												"No epic"
											)}
											<span className="rounded-[10px] bg-secondary px-1.5 font-medium text-muted-foreground">
												{rows.length}
											</span>
											{live > 0 && (
												<span className="rounded-[10px] bg-working/12 px-1.5 font-medium text-working">
													{live} live
												</span>
											)}
										</div>
										{rows.map(renderRow)}
									</div>
								);
							})}
						</div>
					))}
			</div>
		</div>
	);
}
