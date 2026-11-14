import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@odin/ui/hover-card";
import { cn } from "@odin/ui/utils";
import { type ComponentType, useState } from "react";
import { LuEye, LuLightbulb, LuTriangleAlert, LuZap } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { BUTTON } from "../components/pill";
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
	tidyText,
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

const BTN =
	"shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] font-medium";

const CHIP =
	"inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-[11.5px] font-medium text-soft-foreground ring-1 ring-inset ring-border hover:bg-accent hover:text-foreground";

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

	const jump = (id: string) =>
		document
			.getElementById(id)
			?.scrollIntoView({ behavior: "smooth", block: "start" });

	return (
		<section
			aria-label="Inbox"
			className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[18px] pt-2 pb-[18px]"
		>
			<div className="mx-auto flex w-full max-w-[980px] flex-col gap-6">
				<header className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h1 className="text-[17px] font-semibold tracking-[-.2px]">
						{count === 0 && stuck.length === 0
							? "Nothing needs you"
							: `${count} waiting on you`}
					</h1>
					{count === 0 && stuck.length === 0 ? (
						<span className="text-[12.5px] text-muted-foreground">
							Every session is working or done.
						</span>
					) : (
						<div className="flex flex-wrap gap-1.5">
							{stuck.length > 0 && (
								<button
									type="button"
									onClick={() => jump("inbox-stuck")}
									className={cn(CHIP, "text-danger ring-danger/30")}
								>
									<LuTriangleAlert className="size-3" aria-hidden />
									{stuck.length} stuck
								</button>
							)}
							{BANDS.map(({ effort, label, Icon, tone }) => {
								const n = rows.get(effort)?.length;
								if (!n) return null;
								return (
									<button
										key={effort}
										type="button"
										onClick={() => jump(`inbox-${effort}`)}
										className={CHIP}
									>
										<Icon className={cn("size-3", tone)} aria-hidden />
										{n} {label.toLowerCase()}
									</button>
								);
							})}
						</div>
					)}
				</header>
				{stuck.length > 0 && (
					<section
						id="inbox-stuck"
						aria-label="Stuck"
						className="flex scroll-mt-2 flex-col gap-2"
					>
						<BandTitle
							Icon={LuTriangleAlert}
							tone="text-danger"
							label="Stuck"
							hint="can't move on their own and aren't asking"
						/>
						<div className="flex flex-col overflow-hidden rounded-xl border border-danger/30 bg-danger/5">
							{stuck.map(({ session, why, fix }, i) => (
								<div
									key={session.paneId}
									className={cn(
										"flex items-center gap-3 px-4 py-2.5",
										i > 0 && "border-t border-danger/15",
									)}
								>
									<button
										type="button"
										onClick={() => onPreview(session.paneId)}
										className="flex min-w-0 flex-1 flex-col items-start text-left"
									>
										<span className="w-full truncate text-[13.5px] font-medium hover:underline">
											{tidyText(session.title)}
										</span>
										<span className="w-full truncate text-[12px] text-danger/90">
											{why}
										</span>
									</button>
									<button
										type="button"
										onClick={() => fixStuck(session.paneId, fix)}
										className={cn(BTN, BUTTON.primary)}
									>
										{FIX_LABEL[fix]}
									</button>
								</div>
							))}
						</div>
					</section>
				)}
				{BANDS.map(({ effort, label, hint, Icon, tone }) => {
					const band = rows.get(effort);
					if (!band?.length) return null;
					return (
						<section
							key={effort}
							id={`inbox-${effort}`}
							aria-label={label}
							className="flex scroll-mt-2 flex-col gap-2"
						>
							<BandTitle
								Icon={Icon}
								tone={tone}
								label={label}
								hint={`${band.length} - ${hint}`}
							/>
							<div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
								{bySession(band).map((group, g) => (
									<div
										key={group[0].session.paneId}
										className={cn(
											"flex flex-col pb-1",
											g > 0 && "border-t border-border",
										)}
									>
										<button
											type="button"
											onClick={() => onPreview(group[0].session.paneId)}
											className="flex items-center gap-1.5 bg-none px-4 pt-2.5 pb-0.5 text-left text-[11.5px] font-medium text-muted-foreground hover:text-foreground"
										>
											<span className="truncate">
												{tidyText(group[0].session.title)}
											</span>
											{group.length > 1 && (
												<span className="shrink-0 rounded-full bg-secondary px-1.5 text-[10.5px] tabular-nums">
													{group.length}
												</span>
											)}
										</button>
										{group.map((row) => (
											<ItemRow
												key={rowKey(row)}
												row={row}
												onPreview={onPreview}
												onOpen={onOpen}
												answer={answer}
											/>
										))}
									</div>
								))}
							</div>
						</section>
					);
				})}
			</div>
		</section>
	);
}

/** Consecutive rows of one session, so its title shows once above them. */
function bySession(band: Row[]): Row[][] {
	const groups: Row[][] = [];
	for (const row of band) {
		const last = groups.at(-1);
		if (last?.[0].session.paneId === row.session.paneId) last.push(row);
		else groups.push([row]);
	}
	return groups;
}

function BandTitle({
	Icon,
	tone,
	label,
	hint,
}: {
	Icon: ComponentType<{ className?: string }>;
	tone: string;
	label: string;
	hint: string;
}) {
	return (
		<h2 className="flex items-center gap-2 px-1 text-[12px] font-semibold">
			<Icon className={cn("size-3.5", tone)} aria-hidden />
			{label}
			<span className="font-normal text-muted-foreground">{hint}</span>
		</h2>
	);
}

/** One action item: its text, and the buttons that answer it. */
function ItemRow({
	row,
	onPreview,
	onOpen,
	answer,
}: {
	row: Row;
	onPreview: (paneId: string) => void;
	onOpen: (paneId: string) => void;
	answer: (row: Row, text: string) => void;
}) {
	const text = tidyText(row.text);
	return (
		<div className="group flex items-center gap-4 px-4 py-1.5 hover:bg-accent/40">
			<HoverCard openDelay={400} closeDelay={80}>
				<HoverCardTrigger asChild>
					<button
						type="button"
						onClick={() => onPreview(row.session.paneId)}
						className="min-w-0 flex-1 bg-none text-left"
					>
						<span
							dir="auto"
							title={row.text}
							className="line-clamp-2 select-text text-[13.5px] leading-snug"
						>
							{text}
						</span>
					</button>
				</HoverCardTrigger>
				<HoverCardContent
					align="start"
					className="flex w-[480px] flex-col gap-2 border-border bg-popover p-3 text-[12.5px]"
				>
					{row.task && <HoverPart label="The task" text={row.task} />}
					{row.status && (
						<HoverPart label="Where it stands" text={row.status} />
					)}
				</HoverCardContent>
			</HoverCard>
			<div className="flex max-w-[55%] shrink-0 flex-wrap justify-end gap-1.5">
				{row.options.map((option) => (
					<button
						key={option}
						type="button"
						onClick={() =>
							answer(row, `Action item ${row.number} (${row.text}): ${option}`)
						}
						className={cn(BTN, BUTTON.secondary)}
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
						className={cn(BTN, BUTTON.primary)}
					>
						Approve
					</button>
				)}
				{!row.options.length && !row.approve && (
					<button
						type="button"
						onClick={() => onOpen(row.session.paneId)}
						className={cn(BTN, BUTTON.secondary)}
					>
						Open
					</button>
				)}
			</div>
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
