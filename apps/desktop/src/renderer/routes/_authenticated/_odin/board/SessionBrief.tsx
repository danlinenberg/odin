import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { cn } from "@odin/ui/utils";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { openUrl } from "renderer/stores/in-app-browser";
import { PILL } from "../components/pill";
import { type BriefLink, usePaneMeta } from "../hooks/usePaneMeta";
import {
	actionItems,
	artifactLink,
	emailLink,
	jiraIssue,
	jiraKey,
	type LinkKind,
	launchPullRequest,
	linkContext,
	linkKind,
	linkLabel,
	notionPage,
	parseLinks,
	postedMessage,
	pullRequests,
	sessionBrief,
	slackThread,
} from "./brief";

/**
 * Session brief - the drawer's side panel. Answers "what did I walk into?".
 *
 * A model writes it, because excerpts don't work: the opening request is a wall
 * of prose in whatever language it was typed in, and the agent's last turn is
 * 300 words of markdown. Both need reading, which is the job the panel is
 * supposed to be doing for you.
 */

/**
 * Notes you submitted, as a list to tick off once the agent is free - the
 * question you didn't want to interrupt the current change with.
 */
export function MyTodos({ paneId }: { paneId: string }) {
	const todos = usePaneMeta((s) => s.todosByPane[paneId]) ?? [];
	const updateTodo = usePaneMeta((s) => s.updateTodo);
	if (!todos.length) return null;
	return (
		<ul className="flex flex-col gap-1">
			{todos.map((todo, i) => (
				<li
					// biome-ignore lint/suspicious/noArrayIndexKey: the index is the to-do's id
					key={i}
					className="group flex items-start gap-2 text-[12.5px] leading-relaxed"
				>
					<input
						type="checkbox"
						checked={!!todo.done}
						onChange={(event) => updateTodo(paneId, i, event.target.checked)}
						aria-label="Done"
						className="mt-1 shrink-0 accent-primary"
					/>
					<span
						dir="auto"
						className={cn(
							"min-w-0 flex-1 whitespace-pre-wrap break-words",
							todo.done
								? "text-faint-foreground line-through"
								: "text-soft-foreground",
						)}
					>
						{todo.text}
					</span>
					<button
						type="button"
						title="Remove to-do"
						onClick={() => updateTodo(paneId, i)}
						className="text-[12px] text-faint-foreground opacity-0 hover:text-danger group-hover:opacity-100"
					>
						×
					</button>
				</li>
			))}
		</ul>
	);
}

function Section({
	label,
	divided,
	children,
}: {
	label: string;
	/** Link sections get a rule above, so types don't run together. The label
	 *  names the source - a brand-coloured dot beside it only added noise. */
	divided?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div
			className={`flex flex-col gap-1 ${divided ? "border-t border-border pt-3" : ""}`}
		>
			<div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
				{label}
			</div>
			<div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-soft-foreground">
				{children}
			</div>
		</div>
	);
}

/** The model writes markdown: show `code` and **bold** as such, not as raw
 *  backticks and asterisks. Anything else stays plain text. */
function Inline({ text }: { text: string }) {
	return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) =>
		part.startsWith("`") && part.length > 2 ? (
			<code
				// biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
				key={i}
				className="rounded bg-secondary px-1 py-px font-mono text-[11.5px] text-foreground"
			>
				{part.slice(1, -1)}
			</code>
		) : part.startsWith("**") && part.length > 4 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
			<strong key={i} className="font-semibold text-foreground">
				{part.slice(2, -2)}
			</strong>
		) : (
			part
		),
	);
}

/** GitHub's own colours, so merged/open/closed read without a legend. */
const STATE_CHIP: Record<string, { label: string; className: string }> = {
	MERGED: { label: "merged", className: PILL.brand },
	OPEN: { label: "open", className: PILL.success },
	DRAFT: { label: "draft", className: "bg-secondary text-muted-foreground" },
	CLOSED: { label: "closed", className: PILL.danger },
};

function Chip({
	label,
	className,
	title,
}: {
	label: string;
	className: string;
	title?: string;
}) {
	return (
		<span
			title={title}
			className={`inline-block max-w-[130px] shrink-0 truncate rounded-[4px] px-[5px] align-bottom text-[10px] font-medium ${className}`}
		>
			{label}
		</span>
	);
}

function StateChip({
	status,
}: {
	status: { state: string | null; isDraft?: boolean } | null | undefined;
}) {
	// No chip while the lookup is in flight, or when gh couldn't answer.
	// isDraft is optional: a main process older than the renderer won't send it.
	const state = status?.isDraft ? "DRAFT" : status?.state;
	const chip = state ? STATE_CHIP[state] : undefined;
	if (!chip) return null;
	return <Chip label={chip.label} className={chip.className} />;
}

// A Jira status category's colour: done like a merged PR, in progress like a
// running agent, anything else (To Do, Backlog) a plain fact.
const JIRA_CHIP: Record<string, string> = {
	Done: PILL.brand,
	"In Progress": PILL.working,
};

/** A Jira ticket's status in its own words - "closed", "in review". */
function JiraChip({
	status,
}: {
	status: { status: string; statusCategory: string } | undefined;
}) {
	if (!status) return null;
	return (
		<Chip
			label={status.status.toLowerCase()}
			className={JIRA_CHIP[status.statusCategory] ?? PILL.neutral}
		/>
	);
}

/**
 * CI in one word, so "did Bugbot finish?" stops being a trip to the browser.
 * While something is running it names the check rather than counting them -
 * one pending check is the whole answer, and it's usually the bot.
 */
function ChecksChip({
	status,
}: {
	status: {
		state: string | null;
		pending: string[];
		awaiting?: string[];
		failed: string[];
		passed: number;
	} | null;
}) {
	// CI only matters while the PR can still change - merged/closed is final.
	if (!status || status.state !== "OPEN") return null;
	const { pending, awaiting = [], failed, passed } = status;
	if (pending.length > 0) {
		return (
			<Chip
				title={pending.join("\n")}
				label={
					pending.length === 1 ? `${pending[0]}…` : `${pending.length} running…`
				}
				className={PILL.attention}
			/>
		);
	}
	if (failed.length > 0) {
		return (
			<Chip
				title={failed.join("\n")}
				label={failed.length === 1 ? `✗ ${failed[0]}` : `✗ ${failed.length}`}
				className={PILL.danger}
			/>
		);
	}
	if (awaiting.length > 0) {
		return (
			<Chip
				title={awaiting.join("\n")}
				label="awaiting apply"
				className={PILL.attention}
			/>
		);
	}
	// Nothing ran (no CI on this repo) is not the same as everything passed.
	if (passed === 0) return null;
	return <Chip label={`✓ ${passed}`} className={PILL.success} />;
}

/**
 * A link's tooltip: what it is - a title, then a line about it - then where it
 * lives, each set apart so it reads at a glance. With nothing known about the
 * link it's the url alone.
 */
function LinkHover({
	url,
	title,
	summary,
}: {
	url: string;
	title?: string | null;
	summary?: string | null;
}) {
	return (
		<div className="flex flex-col gap-1.5 px-0.5 py-1 font-normal text-pretty">
			{title && (
				<div className="text-[13px] font-semibold leading-snug text-foreground">
					{title}
				</div>
			)}
			{summary && (
				<div className="text-[12px] leading-relaxed text-soft-foreground">
					{summary}
				</div>
			)}
			<div className="break-all text-[11px] text-faint-foreground">
				{url.replace(/^https:\/\//, "")}
			</div>
		</div>
	);
}

/**
 * A link's hover: the full message or url, up after 150ms. The native `title`
 * tooltip waits the OS's ~1s and can't be told otherwise.
 * Selectable, so the PR title or url can be copied (the app is select-none).
 */
function Hover({
	text,
	children,
}: {
	text: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<Tooltip delayDuration={150}>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent
				side="left"
				dir="auto"
				className="max-w-[360px] cursor-text select-text whitespace-pre-wrap break-words text-left"
			>
				{text}
			</TooltipContent>
		</Tooltip>
	);
}

/** Hover-revealed control that moves a found resource under "Hidden". */
function HideButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			title="Hide from the brief"
			onClick={onClick}
			className="ml-auto shrink-0 text-[11px] text-faint-foreground opacity-0 hover:text-soft-foreground group-hover:opacity-100"
		>
			hide
		</button>
	);
}

/** "Slack thread" or "Slack threads", counting the found one and yours. */
function plural(label: string, found: unknown, mine: unknown[]): string {
	return (found ? 1 : 0) + mine.length > 1 ? `${label}s` : label;
}

/**
 * The hover's half of the brief: the goal, and what the session is waiting on
 * you for. Both are cache hits - the board warms the written brief, and the
 * transcript is the one the card's pills already read.
 */
export function HoverBrief({ sessionId }: { sessionId?: string | null }) {
	const { data: transcript } =
		electronTrpc.terminal.readClaudeTranscript.useQuery(
			{ sessionId: sessionId ?? "" },
			{ enabled: !!sessionId, retry: false, staleTime: 60_000 },
		);
	const { data: written } =
		electronTrpc.terminal.summarizeClaudeSession.useQuery(
			{ sessionId: sessionId ?? "" },
			{ enabled: !!sessionId, retry: false, staleTime: 30_000 },
		);
	const todo = transcript ? actionItems(transcript.messages) : [];
	return (
		<>
			{written?.goal && (
				<div className="border-t border-border pt-2">
					<div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
						Goal
					</div>
					<div className="break-words text-[12.5px] leading-relaxed text-soft-foreground">
						{written.goal}
					</div>
				</div>
			)}
			{todo.length > 0 && (
				<div className="border-t border-border pt-2">
					<div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-attention">
						Action items
					</div>
					<ol className="list-decimal space-y-0.5 pl-4 text-[12.5px] leading-relaxed text-soft-foreground">
						{todo.map((item) => (
							<li key={item} className="break-words">
								{item}
							</li>
						))}
					</ol>
				</div>
			)}
		</>
	);
}

export function SessionBrief({
	paneId,
	cwd,
	claudeSessionId,
	marker,
	live,
	launch = null,
	starting = false,
	resourcesOnly = false,
}: {
	paneId: string;
	cwd: string | null;
	claudeSessionId: string | null;
	/** Card title - identifies the transcript for sessions launched without an id. */
	marker: string;
	live: boolean;
	/** The pane's launch brief - the row it was started from. */
	launch?: string | null;
	/** Queued or launching: no transcript yet is expected, not an error. */
	starting?: boolean;
	/** Just the resource sections - no brief, notes or link input. */
	resourcesOnly?: boolean;
}) {
	// Same lookup Resume uses: the pane's own conversation id, then the legacy
	// localStorage mirror for panes launched before that was recorded, then -
	// for the oldest ones, which have neither - the newest transcript in the
	// session's directory that mentions the task.
	// Your own notes. Written straight to the persisted store on each keystroke:
	// it's a handful of characters into localStorage, and anything cleverer
	// (debounce, save button) can lose the last words you typed.
	const notes = usePaneMeta((s) => s.notesByPane[paneId] ?? "");
	const setNotes = usePaneMeta((s) => s.setNotes);
	const addTodo = usePaneMeta((s) => s.addTodo);
	const submitNote = () => {
		addTodo(paneId, notes);
		setNotes(paneId, "");
	};
	// Links you attach yourself - the brief only finds what the transcript quotes.
	const links = usePaneMeta((s) => s.linksByPane[paneId]) ?? [];
	const addLink = usePaneMeta((s) => s.addLink);
	const removeLink = usePaneMeta((s) => s.removeLink);
	const [draftLink, setDraftLink] = useState("");
	const hiddenUrls = usePaneMeta((s) => s.hiddenByPane[paneId]) ?? [];
	const setHidden = usePaneMeta((s) => s.setHidden);
	const hide = (url: string) => setHidden(paneId, url, true);

	const mirrored = usePaneMeta((s) => s.sessionIdByPane[paneId]);
	const known = claudeSessionId ?? mirrored ?? null;
	const { data: found, isFetching: isSearching } =
		electronTrpc.terminal.findClaudeSession.useQuery(
			{ cwd: cwd ?? "", marker },
			{ enabled: !known && !!cwd, retry: false },
		);
	const sessionId = known ?? found?.sessionId ?? null;

	// The written brief. Slow the first time (a `claude -p` spawn, ~7s), then
	// cached in the main process until the session says something new.
	const {
		data: written,
		isFetching: isWriting,
		error,
	} = electronTrpc.terminal.summarizeClaudeSession.useQuery(
		{ sessionId: sessionId ?? "" },
		{
			enabled: !!sessionId,
			retry: false,
			staleTime: 30_000,
			// A live agent keeps working; an unchanged transcript costs one stat.
			refetchInterval: live ? 60_000 : false,
		},
	);

	// Facts, straight from the transcript - they cost nothing and they're the
	// part of the panel that stays true while the brief is still being written.
	const { data: transcript } =
		electronTrpc.terminal.readClaudeTranscript.useQuery(
			{ sessionId: sessionId ?? "" },
			{
				enabled: !!sessionId,
				retry: false,
				refetchInterval: live ? 15_000 : false,
			},
		);
	const facts = transcript ? sessionBrief(transcript.messages) : null;
	// The agent's own ACTION ITEMS list, verbatim - the model paraphrasing it
	// came out as "execute the six action items", which tells you nothing.
	const todo = transcript ? actionItems(transcript.messages) : [];
	// `links` is missing until main restarts onto it; the tail still has most.
	const linkSource = transcript
		? (transcript.links ?? transcript.messages)
		: null;
	// The PR the session was launched on is its subject even when a teammate
	// opened it and the replies only call it "#12": a review lists what it
	// reviewed.
	const launchPr = launchPullRequest(launch);
	const linkedPrs = linkSource ? pullRequests(linkSource) : [];
	const allPrs =
		launchPr && !linkedPrs.some((pr) => pr.url === launchPr.url)
			? [...linkedPrs, launchPr]
			: linkedPrs;
	const foundThread = linkSource ? slackThread(linkSource) : null;
	const foundPage = linkSource ? notionPage(linkSource) : null;
	const foundIssue = linkSource ? jiraIssue(linkSource) : null;
	const foundArtifact = linkSource ? artifactLink(linkSource) : null;
	const foundEmail = emailLink(launch, linkSource ?? []);
	// Only rules that actually fired, and on which PR - not every rule the
	// launch prompt listed. `rules` is missing until main restarts onto it.
	const rules = transcript?.rules ?? [];
	// What you hid drops out of its section; the "Hidden" fold below lists it.
	const isHidden = (url: string) => hiddenUrls.includes(url);
	const prs = allPrs.filter((pr) => !isHidden(pr.url));
	const thread = foundThread && !isHidden(foundThread) ? foundThread : null;
	const page = foundPage && !isHidden(foundPage.url) ? foundPage : null;
	const issue = foundIssue && !isHidden(foundIssue.url) ? foundIssue : null;
	const artifact =
		foundArtifact && !isHidden(foundArtifact) ? foundArtifact : null;
	const email = foundEmail && !isHidden(foundEmail) ? foundEmail : null;
	// An <a> in the renderer would navigate the app window; PRs open in a browser.

	// Links you added, filed under the section they belong to. One the
	// transcript already surfaced isn't listed twice.
	const surfaced = new Set(
		[
			foundIssue?.url,
			foundThread,
			foundPage?.url,
			foundArtifact,
			foundEmail,
			...allPrs.map((pr) => pr.url),
		].filter(Boolean),
	);
	const allAdded = links
		.map((link) =>
			typeof link === "string" ? { url: link } : (link as BriefLink),
		)
		.filter((link) => !surfaced.has(link.url));
	const added = allAdded.filter((link) => !isHidden(link.url));
	const mine = (kind: LinkKind) =>
		added.filter((link) => linkKind(link.url) === kind);

	// Channel, author and opening line for every Slack link on the panel, so
	// two "Slack thread"s say which conversation each one is. Cached in main.
	const slackUrls = [foundThread, ...allAdded.map((link) => link.url)].filter(
		(url): url is string => !!url && /\.slack\.com\/archives\//.test(url),
	);
	const { data: previews } = electronTrpc.slack.previews.useQuery(
		{ urls: slackUrls },
		{
			enabled: slackUrls.length > 0,
			retry: false,
			staleTime: Infinity,
			// Slack sends `:slightly_smiling_face:`; the link and its hover show 🙂.
			select: (data) =>
				Object.fromEntries(
					Object.entries(data).map(([url, preview]) => [
						url,
						preview && {
							...preview,
							text: emojify(preview.text),
							full: preview.full && emojify(preview.full),
						},
					]),
				),
		},
	);
	const threadPreview = thread ? previews?.[thread] : null;
	// The message's first line when Slack sent none: the opening prompt quotes it.
	const threadPosted =
		thread && !threadPreview
			? postedMessage(transcript?.messages ?? [], thread)?.split("\n")[0]
			: null;

	// Only what's still on the panel - a URL the transcript stopped quoting, or
	// a link you removed, doesn't linger in the fold.
	const hiddenList = [
		foundIssue && { url: foundIssue.url, label: foundIssue.key },
		foundThread && {
			url: foundThread,
			label: previews?.[foundThread]?.text ?? "Slack thread",
		},
		...allPrs.map((pr) => ({
			url: pr.url,
			label: `${pr.repo.split("/").pop()} #${pr.number}`,
		})),
		foundPage && {
			url: foundPage.url,
			label: foundPage.title ?? "Notion page",
		},
		foundArtifact && { url: foundArtifact, label: "Artifact" },
		foundEmail && { url: foundEmail, label: "Email" },
		...allAdded.map((link) => ({
			url: link.url,
			label: link.name ?? previews?.[link.url]?.text ?? linkLabel(link.url),
		})),
	].filter(
		(item): item is { url: string; label: string } =>
			!!item && isHidden(item.url),
	);

	// Which of them shipped, and what CI is still chewing on. One `gh pr view`
	// per link, so poll only while a PR is still open - a merged one never
	// changes again, and the panel is otherwise spawning subprocesses forever.
	const { data: prStates } = electronTrpc.terminal.pullRequestStates.useQuery(
		{ urls: [...prs.map((pr) => pr.url), ...mine("pr").map((pr) => pr.url)] },
		{
			enabled: prs.length > 0 || mine("pr").length > 0,
			retry: false,
			staleTime: 10_000,
			refetchInterval: (query) =>
				Object.values(query.state.data ?? {}).some(
					(status) => status?.state === "OPEN" && status.mine !== false,
				) && 15_000,
		},
	);
	// Every linked ticket's status in one search. A ticket moves slowly, so a
	// minute between looks is plenty.
	const jiraKeys = [
		issue?.key,
		...mine("jira").map((link) => jiraKey(link.url)),
	].filter((key): key is string => !!key);
	const { data: jiraStates } = electronTrpc.work.jiraIssueStates.useQuery(
		{ keys: jiraKeys },
		{
			enabled: jiraKeys.length > 0,
			retry: false,
			staleTime: 30_000,
			refetchInterval: 60_000,
		},
	);
	// Someone else's PR the session only linked isn't one of its PRs. Listed
	// until its author is known, so the section doesn't flash empty.
	const ownPrs = prs.filter(
		(pr) => pr.url === launchPr?.url || prStates?.[pr.url]?.mine !== false,
	);

	// Every link's hover. A PR's comes from GitHub, a Slack link's from Slack
	// (the whole message - the link shows two lines of it); the rest say what
	// the session said the link is. `full`, `title` and `summary` are missing
	// until main restarts onto the procedures that return them.
	const said = transcript
		? [...(transcript.links ?? []), ...transcript.messages]
		: [];
	const hoverFor = (url: string, name?: string | null) => {
		if (linkKind(url) === "pr") {
			const pr = prStates?.[url];
			return <LinkHover url={url} title={pr?.title} summary={pr?.summary} />;
		}
		const preview = previews?.[url];
		if (preview)
			return (
				<LinkHover
					url={url}
					title={[preview.channel, preview.author].filter(Boolean).join(" · ")}
					summary={preview.full ?? preview.text}
				/>
			);
		const posted = postedMessage(said, url);
		if (posted)
			return (
				<LinkHover url={url} title="Slack thread" summary={emojify(posted)} />
			);
		const context = linkContext(said, url);
		return (
			<LinkHover
				url={url}
				title={name ?? context?.title ?? linkLabel(url)}
				summary={context?.summary}
			/>
		);
	};

	// A link you added: your name for it, else what Slack says the message is,
	// else its kind; the line under it says where it lives. Removable, since
	// it's yours.
	const myLink = ({ url, name }: BriefLink) => {
		const preview = previews?.[url];
		const kind = linkLabel(url);
		const title = name ?? preview?.text ?? kind;
		const where = [
			title === kind ? null : kind,
			preview?.channel,
			preview?.author,
		]
			.filter(Boolean)
			.join(" · ");
		return (
			<div key={url} className="group flex items-start gap-1.5">
				<Hover text={hoverFor(url, name)}>
					<button
						type="button"
						onClick={() => openUrl(url)}
						className="min-w-0 flex-1 text-left hover:underline"
					>
						{/* dir="auto": a Hebrew message reads right-to-left and clamps at
						    its own end, not mid-sentence. Still left-aligned, so the
						    panel keeps one edge. */}
						<div
							dir="auto"
							className="line-clamp-2 text-left text-[12px] text-link"
						>
							{title} ↗
						</div>
						{where && (
							<div className="truncate text-[11px] text-muted-foreground">
								{where}
							</div>
						)}
					</button>
				</Hover>
				{linkKind(url) === "jira" && (
					<JiraChip status={jiraStates?.[jiraKey(url) ?? ""]} />
				)}
				{linkKind(url) === "pr" && (
					<>
						<StateChip status={prStates?.[url]} />
						<ChecksChip status={prStates?.[url] ?? null} />
					</>
				)}
				<HideButton onClick={() => hide(url)} />
				<button
					type="button"
					title="Remove link"
					onClick={() => removeLink(paneId, url)}
					className="text-[12px] text-faint-foreground opacity-0 hover:text-danger group-hover:opacity-100"
				>
					×
				</button>
			</div>
		);
	};

	// The resources - Jira, Slack, PRs, Notion, artifacts, links you added.
	// Outside the transcript branch: the ones you added are yours, and a
	// session with no readable conversation still has them. Catch up's card
	// shows only these, under its own action items.
	const resources = (
		<>
			{(issue || mine("jira").length > 0) && (
				<Section label={plural("Jira ticket", issue, mine("jira"))} divided>
					<div className="flex flex-col gap-1">
						{issue && (
							<div className="group flex items-center gap-1.5">
								<Hover text={hoverFor(issue.url, issue.key)}>
									<button
										type="button"
										onClick={() => openUrl(issue.url)}
										className="truncate text-left text-[12px] text-link hover:underline"
									>
										{issue.key} ↗
									</button>
								</Hover>
								<JiraChip status={jiraStates?.[issue.key]} />
								<HideButton onClick={() => hide(issue.url)} />
							</div>
						)}
						{mine("jira").map(myLink)}
					</div>
				</Section>
			)}
			{(thread || mine("slack").length > 0) && (
				<Section label={plural("Slack thread", thread, mine("slack"))} divided>
					<div className="flex flex-col gap-1.5">
						{thread && (
							<div className="group flex items-start gap-1.5">
								<div className="min-w-0 flex-1">
									<Hover text={hoverFor(thread)}>
										<button
											type="button"
											onClick={() => openUrl(thread)}
											dir="auto"
											className="line-clamp-2 w-full text-left text-[12px] text-link hover:underline"
										>
											{threadPreview?.text ??
												(threadPosted && emojify(threadPosted)) ??
												"Open thread"}{" "}
											↗
										</button>
									</Hover>
									{threadPreview && (
										<div className="truncate text-[11px] text-muted-foreground">
											{[threadPreview.channel, threadPreview.author]
												.filter(Boolean)
												.join(" · ")}
										</div>
									)}
								</div>
								<HideButton onClick={() => hide(thread)} />
							</div>
						)}
						{mine("slack").map(myLink)}
					</div>
				</Section>
			)}
			{(ownPrs.length > 0 || mine("pr").length > 0) && (
				<Section
					divided
					label={
						ownPrs.length + mine("pr").length === 1
							? "Pull request"
							: "Pull requests"
					}
				>
					<div className="flex flex-col gap-1">
						{ownPrs.map((pr) => (
							<div key={pr.url} className="group flex items-center gap-1.5">
								<Hover text={hoverFor(pr.url)}>
									<button
										type="button"
										onClick={() => openUrl(pr.url)}
										className="flex min-w-0 items-center gap-1.5 text-left text-[12px] text-link hover:underline"
									>
										<span className="truncate">
											{pr.repo.split("/").pop()} #{pr.number}
										</span>
										<StateChip status={prStates?.[pr.url]} />
										<ChecksChip status={prStates?.[pr.url] ?? null} />
									</button>
								</Hover>
								<HideButton onClick={() => hide(pr.url)} />
							</div>
						))}
						{mine("pr").map(myLink)}
					</div>
				</Section>
			)}
			{(page || mine("notion").length > 0) && (
				<Section label={plural("Notion page", page, mine("notion"))} divided>
					<div className="flex flex-col gap-1">
						{page && (
							<div className="group flex items-center gap-1.5">
								<Hover text={hoverFor(page.url, page.title)}>
									<button
										type="button"
										onClick={() => openUrl(page.url)}
										className="block min-w-0 flex-1 truncate text-left text-[12px] text-link hover:underline"
									>
										{page.title ?? "Notion page"} ↗
									</button>
								</Hover>
								<HideButton onClick={() => hide(page.url)} />
							</div>
						)}
						{mine("notion").map(myLink)}
					</div>
				</Section>
			)}
			{(artifact || mine("artifact").length > 0) && (
				<Section label={plural("Artifact", artifact, mine("artifact"))} divided>
					<div className="flex flex-col gap-1">
						{artifact && (
							<div className="group flex items-center gap-1.5">
								<Hover text={hoverFor(artifact)}>
									<button
										type="button"
										onClick={() => openUrl(artifact)}
										className="block min-w-0 flex-1 truncate text-left text-[12px] text-link hover:underline"
									>
										Open artifact ↗
									</button>
								</Hover>
								<HideButton onClick={() => hide(artifact)} />
							</div>
						)}
						{mine("artifact").map(myLink)}
					</div>
				</Section>
			)}
			{(email || mine("email").length > 0) && (
				<Section label={plural("Email", email, mine("email"))} divided>
					<div className="flex flex-col gap-1">
						{email && (
							<div className="group flex items-center gap-1.5">
								<Hover text={hoverFor(email)}>
									<button
										type="button"
										onClick={() => openUrl(email)}
										className="block min-w-0 flex-1 truncate text-left text-[12px] text-link hover:underline"
									>
										Open email ↗
									</button>
								</Hover>
								<HideButton onClick={() => hide(email)} />
							</div>
						)}
						{mine("email").map(myLink)}
					</div>
				</Section>
			)}
			{mine("other").length > 0 && (
				<Section label="Links" divided>
					<div className="flex flex-col gap-1">{mine("other").map(myLink)}</div>
				</Section>
			)}
		</>
	);

	if (resourcesOnly)
		return <div className="flex flex-col gap-3.5">{resources}</div>;

	return (
		<div className="flex w-[340px] shrink-0 flex-col border-l border-border bg-tertiary">
			<div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
				What's going on
				{isWriting && !written && (
					<span className="ml-auto normal-case tracking-normal text-primary">
						writing…
					</span>
				)}
			</div>
			<div className="flex min-h-0 flex-1 select-text cursor-text flex-col gap-3.5 overflow-y-auto px-4 py-3">
				{!sessionId ? (
					<div className="text-[12px] text-muted-foreground">
						{isSearching
							? "looking for the transcript…"
							: "This session has no Claude conversation id - nothing to read."}
					</div>
				) : (
					<>
						{transcript?.title && (
							<div className="text-[13px] font-semibold text-foreground">
								{transcript.title}
							</div>
						)}
						{error && starting ? (
							<div className="text-[12px] text-muted-foreground">
								Nothing yet - the session hasn't started.
							</div>
						) : error ? (
							<div className="text-[12px] text-danger">{error.message}</div>
						) : written ? (
							<>
								{/* What it's for, then yours to do, then where it stands. A
								    four-word title can't carry the goal on its own. */}
								{written.goal && (
									<Section label="Goal">
										<Inline text={written.goal} />
									</Section>
								)}
								{todo.length > 0 ? (
									<Section label="Your action items">
										<ol className="list-decimal space-y-0.5 whitespace-normal pl-4">
											{todo.map((item) => (
												<li key={item}>
													<Inline text={item} />
												</li>
											))}
										</ol>
									</Section>
								) : (
									written.next && (
										<Section label="Your move">
											<Inline text={written.next} />
										</Section>
									)
								)}
								{written.status && (
									<Section label="Where it stands">
										<Inline text={written.status} />
									</Section>
								)}
								{/* The model ignored the shape we asked for - show what it said
								    rather than an empty panel. */}
								{written.raw && (
									<Section label="Summary">
										<Inline text={written.raw} />
									</Section>
								)}
							</>
						) : (
							<div className="text-[12px] text-muted-foreground">
								reading the conversation…
							</div>
						)}
					</>
				)}
				{resources}
				{rules.length > 0 && (
					<details className="group/rules flex flex-col gap-1 border-t border-border pt-3">
						<summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground hover:text-soft-foreground">
							<span className="size-1.5 shrink-0 rounded-full bg-primary" />
							Rules applied ({rules.length})
							<span className="inline-block transition-transform group-open/rules:rotate-90">
								›
							</span>
						</summary>
						<div className="mt-1 flex flex-col gap-1.5 text-[12px] leading-relaxed text-soft-foreground">
							{rules.map(({ rule, on }) => (
								<div key={rule}>
									<div>{rule}</div>
									<div className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
										on
										{on.map((url) => (
											<Hover key={url} text={hoverFor(url)}>
												<button
													type="button"
													onClick={() => openUrl(url)}
													className="text-link hover:underline"
												>
													{url.split("/").slice(-3, -2)[0]} #
													{url.split("/").pop()} ↗
												</button>
											</Hover>
										))}
									</div>
								</div>
							))}
						</div>
					</details>
				)}
				{hiddenList.length > 0 && (
					<details className="group/hidden">
						<summary className="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground hover:text-soft-foreground">
							<span className="inline-block transition-transform group-open/hidden:rotate-90">
								›
							</span>{" "}
							Hidden ({hiddenList.length})
						</summary>
						<div className="mt-1 flex flex-col gap-1">
							{hiddenList.map(({ url, label }) => (
								<div key={url} className="group flex items-center gap-1.5">
									<Hover text={hoverFor(url)}>
										<button
											type="button"
											onClick={() => openUrl(url)}
											dir="auto"
											className="min-w-0 flex-1 truncate text-left text-[12px] text-muted-foreground hover:underline"
										>
											{label} ↗
										</button>
									</Hover>
									<button
										type="button"
										title="Show on the brief again"
										onClick={() => setHidden(paneId, url, false)}
										className="ml-auto shrink-0 text-[11px] text-faint-foreground opacity-0 hover:text-soft-foreground group-hover:opacity-100"
									>
										show
									</button>
								</div>
							))}
						</div>
					</details>
				)}
				{facts && (
					<div className="pt-2 text-[11px] text-muted-foreground">
						{facts.turns} turns
						{facts.at &&
							` · last activity ${new Date(facts.at).toLocaleString()}`}
						{written?.writtenAt &&
							` · brief written ${new Date(written.writtenAt).toLocaleTimeString()}`}
					</div>
				)}
				<div className="mt-auto flex flex-col gap-1 pt-2">
					<input
						value={draftLink}
						onChange={(event) => setDraftLink(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter") return;
							// Several pasted at once become several links; one link
							// takes the rest of the line as its name.
							const parsed = parseLinks(draftLink);
							for (const link of parsed) addLink(paneId, link.url, link.name);
							if (parsed.length) setDraftLink("");
						}}
						placeholder="Add a link (+ a name), Enter"
						className="rounded-[7px] border border-border bg-background px-2 py-1 text-[12px] text-soft-foreground placeholder:text-faint-foreground focus:border-primary focus:outline-none"
					/>
				</div>
				<div className="flex flex-col gap-1 pt-2">
					<div className="text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
						My notes
					</div>
					<MyTodos paneId={paneId} />
					<textarea
						value={notes}
						onChange={(event) => setNotes(paneId, event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
								return;
							event.preventDefault();
							submitNote();
						}}
						placeholder={`Notes to yourself - saved as you type. ${navigator.platform.toLowerCase().includes("mac") ? "⌘Enter" : "Ctrl+Enter"} adds it to your to-dos.`}
						rows={4}
						className="resize-y rounded-[7px] border border-border bg-background px-2 py-1.5 text-[12.5px] leading-relaxed text-soft-foreground placeholder:text-faint-foreground focus:border-primary focus:outline-none"
					/>
					{notes.trim() && (
						<button
							type="button"
							onClick={submitNote}
							title="Move this note to your to-do list (⌘Enter)"
							className="self-end text-[11px] font-semibold text-link hover:underline"
						>
							Add to to-dos
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
