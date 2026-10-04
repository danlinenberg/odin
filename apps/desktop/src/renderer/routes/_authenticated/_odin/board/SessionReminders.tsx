import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@odin/ui/hover-card";
import { toast } from "@odin/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { LuBellRing } from "react-icons/lu";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { BUTTON } from "../components/pill";
import { dayOf, dueLabel, isDue, useReminders } from "../components/Reminders";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { HoverBrief } from "./SessionBrief";

/**
 * "Remind me" on a board session: Done now, back on a day you pick. The
 * reminder rides the existing due-date store under `remind:<sessionId>`, so
 * the minute ticker (layout's useDueReminders) sends the notification; this
 * file adds the resume info and the strip that brings it back.
 */
export const PREFIX = "remind:";

/** Resume a reminded session into a fresh pane and drop the reminder. */
export function useResumeReminder() {
	const clear = useReminders((s) => s.clear);
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching } = useLaunchTaskSession();
	const navigate = useNavigate();
	const resume = async (key: string) => {
		const r = useReminders.getState().reminders[key];
		if (!r?.resume) return;
		const ensured = await ensureWorkspace(r.resume.cwd);
		if (!ensured.ok) return void toast.error(ensured.error);
		const result = await launch({
			workspaceId: ensured.workspace.id,
			title: r.title,
			description: null,
			resumeSessionId: r.resume.sessionId,
			repoPath: r.resume.cwd,
		});
		if (!result.ok) return void toast.error(result.error);
		clear(key);
		usePendingFocus.getState().focus(result.paneId);
		navigate({ to: "/board" });
	};
	return { resume, isLaunching };
}

export function remindSession(
	session: { sessionId: string; cwd: string; title: string; brief?: string },
	day: string,
): void {
	useReminders.setState((s) => ({
		reminders: {
			...s.reminders,
			[PREFIX + session.sessionId]: {
				due: day,
				title: session.title,
				resume: {
					sessionId: session.sessionId,
					cwd: session.cwd,
					brief: session.brief,
					setAt: Date.now(),
				},
			},
		},
		notified: { ...s.notified, [PREFIX + session.sessionId]: "" },
	}));
}

/** The bell: opens the OS date picker, tomorrow at the earliest. */
export function RemindButton({
	onPick,
	className,
	label,
}: {
	onPick: (day: string) => void;
	className: string;
	label?: string;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<span className="relative inline-flex shrink-0">
			<input
				ref={input}
				type="date"
				min={dayOf(Date.now() + 86_400_000)}
				value=""
				onChange={(e) => e.target.value && onPick(e.target.value)}
				onClick={(e) => e.stopPropagation()}
				tabIndex={-1}
				aria-hidden
				style={{ colorScheme: "dark" }}
				className="pointer-events-none absolute inset-0 size-full opacity-0"
			/>
			<button
				type="button"
				title="Remind me — done for now, back on a day you pick"
				aria-label="Remind me"
				// A board card is itself a button — don't open its drawer.
				onClick={(e) => {
					e.stopPropagation();
					input.current?.showPicker();
				}}
				className={className}
			>
				<LuBellRing className="inline size-3 align-[-2px]" aria-hidden />
				{label && ` ${label}`}
			</button>
		</span>
	);
}

/**
 * Sessions whose reminder day has come, above the columns, each with Resume —
 * the same `claude --resume` into a fresh pane Session History does.
 */
export function SessionReminders() {
	const reminders = useReminders((s) => s.reminders);
	const clear = useReminders((s) => s.clear);
	const { resume, isLaunching } = useResumeReminder();
	const now = Date.now();
	const due = Object.entries(reminders).filter(
		([key, r]) => key.startsWith(PREFIX) && r.resume && isDue(r.due, now),
	);
	if (!due.length) return null;

	return (
		<div className="mx-[18px] mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-attention/25 bg-attention/8 px-3 py-2 text-[12px]">
			<span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.4px] text-attention">
				<LuBellRing className="size-3.5" aria-hidden />
				Reminders · {due.length}
			</span>
			{due.map(([key, r]) => (
				<span
					key={key}
					className="flex min-w-0 items-center gap-1.5 rounded-lg border border-attention/30 bg-card py-0.5 pl-2.5 pr-1"
				>
					<HoverCard openDelay={300} closeDelay={80}>
						<HoverCardTrigger asChild>
							<span
								dir="auto"
								className="max-w-[320px] cursor-default truncate font-medium text-foreground"
							>
								{r.title}
							</span>
						</HoverCardTrigger>
						<HoverCardContent
							align="start"
							className="flex max-h-[70vh] w-[400px] flex-col gap-2 overflow-y-auto border-input bg-secondary p-3 shadow-[0_12px_40px_rgba(0,0,0,0.75)]"
						>
							<div
								dir="auto"
								className="whitespace-pre-wrap break-words text-[13px] font-semibold text-foreground"
							>
								{r.title}
							</div>
							{/* The launch-time brief is usually just the title — don't repeat it. */}
							{r.resume?.brief && r.resume.brief.trim() !== r.title.trim() && (
								<div
									dir="auto"
									className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-soft-foreground"
								>
									{r.resume.brief.slice(0, 1500)}
								</div>
							)}
							<HoverBrief sessionId={r.resume?.sessionId} />
							<div className="border-t border-border pt-2 text-[11px] text-muted-foreground">
								<div>
									In {r.resume?.cwd.split("/").pop()} · {r.resume?.cwd}
								</div>
								<div>
									Due {r.due}
									{r.resume?.setAt &&
										` · snoozed ${new Date(r.resume.setAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
								</div>
							</div>
						</HoverCardContent>
					</HoverCard>
					<span className="text-[11px] text-muted-foreground">
						{dueLabel(r.due, now)}
					</span>
					<button
						type="button"
						disabled={isLaunching}
						onClick={() => void resume(key)}
						className={`rounded-md px-2 py-0.5 text-[11px] font-semibold disabled:opacity-60 ${BUTTON.secondary}`}
					>
						↻ Resume
					</button>
					<button
						type="button"
						title="Dismiss the reminder"
						onClick={() => clear(key)}
						className="rounded-md px-1 text-[11px] text-muted-foreground hover:text-foreground"
					>
						✕
					</button>
				</span>
			))}
		</div>
	);
}
