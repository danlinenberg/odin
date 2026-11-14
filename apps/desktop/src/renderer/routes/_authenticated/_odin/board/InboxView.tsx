import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@odin/ui/hover-card";
import { cn } from "@odin/ui/utils";
import { type ComponentType, useState } from "react";
import { LuEye, LuLightbulb, LuTriangleAlert, LuZap } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	isApprovalItem,
	itemDetail,
	itemOptions,
	splitActionItems,
} from "./action-items";
import { actionItemEntries, lastMessageAt } from "./brief";
import {
	type InboxEffort,
	itemEffort,
	REBASE_PROMPT,
	STATUS_PROMPT,
	type StuckFix,
	type StuckSignals,
	stuckReason,
} from "./inbox";

/** A board session as the Inbox sees it. */
export interface InboxSession {
	paneId: string;
	title: string;
	sessionId: string | null;
	/** Claude runs in its pane now. */
	live: boolean;
	/** Needs you or Final Review: its action items are listed. */
	asks: boolean;
	stuck: StuckSignals;
}

interface Row {
	session: InboxSession;
	number: number;
	text: string;
	options: string[];
	approve: boolean;
	/** The session's opening ask: what the task is. */
	task: string | null;
	/** The reply's paragraph about this item: where things stand. */
	status: string;
}

const BANDS: {
	effort: InboxEffort;
	label: string;
	hint: string;
	Icon: ComponentType<{ className?: string }>;
	tone: string;
}[] = [
	{
		effort: "quick",
		label: "One click",
		hint: "a choice, a go-ahead, a merge or a command",
		Icon: LuZap,
		tone: "text-attention",
	},
	{
		effort: "look",
		label: "Needs a look",
		hint: "a PR, a draft or a page to check",
		Icon: LuEye,
		tone: "text-working",
	},
	{
		effort: "think",
		label: "Needs thinking",
		hint: "an open question or something only you can do",
		Icon: LuLightbulb,
		tone: "text-primary",
	},
];

const rowKey = (row: Row) => `${row.session.paneId}:${row.number}:${row.text}`;

const BUTTON =
	"shrink-0 rounded-md border border-border bg-secondary px-2.5 py-1 text-[12px] font-medium hover:bg-accent";

/**
 * Every open action item across the board's sessions in one list, banded by
 * effort, with the stuck sessions on top - so you clear what needs you
 * without opening each card.
 */
export function InboxView({
	sessions,
	onPreview,
	onOpen,
	onSend,
	onResume,
}: {
	sessions: InboxSession[];
	/** A clicked row: show the session's brief beside the list. */
	onPreview: (paneId: string) => void;
	/** An Open button: the session itself. */
	onOpen: (paneId: string) => void;
	onSend: (paneId: string, text: string) => void;
	onResume: (paneId: string) => void;
}) {
	// The same query the cards' pills run, so it comes from their cache.
	const transcripts = electronTrpc.useQueries((t) =>
		sessions.map((session) =>
			t.terminal.readClaudeTranscript(
				{ sessionId: session.sessionId ?? "" },
				{
					// Idle cards are only read for stuck signals the board already has.
					enabled:
						!!session.sessionId && (session.asks || !!session.stuck.working),
					retry: false,
					staleTime: 60_000,
					refetchInterval: session.live ? 60_000 : false,
				},
			),
		),
	);
	// Answered here: hidden until the session's next reply replaces its items.
	const [answered, setAnswered] = useState<Set<string>>(() => new Set());
	const answer = (row: Row, text: string) => {
		setAnswered((now) => new Set(now).add(rowKey(row)));
		onSend(row.session.paneId, text);
	};
	const now = Date.now();
	const rows = new Map<InboxEffort, Row[]>();
	const stuck: { session: InboxSession; why: string; fix: StuckFix }[] = [];
	sessions.forEach((session, i) => {
		const messages = transcripts[i]?.data?.messages;
		const reason = stuckReason(
			{
				...session.stuck,
				working: session.stuck.working && {
					lastMessageAt: messages ? lastMessageAt(messages) : null,
				},
			},
			now,
		);
		if (reason) stuck.push({ session, ...reason });
		if (!session.asks || !messages) return;
		const last = messages.findLast((m) => m.role === "assistant")?.text ?? "";
		const { body, actions } = splitActionItems(last);
		if (!actions) return;
		const task = messages.find((m) => m.role === "user")?.text ?? null;
		actionItemEntries(actions).forEach((entry, at) => {
			const effort = itemEffort(entry);
			const { text, options } = itemOptions(entry.text);
			const row = {
				session,
				number: at + 1,
				text,
				options,
				approve: isApprovalItem(entry.text),
				task,
				status: itemDetail(entry.text, body, at + 1) ?? body,
			};
			if (answered.has(rowKey(row))) return;
			rows.set(effort, [...(rows.get(effort) ?? []), row]);
		});
	});
	const count = [...rows.values()].reduce((n, band) => n + band.length, 0);
	const fixStuck = (paneId: string, fix: StuckFix) => {
		if (fix === "resume") onResume(paneId);
		else if (fix === "status") onSend(paneId, STATUS_PROMPT);
		else if (fix === "rebase") onSend(paneId, REBASE_PROMPT);
		else onOpen(paneId);
	};
	const FIX_LABEL: Record<StuckFix, string> = {
		open: "Open",
		resume: "Resume",
		status: "Ask for status",
		rebase: "Rebase on main",
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-[18px] pt-1 pb-[18px]">
			<div className="text-[12px] text-muted-foreground">
				{count === 0 && stuck.length === 0
					? "Inbox: nothing needs you. Every session is working or done."
					: `Inbox: ${count} ${count === 1 ? "item" : "items"} waiting on you${stuck.length ? `, ${stuck.length} stuck` : ""}`}
			</div>
			{stuck.length > 0 && (
				<section
					aria-label="Stuck"
					className="flex flex-col rounded-xl border border-danger/40 bg-danger/5 px-4 py-2"
				>
					<h2 className="flex items-center gap-2 py-1.5 text-[12px] font-semibold text-danger">
						<LuTriangleAlert className="size-3.5" aria-hidden />
						Stuck
						<span className="font-normal text-muted-foreground">
							can't move on their own and aren't asking
						</span>
					</h2>
					{stuck.map(({ session, why, fix }) => (
						<div
							key={session.paneId}
							className="flex items-center gap-3 border-t border-danger/20 py-2"
						>
							<button
								type="button"
								onClick={() => onPreview(session.paneId)}
								className="w-56 shrink-0 truncate text-left text-[13px] font-medium hover:underline"
							>
								{session.title}
							</button>
							<span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
								{why}
							</span>
							<button
								type="button"
								onClick={() => fixStuck(session.paneId, fix)}
								className={BUTTON}
							>
								{FIX_LABEL[fix]}
							</button>
						</div>
					))}
				</section>
			)}
			{BANDS.map(({ effort, label, hint, Icon, tone }) => {
				const band = rows.get(effort);
				if (!band?.length) return null;
				return (
					<section
						key={effort}
						aria-label={label}
						className="flex flex-col gap-2"
					>
						<h2 className="flex items-center gap-2 text-[12px] font-semibold">
							<Icon className={cn("size-3.5", tone)} aria-hidden />
							{label}
							<span className="font-normal text-muted-foreground">
								{band.length} - {hint}
							</span>
						</h2>
						<div className="flex flex-col rounded-xl border border-border bg-card">
							{band.map((row, i) => (
								<div
									key={`${row.session.paneId}:${row.number}`}
									className={cn(
										"flex items-center gap-2 px-4 py-2.5",
										i > 0 && "border-t border-border",
									)}
								>
									<HoverCard openDelay={400} closeDelay={80}>
										<HoverCardTrigger asChild>
											<button
												type="button"
												onClick={() => onPreview(row.session.paneId)}
												className="flex min-w-0 flex-1 flex-col items-start text-left"
											>
												<span className="w-full select-text truncate text-[13.5px]">
													{row.text}
												</span>
												<span className="w-full truncate text-[11.5px] text-muted-foreground">
													{row.session.title}
												</span>
											</button>
										</HoverCardTrigger>
										<HoverCardContent
											align="start"
											className="flex w-[480px] flex-col gap-2 border-border bg-popover p-3 text-[12.5px]"
										>
											{row.task && (
												<HoverPart label="The task" text={row.task} />
											)}
											{row.status && (
												<HoverPart label="Where it stands" text={row.status} />
											)}
										</HoverCardContent>
									</HoverCard>
									{row.options.map((option) => (
										<button
											key={option}
											type="button"
											onClick={() =>
												answer(
													row,
													`Action item ${row.number} (${row.text}): ${option}`,
												)
											}
											className={BUTTON}
										>
											{option}
										</button>
									))}
									{row.approve && (
										<button
											type="button"
											onClick={() =>
												answer(
													row,
													`Approved - go ahead with action item ${row.number}: ${row.text}`,
												)
											}
											className={BUTTON}
										>
											Approve
										</button>
									)}
									{!row.options.length && !row.approve && (
										<button
											type="button"
											onClick={() => onOpen(row.session.paneId)}
											className={BUTTON}
										>
											Open
										</button>
									)}
								</div>
							))}
						</div>
					</section>
				);
			})}
		</div>
	);
}

/** One labelled part of a row's hover card, clipped to a few lines. */
function HoverPart({ label, text }: { label: string; text: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[11px] font-semibold text-muted-foreground">
				{label}
			</span>
			<p
				dir="auto"
				className="line-clamp-6 whitespace-pre-wrap break-words text-foreground"
			>
				{text}
			</p>
		</div>
	);
}
