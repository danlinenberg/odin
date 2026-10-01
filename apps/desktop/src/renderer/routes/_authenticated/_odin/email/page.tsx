import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { DoneButton } from "../components/DoneButton";
import {
	FEED_LIST,
	FEED_ROW,
	FeedDivider,
	FeedHeader,
	FilterPill,
	META_DATE,
	META_PERSON,
	ROW_LINK_BUTTON,
	ROW_LINK_SLOT,
	RowActions,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";

export const Route = createFileRoute("/_authenticated/_odin/email/")({
	component: EmailPage,
});

/**
 * Gmail inbox mail (unread when first seen; it stays after you open it until Done), junk (the model's call, and every calendar invite) hidden until "All". Read-only:
 * Open takes you to the thread, Done takes the row out of Odin (not Gmail).
 */
function EmailPage() {
	const { emails, workConfig, syncAll, isSyncing } = useOdinFeeds();
	const { isDone, markDone } = useDone();
	const openUrl = electronTrpc.external.openUrl.useMutation();
	// ponytail: local state — opens on the interesting mail every visit.
	const [showJunk, setShowJunk] = useState(false);
	const open = (emails.data?.emails ?? []).filter(
		(email) => !isDone({ key: `email:${email.id}`, url: email.url }),
	);
	const junkCount = open.filter((email) => email.junk === true).length;
	const rows = showJunk ? open : open.filter((email) => email.junk !== true);

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<FilterPill
					active={!showJunk}
					count={open.length - junkCount}
					onClick={() => setShowJunk(false)}
				>
					Interesting
				</FilterPill>
				<FilterPill
					active={showJunk}
					count={open.length}
					onClick={() => setShowJunk(true)}
				>
					All
				</FilterPill>
				<div className="ml-auto flex items-center gap-2.5">
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={FEED_LIST}>
				{workConfig && !workConfig.hasGmail && (
					<ConnectNotice
						provider="gmail"
						text="Gmail isn't connected — add an app password to see your unread mail."
					/>
				)}
				{/* A dead app password is fixed right here, not in Settings: paste a
				    new one and the feed refetches. */}
				{emails.error?.data?.code === "UNAUTHORIZED" ? (
					<ConnectNotice
						provider="gmail"
						text="Gmail rejected the app password — it was revoked or changed. Paste a new one."
					/>
				) : (
					<FeedError error={emails.error} />
				)}
				{emails.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						{junkCount > 0 && !showJunk
							? `Nothing interesting — ${junkCount} junk hidden`
							: "No unread mail 🎉"}
					</div>
				)}
				{rows.map((email) => (
					<div key={email.id} className={FEED_ROW}>
						<div className="flex items-center gap-3">
							<div className="min-w-0 flex-1">
								<div className="truncate text-[13px] font-semibold text-[#f5f5f7]">
									{email.subject}
								</div>
								{email.snippet && (
									<div className="truncate text-[11px] text-[#8a8a97]">
										{email.snippet}
									</div>
								)}
							</div>
							<div className="flex shrink-0 items-center gap-2 text-[11px]">
								<span className={`${META_PERSON} truncate text-[#a5a5b3]`}>
									{email.from}
								</span>
								<span title={email.at ?? undefined} className={META_DATE}>
									{email.at
										? new Date(email.at).toLocaleDateString(undefined, {
												month: "short",
												day: "numeric",
											})
										: null}
								</span>
							</div>
							<div className="flex shrink-0 items-center gap-1.5">
								<span className={ROW_LINK_SLOT}>
									<button
										type="button"
										onClick={() => openUrl.mutate(email.url)}
										className={ROW_LINK_BUTTON}
									>
										Open ↗
									</button>
								</span>
								<RowActions>
									<DoneButton
										onClick={() =>
											markDone({
												key: `email:${email.id}`,
												title: email.subject,
												source: "Email",
												url: email.url,
											})
										}
									/>
								</RowActions>
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
