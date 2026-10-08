import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@odin/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@odin/ui/dialog";
import { cn } from "@odin/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { IconType } from "react-icons";
import { emojify } from "renderer/lib/emoji";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useAllItems } from "../all/use-all-items";
import { useOdinProfile } from "../hooks/useOdinProfile";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import { ROW_META } from "./FeedChrome";
import { FEED_TABS, type FeedPath } from "./feed-counts";
import { PILL } from "./pill";
import { boardSessions, searchAll } from "./search-all";

const SOURCE_ICON = Object.fromEntries(
	FEED_TABS.map(({ to, Icon }) => [to, Icon]),
) as Record<FeedPath, IconType>;

const CHIP = cn(
	"flex w-[68px] shrink-0 items-center justify-center gap-1 rounded-[5px] px-[7px] py-[1px] text-[11px] font-semibold",
	PILL.neutral,
);
const ITEM = "gap-2.5 rounded-[7px] px-2.5 py-1.5 text-[13px]";

/**
 * Search all (⌘⇧F): one palette over every feed row and every Dev Board
 * session. Rows come from the same list All draws, out of the caches the shell
 * already keeps warm. A row opens its details on All; a session opens its
 * drawer on the board.
 */
export function SearchAll({ onClose }: { onClose: () => void }) {
	const navigate = useNavigate();
	const rows = useAllItems();
	const panes = useTabsStore((s) => s.panes);
	const tabs = useTabsStore((s) => s.tabs);
	const { activeId, isLoading } = useOdinProfile();
	const sessions = useMemo(
		() =>
			isLoading
				? []
				: boardSessions(panes, new Set(tabs.map((tab) => tab.id)), activeId),
		[panes, tabs, activeId, isLoading],
	);
	const [query, setQuery] = useState("");
	const results = useMemo(
		() => searchAll(query, rows, sessions),
		[query, rows, sessions],
	);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				showCloseButton={false}
				aria-describedby={undefined}
				className="top-[12vh] w-[620px] max-w-[92vw] translate-y-0 gap-0 overflow-hidden rounded-[10px] border-border bg-popover p-0 shadow-[0_18px_60px_rgba(0,0,0,0.6)] sm:max-w-[92vw]"
			>
				<DialogTitle className="sr-only">Search all</DialogTitle>
				<Command shouldFilter={false} className="bg-transparent">
					<CommandInput
						value={query}
						onValueChange={setQuery}
						placeholder="Search every feed and session"
						className="text-[13px]"
					/>
					<CommandList className="max-h-[60vh] p-1">
						<CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
							Nothing matches
						</CommandEmpty>
						{results.sessions.length > 0 && (
							<CommandGroup heading="Dev Board">
								{results.sessions.map((session) => (
									<CommandItem
										key={session.paneId}
										value={`session:${session.paneId}`}
										className={ITEM}
										onSelect={() => {
											onClose();
											usePendingFocus.getState().focus(session.paneId);
											navigate({ to: "/board" });
										}}
									>
										<span
											className="size-1.5 shrink-0 rounded-full"
											style={{ background: PANE_STATUS[session.status].dot }}
											title={PANE_STATUS[session.status].label}
										/>
										<span className="min-w-0 flex-1 truncate">
											{emojify(session.title)}
										</span>
										<span className={cn(ROW_META, "shrink-0")}>
											{[session.contact, session.repo]
												.filter(Boolean)
												.join(" · ")}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						)}
						{results.rows.length > 0 && (
							<CommandGroup heading="Feeds">
								{results.rows.map((item) => {
									const Icon = SOURCE_ICON[item.to];
									return (
										<CommandItem
											key={item.key}
											value={item.key}
											className={ITEM}
											onSelect={() => {
												onClose();
												navigate({ to: "/all", search: { open: item.key } });
											}}
										>
											<span className={CHIP}>
												<Icon className="size-3 shrink-0" aria-hidden />
												{item.source}
											</span>
											<span className="min-w-0 flex-1 truncate">
												{emojify(item.title)}
											</span>
											{item.person && (
												<span
													className={cn(ROW_META, "max-w-[140px] truncate")}
												>
													{item.person}
												</span>
											)}
										</CommandItem>
									);
								})}
							</CommandGroup>
						)}
					</CommandList>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
