import { type ReactNode, useState } from "react";
import {
	LuChevronDown,
	LuChevronLeft,
	LuChevronRight,
	LuMoon,
} from "react-icons/lu";
import type { PhoneNight } from "renderer/routes/_authenticated/_odin/night-agent/night-log";

export type NightData = {
	enabled: boolean;
	start: string;
	end: string;
	maxSessions: number;
	running: boolean;
	startedTonight: number;
	nights: PhoneNight[];
};

const time = (at: string) =>
	new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The hero's line, as the desktop page's: off, running, or when it starts. */
export function nightHeadline(data: NightData): string {
	if (!data.enabled) return "Off";
	return data.running
		? `Running until ${data.end}`
		: `Next run at ${data.start}`;
}

/**
 * The Night Agent on the phone: on or off, its window and cap, then each
 * night newest first - the sessions it started (tap one to open it) and,
 * folded, the log of what it did.
 */
export function NightPage({
	data,
	error,
	onToggle,
	toggling,
	onResume,
}: {
	data: NightData | undefined;
	error: ReactNode;
	onToggle: (enabled: boolean) => void;
	toggling: boolean;
	/** A started session no longer on the board: resume its conversation. */
	onResume: (sessionId: string, title: string) => void;
}) {
	return (
		<div className="min-h-dvh pb-12">
			<header className="sticky top-0 z-10 border-b border-border bg-background/95 px-3.5 pt-[calc(env(safe-area-inset-top)+10px)] pb-2 backdrop-blur">
				<a
					href="#/"
					className="-ml-1.5 flex w-fit items-center px-1 py-1.5 text-[15px] text-primary"
				>
					<LuChevronLeft className="size-5" />
					Board
				</a>
				<h1 className="mt-1 text-2xl font-bold">Night Agent</h1>
			</header>
			{error}
			{data && (
				<>
					<section className="relative mx-3 mt-3 overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/15 via-card/80 to-card/40 p-4">
						<LuMoon
							className="pointer-events-none absolute -top-6 -right-4 size-32 text-primary/[.08]"
							aria-hidden
						/>
						<div className="relative flex items-center gap-3">
							<span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
								<LuMoon className="size-5" />
							</span>
							<div className="min-w-0 flex-1">
								<div className="text-lg font-semibold">
									{nightHeadline(data)}
								</div>
								<div className="text-[13px] text-muted-foreground">
									{data.start} to {data.end} · up to {data.maxSessions} sessions
								</div>
							</div>
							<button
								type="button"
								role="switch"
								aria-checked={data.enabled}
								aria-label="Night Agent"
								disabled={toggling}
								onClick={() => onToggle(!data.enabled)}
								className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors disabled:opacity-60 ${data.enabled ? "bg-primary" : "bg-secondary"}`}
							>
								<span
									className={`absolute top-[2px] size-[27px] rounded-full bg-white shadow transition-[left] ${data.enabled ? "left-[22px]" : "left-[2px]"}`}
								/>
							</button>
						</div>
						{data.running && (
							<div className="relative mt-3 text-[13px] text-soft-foreground">
								{data.startedTonight} of {data.maxSessions} started tonight
							</div>
						)}
					</section>
					{data.nights.length === 0 ? (
						<div className="mx-3 mt-4 rounded-[10px] border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
							No night has run yet.
						</div>
					) : (
						data.nights.map((night) => (
							<NightSection
								key={`${night.label}-${night.date}`}
								night={night}
								onResume={onResume}
							/>
						))
					)}
				</>
			)}
		</div>
	);
}

function NightSection({
	night,
	onResume,
}: {
	night: PhoneNight;
	onResume: (sessionId: string, title: string) => void;
}) {
	const [logOpen, setLogOpen] = useState(false);
	const Chevron = logOpen ? LuChevronDown : LuChevronRight;
	return (
		<section>
			<h2 className="px-4 pt-5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
				{[
					night.label,
					night.date !== night.label && night.date,
					`${night.started.length} started`,
				]
					.filter(Boolean)
					.join(" · ")}
			</h2>
			{night.started.map((row) => {
				const body = (
					<>
						<div className="line-clamp-2 text-[15px]">{row.title}</div>
						<div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
							<span className="truncate">{row.source}</span>
							<span className="ml-auto shrink-0">{time(row.at)}</span>
						</div>
					</>
				);
				const style =
					"mx-3 my-1.5 block w-[calc(100%-1.5rem)] rounded-[10px] border border-border bg-card px-3 py-2.5 text-left active:bg-accent";
				if (row.paneId)
					return (
						<a key={row.at} href={`#/s/${row.paneId}`} className={style}>
							{body}
						</a>
					);
				const { sessionId } = row;
				return sessionId ? (
					<button
						key={row.at}
						type="button"
						onClick={() => onResume(sessionId, row.title)}
						className={style}
					>
						{body}
					</button>
				) : (
					<div key={row.at} className={style}>
						{body}
					</div>
				);
			})}
			{night.lines.length > 0 && (
				<>
					<button
						type="button"
						aria-expanded={logOpen}
						onClick={() => setLogOpen((open) => !open)}
						className="flex items-center gap-1 px-4 pt-2 pb-1 text-[13px] text-muted-foreground"
					>
						<Chevron className="size-3.5" />
						Log · {night.lines.length}
					</button>
					{logOpen && (
						<ol className="mx-3 rounded-[10px] border border-border bg-card/60 px-3 py-2 text-[13px] select-text">
							{night.lines.map((line) => (
								<li
									key={`${line.at}-${line.event}`}
									className="flex gap-2 py-1"
								>
									<span className="w-16 shrink-0 text-faint-foreground">
										{time(line.at)}
									</span>
									<span className="min-w-0 flex-1 text-soft-foreground">
										{line.event}
									</span>
								</li>
							))}
						</ol>
					)}
				</>
			)}
		</section>
	);
}
