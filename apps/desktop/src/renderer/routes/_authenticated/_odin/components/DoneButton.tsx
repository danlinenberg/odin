/**
 * Per-row Done, the same green pill on every feed and always visible: it's the
 * other half of what a queue row is for. Undo is on the toast, in All tasks'
 * Done list, and — on Reactions — this same button with `done` set.
 */
export function DoneButton({
	onClick,
	done = false,
	disabled,
}: {
	onClick: () => void;
	done?: boolean;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={done ? "Move back to the queue" : "Mark done"}
			className="shrink-0 whitespace-nowrap rounded-[7px] bg-[#1f1f27] px-2.5 py-1 text-xs font-semibold text-[#3ecf8e] transition-colors hover:bg-[#14301f] disabled:opacity-40"
		>
			{done ? "↺ Undo" : "✓ Done"}
		</button>
	);
}
