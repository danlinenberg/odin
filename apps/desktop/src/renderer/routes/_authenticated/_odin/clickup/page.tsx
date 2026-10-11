import { createFileRoute } from "@tanstack/react-router";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { openUrl } from "renderer/stores/in-app-browser";
import { DoneButton } from "../components/DoneButton";
import {
	FEED_LIST,
	FEED_ROW,
	FeedHeader,
	META_DATE,
	META_PERSON,
	ROW_LINK_BUTTON,
	ROW_LINK_SLOT,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";

export const Route = createFileRoute("/_authenticated/_odin/clickup/")({
	component: ClickupPage,
});

/**
 * Open ClickUp tasks assigned to me. Read-only: Open takes you to the task,
 * Done takes the row out of Odin (not ClickUp).
 */
function ClickupPage() {
	const { clickup, workConfig, syncAll, isSyncing } = useOdinFeeds();
	const { isDone, markDone } = useDone();
	const rows = (clickup.data?.tasks ?? []).filter(
		(task) => !isDone({ key: `clickup:${task.id}`, url: task.url }),
	);

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<div className="ml-auto flex items-center gap-2.5">
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={FEED_LIST}>
				{workConfig && !workConfig.hasClickup && (
					<ConnectNotice
						provider="clickup"
						text="ClickUp isn't connected - add a personal token to see your tasks."
					/>
				)}
				{clickup.error?.data?.code === "UNAUTHORIZED" ? (
					<ConnectNotice
						provider="clickup"
						text="ClickUp rejected the token - it was revoked or changed. Paste a new one."
					/>
				) : (
					<FeedError error={clickup.error} />
				)}
				{clickup.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						No open ClickUp tasks 🎉
					</div>
				)}
				{rows.map((task) => (
					<div key={task.id} className={FEED_ROW}>
						<div className="flex items-center gap-3">
							<div className="min-w-0 flex-1">
								<div className="truncate text-[13px] font-semibold text-foreground">
									{task.name}
								</div>
								<div className="truncate text-[11px] text-muted-foreground">
									{[task.status, task.list, task.priority]
										.filter(Boolean)
										.join(" · ")}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-2 text-[11px]">
								{task.creator && (
									<span
										className={`${META_PERSON} truncate text-muted-foreground`}
									>
										{task.creator}
									</span>
								)}
								<span title={task.updated ?? undefined} className={META_DATE}>
									{task.updated
										? new Date(task.updated).toLocaleDateString(undefined, {
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
										onClick={() => openUrl(task.url)}
										className={ROW_LINK_BUTTON}
									>
										Open ↗
									</button>
								</span>
								<DoneButton
									onClick={() =>
										markDone({
											key: `clickup:${task.id}`,
											title: task.name,
											source: "ClickUp",
											url: task.url,
										})
									}
								/>
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
