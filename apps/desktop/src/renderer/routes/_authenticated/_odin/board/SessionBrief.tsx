import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { type BriefLink, usePaneMeta } from "../hooks/usePaneMeta";
import {
	jiraIssue,
	type LinkKind,
	linkKind,
	linkLabel,
	notionPage,
	parseLinks,
	pullRequests,
	sessionBrief,
	slackThread,
} from "./brief";

/**
 * Session brief — the drawer's side panel. Answers "what did I walk into?".
 *
 * A model writes it, because excerpts don't work: the opening request is a wall
 * of prose in whatever language it was typed in, and the agent's last turn is
 * 300 words of markdown. Both need reading, which is the job the panel is
 * supposed to be doing for you.
 */

function Section({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
				{label}
			</div>
			<div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[#d6d6dc]">
				{children}
			</div>
		</div>
	);
}

/** GitHub's own colours, so merged/open/closed read without a legend. */
const STATE_CHIP: Record<string, { label: string; className: string }> = {
	MERGED: { label: "merged", className: "bg-[#241a3f] text-[#a371f7]" },
	OPEN: { label: "open", className: "bg-[#14301f] text-[#3ecf8e]" },
	CLOSED: { label: "closed", className: "bg-[#331a20] text-[#f0647a]" },
};

function Chip({ label, className }: { label: string; className: string }) {
	return (
		<span
			className={`inline-block max-w-[130px] shrink-0 truncate rounded-[4px] px-[5px] align-bottom text-[10px] font-medium ${className}`}
		>
			{label}
		</span>
	);
}

function StateChip({ state }: { state: string | null }) {
	// No chip while the lookup is in flight, or when gh couldn't answer.
	const chip = state ? STATE_CHIP[state] : undefined;
	if (!chip) return null;
	return <Chip label={chip.label} className={chip.className} />;
}

/**
 * CI in one word, so "did Bugbot finish?" stops being a trip to the browser.
 * While something is running it names the check rather than counting them —
 * one pending check is the whole answer, and it's usually the bot.
 */
function ChecksChip({
	status,
}: {
	status: {
		state: string | null;
		pending: string[];
		failed: string[];
		passed: number;
	} | null;
}) {
	// CI only matters while the PR can still change — merged/closed is final.
	if (!status || status.state !== "OPEN") return null;
	const { pending, failed, passed } = status;
	if (pending.length > 0) {
		return (
			<span title={pending.join("\n")}>
				<Chip
					label={
						pending.length === 1
							? `${pending[0]}…`
							: `${pending.length} running…`
					}
					className="bg-[#3a2c12] text-[#d2a336]"
				/>
			</span>
		);
	}
	if (failed.length > 0) {
		return (
			<span title={failed.join("\n")}>
				<Chip
					label={failed.length === 1 ? `✗ ${failed[0]}` : `✗ ${failed.length}`}
					className="bg-[#331a20] text-[#f0647a]"
				/>
			</span>
		);
	}
	// Nothing ran (no CI on this repo) is not the same as everything passed.
	if (passed === 0) return null;
	return <Chip label={`✓ ${passed}`} className="bg-[#14301f] text-[#3ecf8e]" />;
}

/**
 * A Slack link's tooltip: the whole message (the link shows two lines of it),
 * then the url. `full` is missing until main restarts onto the procedure that
 * returns it, so fall back to the line we have.
 */
function hoverText(
	url: string,
	preview: { text: string; full?: string } | null | undefined,
): string {
	const message = preview?.full ?? preview?.text;
	return message ? `${message}\n\n${url}` : url;
}

/**
 * A link's hover: the full message or url, up after 150ms. The native `title`
 * tooltip waits the OS's ~1s and can't be told otherwise.
 */
function Hover({
	text,
	children,
}: {
	text: string;
	children: React.ReactNode;
}) {
	return (
		<Tooltip delayDuration={150}>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent
				side="left"
				dir="auto"
				className="max-w-[320px] whitespace-pre-wrap break-words text-left"
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
			className="ml-auto shrink-0 text-[11px] text-[#7c7c88] opacity-0 hover:text-[#d6d6dc] group-hover:opacity-100"
		>
			hide
		</button>
	);
}

/** "Slack thread" or "Slack threads", counting the found one and yours. */
function plural(label: string, found: unknown, mine: unknown[]): string {
	return (found ? 1 : 0) + mine.length > 1 ? `${label}s` : label;
}

export function SessionBrief({
	paneId,
	cwd,
	claudeSessionId,
	marker,
	live,
}: {
	paneId: string;
	cwd: string | null;
	claudeSessionId: string | null;
	/** Card title — identifies the transcript for sessions launched without an id. */
	marker: string;
	live: boolean;
}) {
	// Same lookup Resume uses: the pane's own conversation id, then the legacy
	// localStorage mirror for panes launched before that was recorded, then —
	// for the oldest ones, which have neither — the newest transcript in the
	// session's directory that mentions the task.
	// Your own notes. Written straight to the persisted store on each keystroke:
	// it's a handful of characters into localStorage, and anything cleverer
	// (debounce, save button) can lose the last words you typed.
	const notes = usePaneMeta((s) => s.notesByPane[paneId] ?? "");
	const setNotes = usePaneMeta((s) => s.setNotes);
	// Links you attach yourself — the brief only finds what the transcript quotes.
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

	// Facts, straight from the transcript — they cost nothing and they're the
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
	const allPrs = transcript ? pullRequests(transcript.messages) : [];
	const foundThread = transcript ? slackThread(transcript.messages) : null;
	const foundPage = transcript ? notionPage(transcript.messages) : null;
	const foundIssue = transcript ? jiraIssue(transcript.messages) : null;
	// What you hid drops out of its section; the "Hidden" fold below lists it.
	const isHidden = (url: string) => hiddenUrls.includes(url);
	const prs = allPrs.filter((pr) => !isHidden(pr.url));
	const thread = foundThread && !isHidden(foundThread) ? foundThread : null;
	const page = foundPage && !isHidden(foundPage.url) ? foundPage : null;
	const issue = foundIssue && !isHidden(foundIssue.url) ? foundIssue : null;
	// An <a> in the renderer would navigate the app window; PRs open in a browser.
	const openUrl = electronTrpc.external.openUrl.useMutation();

	// Links you added, filed under the section they belong to. One the
	// transcript already surfaced isn't listed twice.
	const surfaced = new Set(
		[
			foundIssue?.url,
			foundThread,
			foundPage?.url,
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

	// Only what's still on the panel — a URL the transcript stopped quoting, or
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
		...allAdded.map((link) => ({
			url: link.url,
			label: link.name ?? previews?.[link.url]?.text ?? linkLabel(link.url),
		})),
	].filter(
		(item): item is { url: string; label: string } =>
			!!item && isHidden(item.url),
	);

	// Which of them shipped, and what CI is still chewing on. One `gh pr view`
	// per link, so poll only while a PR is still open — a merged one never
	// changes again, and the panel is otherwise spawning subprocesses forever.
	const { data: prStates } = electronTrpc.terminal.pullRequestStates.useQuery(
		{ urls: [...prs.map((pr) => pr.url), ...mine("pr").map((pr) => pr.url)] },
		{
			enabled: prs.length > 0 || mine("pr").length > 0,
			retry: false,
			staleTime: 10_000,
			refetchInterval: (query) =>
				Object.values(query.state.data ?? {}).some(
					(status) => status?.state === "OPEN",
				) && 15_000,
		},
	);

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
				<Hover text={hoverText(url, preview)}>
					<button
						type="button"
						onClick={() => openUrl.mutate(url)}
						className="min-w-0 flex-1 text-left hover:underline"
					>
						{/* dir="auto": a Hebrew message reads right-to-left and clamps at
						    its own end, not mid-sentence. Still left-aligned, so the
						    panel keeps one edge. */}
						<div
							dir="auto"
							className="line-clamp-2 text-left text-[12px] text-[#a394ff]"
						>
							{title} ↗
						</div>
						{where && (
							<div className="truncate text-[11px] text-[#8a8a97]">{where}</div>
						)}
					</button>
				</Hover>
				{linkKind(url) === "pr" && (
					<>
						<StateChip state={prStates?.[url]?.state ?? null} />
						<ChecksChip status={prStates?.[url] ?? null} />
					</>
				)}
				<HideButton onClick={() => hide(url)} />
				<button
					type="button"
					title="Remove link"
					onClick={() => removeLink(paneId, url)}
					className="text-[12px] text-[#7c7c88] opacity-0 hover:text-[#f0647a] group-hover:opacity-100"
				>
					×
				</button>
			</div>
		);
	};

	return (
		<div className="flex w-[340px] shrink-0 flex-col border-l border-[#25252e] bg-[#111114]">
			<div className="flex items-center gap-2 border-b border-[#25252e] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
				What's going on
				{isWriting && !written && (
					<span className="ml-auto normal-case tracking-normal text-[#a394ff]">
						writing…
					</span>
				)}
			</div>
			<div className="flex min-h-0 flex-1 select-text cursor-text flex-col gap-3.5 overflow-y-auto px-4 py-3">
				{!sessionId ? (
					<div className="text-[12px] text-[#8a8a97]">
						{isSearching
							? "looking for the transcript…"
							: "This session has no Claude conversation id — nothing to read."}
					</div>
				) : (
					<>
						{transcript?.title && (
							<div className="text-[13px] font-semibold text-[#f5f5f7]">
								{transcript.title}
							</div>
						)}
						{error ? (
							<div className="text-[12px] text-[#f0647a]">{error.message}</div>
						) : written ? (
							<>
								{written.goal && <Section label="Goal">{written.goal}</Section>}
								{written.status && (
									<Section label="Status">{written.status}</Section>
								)}
								{/* "Your move", not "Next": the card is in Needs you because
								    something is waiting on you, and the label should say so. */}
								{written.next && (
									<Section label="Your move">{written.next}</Section>
								)}
								{/* The model ignored the shape we asked for — show what it said
								    rather than an empty panel. */}
								{written.raw && (
									<Section label="Summary">{written.raw}</Section>
								)}
							</>
						) : (
							<div className="text-[12px] text-[#8a8a97]">
								reading the conversation…
							</div>
						)}
					</>
				)}
				{/* Links sit outside the transcript branch: the ones you added are
				    yours, and a session with no readable conversation still has them. */}
				{(issue || mine("jira").length > 0) && (
					<Section label={plural("Jira ticket", issue, mine("jira"))}>
						<div className="flex flex-col gap-1">
							{issue && (
								<div className="group flex items-center gap-1.5">
									<Hover text={issue.url}>
										<button
											type="button"
											onClick={() => openUrl.mutate(issue.url)}
											className="truncate text-left text-[12px] text-[#a394ff] hover:underline"
										>
											{issue.key} ↗
										</button>
									</Hover>
									<HideButton onClick={() => hide(issue.url)} />
								</div>
							)}
							{mine("jira").map(myLink)}
						</div>
					</Section>
				)}
				{(thread || mine("slack").length > 0) && (
					<Section label={plural("Slack thread", thread, mine("slack"))}>
						<div className="flex flex-col gap-1.5">
							{thread && (
								<div className="group flex items-start gap-1.5">
									<div className="min-w-0 flex-1">
										<Hover text={hoverText(thread, threadPreview)}>
											<button
												type="button"
												onClick={() => openUrl.mutate(thread)}
												dir="auto"
												className="line-clamp-2 w-full text-left text-[12px] text-[#a394ff] hover:underline"
											>
												{threadPreview?.text ?? "Open thread"} ↗
											</button>
										</Hover>
										{threadPreview && (
											<div className="truncate text-[11px] text-[#8a8a97]">
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
				{(prs.length > 0 || mine("pr").length > 0) && (
					<Section
						label={
							prs.length + mine("pr").length === 1
								? "Pull request"
								: "Pull requests"
						}
					>
						<div className="flex flex-col gap-1">
							{prs.map((pr) => (
								<div key={pr.url} className="group flex items-center gap-1.5">
									<Hover text={pr.url}>
										<button
											type="button"
											onClick={() => openUrl.mutate(pr.url)}
											className="flex min-w-0 items-center gap-1.5 text-left text-[12px] text-[#a394ff] hover:underline"
										>
											<span className="truncate">
												{pr.repo.split("/").pop()} #{pr.number}
											</span>
											<StateChip state={prStates?.[pr.url]?.state ?? null} />
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
					<Section label={plural("Notion page", page, mine("notion"))}>
						<div className="flex flex-col gap-1">
							{page && (
								<div className="group flex items-center gap-1.5">
									<Hover text={page.url}>
										<button
											type="button"
											onClick={() => openUrl.mutate(page.url)}
											className="block min-w-0 flex-1 truncate text-left text-[12px] text-[#a394ff] hover:underline"
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
				{mine("other").length > 0 && (
					<Section label="Links">
						<div className="flex flex-col gap-1">
							{mine("other").map(myLink)}
						</div>
					</Section>
				)}
				{hiddenList.length > 0 && (
					<details className="group/hidden">
						<summary className="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97] hover:text-[#d6d6dc]">
							<span className="inline-block transition-transform group-open/hidden:rotate-90">
								›
							</span>{" "}
							Hidden ({hiddenList.length})
						</summary>
						<div className="mt-1 flex flex-col gap-1">
							{hiddenList.map(({ url, label }) => (
								<div key={url} className="group flex items-center gap-1.5">
									<Hover text={url}>
										<button
											type="button"
											onClick={() => openUrl.mutate(url)}
											dir="auto"
											className="min-w-0 flex-1 truncate text-left text-[12px] text-[#8a8a97] hover:underline"
										>
											{label} ↗
										</button>
									</Hover>
									<button
										type="button"
										title="Show on the brief again"
										onClick={() => setHidden(paneId, url, false)}
										className="ml-auto shrink-0 text-[11px] text-[#7c7c88] opacity-0 hover:text-[#d6d6dc] group-hover:opacity-100"
									>
										show
									</button>
								</div>
							))}
						</div>
					</details>
				)}
				{facts && (
					<div className="pt-2 text-[11px] text-[#8a8a97]">
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
						className="rounded-[7px] border border-[#25252e] bg-[#0a0a0c] px-2 py-1 text-[12px] text-[#d6d6dc] placeholder:text-[#7c7c88] focus:border-[#a394ff] focus:outline-none"
					/>
				</div>
				<div className="flex flex-col gap-1 pt-2">
					<div className="text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
						My notes
					</div>
					<textarea
						value={notes}
						onChange={(event) => setNotes(paneId, event.target.value)}
						placeholder="Notes to yourself — saved as you type."
						rows={4}
						className="resize-y rounded-[7px] border border-[#25252e] bg-[#0a0a0c] px-2 py-1.5 text-[12.5px] leading-relaxed text-[#d6d6dc] placeholder:text-[#7c7c88] focus:border-[#a394ff] focus:outline-none"
					/>
				</div>
			</div>
		</div>
	);
}
