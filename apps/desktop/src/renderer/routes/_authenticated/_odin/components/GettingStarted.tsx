import { cn } from "@odin/ui/utils";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { LuCheck, LuChevronDown, LuX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { profileOf } from "shared/odin-profile";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useOdinProfile } from "../hooks/useOdinProfile";
import { useMyTasks } from "../hooks/useOdinTasks";
import {
	isFreshProfile,
	STEPS,
	type StepId,
	satisfiedSteps,
} from "./getting-started";
import { BUTTON, PILL } from "./pill";

/**
 * Get started — a checklist a new profile walks through, one pillar per row.
 * It sits in the corner of every Odin view until every row is ticked or it is
 * closed, and each row's button takes you to the place that ticks it.
 *
 * Rows tick themselves from what the profile actually has (a working sign-in,
 * a task, a session), never from a click, and stay ticked once they have been:
 * deleting your first task shouldn't un-learn it.
 */

interface ProfileProgress {
	/** Decided once, the first time this profile is seen: fresh or not. */
	show: boolean;
	collapsed?: boolean;
	done: StepId[];
}

/**
 * ponytail: one small entry per profile ever seen, never deleted — a deleted
 * profile leaves ~50 bytes behind. Bounded by how many profiles you make.
 */
const useGettingStarted = create<{
	profiles: Record<string, ProfileProgress | undefined>;
	update: (profileId: string, patch: Partial<ProfileProgress>) => void;
}>()(
	persist(
		(set) => ({
			profiles: {},
			update: (profileId, patch) =>
				set((s) => ({
					profiles: {
						...s.profiles,
						[profileId]: {
							...(s.profiles[profileId] ?? { show: false, done: [] }),
							...patch,
						},
					},
				})),
		}),
		{ name: "odin-getting-started" },
	),
);

const STEP_COPY: Record<
	StepId,
	{ title: string; body: (newTaskKeys: string) => string; action: string }
> = {
	connections: {
		title: "Connect your accounts",
		body: () =>
			"Slack, GitHub, Jira, Notion or Gmail — what's waiting on you there lands in Tasks.",
		action: "Connect",
	},
	task: {
		title: "Write down a task",
		body: (keys) =>
			`The thing to do that isn't a ticket yet.${keys ? ` ${keys} adds one from anywhere.` : ""}`,
		action: "Add task",
	},
	session: {
		title: "Start a session on it",
		body: () =>
			"Start session hands a task to an agent. Its card lands on the Dev Board.",
		action: "My Tasks",
	},
	automation: {
		title: "Schedule an automation",
		body: () =>
			"A task on a timer — it starts its own session every morning, or every Monday.",
		action: "Automations",
	},
	review: {
		title: "Clear the backlog",
		body: () =>
			"Review checks your feeds for work that's already done elsewhere and offers to drop it.",
		action: "Review",
	},
};

export function GettingStarted({
	onAddTask,
	newTaskKeys,
}: {
	onAddTask: () => void;
	newTaskKeys: string;
}) {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const { activeId, activeName, isLoading: profileLoading } = useOdinProfile();
	const progress = useGettingStarted((s) => s.profiles[activeId]);
	const update = useGettingStarted((s) => s.update);
	const { todos, automations, tasks } = useMyTasks();
	const panes = useTabsStore((s) => s.panes);

	// Probes every provider over the network, so only while it can matter: to
	// decide whether this profile is new, and while its checklist is up.
	const wanted = !progress || progress.show;
	const status = electronTrpc.connections.status.useQuery(undefined, {
		enabled: wanted && !profileLoading,
		refetchOnWindowFocus: false,
	});
	const settled = !profileLoading && !!status.data && !status.isFetching;

	const sessionCount =
		Object.values(panes).filter(
			(pane) =>
				pane.type === "terminal" &&
				!!pane.odinTaskTitle &&
				profileOf(pane.odinProfile) === activeId,
		).length + tasks.filter((task) => task.paneId).length;
	const met = satisfiedSteps({
		connections: status.data,
		todoCount: todos.length,
		sessionCount,
		ownAutomationCount: automations.filter((task) => !task.builtin).length,
		onReview: !!matchRoute({ to: "/review", fuzzy: true }),
	});
	const done = STEPS.filter(
		(step) => progress?.done.includes(step) || met.includes(step),
	);

	useEffect(() => {
		if (!settled) return;
		if (!progress) {
			update(activeId, {
				show: isFreshProfile(status.data ?? [], todos.length),
			});
		} else if (progress.show && done.length > progress.done.length) {
			update(activeId, { done });
		}
	}, [settled, progress, done, activeId, status.data, todos.length, update]);

	if (!progress?.show) return null;

	const close = () => update(activeId, { show: false });
	const next = STEPS.find((step) => !done.includes(step));
	const run: Record<StepId, () => void> = {
		connections: () => navigate({ to: "/settings/connections" }),
		task: onAddTask,
		session: () => navigate({ to: "/my-tasks" }),
		automation: () => navigate({ to: "/automations" }),
		review: () => navigate({ to: "/review" }),
	};

	return (
		<div className="absolute right-4 bottom-4 z-30 w-[320px] overflow-hidden rounded-[12px] border border-border bg-card shadow-[0_10px_30px_rgba(0,0,0,.45),0_0_24px_-8px_color-mix(in_oklab,var(--primary)_45%,transparent)]">
			<div className="flex items-center gap-2 px-3.5 pt-3 pb-2.5">
				<button
					type="button"
					onClick={() => update(activeId, { collapsed: !progress.collapsed })}
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
					aria-expanded={!progress.collapsed}
				>
					<span className="bg-gradient-to-r from-primary-ink to-primary bg-clip-text text-[13px] font-bold text-transparent">
						{next ? "Get started" : "You're set up"}
					</span>
					<span className="truncate text-[11px] text-muted-foreground">
						{activeName}
					</span>
					<span
						className={cn(
							"ml-auto shrink-0 rounded-full px-2 py-[1px] text-[10px] font-bold tabular-nums",
							next ? PILL.brand : PILL.success,
						)}
					>
						{done.length}/{STEPS.length}
					</span>
					<LuChevronDown
						className={cn(
							"size-3.5 shrink-0 text-muted-foreground transition-transform",
							progress.collapsed && "rotate-180",
						)}
					/>
				</button>
				<button
					type="button"
					onClick={close}
					title="Close — it won't come back for this profile"
					aria-label="Close Get started"
					className="shrink-0 rounded-[6px] p-0.5 text-muted-foreground hover:text-foreground"
				>
					<LuX className="size-3.5" />
				</button>
			</div>

			<div className="mx-3.5 h-1 overflow-hidden rounded-full bg-secondary">
				<div
					className="h-full rounded-full bg-gradient-to-r from-primary to-working transition-[width] duration-500"
					style={{ width: `${(done.length / STEPS.length) * 100}%` }}
				/>
			</div>

			{!progress.collapsed && (
				<ol className="space-y-0.5 px-2 pt-2 pb-2">
					{STEPS.map((step) => {
						const copy = STEP_COPY[step];
						const isDone = done.includes(step);
						const isNext = step === next;
						return (
							<li
								key={step}
								className={cn(
									"flex gap-2.5 rounded-[8px] px-1.5 py-1.5",
									isNext && "bg-primary/8",
								)}
							>
								<span
									className={cn(
										"mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full",
										isDone
											? PILL.success
											: isNext
												? "ring-[1.5px] ring-primary ring-inset"
												: "ring-1 ring-border ring-inset",
									)}
								>
									{isDone && <LuCheck className="size-3" strokeWidth={3} />}
								</span>
								<div className="min-w-0 flex-1">
									<div
										className={cn(
											"text-[12.5px] font-medium",
											isDone && "text-muted-foreground line-through",
										)}
									>
										{copy.title}
									</div>
									{!isDone && (
										<div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
											{copy.body(newTaskKeys)}
										</div>
									)}
								</div>
								{!isDone && (
									<button
										type="button"
										onClick={run[step]}
										className={cn(
											"h-6 shrink-0 self-center rounded-[7px] px-2.5 text-[11px] font-semibold",
											isNext ? BUTTON.primary : BUTTON.secondary,
										)}
									>
										{copy.action}
									</button>
								)}
							</li>
						);
					})}
				</ol>
			)}

			{!next && !progress.collapsed && (
				<div className="flex justify-end px-3.5 pb-3">
					<button
						type="button"
						onClick={close}
						className={cn(
							"h-7 rounded-[7px] px-3 text-[11px] font-semibold",
							BUTTON.done,
						)}
					>
						Done
					</button>
				</div>
			)}
		</div>
	);
}
