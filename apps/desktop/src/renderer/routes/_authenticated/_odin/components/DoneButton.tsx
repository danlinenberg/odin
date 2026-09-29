import { LuCheck } from "react-icons/lu";

/** Per-row Done. Undo is on the toast, and in All tasks' Done list. */
export function DoneButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			title="Mark done"
			aria-label="Mark done"
			className="rounded-[7px] px-2 py-1 text-xs font-semibold text-[#8a8a97] hover:bg-[#14301f] hover:text-[#3ecf8e]"
		>
			<LuCheck className="size-3.5" strokeWidth={3} aria-hidden />
		</button>
	);
}
