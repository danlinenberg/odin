import type { JiraIssueRow } from "lib/trpc/routers/work";

/**
 * Jira's board, read the way its sprint view reads: the active sprint, the
 * ones coming up, then the Backlog - and inside each, In review, In progress,
 * To do. Ported from spyd.
 */

export interface SprintGroup {
	id: string;
	label: string;
	sprint: JiraIssueRow["sprint"] | null;
	rows: JiraIssueRow[];
}

/** Rows by sprint, in board order: active, then upcoming by start, then Backlog. */
export function sprintGroupsOf(rows: JiraIssueRow[]): SprintGroup[] {
	const bySprint = new Map<string, SprintGroup>();
	for (const row of rows) {
		const sprint = row.sprint ?? null;
		const id = sprint ? `sprint:${sprint.name}` : "backlog";
		const group =
			bySprint.get(id) ??
			bySprint
				.set(id, { id, label: sprint?.name ?? "Backlog", sprint, rows: [] })
				.get(id);
		group?.rows.push(row);
	}
	const order = (group: SprintGroup) =>
		!group.sprint ? 2 : group.sprint.state === "active" ? 0 : 1;
	return [...bySprint.values()].sort(
		(a, b) =>
			order(a) - order(b) ||
			(a.sprint?.startDate ?? "~").localeCompare(b.sprint?.startDate ?? "~"),
	);
}

export type Phase = "review" | "progress" | "todo" | "done";
const PHASES: Phase[] = ["review", "progress", "todo", "done"];
const PHASE_LABEL: Record<Phase, string> = {
	review: "In review",
	progress: "In progress",
	todo: "To do",
	done: "Done",
};

const isReview = (status: string) => /review|qa|test/i.test(status);

function phaseOf(row: JiraIssueRow): Phase {
	const c = row.statusCategory.toLowerCase();
	if (c === "done") return "done";
	if (c === "in progress") return isReview(row.status) ? "review" : "progress";
	return "todo";
}

/** A sprint's rows the way Jira's board columns read: review, doing, to do, done. */
export function phasesOf(
	rows: JiraIssueRow[],
): { phase: Phase; rows: JiraIssueRow[] }[] {
	return PHASES.map((phase) => ({
		phase,
		rows: rows.filter((row) => phaseOf(row) === phase),
	})).filter((group) => group.rows.length > 0);
}

function daysLeft(endDate: string | null): number | null {
	if (!endDate) return null;
	return Math.ceil((new Date(endDate).getTime() - Date.now()) / 86_400_000);
}

/**
 * A sprint the way you'd glance at it on the board: its name, whether it's
 * running and how long it has left, and how much of yours is moving - a thin
 * bar, not a chart.
 */
export function SprintHeading({ group }: { group: SprintGroup }) {
	const { label, sprint, rows } = group;
	const left = daysLeft(sprint?.endDate ?? null);
	const moving = rows.filter(
		(row) => row.statusCategory.toLowerCase() === "in progress",
	).length;
	const active = sprint?.state === "active";
	return (
		<div className="flex items-end gap-3 px-1 pt-3 pb-2">
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex items-center gap-2">
					<h2 className="truncate font-display text-[17px] font-semibold tracking-[-0.01em]">
						{label}
					</h2>
					{active ? (
						<span className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary-ink">
							<span className="size-1.5 animate-pulse rounded-full bg-primary" />
							Active
						</span>
					) : sprint ? (
						<span className="shrink-0 rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
							Up next
						</span>
					) : null}
				</div>
				<span className="text-[12px] text-faint-foreground">
					{[
						`${rows.length} ${rows.length === 1 ? "ticket" : "tickets"}`,
						moving > 0 && `${moving} in progress`,
						left !== null &&
							(active
								? left > 0
									? `${left} ${left === 1 ? "day" : "days"} left`
									: "ends today"
								: sprint?.startDate
									? `starts ${new Date(sprint.startDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
									: null),
						!sprint && "not in a sprint",
					]
						.filter(Boolean)
						.join(" · ")}
				</span>
			</div>
			{active && rows.length > 0 && (
				<div
					className="ml-auto mb-1.5 h-1 w-28 shrink-0 overflow-hidden rounded-full bg-secondary"
					title={`${moving} of ${rows.length} in progress`}
				>
					<div
						className="h-full rounded-full bg-working transition-[width] duration-500"
						style={{ width: `${(moving / rows.length) * 100}%` }}
					/>
				</div>
			)}
		</div>
	);
}

/** A phase band's header: its icon, name and count. */
export function PhaseHeading({
	phase,
	count,
}: {
	phase: Phase;
	count: number;
}) {
	return (
		<div className="flex h-8 items-center gap-2 rounded-md bg-secondary/50 px-3 text-[12px]">
			<StatusIcon phase={phase} />
			<span className="font-medium text-foreground">{PHASE_LABEL[phase]}</span>
			<span className="text-faint-foreground">{count}</span>
		</div>
	);
}

/**
 * Where a ticket stands, at a glance and without reading: an empty ring to
 * do, a half-filled blue one in progress, a filled one in review, a green
 * check when it's done.
 */
function StatusIcon({ phase }: { phase: Phase }) {
	return (
		<span
			role="img"
			aria-label={PHASE_LABEL[phase]}
			className="flex size-[15px] shrink-0 items-center justify-center"
		>
			{phase === "done" ? (
				<svg viewBox="0 0 22 22" className="size-[15px]" aria-hidden="true">
					<circle cx="11" cy="11" r="10" className="fill-success" />
					<path
						d="M6.5 11.5l3 3 6-6.5"
						fill="none"
						stroke="white"
						strokeWidth="2.2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			) : phase === "todo" ? (
				<svg viewBox="0 0 22 22" className="size-[15px]" aria-hidden="true">
					<circle
						cx="11"
						cy="11"
						r="9"
						fill="none"
						strokeWidth="2.2"
						strokeDasharray="3.4 2.6"
						className="stroke-muted-foreground"
					/>
				</svg>
			) : (
				<svg viewBox="0 0 22 22" className="size-[15px]" aria-hidden="true">
					<circle
						cx="11"
						cy="11"
						r="9"
						fill="none"
						strokeWidth="2.2"
						className="stroke-working"
					/>
					{phase === "review" ? (
						<circle cx="11" cy="11" r="5.5" className="fill-working" />
					) : (
						<path d="M11 5.5a5.5 5.5 0 0 1 0 11z" className="fill-working" />
					)}
				</svg>
			)}
		</span>
	);
}
