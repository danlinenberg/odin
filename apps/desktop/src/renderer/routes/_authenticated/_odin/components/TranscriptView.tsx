import { cn } from "@odin/ui/utils";
import { useEffect, useMemo, useRef } from "react";
import { MarkdownRenderer } from "renderer/components/MarkdownRenderer";
import { electronTrpc } from "renderer/lib/electron-trpc";

type Turn = { role: "user" | "assistant"; text: string; at: string | null };

/**
 * Claude speaks in bursts between tool calls - five assistant messages in a
 * row read as one reply, so show them as one.
 */
export function mergeTurns(messages: Turn[]): Turn[] {
	const turns: Turn[] = [];
	for (const message of messages) {
		const last = turns.at(-1);
		if (last?.role === message.role)
			turns[turns.length - 1] = {
				...last,
				text: `${last.text}\n\n${message.text}`,
			};
		else turns.push(message);
	}
	return turns;
}

// The renderer's headings are sized for a document; inside a chat bubble they
// shout. Unlayered .default-markdown CSS beats utilities, hence the `!`.
export const COMPACT_MARKDOWN =
	"h-auto! overflow-visible! bg-transparent! text-[13px] leading-relaxed text-soft-foreground [&_article]:p-0! [&_h1]:text-[15px]! [&_h2]:text-[14px]! [&_h2]:border-0! [&_h2]:pb-0! [&_h2]:mt-4! [&_h3]:text-[13px]! [&_h3]:mt-3! [&_p:last-child]:mb-0! [&_ul:last-child]:mb-0! [&_ol:last-child]:mb-0! [&_p]:mb-2.5! [&_code]:text-[12px]";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highlight every occurrence of any search term (the server tokenises them). */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
	if (terms.length === 0) return <>{text}</>;
	const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
	return (
		<>
			{text.split(pattern).map((part, index) =>
				// split() with one capture group puts matches at the odd indices.
				index % 2 === 1 ? (
					<mark
						// biome-ignore lint/suspicious/noArrayIndexKey: split() output is positional
						key={index}
						className="rounded-[3px] bg-primary/30 px-[1px] text-primary"
					>
						{part}
					</mark>
				) : (
					part
				),
			)}
		</>
	);
}

/** The conversation itself, user/assistant turns only - no tool-call noise. */
export function TranscriptView({
	project,
	sessionId,
	terms = [],
}: {
	project?: string;
	sessionId: string;
	terms?: string[];
}) {
	const { data, isLoading, error } =
		electronTrpc.terminal.readClaudeTranscript.useQuery({ project, sessionId });
	const turns = useMemo(() => mergeTurns(data?.messages ?? []), [data]);
	const ref = useRef<HTMLDivElement>(null);
	// Jump to the first hit when arriving from a search, else the latest turn.
	useEffect(() => {
		if (!data) return;
		const target = ref.current?.querySelector("mark");
		if (target) target.scrollIntoView({ block: "center" });
		else if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [data]);

	if (error) {
		return (
			<div className="flex-1 select-text cursor-text px-4 py-3 text-[12px] text-danger">
				{error.message}
			</div>
		);
	}
	return (
		<div
			ref={ref}
			className="min-h-0 flex-1 select-text cursor-text overflow-y-auto px-5 py-4"
		>
			{isLoading && (
				<div className="text-[12px] text-muted-foreground">loading…</div>
			)}
			{data?.messages.length === 0 && (
				<div className="text-[12px] text-muted-foreground">
					No prose turns in this transcript.
				</div>
			)}
			<div className="mx-auto flex max-w-[820px] flex-col gap-5">
				{turns.map((turn, index) => (
					<div
						key={`${index}-${turn.at ?? ""}`}
						className={cn(
							turn.role === "user" &&
								"ml-auto max-w-[85%] rounded-[12px] border border-primary/20 bg-primary/8 px-3.5 py-2.5",
						)}
					>
						<div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.4px]">
							<span
								className={
									turn.role === "user"
										? "text-primary"
										: "text-muted-foreground"
								}
							>
								{turn.role === "user" ? "you" : "claude"}
							</span>
							{turn.at && (
								<span className="font-normal normal-case tracking-normal text-faint-foreground">
									{new Date(turn.at).toLocaleString()}
								</span>
							)}
						</div>
						{/* Search hits need <mark>s to jump to; otherwise it's Claude's
						    markdown, so render it as markdown. */}
						{terms.length > 0 ? (
							<div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-soft-foreground">
								<Highlight text={turn.text} terms={terms} />
							</div>
						) : (
							<MarkdownRenderer
								content={turn.text}
								style="default"
								allowHtml={false}
								className={COMPACT_MARKDOWN}
							/>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
