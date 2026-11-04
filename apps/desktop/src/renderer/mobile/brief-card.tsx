import { useState } from "react";
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
			/** `repo` is missing from an older Odin on the Mac. */
			prs: { url: string; label: string; repo?: string; status: PrStatus }[];
			jira: { url: string; key: string; status: string | null } | null;
			slack: string | null;
			notion: { url: string; title: string | null } | null;
			/** Hidden on the desktop brief; missing from an older Odin on the Mac. */
			hidden?: string[];
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
	onHide,
}: {
	href: string;
	children: React.ReactNode;
	/** The desktop brief's hide: the link moves under "Hidden" on both. */
	onHide?: () => void;
}) {
	return (
		<div className="flex items-center gap-1">
			<a
				href={href}
				target="_blank"
				rel="noreferrer"
				className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-lg py-1.5 text-[15px] text-link active:bg-accent"
			>
				{children}
			</a>
			{onHide && (
				<button
					type="button"
					aria-label="Hide from the brief"
					onClick={onHide}
					className="shrink-0 rounded-md px-2 py-1.5 text-[12px] text-faint-foreground active:bg-accent"
				>
					hide
				</button>
			)}
		</div>
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
	onHide,
}: {
	brief: Brief;
	loading: boolean;
	open: boolean;
	/** The header's tap; none where the card is always open (the side panel). */
	onToggle?: () => void;
	links: BriefLinks;
	linksLoading: boolean;
	/** Hide or show a link, as the desktop brief's hide / show does. */
	onHide?: (url: string, hidden: boolean) => void;
}) {
	const full = brief && typeof brief === "object" ? brief : null;
	const tldr = typeof brief === "string" ? brief : full?.tldr;
	const sections = SECTIONS.filter(([key]) => full?.[key]);
	const Chevron = open ? LuChevronDown : LuChevronRight;
	const [hiddenOpen, setHiddenOpen] = useState(false);
	// What you hid on either brief drops out of Links into the Hidden fold.
	const hiddenUrls = links?.hidden ?? [];
	const shown = (url: string) => !hiddenUrls.includes(url);
	const prs = links?.prs.filter((pr) => shown(pr.url)) ?? [];
	const jira = links?.jira && shown(links.jira.url) ? links.jira : null;
	const slack = links?.slack && shown(links.slack) ? links.slack : null;
	const notion = links?.notion && shown(links.notion.url) ? links.notion : null;
	const hiddenList = [
		...(links?.prs ?? [])
			.filter((pr) => !shown(pr.url))
			.map((pr) => ({ url: pr.url, label: pr.label })),
		...(links?.jira && !shown(links.jira.url)
			? [{ url: links.jira.url, label: links.jira.key }]
			: []),
		...(links?.slack && !shown(links.slack)
			? [{ url: links.slack, label: "Slack thread" }]
			: []),
		...(links?.notion && !shown(links.notion.url)
			? [
					{
						url: links.notion.url,
						label: links.notion.title ?? "Notion page",
					},
				]
			: []),
	];
	const hide = onHide && ((url: string) => () => onHide(url, true));
	const hasLinks =
		prs.length > 0 || !!jira || !!slack || !!notion || hiddenList.length > 0;
	return (
		<div className="mb-2 rounded-[10px] border border-border border-l-[3px] border-l-primary bg-card text-sm leading-snug text-soft-foreground">
			<button
				type="button"
				disabled={!onToggle}
				onClick={onToggle}
				className="block w-full p-2.5 text-left"
			>
				<div className="flex items-center justify-between text-[10px] font-semibold text-faint-foreground">
					{open ? "BRIEF" : "TL;DR"}
					{onToggle && <Chevron className="size-4" />}
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
						{prs.map((pr) => (
							<LinkRow key={pr.url} href={pr.url} onHide={hide?.(pr.url)}>
								{pr.repo && !pr.label.startsWith(pr.repo) && (
									<span className="shrink-0 text-muted-foreground">
										{pr.repo}
									</span>
								)}
								<span className="min-w-0 truncate">{pr.label}</span>
								<StateChip status={pr.status} />
								<ChecksChip status={pr.status} />
							</LinkRow>
						))}
						{jira && (
							<LinkRow href={jira.url} onHide={hide?.(jira.url)}>
								<span>{jira.key}</span>
								{jira.status && (
									<span className={`${CHIP} bg-secondary text-soft-foreground`}>
										{jira.status}
									</span>
								)}
							</LinkRow>
						)}
						{slack && (
							<LinkRow href={slack} onHide={hide?.(slack)}>
								Slack thread
							</LinkRow>
						)}
						{notion && (
							<LinkRow href={notion.url} onHide={hide?.(notion.url)}>
								{notion.title ?? "Notion page"}
							</LinkRow>
						)}
						{hiddenList.length > 0 && (
							<div className="pt-1">
								<button
									type="button"
									onClick={() => setHiddenOpen((was) => !was)}
									className="flex items-center gap-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground"
								>
									{hiddenOpen ? (
										<LuChevronDown className="size-3.5" />
									) : (
										<LuChevronRight className="size-3.5" />
									)}
									Hidden ({hiddenList.length})
								</button>
								{hiddenOpen &&
									hiddenList.map(({ url, label }) => (
										<div key={url} className="flex items-center gap-1">
											<a
												href={url}
												target="_blank"
												rel="noreferrer"
												className="min-w-0 flex-1 truncate py-1.5 text-[14px] text-muted-foreground"
											>
												{label}
											</a>
											{onHide && (
												<button
													type="button"
													aria-label="Show on the brief again"
													onClick={() => onHide(url, false)}
													className="shrink-0 rounded-md px-2 py-1.5 text-[12px] text-link active:bg-accent"
												>
													show
												</button>
											)}
										</div>
									))}
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
