import { useEffect, useState } from "react";
import {
	LuCheck,
	LuChevronDown,
	LuChevronRight,
	LuLoaderCircle,
	LuSquare,
	LuX,
} from "react-icons/lu";
import {
	elapsedLabel,
	tokenLabel,
} from "../routes/_authenticated/_odin/board/tool-description";

type Step = { id: string; text: string; done: boolean; error: boolean };

/** What Claude ran since your last message; none from an older Odin. */
export type Turn = {
	start: string | null;
	tokens: number;
	steps: Step[];
	total: number;
};

/** Steps shown before Show all: the latest, so the one running is in view. */
const FOLDED_STEPS = 4;

/** "3m 05s", ticking. */
function Elapsed({ since }: { since: number }) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return <span className="tabular-nums">{elapsedLabel(now - since)}</span>;
}

/**
 * Claude at work, as the board's chat shows it: what it does now, how long
 * and how much it has written, the turn's steps - the running one spinning -
 * and Stop.
 */
export function WorkingCard({
	activity,
	turn,
	onStop,
	stopping,
}: {
	/** The spinner line read off the screen ("Cogitating… 5m 0s"). */
	activity: string | null | undefined;
	turn: Turn | null | undefined;
	onStop: () => void;
	stopping: boolean;
}) {
	const [all, setAll] = useState(false);
	const steps = turn?.steps ?? [];
	const shown = all ? steps : steps.slice(-FOLDED_STEPS);
	const hidden = (turn?.total ?? 0) - shown.length;
	const start = turn?.start ? Date.parse(turn.start) : Number.NaN;
	const facts = [
		!Number.isNaN(start) && <Elapsed key="time" since={start} />,
		!!turn?.tokens && `${tokenLabel(turn.tokens)} tokens`,
		!!turn?.total && `${turn.total} step${turn.total === 1 ? "" : "s"}`,
	].filter(Boolean);
	return (
		<div className="my-3 mr-6 rounded-2xl border border-working/30 bg-working/10 px-3 py-2.5 text-sm">
			<div className="flex items-center gap-2 text-working-ink">
				<LuLoaderCircle className="size-4 shrink-0 animate-spin" />
				<span className="min-w-0 flex-1 truncate">
					{activity ?? "Working…"}
				</span>
				<button
					type="button"
					disabled={stopping}
					onClick={onStop}
					className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-secondary px-3 text-[13px] font-semibold text-foreground disabled:opacity-50"
				>
					<LuSquare className="size-3 fill-current" />
					Stop
				</button>
			</div>
			{facts.length > 0 && (
				<div className="mt-1 flex gap-1.5 pl-6 text-[12px] text-muted-foreground">
					{facts.map((fact, i) => (
						<span key={typeof fact === "string" ? fact : "time"}>
							{i > 0 && "· "}
							{fact}
						</span>
					))}
				</div>
			)}
			{shown.length > 0 && (
				<ol className="mt-2 flex flex-col gap-1 border-t border-working/20 pt-2">
					{shown.map((step, i) => {
						const running = !step.done && i === shown.length - 1;
						return (
							<li
								key={step.id}
								className={`flex items-start gap-2 text-[13px] leading-snug ${running ? "text-foreground" : "text-muted-foreground"}`}
							>
								{step.error ? (
									<LuX className="mt-0.5 size-3.5 shrink-0 text-danger" />
								) : running ? (
									<LuLoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-working-ink" />
								) : (
									<LuCheck className="mt-0.5 size-3.5 shrink-0" />
								)}
								<span className="min-w-0 select-text break-words">
									{step.text}
								</span>
							</li>
						);
					})}
				</ol>
			)}
			{(hidden > 0 || all) && steps.length > FOLDED_STEPS && (
				<button
					type="button"
					onClick={() => setAll(!all)}
					className="mt-1.5 flex items-center gap-1 text-[13px] font-medium text-primary"
				>
					{all ? (
						<LuChevronDown className="size-4" />
					) : (
						<LuChevronRight className="size-4" />
					)}
					{all ? "Show fewer steps" : `Show all ${turn?.total} steps`}
				</button>
			)}
		</div>
	);
}
