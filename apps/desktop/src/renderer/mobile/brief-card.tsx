import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { Markdown } from "./markdown";

/** The session's brief; an older Odin on the Mac answers the TL;DR line alone. */
export type Brief =
	| string
	| {
			tldr: string | null;
			goal: string | null;
			done: string | null;
			status: string | null;
			next: string | null;
	  }
	| null
	| undefined;

type PrStatus = {
	state: string;
	isDraft?: boolean;
	approved?: boolean;
	pending?: string[];
	awaiting?: string[];
	failed?: string[];
	passed?: number;
} | null;

/** What phone.links answers: the brief's links, with their live state. */
export type BriefLinks =
	| {
			prs: { url: string; label: string; status: PrStatus }[];
			jira: { url: string; key: string; status: string | null } | null;
			slack: string | null;
			notion: { url: string; title: string | null } | null;
	  }
	| undefined;

const SECTIONS = [
	["goal", "Goal"],
	["done", "What it did"],
	["status", "Where it stands"],
	["next", "Next"],
] as const;

const CHIP = "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold";

/** A PR's state, as the desktop brief's chip says it. */
function StateChip({ status }: { status: PrStatus }) {
	if (!status) return null;
	const [label, tone] =
		status.state === "MERGED"
			? ["Merged", "bg-primary/20 text-primary-ink"]
			: status.state === "CLOSED"
				? ["Closed", "bg-danger/20 text-danger-ink"]
				: status.isDraft
					? ["Draft", "bg-secondary text-muted-foreground"]
					: status.approved
						? ["Approved", "bg-success/20 text-success-ink"]
						: ["Open", "bg-working/20 text-working-ink"];
	return <span className={`${CHIP} ${tone}`}>{label}</span>;
}

/** CI while the PR can still change: running, failed, or all green. */
function ChecksChip({ status }: { status: PrStatus }) {
	if (!status || status.state !== "OPEN") return null;
	const { pending = [], awaiting = [], failed = [], passed = 0 } = status;
	if (pending.length)
		return (
			<span className={`${CHIP} bg-attention/20 text-attention-ink`}>
				{pending.length === 1 ? `${pending[0]}…` : `${pending.length} running…`}
			</span>
		);
	if (failed.length)
		return (
			<span className={`${CHIP} bg-danger/20 text-danger-ink`}>
				{failed.length === 1
					? `${failed[0]} failed`
					: `${failed.length} failed`}
			</span>
		);
	if (awaiting.length)
		return (
			<span className={`${CHIP} bg-attention/20 text-attention-ink`}>
				awaiting apply
			</span>
		);
	// No CI on the repo isn't the same as all green.
	if (!passed) return null;
	return (
		<span className={`${CHIP} bg-success/20 text-success-ink`}>
			{passed} passed
		</span>
	);
}

function LinkRow({
	href,
	children,
}: {
	href: string;
	children: React.ReactNode;
}) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="flex flex-wrap items-center gap-1.5 rounded-lg py-1.5 text-[15px] text-link active:bg-accent"
		>
			{children}
		</a>
	);
}

/**
 * The TL;DR at the top of a session; tap it for the whole brief - goal, what
 * it did, where it stands, what's next - and its links: PRs with their state
 * and CI, the Jira ticket, the Slack thread, the Notion page.
 */
export function BriefCard({
	brief,
	loading,
	open,
	onToggle,
	links,
	linksLoading,
}: {
	brief: Brief;
	loading: boolean;
	open: boolean;
	onToggle: () => void;
	links: BriefLinks;
	linksLoading: boolean;
}) {
	const full = brief && typeof brief === "object" ? brief : null;
	const tldr = typeof brief === "string" ? brief : full?.tldr;
	const sections = SECTIONS.filter(([key]) => full?.[key]);
	const Chevron = open ? LuChevronDown : LuChevronRight;
	const hasLinks =
		!!links &&
		(links.prs.length > 0 || !!links.jira || !!links.slack || !!links.notion);
	return (
		<div className="mb-2 rounded-[10px] border border-border border-l-[3px] border-l-primary bg-card text-sm leading-snug text-soft-foreground">
			<button
				type="button"
				onClick={onToggle}
				className="block w-full p-2.5 text-left"
			>
				<div className="flex items-center justify-between text-[10px] font-semibold text-faint-foreground">
					{open ? "BRIEF" : "TL;DR"}
					<Chevron className="size-4" />
				</div>
				{loading ? "Writing the TL;DR…" : !open && (tldr ?? "No summary yet.")}
			</button>
			{open && (
				<div className="space-y-2 px-2.5 pb-2.5">
					{sections.map(([key, label]) => (
						<div key={key}>
							<div className="text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
								{label}
							</div>
							<Markdown text={full?.[key] ?? ""} />
						</div>
					))}
					{!loading && sections.length === 0 && (
						<div>{tldr ?? "No summary yet."}</div>
					)}
					<div>
						<div className="text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
							Links
						</div>
						{linksLoading && (
							<div className="py-1 text-muted-foreground">
								Checking PRs and CI…
							</div>
						)}
						{!linksLoading && !hasLinks && (
							<div className="py-1 text-muted-foreground">
								No PRs or tickets yet.
							</div>
						)}
						{links?.prs.map((pr) => (
							<LinkRow key={pr.url} href={pr.url}>
								<span className="min-w-0 truncate">{pr.label}</span>
								<StateChip status={pr.status} />
								<ChecksChip status={pr.status} />
							</LinkRow>
						))}
						{links?.jira && (
							<LinkRow href={links.jira.url}>
								<span>{links.jira.key}</span>
								{links.jira.status && (
									<span className={`${CHIP} bg-secondary text-soft-foreground`}>
										{links.jira.status}
									</span>
								)}
							</LinkRow>
						)}
						{links?.slack && <LinkRow href={links.slack}>Slack thread</LinkRow>}
						{links?.notion && (
							<LinkRow href={links.notion.url}>
								{links.notion.title ?? "Notion page"}
							</LinkRow>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
