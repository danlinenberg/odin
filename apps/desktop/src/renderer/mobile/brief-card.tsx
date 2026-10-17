import { useState } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { Markdown } from "./markdown";

/** The session's brief; an older Odin on the Mac answers the TL;DR line alone. */
export type Brief =
	| string
	| {
			tldr: string | null;
			goal: string | null;
			done: string | null;
			status: string | null;
			next: string | null;
	  }
	| null
	| undefined;

const SECTIONS = [
	["goal", "Goal"],
	["done", "What it did"],
	["status", "Where it stands"],
	["next", "Next"],
] as const;

/**
 * The TL;DR at the top of a session; tap it for the whole brief - goal, what
 * it did, where it stands, what's next - like the desktop's session brief.
 */
export function BriefCard({
	brief,
	loading,
}: {
	brief: Brief;
	loading: boolean;
}) {
	const [open, setOpen] = useState(false);
	const full = brief && typeof brief === "object" ? brief : null;
	const tldr = typeof brief === "string" ? brief : full?.tldr;
	const sections = SECTIONS.filter(([key]) => full?.[key]);
	const Chevron = open ? LuChevronDown : LuChevronRight;
	return (
		<button
			type="button"
			disabled={sections.length === 0}
			onClick={() => setOpen((shown) => !shown)}
			className="mb-2 block w-full rounded-[10px] border border-border border-l-[3px] border-l-primary bg-card p-2.5 text-left text-sm leading-snug text-soft-foreground"
		>
			<div className="flex items-center justify-between text-[10px] font-semibold text-faint-foreground">
				{open ? "BRIEF" : "TL;DR"}
				{sections.length > 0 && <Chevron className="size-4" />}
			</div>
			{loading ? (
				"Writing the TL;DR…"
			) : !open ? (
				(tldr ?? "No summary yet.")
			) : (
				<div className="space-y-2 pt-1">
					{sections.map(([key, label]) => (
						<div key={key}>
							<div className="text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
								{label}
							</div>
							<Markdown text={full?.[key] ?? ""} />
						</div>
					))}
				</div>
			)}
		</button>
	);
}
