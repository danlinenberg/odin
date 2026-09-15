import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { useState } from "react";
import {
	PRIORITY_LABELS,
	parseTask,
	priorityOf,
	useMyTasks,
	withPriority,
} from "../hooks/useOdinTasks";

/**
 * The box you write a task in — compose row, edit row and the hotkey's quick
 * capture all use this one, so priority works the same in all three.
 *
 * Enter adds/saves, Shift+Enter is a newline, Escape cancels.
 */
export function TaskBox({
	value,
	placeholder,
	autoFocus,
	onChange,
	onSubmit,
	onCancel,
}: {
	value: string;
	placeholder?: string;
	autoFocus?: boolean;
	onChange: (text: string) => void;
	onSubmit: () => void;
	onCancel?: () => void;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<textarea
				value={value}
				placeholder={placeholder}
				// biome-ignore lint/a11y/noAutofocus: the edit box replaces the row you clicked
				autoFocus={autoFocus}
				rows={2}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						onSubmit();
					}
					if (event.key === "Escape") onCancel?.();
				}}
				className="w-full resize-none rounded-[10px] border border-[#25252e] bg-[#111114] px-3 py-2 text-[13px] text-[#f5f5f7] outline-none placeholder:text-[#8a8a97] focus:border-[#a394ff]"
			/>
			{/* The picker doesn't hold a value of its own: it rewrites the "!"s in
			    the text, which is what the store reads either way. Typing "!" and
			    picking Low are the same edit, so neither can go stale. Medium is
			    the no-"!"s case, so the box you just typed into already reads as it.

			    ponytail: a native <select> — it opens as a real menu, it's keyboard
			    navigable for free, and there's no popup to style. */}
			<div className="flex items-center gap-1.5">
				<span className="text-[11px] text-[#8a8a97]">Priority</span>
				<select
					aria-label="Priority"
					title="Or lead the first line with ! (Low) or !!! (High) — no ! is Medium"
					value={parseTask(value).priority}
					onChange={(event) =>
						onChange(withPriority(value, Number(event.target.value)))
					}
					className="cursor-pointer rounded-[6px] bg-[#1f1f27] px-1.5 py-[3px] text-[11px] font-semibold text-[#a5a5b3] outline-none transition-colors hover:text-[#f5f5f7]"
				>
					{/* Levels only — slot 0 ("None") is legacy storage, not a choice. */}
					{PRIORITY_LABELS.slice(1).map((label, index) => (
						<option key={label} value={index + 1}>
							{label}
						</option>
					))}
				</select>
			</div>
		</div>
	);
}

/**
 * Quieter the lower it is — High has to be the one that catches the eye, and
 * Medium is on most rows now that it's the default, so it can't shout.
 */
const PRIORITY_CHIP = [
	"",
	"bg-[#17171c] text-[#6f6f7d]",
	"bg-[#1f1f27] text-[#a5a5b3]",
	"bg-[#3a1a20] text-[#f0647a]",
];

/** A task's priority on its row. Every task has one — no "!"s means Medium. */
export function PriorityChip({ priority }: { priority?: number }) {
	const level = priorityOf({ priority });
	return (
		<span
			className={cn(
				"rounded-[5px] px-[7px] py-[1px] font-semibold",
				PRIORITY_CHIP[level],
			)}
		>
			{PRIORITY_LABELS[level]}
		</span>
	);
}

/**
 * The same chip for a source with its own names for the levels — Jira's
 * Highest, Notion's Low. A level it shares with ours is coloured like ours;
 * anything else (P1, Blocker) stays grey rather than guessing at severity.
 */
export function PriorityLabelChip({ label }: { label: string }) {
	const level = PRIORITY_LABELS.findIndex(
		(known, i) => i > 0 && label.toLowerCase().startsWith(known.toLowerCase()),
	);
	return (
		<span
			className={cn(
				"truncate rounded-[5px] px-[7px] py-[1px] font-semibold",
				level > 0 ? PRIORITY_CHIP[level] : "bg-[#1f1f27] text-[#a5a5b3]",
			)}
		>
			{label}
		</span>
	);
}

/**
 * Quick capture — the hotkey's box, over whatever you were looking at. The
 * task lands on My Tasks and you go back to what you were doing; walking to
 * the list to write it down is how a task gets lost on the way.
 */
export function QuickAddTask({ onClose }: { onClose: () => void }) {
	const { add } = useMyTasks();
	const [draft, setDraft] = useState("");

	const save = () => {
		// Same rule the store uses — no title, no task, so don't claim one.
		if (!parseTask(draft).title) return onClose();
		add(draft);
		toast.success("Added to My Tasks");
		onClose();
	};

	return (
		<>
			<button
				type="button"
				aria-label="Cancel"
				className="fixed inset-0 z-40 cursor-default bg-black/50"
				onClick={onClose}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="New task"
				className="fixed left-1/2 top-[12vh] z-50 w-[520px] max-w-[92vw] -translate-x-1/2 rounded-[10px] border border-[#2e2e38] bg-[#111114] p-3.5 shadow-[0_18px_60px_rgba(0,0,0,0.6)]"
			>
				<div className="mb-2 text-xs font-semibold text-[#f5f5f7]">
					New task
					<span className="ml-1.5 font-normal text-[#8a8a97]">
						⏎ add · esc cancel · first line names it
					</span>
				</div>
				<TaskBox
					value={draft}
					autoFocus
					placeholder="What needs doing? (Medium unless you lead with ! or !!!)"
					onChange={setDraft}
					onSubmit={save}
					onCancel={onClose}
				/>
			</div>
		</>
	);
}
